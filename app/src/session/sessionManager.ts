import { ComputePipeline } from "../compute/pipeline";
import { MovingAverageModule } from "../compute/modules/movingAverage";
import { PeakHeartRateModule } from "../compute/modules/peakHeartRate";
import { PpgPulseRateModule } from "../compute/modules/ppgPulseRate";
import { crossSensorChecks, median, rateKind, StreamVerifier, type CheckResult, type RateEstimate, type VerificationReport } from "../verify/verifier";
import { DEFAULT_THRESHOLDS, ThresholdAlertModule, type ChannelThresholds } from "../compute/modules/thresholdAlert";
import type { AlertEvent, ComputeModule } from "../compute/types";
import type { DecoderStats } from "../descriptors/compile";
import type { Descriptor } from "../descriptors/types";
import { DescriptorDriver } from "../drivers/descriptorDriver";
import { DEVICE_FACTORIES, type DeviceGroup } from "../drivers/registry";
import type { DeviceReading, DeviceStatus } from "../drivers/types";
import { PhysiologyModel, type SimScenario } from "../sim/physiology";
import { SimSyncRig } from "../sim/syncRig";
import { RingBuffer } from "../state/ringBuffer";
import { createClockMapper, DEFAULT_CLOCK_METHOD, hostNowMs, type ClockMethodId } from "../time/clock";
import { PulsePairTracker, type PulsePairSeries } from "../sync/pulsePairs";
import { summarize, type ErrorStats } from "../sync/stats";
import { ReplayTransport } from "../transports/replayTransport";
import { Recorder } from "./recorder";
import { parseRecording, serializeRecording, type RecordingConnection, type RecordingMeta } from "./recording";
import { RecordingStore } from "./recordingStore";

const WAVEFORM_CAPACITY = 3000; // 12 s of 250 Hz ECG
const SCALAR_CAPACITY = 240;
const MAX_ALERTS = 100;

export type ConnectionGroup = DeviceGroup | "replay";

export type ConnectionView = {
  id: string;
  factoryId: string;
  label: string;
  group: ConnectionGroup;
  status: DeviceStatus;
  lastError: string | null;
  deviceLabel: string | null;
  info: Record<string, number | string>;
  stats: DecoderStats;
  descriptor: Descriptor;
  clockMapper: string;
  clockDetail: string | null;
  verification: VerificationReport;
};

export type SyncPairView = { key: string; a: string; b: string; stats: ErrorStats; series: PulsePairSeries["points"] };

type Connection = {
  id: string;
  factoryId: string;
  label: string;
  group: ConnectionGroup;
  driver: DescriptorDriver;
  pipeline: ComputePipeline;
  buffers: Map<string, RingBuffer<DeviceReading>>;
  latest: Map<string, DeviceReading>;
  waveformChannels: Set<string>;
  /** Connections pair sync pulses only within the same group: live devices, or one replayed recording. */
  syncGroup: string;
  verifier: StreamVerifier;
  verification: { at: number; report: VerificationReport } | null;
  unsubs: Array<() => void>;
};

const RATE_WINDOW_MS = 15_000;

function createModules(thresholds: Record<string, ChannelThresholds>): ComputeModule[] {
  return [
    new MovingAverageModule("spo2", 8),
    new PeakHeartRateModule(),
    new PpgPulseRateModule(),
    new ThresholdAlertModule(thresholds),
  ];
}

/**
 * Owns every live connection, its compute pipeline and buffers, and the recorder. Framework-free so it can
 * be driven from tests or a future headless runner; React subscribes via subscribe()/getVersion().
 */
export class SessionManager {
  readonly physiology = new PhysiologyModel();
  /** Simulated sync-pulse rig shared by all simulated nodes (the hardware rig's stand-in). */
  readonly rig = new SimSyncRig();
  /** Shared by every connection's threshold module, so one edit applies everywhere. */
  readonly thresholds: Record<string, ChannelThresholds> = { ...DEFAULT_THRESHOLDS };
  /** Display-only module instances for the pipeline panel; per-connection instances do the work. */
  readonly modulePrototypes: ComputeModule[] = createModules(this.thresholds);
  readonly recordingsSupported = RecordingStore.isAvailable();

  alerts: AlertEvent[] = [];
  recordings: RecordingMeta[] = [];

  private connections = new Map<string, Connection>();
  private nextId = 1;
  private moduleEnabled = new Map<string, boolean>();
  private listeners = new Set<() => void>();
  private version = 0;
  private readonly store = new RecordingStore();
  private readonly pulses = new PulsePairTracker();
  /** Clock-sync method given to newly created connections (and replays). */
  clockMethod: ClockMethodId = DEFAULT_CLOCK_METHOD;
  private readonly recorder = new Recorder(this.store);

  // ---- subscription -------------------------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  private changed(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  // ---- connections --------------------------------------------------------------------------------

