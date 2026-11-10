import { ComputePipeline } from "../compute/pipeline";
import { MovingAverageModule } from "../compute/modules/movingAverage";
import { PeakHeartRateModule } from "../compute/modules/peakHeartRate";
import { PpgPulseRateModule } from "../compute/modules/ppgPulseRate";
import { WasmEcgModule, WasmPpgModule } from "../compute/modules/edgeDsp";
import bbdspUrl from "../dsp/bbdsp.wasm?url";
import { EdgeDsp } from "../dsp/edgeDsp";
import { estimatePower, type PowerEstimate } from "../placement/energy";
import { crossSensorChecks, median, rateKind, StreamVerifier, type CheckResult, type RateEstimate, type VerificationReport } from "../verify/verifier";
import { DEFAULT_THRESHOLDS, ThresholdAlertModule, type ChannelThresholds } from "../compute/modules/thresholdAlert";
import type { AlertEvent, ComputeModule } from "../compute/types";
import type { DecoderStats } from "../descriptors/compile";
import type { Descriptor } from "../descriptors/types";
import { DescriptorDriver } from "../drivers/descriptorDriver";
import { DEVICE_FACTORIES, hardwareTransport, type DeviceFactory, type DeviceGroup } from "../drivers/registry";
import { BENCH_DEVICES } from "../bench/devices";
import { DESCRIPTORS } from "../descriptors/library";
import { BleTransport } from "../transports/bleTransport";
import { SerialTransport } from "../transports/serialTransport";
import type { Transport } from "../transports/types";
import { SimulatedNodeATransport } from "../transports/simulatedTransports";
import { loadCustomDevices, saveCustomDevices, type CustomDevice } from "./customDevices";
import type { DeviceReading, DeviceStatus } from "../drivers/types";
import { PhysiologyModel, type SimScenario } from "../sim/physiology";
import { SimSyncRig } from "../sim/syncRig";
import { RingBuffer } from "../state/ringBuffer";
import { createClockMapper, DEFAULT_CLOCK_METHOD, hostNowMs, type ClockEstimate, type ClockMethodId } from "../time/clock";
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

export type CaptureSource =
  | { kind: "serial"; baudRate: number }
  | { kind: "ble"; service: string; characteristic: string; namePrefix?: string }
  | { kind: "sim-bench"; benchId: string };

export type CapturedChunk = { t: number; bytes: Uint8Array };

export type CaptureResult = {
  chunks: CapturedChunk[];
  /** Node A ECG captured over the same window, for the cross-sensor oracle. */
  reference: { label: string; descriptor: Descriptor; chunks: CapturedChunk[] } | null;
  deviceLabel: string | null;
};

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
  clock: ClockEstimate | null;
  verification: VerificationReport;
  /** Where the data comes from: a simulator, real hardware, or a replayed recording. */
  source: "simulated" | "hardware" | "replay";
  connectedAt: number;
  /** Host time of the last chunk received, or null before any. */
  lastChunkAt: number | null;
  /** Newest raw chunks as received (for the packet inspector), oldest first. */
  recentChunks: { t: number; bytes: Uint8Array }[];
  /** Per channel that produced data: sample count and rate measured from timestamps. */
  channels: ChannelStatsView[];
};

export type ChannelStatsView = { id: string; unit?: string; count: number; rateHz: number | null };

export type DiagnosticCategory = "connection" | "packets" | "verification" | "signal" | "sync" | "physiology";

export type Diagnostic = {
  id: string;
  category: DiagnosticCategory;
  severity: "info" | "warning" | "critical";
  time: number;
  device: string | null;
  message: string;
  context?: string;
};

export type DescriptorView = { descriptor: Descriptor; source: "bundled" | "user"; factoryIds: string[] };

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
  connectedAt: number;
  lastChunkAt: number | null;
  recent: { t: number; bytes: Uint8Array }[];
  /** First/last timestamp (device µs when available, else host ms × 1000) and count per channel. */
  channelTimes: Map<string, { first: number; last: number; n: number; unit?: string }>;
  unsubs: Array<() => void>;
};

const RECENT_CHUNKS = 8;

const RATE_WINDOW_MS = 15_000;

function createModules(thresholds: Record<string, ChannelThresholds>, getDsp: () => EdgeDsp | null): ComputeModule[] {
  return [
    new MovingAverageModule("spo2", 8),
    new PeakHeartRateModule(),
    new PpgPulseRateModule(),
    new WasmEcgModule(getDsp),
    new WasmPpgModule(getDsp),
    new ThresholdAlertModule(thresholds),
  ];
}

/** What the device computed (*_edge) next to what the browser computed from samples (*_wasm). */
const PLACEMENT_PAIRS: { label: string; device: string; browser: string; unit: string }[] = [
  { label: "Heart rate (ECG)", device: "heartRate_edge", browser: "heartRate_wasm", unit: "bpm" },
  { label: "Pulse rate (PPG)", device: "pulseRate_edge", browser: "pulseRate_wasm", unit: "bpm" },
  { label: "SpO2", device: "spo2_edge", browser: "spo2_wasm", unit: "%" },
  { label: "Signal quality", device: "sqi_edge", browser: "sqi_wasm", unit: "" },
];

export type PlacementView = {
  id: string;
  label: string;
  transport: "serial" | "ble";
  commands: { id: string; label: string; description?: string }[];
  /** From the device's last STATS frame. */
  mode: number | null;
  linkBytesPerS: number | null;
  deviceDspUsPerS: number | null;
  /** Wall time the browser spent in Wasm DSP for this connection, ms per second. */
  browserDspMsPerS: number;
  power: PowerEstimate | null;
  results: { label: string; unit: string; device: number | null; browser: number | null }[];
};

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
  readonly modulePrototypes: ComputeModule[] = createModules(this.thresholds, () => null);
  /** The firmware DSP compiled to WebAssembly; shared by the browser modules and the simulated nodes. */
  dsp: EdgeDsp | null = null;
  private readonly dspReady: Promise<EdgeDsp | null>;
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
  private cpuHistory = new Map<string, Array<{ t: number; ms: number }>>();

  constructor() {
    this.dspReady =
      typeof fetch === "undefined"
        ? Promise.resolve(null)
        : EdgeDsp.fromUrl(bbdspUrl)
            .then((d) => (this.dsp = d))
            .catch((err) => {
              console.error("Could not load the Wasm DSP:", err);
              return null;
            });
  }
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
  // ---- device catalogue (built-in + added by the user) ---------------------------------------------

  private custom: CustomDevice[] = loadCustomDevices();

  listFactories(): DeviceFactory[] {
    return [...DEVICE_FACTORIES, ...this.custom.map((d) => this.customFactory(d))];
  }

  private customFactory(d: CustomDevice): DeviceFactory {
    const source = d.source;
    const bench = source.kind === "sim-bench" ? BENCH_DEVICES.find((b) => b.id === source.benchId) : undefined;
    return {
      id: `custom-${d.id}`,
      label: d.label,
      description: bench
        ? `Added descriptor, connected to the simulated ${bench.title}.`
        : `Added descriptor (${d.descriptor.transport.kind === "serial" ? "USB-serial" : "Bluetooth LE"}).`,
      group: "custom",
      descriptor: d.descriptor,
      isSupported: () => (bench ? true : hardwareTransport(d.descriptor).isSupported()),
      createTransport: (env) => (bench ? bench.createTransport(env) : hardwareTransport(d.descriptor)),
    };
  }

  /** Adds (or replaces) a user device; ids are slugs of the label. */
  addCustomDevice(label: string, descriptor: Descriptor, source: CustomDevice["source"]): string {
    const id = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `device-${Date.now()}`;
    this.custom = [...this.custom.filter((d) => d.id !== id), { id, label, descriptor, source, addedAt: Date.now() }];
    saveCustomDevices(this.custom);
    this.changed();
    return `custom-${id}`;
  }

  removeCustomDevice(factoryId: string): void {
    this.custom = this.custom.filter((d) => `custom-${d.id}` !== factoryId);
    saveCustomDevices(this.custom);
    this.changed();
  }

  // ---- raw capture of an unknown device ------------------------------------------------------------

  /**
   * Records an unknown device's raw bytes for durationMs, with no descriptor. When a Node A (real or
   * simulated) is connected, its bytes over the same window come along as the cross-sensor ECG reference;
   * for a simulated benchmark device, a simulated Node A on the same simulated subject is captured with it.
   * Call from a click handler: opening hardware shows the browser's device picker.
   */
  async capture(source: CaptureSource, durationMs: number): Promise<CaptureResult> {
    let transport: Transport;
    let ownRef: Transport | null = null;
    if (source.kind === "serial") transport = new SerialTransport(source.baudRate);
    else if (source.kind === "ble") transport = new BleTransport({ kind: "ble", service: source.service, characteristic: source.characteristic, namePrefix: source.namePrefix || undefined });
    else {
      const bench = BENCH_DEVICES.find((b) => b.id === source.benchId);
      if (!bench) throw new Error(`No benchmark device ${source.benchId}`);
      transport = bench.createTransport({ physiology: this.physiology, rig: this.rig, dsp: this.dsp });
      ownRef = new SimulatedNodeATransport({ physiology: this.physiology, rig: this.rig, dsp: this.dsp });
    }

    const chunks: CapturedChunk[] = [];
    const refChunks: CapturedChunk[] = [];
    const unsubs = [transport.onChunk((bytes, t) => chunks.push({ t, bytes: bytes.slice() }))];
    const liveRef = ownRef ? null : [...this.connections.values()].find((c) => c.factoryId === "node-a" || c.factoryId === "sim-node-a");
    if (ownRef) unsubs.push(ownRef.onChunk((bytes, t) => refChunks.push({ t, bytes: bytes.slice() })));
    if (liveRef) unsubs.push(liveRef.driver.onRawChunk((bytes, t) => refChunks.push({ t, bytes: bytes.slice() })));

    try {
      await transport.open();
      await ownRef?.open();
      await new Promise((r) => setTimeout(r, durationMs));
    } finally {
      for (const u of unsubs) u();
      await transport.close().catch(() => undefined);
      await ownRef?.close();
    }
    const reference =
      refChunks.length > 0
        ? { label: liveRef?.label ?? "Simulated Node A (reference)", descriptor: liveRef?.driver.descriptor ?? DESCRIPTORS.nodeA, chunks: refChunks }
        : null;
    return { chunks, reference, deviceLabel: transport.deviceLabel() };
  }

  async connect(factoryId: string): Promise<string> {
    const factory = this.listFactories().find((f) => f.id === factoryId);
    if (!factory) throw new Error(`Unknown device type ${factoryId}`);
    // Simulated nodes run the Wasm DSP in edge modes. Hardware must not wait: the device picker needs the click's user gesture.
    if (factory.group === "simulated") await this.dspReady;
    const transport = factory.createTransport({ physiology: this.physiology, rig: this.rig, dsp: this.dsp });
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
    conn.pipeline.reset(); // frees Wasm detectors
    this.connections.delete(id);
    this.pulses.removeSource(id);
    this.cpuHistory.delete(id);
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
      clock: c.driver.getClockEstimate(),
      verification: this.verificationOf(c),
      source: c.group === "replay" ? "replay" : c.driver.transport.kind === "simulated" ? "simulated" : "hardware",
      connectedAt: c.connectedAt,
      lastChunkAt: c.lastChunkAt,
      recentChunks: [...c.recent],
      channels: [...c.channelTimes].map(([id, t]) => ({
        id,
        unit: t.unit,
        count: t.n,
        rateHz: t.n > 10 && t.last > t.first ? ((t.n - 1) * 1e6) / (t.last - t.first) : null,
      })),
    }));
  }

  /** Every descriptor the app knows: bundled ones and the user's, with the device types that use each. */
  listDescriptors(): DescriptorView[] {
    const out = new Map<string, DescriptorView>();
    for (const f of this.listFactories()) {
      const key = `${f.group === "custom" ? "user" : "bundled"}:${f.descriptor.id}`;
      const v = out.get(key) ?? { descriptor: f.descriptor, source: f.group === "custom" ? ("user" as const) : ("bundled" as const), factoryIds: [] };
      v.factoryIds.push(f.id);
      out.set(key, v);
    }
    return [...out.values()];
  }

  /**
   * Live diagnostics derived from the current state (connection errors, link problems, failed verification,
   * high sync error, poor signal quality), plus the physiological threshold alerts.
   */
  diagnostics(): Diagnostic[] {
    const now = hostNowMs();
    const out: Diagnostic[] = [];
    for (const c of this.listConnections()) {
      if (c.status === "error") {
        out.push({ id: `${c.id}:conn`, category: "connection", severity: "critical", time: now, device: c.label, message: "Connection failed", context: c.lastError ?? undefined });
      }
      const s = c.stats;
      const frames = s.framesOk + s.crcErrors + s.malformed;
      if (frames > 0) {
        const pct = (n: number) => `${((100 * n) / frames).toFixed(1)}%`;
        if (s.crcErrors > 0) out.push({ id: `${c.id}:crc`, category: "packets", severity: s.crcErrors / frames > 0.05 ? "critical" : "warning", time: now, device: c.label, message: `${s.crcErrors} checksum failures`, context: `${pct(s.crcErrors)} of frames` });
        if (s.malformed > 0) out.push({ id: `${c.id}:malformed`, category: "packets", severity: s.malformed / frames > 0.05 ? "critical" : "warning", time: now, device: c.label, message: `${s.malformed} frames matched no message`, context: `${pct(s.malformed)} of frames; the descriptor may be incomplete` });
        if (s.seqGaps > 0) out.push({ id: `${c.id}:seq`, category: "packets", severity: s.seqGaps / frames > 0.05 ? "critical" : "warning", time: now, device: c.label, message: `${s.seqGaps} frames lost (sequence gaps)` });
      }
      for (const ch of c.verification.checks.filter((x) => x.status === "fail" || x.status === "warn")) {
        out.push({ id: `${c.id}:v:${ch.id}`, category: "verification", severity: ch.status === "fail" ? "critical" : "warning", time: now, device: c.label, message: `${ch.oracle}: ${ch.name}`, context: ch.detail });
      }
      for (const ch of ["sqi_edge", "sqi_wasm"]) {
        const v = this.getLatest(c.id, ch)?.value;
        if (v !== undefined && v < 0.8) out.push({ id: `${c.id}:${ch}`, category: "signal", severity: "warning", time: now, device: c.label, message: `Low PPG signal quality (${v.toFixed(2)})`, context: ch === "sqi_edge" ? "computed on the device" : "computed in the browser" });
      }
    }
    for (const p of this.listSyncPairs()) {
      if (p.stats.n >= 10 && p.stats.rmseMs > 2) {
        out.push({ id: `sync:${p.key}`, category: "sync", severity: p.stats.rmseMs > 5 ? "critical" : "warning", time: now, device: `${p.a} / ${p.b}`, message: `Sync error ${p.stats.rmseMs.toFixed(2)} ms RMS`, context: `last ${p.stats.n} pulse edges` });
      }
    }
    for (const a of this.alerts) {
      out.push({ id: a.id, category: "physiology", severity: a.severity, time: a.timestamp, device: a.source ?? null, message: a.message });
    }
    return out;
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
    for (const m of createModules(this.thresholds, () => this.dsp)) pipeline.register(m, this.moduleEnabled.get(m.id) ?? true);

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
      connectedAt: hostNowMs(),
      lastChunkAt: null,
      recent: [],
      channelTimes: new Map(),
      unsubs: [],
    };
    conn.unsubs = [
      driver.onData((r) => this.handleReading(conn, r)),
      driver.onStatusChange(() => this.changed()),
    ];
    conn.unsubs.push(
      driver.onRawChunk((bytes, t) => {
        conn.lastChunkAt = t;
        conn.recent.push({ t, bytes: bytes.slice() });
        if (conn.recent.length > RECENT_CHUNKS) conn.recent.shift();
      })
    );
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
    const tUs = reading.deviceTimestampUs ?? reading.timestamp * 1000;
    const ct = conn.channelTimes.get(reading.channel);
    if (ct) {
      ct.last = tUs;
      ct.n++;
    } else conn.channelTimes.set(reading.channel, { first: tUs, last: tUs, n: 1, unit: reading.unit });
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

  // ---- compute placement --------------------------------------------------------------------------

  private defaultConnected = false;

  /** The demo device shown on first load; idempotent (React may run start-up effects twice in development). */
  connectDefaultOnce(): void {
    if (this.defaultConnected) return;
    this.defaultConnected = true;
    void this.connect("sim-monitor");
  }

  async sendCommand(connectionId: string, commandId: string): Promise<void> {
    const conn = this.connections.get(connectionId);
    if (!conn) throw new Error("No such connection.");
    await conn.driver.sendCommand(commandId);
  }

  /** Devices that accept commands (compute-placement nodes), with their link, compute cost and results. */
  listPlacement(): PlacementView[] {
    const now = hostNowMs();
    const views: PlacementView[] = [];
    for (const c of this.connections.values()) {
      const commands = c.driver.descriptor.commands ?? [];
      if (commands.length === 0) continue;
      const info = c.driver.getInfo();
      const periodMs = typeof info.statsPeriodMs === "number" && info.statsPeriodMs > 0 ? info.statsPeriodMs : null;
      const linkBytesPerS = periodMs && typeof info.txBytes === "number" ? (info.txBytes / periodMs) * 1000 : null;
      const deviceDspUsPerS = periodMs && typeof info.dspUs === "number" ? (info.dspUs / periodMs) * 1000 : null;
      const transport = c.driver.descriptor.transport.kind;

      // Browser Wasm cost: rate over the last ~5 s of this connection's Wasm module time.
      const cpu = c.pipeline
        .getEntries()
        .reduce((s, e) => s + (e.module instanceof WasmEcgModule || e.module instanceof WasmPpgModule ? e.module.cpuMs() : 0), 0);
      const hist = this.cpuHistory.get(c.id) ?? [];
      hist.push({ t: now, ms: cpu });
      while (hist.length > 2 && hist[1].t < now - 5000) hist.shift();
      this.cpuHistory.set(c.id, hist);
      const span = (now - hist[0].t) / 1000;
      const browserDspMsPerS = span > 0.5 ? (cpu - hist[0].ms) / span : 0;

      const latest = (ch: string) => c.latest.get(ch)?.value ?? null;
      views.push({
        id: c.id,
        label: c.label,
        transport,
        commands: commands.map(({ id, label, description }) => ({ id, label, description })),
        mode: typeof info.mode === "number" ? info.mode : null,
        linkBytesPerS,
        deviceDspUsPerS,
        browserDspMsPerS,
        power: linkBytesPerS === null || deviceDspUsPerS === null ? null : estimatePower({ transport, linkBytesPerS, dspUsPerS: deviceDspUsPerS }),
        results: PLACEMENT_PAIRS.filter((p) => c.latest.has(p.device) || c.latest.has(p.browser)).map((p) => ({
          label: p.label,
          unit: p.unit,
          device: latest(p.device),
          browser: latest(p.browser),
        })),
      });
    }
    return views;
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