  /** For hardware factories, call directly from a click handler: the browser device picker needs it. */
  async connect(factoryId: string): Promise<string> {
    const factory = DEVICE_FACTORIES.find((f) => f.id === factoryId);
    if (!factory) throw new Error(`Unknown device type ${factoryId}`);
    const transport = factory.createTransport({ physiology: this.physiology, rig: this.rig });
    const driver = new DescriptorDriver(factory.descriptor, transport, createClockMapper(this.clockMethod, factory.descriptor));
    const conn = this.addConnection(factory.id, factory.label, factory.group, driver, "live");
    await driver.connect();
    if (driver.getStatus() === "connected") this.recorder.addConnection(this.recordingConnection(conn));
    return conn.id;
  }

  async disconnect(id: string): Promise<void> {
    const conn = this.connections.get(id);
    if (!conn) return;
    for (const u of conn.unsubs) u();
    await conn.driver.disconnect();
    this.connections.delete(id);
    this.pulses.removeSource(id);
    this.changed();
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)));
  }

  listConnections(): ConnectionView[] {
    return [...this.connections.values()].map((c) => ({
      id: c.id,
      factoryId: c.factoryId,
      label: c.label,
      group: c.group,
      status: c.driver.getStatus(),
      lastError: c.driver.getLastError(),
      deviceLabel: c.driver.transport.deviceLabel(),
      info: c.driver.getInfo(),
      stats: { ...c.driver.getStats() },
      descriptor: c.driver.descriptor,
      clockMapper: c.driver.getClockMapperName(),
      clockDetail: c.driver.getClockDetail(),
      verification: this.verificationOf(c),
    }));
  }

  /** Recomputed at most once a second: cheap enough for a 15 fps UI, fresh enough to watch. */
  private verificationOf(c: Connection): VerificationReport {
    const now = hostNowMs();
    if (!c.verification || now - c.verification.at > 1000) {
      c.verifier.setInfo(c.driver.getInfo());
      c.verification = { at: now, report: c.verifier.report(c.driver.getStats()) };
    }
    return c.verification.report;
  }

  /**
   * Cross-sensor oracle, live: compares every heart/pulse-rate estimate (median over the last 15 s) between
   * connections in the same group, e.g. Node A's ECG heart rate against Node B's PPG pulse rate.
   */
  listCrossSensorChecks(): CheckResult[] {
    const groups = new Map<string, RateEstimate[]>();
    for (const c of this.connections.values()) {
      for (const [channel, buf] of c.buffers) {
        const kind = rateKind(channel);
        if (!kind) continue;
        const items = buf.toArray();
        if (items.length === 0) continue;
        const end = items[items.length - 1].timestamp;
        const bpm = median(items.filter((r) => r.timestamp >= end - RATE_WINDOW_MS).map((r) => r.value));
        if (bpm === null) continue;
        if (!groups.has(c.syncGroup)) groups.set(c.syncGroup, []);
        groups.get(c.syncGroup)!.push({ source: c.label, kind, bpm });
      }
    }
    return [...groups.values()].flatMap((estimates) => crossSensorChecks(estimates));
  }

  getBuffer(connectionId: string, channel: string): DeviceReading[] {
    return this.connections.get(connectionId)?.buffers.get(channel)?.toArray() ?? [];
  }

  getLatest(connectionId: string, channel: string): DeviceReading | undefined {
    return this.connections.get(connectionId)?.latest.get(channel);
  }

  /** Channels that have produced data on a connection, including derived ones (e.g. heartRate_computed). */
  getChannels(connectionId: string): string[] {
    return [...(this.connections.get(connectionId)?.latest.keys() ?? [])];
  }

  private addConnection(
    factoryId: string,
    label: string,
    group: ConnectionGroup,
    driver: DescriptorDriver,
    syncGroup: string
  ): Connection {
    const id = `c${this.nextId++}`;
    const sameKind = [...this.connections.values()].filter((c) => c.label === label || c.label.startsWith(`${label} #`));
    const pipeline = new ComputePipeline();
    for (const m of createModules(this.thresholds)) pipeline.register(m, this.moduleEnabled.get(m.id) ?? true);

    const conn: Connection = {
      id,
      factoryId,
      label: sameKind.length > 0 ? `${label} #${sameKind.length + 1}` : label,
      group,
      driver,
      pipeline,
      buffers: new Map(),
      latest: new Map(),
      waveformChannels: new Set(driver.descriptor.channels.filter((c) => c.display === "waveform").map((c) => c.id)),
      syncGroup,
      verifier: new StreamVerifier(driver.descriptor),
      verification: null,
      unsubs: [],
    };
    conn.unsubs = [
      driver.onData((r) => this.handleReading(conn, r)),
      driver.onStatusChange(() => this.changed()),
    ];
    if (group !== "replay") conn.unsubs.push(driver.onRawChunk((bytes, t) => this.recorder.push(conn.id, bytes, t)));
    this.connections.set(id, conn);
    this.changed();
    return conn;
  }

  private record(conn: Connection, reading: DeviceReading): void {
    let buf = conn.buffers.get(reading.channel);
    if (!buf) {
      buf = new RingBuffer(conn.waveformChannels.has(reading.channel) ? WAVEFORM_CAPACITY : SCALAR_CAPACITY);
      conn.buffers.set(reading.channel, buf);
    }
    buf.push(reading);
    conn.latest.set(reading.channel, reading);
  }

  private handleReading(conn: Connection, reading: DeviceReading): void {
    if (reading.channel === "syncEvent") this.pulses.add(conn.id, reading.value, reading.timestamp, conn.syncGroup);
    conn.verifier.observe(reading);
    this.record(conn, reading);
    const { derivedReadings, alerts } = conn.pipeline.process(reading);
    for (const d of derivedReadings) this.record(conn, d);
    if (alerts.length > 0) {
      const tagged = alerts.map((a) => ({ ...a, source: conn.label }));
      this.alerts = [...tagged, ...this.alerts].slice(0, MAX_ALERTS);
      this.changed();
    }
  }

  // ---- clock sync ---------------------------------------------------------------------------------

  setClockMethod(method: ClockMethodId): void {
    this.clockMethod = method;
    this.changed();
  }

  /** Live sync error between every pair of devices that both report sync-rig pulses. */
  listSyncPairs(): SyncPairView[] {
    const label = (id: string) => this.connections.get(id)?.label ?? id;
    return this.pulses.getSeries().map((s) => ({
      key: s.key,
      a: label(s.a),
      b: label(s.b),
      stats: summarize(s.points.slice(-600).map((p) => p.errMs)),
      series: s.points,
    }));
  }

  // ---- simulation & pipeline config ---------------------------------------------------------------

  getScenario(): SimScenario {
    return this.physiology.getScenario();
  }

  setScenario(s: SimScenario): void {
    this.physiology.setScenario(s);
    this.changed();
  }

  isModuleEnabled(moduleId: string): boolean {
    return this.moduleEnabled.get(moduleId) ?? true;
  }

  setModuleEnabled(moduleId: string, enabled: boolean): void {
    this.moduleEnabled.set(moduleId, enabled);
    for (const c of this.connections.values()) c.pipeline.setEnabled(moduleId, enabled);
    this.changed();
  }

  // ---- recording ----------------------------------------------------------------------------------

  get activeRecording(): RecordingMeta | null {
    return this.recorder.active;
  }

  get recorderError(): string | null {
    return this.recorder.lastError;
  }

  private recordingConnection(c: Connection): RecordingConnection {
    return {
      key: c.id,
      factoryId: c.factoryId,
      label: c.label,
      transportKind: c.driver.transport.kind,
      descriptor: c.driver.descriptor,
      joinedAt: hostNowMs(),
      groundTruth: c.driver.transport.groundTruth?.() ?? null,
    };
  }

  async startRecording(name?: string): Promise<void> {
    const now = hostNowMs();
    const live = [...this.connections.values()].filter((c) => c.group !== "replay" && c.driver.getStatus() === "connected");
    await this.recorder.start(name || `Session ${new Date(now).toLocaleString()}`, live.map((c) => this.recordingConnection(c)), now);
    this.changed();
  }

  async stopRecording(): Promise<void> {
    await this.recorder.stop(hostNowMs());
    await this.refreshRecordings();
  }

  async refreshRecordings(): Promise<void> {
    if (!this.recordingsSupported) return;
    this.recordings = await this.store.list();
    this.changed();
  }

  async replayRecording(id: string): Promise<void> {
    const { meta, chunks } = await this.store.load(id);
    const startAt = hostNowMs() + 100; // shared start so devices stay aligned
    for (const rc of meta.connections) {
      const own = chunks.filter((c) => c.c === rc.key).map((c) => ({ t: c.t, bytes: c.bytes }));
      const transport = new ReplayTransport(own, meta.startedAt, rc.label);
      transport.startAt(startAt);
      const driver = new DescriptorDriver(rc.descriptor, transport, createClockMapper(this.clockMethod, rc.descriptor));
      this.addConnection(rc.factoryId, `Replay · ${rc.label}`, "replay", driver, `replay:${id}:${startAt}`);
      void driver.connect();
    }
  }

  async exportRecording(id: string): Promise<{ filename: string; text: string }> {
    const { meta, chunks } = await this.store.load(id);
    const safe = meta.name.replace(/[^a-z0-9-_]+/gi, "_").slice(0, 60);
    return { filename: `${safe || meta.id}.bbrec.jsonl`, text: serializeRecording(meta, chunks) };
  }

  async importRecording(text: string): Promise<void> {
    const { meta, chunks } = parseRecording(text);
    await this.store.put(meta, chunks);
    await this.refreshRecordings();
  }

  async deleteRecording(id: string): Promise<void> {
    await this.store.delete(id);
    await this.refreshRecordings();
  }
}
