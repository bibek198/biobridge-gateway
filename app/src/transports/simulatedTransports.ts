import {
  FrameType,
  NodeKind,
  frame,
  helloPayload,
  nodeASamplesPayload,
  nodeBSamplesPayload,
  syncEventPayload,
  ComputeMode,
  derivedPayload,
  parseConfigFrame,
  statsPayload,
} from "../protocol/nodes";
import type { DspEvent, EcgDetector, EdgeDsp, PpgDetector } from "../dsp/edgeDsp";
import type { PhysiologyModel } from "../sim/physiology";
import type { SimSyncRig } from "../sim/syncRig";
import { hostNowMs } from "../time/clock";
import { BaseTransport, type TransportKind } from "./types";

// Simulated transports emit exactly the bytes real hardware would, so the simulator exercises the same
// descriptor/decoder path as a real device. Each simulated node has its own drifting clock and a
// transport-shaped delivery delay; groundTruth() exposes both for later sync evaluation.

/** What every simulated device shares: one subject, one sync-pulse rig. */
export type SimEnv = {
  physiology: PhysiologyModel;
  rig: SimSyncRig;
  /** Simulated nodes send timing probes unless this is false (the firmware's TIME_PROBES=0 ablation). */
  probes?: boolean;
  /** The firmware DSP (Wasm). Without it, simulated nodes accept mode changes but compute nothing. */
  dsp?: EdgeDsp | null;
};

const encoder = new TextEncoder();

/** A device's free-running clock: random boot time, constant drift (ppm). */
export class SimDeviceClock {
  readonly bootHostMs: number;
  readonly driftPpm: number;

  constructor(driftPpm: number) {
    this.bootHostMs = hostNowMs() - (5_000 + Math.random() * 55_000);
    this.driftPpm = driftPpm;
  }

  deviceUs(hostMs: number): number {
    return Math.floor((hostMs - this.bootHostMs) * 1000 * (1 + this.driftPpm * 1e-6));
  }

  hostMs(deviceUs: number): number {
    return this.bootHostMs + deviceUs / 1000 / (1 + this.driftPpm * 1e-6);
  }
}

export const randomMac = () => [0x24, 0x6f, 0x28, ...Array.from({ length: 3 }, () => Math.floor(Math.random() * 256))];
export const randomDriftPpm = () => Math.round((Math.random() - 0.5) * 80); // ESP32 crystals: tens of ppm

export abstract class SimulatedTransport extends BaseTransport {
  readonly kind: TransportKind = "simulated";
  protected readonly model: PhysiologyModel;
  protected readonly rig: SimSyncRig;
  protected readonly probesEnabled: boolean;
  protected readonly dsp: EdgeDsp | null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private timeouts = new Set<ReturnType<typeof setTimeout>>();
  protected cleanups: Array<() => void> = [];
  protected running = false;

  constructor(env: SimEnv) {
    super();
    this.model = env.physiology;
    this.rig = env.rig;
    this.probesEnabled = env.probes ?? true;
    this.dsp = env.dsp ?? null;
  }

  isSupported(): boolean {
    return true;
  }

  async open(): Promise<void> {
    this.running = true;
    this.start();
  }

  async close(): Promise<void> {
    this.running = false;
    for (const c of this.cleanups) c();
    this.cleanups = [];
    for (const t of this.timers) clearInterval(t);
    for (const t of this.timeouts) clearTimeout(t);
    this.timers = [];
    this.timeouts.clear();
  }

  groundTruth(): Record<string, number> | null {
    return null;
  }

  protected abstract start(): void;

  protected every(ms: number, fn: () => void): void {
    this.timers.push(setInterval(fn, ms));
  }

  /**
   * Deliver bytes at a modelled arrival time. The chunk is stamped with that time rather than with when the
   * JS timer actually fires, so the transport model is not blurred by timer granularity.
   */
  protected deliverAt(arrivalHostMs: number, bytes: Uint8Array): void {
    const t = setTimeout(() => {
      this.timeouts.delete(t);
      if (this.running) this.emitChunk(bytes, arrivalHostMs);
    }, Math.max(0, arrivalHostMs - hostNowMs()));
    this.timeouts.add(t);
  }
}

/** The original all-in-one demo monitor, now speaking "channel,value" text through the CSV descriptor. */
export class SimulatedMonitorTransport extends SimulatedTransport {
  private lastScalar = 0;
  private lastBp = 0;

  deviceLabel(): string {
    return "Simulated monitor";
  }

  protected start(): void {
    this.every(20, () => {
      const now = hostNowMs();
      const v = this.model.vitalsAtTime(now);
      let text = `ecg,${this.model.ecgMv(now).toFixed(4)}\n`;
      if (now - this.lastScalar >= 1000) {
        this.lastScalar = now;
        text += `heartRate,${Math.round(v.hr)}\nspo2,${v.spo2.toFixed(1)}\n`;
      }
      if (now - this.lastBp >= 3000) {
        this.lastBp = now;
        text += `bp_systolic,${Math.round(v.bpSys)}\nbp_diastolic,${Math.round(v.bpDia)}\n`;
      }
      this.emitChunk(encoder.encode(text), now);
    });
  }
}

/** Common sampling loop: samples at a fixed device rate, batched into SAMPLES frames. */
abstract class SimulatedNodeTransport<S> extends SimulatedTransport {
  protected readonly clock = new SimDeviceClock(randomDriftPpm());
  protected readonly mac = randomMac();
  private seq = 0;
  /** Frames waiting to be "transmitted"; see enqueue(). */
  private pending: Array<{ ready: number; build: (seq: number) => Uint8Array }> = [];
  /** Like firmware, sample instants are counted on the device clock: first + n × period. */
  private nextSampleDeviceUs = 0;
  private batch: S[] = [];
  private batchStartDeviceUs = 0;
  private probeTimer: ReturnType<typeof setTimeout> | undefined;
  // Compute placement, as in firmware/src/common/placement.cpp.
  private mode: number = ComputeMode.RAW;
  private dspUs = 0;
  private txBytes = 0;
  private lastStatsHostMs = 0;

  protected abstract readonly periodUs: number;
  /** Runs this node's on-device DSP on one sample (only in modes other than RAW). */
  protected abstract runDsp(sample: S, deviceUs: number): DspEvent[];
  /** GATED mode: whether the node's own quality check currently wants raw samples sent. */
  protected abstract rawWanted(): boolean;
  protected abstract readonly batchSize: number;
  protected abstract sampleAt(hostMs: number): S;
  protected abstract samplesPayload(batch: S[]): Uint8Array;
  protected abstract helloFrame(seq: number, hostMs: number): Uint8Array;
  protected abstract deliver(bytes: Uint8Array, readyHostMs: number): void;

  groundTruth(): Record<string, number> {
    return { bootHostMs: this.clock.bootHostMs, driftPpm: this.clock.driftPpm, pttMs: this.model.pttMs };
  }

  protected start(): void {
    const now = hostNowMs();
    this.nextSampleDeviceUs = this.clock.deviceUs(now);
    this.enqueue(now, (seq) => this.helloFrame(seq, now));
    this.every(5000, () => {
      const t = hostNowMs();
      this.enqueue(t, (seq) => this.helloFrame(seq, t));
    });
    this.every(10, () => this.tick());
    this.cleanups.push(this.rig.subscribe((edge, t) => this.onSyncEdge(edge, t)));
    this.cleanups.push(() => clearTimeout(this.probeTimer));
    if (this.probesEnabled) this.scheduleProbe();
    this.lastStatsHostMs = now;
    this.every(5000, () => this.sendStats(hostNowMs()));
  }

  /** Accepts CONFIG frames, like the firmware's command path; anything else is ignored. */
  async write(bytes: Uint8Array): Promise<void> {
    const mode = parseConfigFrame(bytes);
    if (mode === null) return;
    this.mode = mode;
    this.sendStats(hostNowMs()); // acknowledge with the new mode
  }

  private sendStats(now: number): void {
    const payload = statsPayload({
      mode: this.mode,
      dspUs: Math.round(this.dspUs),
      txBytes: this.txBytes,
      periodMs: Math.min(65535, Math.round(now - this.lastStatsHostMs)),
    });
    this.dspUs = 0;
    this.txBytes = 0;
    this.lastStatsHostMs = now;
    const deviceUs = this.clock.deviceUs(now);
    this.enqueue(now, (seq) => frame(FrameType.STATS, seq, deviceUs, payload));
  }

  /**
   * Timing probe: an empty frame stamped at the instant it is handed to the transport, sent at random
   * 100–300 ms intervals. Random send times sample every phase of the BLE connection-event grid (sample
   * batches at a fixed cadence only hit a few), so the least-delayed probe approaches the true floor.
   */
  private scheduleProbe(): void {
    this.probeTimer = setTimeout(() => {
      if (!this.running) return;
      const sendHostMs = hostNowMs() + Math.random(); // sub-ms phase: real send instants are not on a ms grid
      const deviceUs = this.clock.deviceUs(sendHostMs);
      this.enqueue(sendHostMs, (seq) => frame(FrameType.TIME_PROBE, seq, deviceUs, new Uint8Array(0)));
      this.scheduleProbe();
    }, 100 + Math.random() * 200);
  }

  /** The sync input ISR stamps the edge a few µs late; the main loop sends the frame within ~5 ms. */
  private onSyncEdge(edge: 0 | 1, trueHostMs: number): void {
    const isrLatencyUs = 2 + Math.random() * 3;
    const deviceUs = Math.round(this.clock.deviceUs(trueHostMs) + isrLatencyUs);
    this.enqueue(trueHostMs + Math.random() * 5, (seq) => frame(FrameType.SYNC_EVENT, seq, deviceUs, syncEventPayload(edge, 4)));
  }

  /**
   * Firmware numbers and transmits frames in the order they become ready. Here, sample batches are only
   * generated on 10 ms ticks, so frames are queued and released in ready order once no earlier frame can
   * still appear; their arrival times come from the ready time, so the hold-back adds no modelled delay.
   */
  private enqueue(ready: number, build: (seq: number) => Uint8Array): void {
    this.pending.push({ ready, build });
  }

  private flushPending(now: number): void {
    const due = this.pending.filter((p) => p.ready <= now - 10).sort((a, b) => a.ready - b.ready);
    if (due.length === 0) return;
    this.pending = this.pending.filter((p) => p.ready > now - 10);
    for (const p of due) {
      const bytes = p.build(this.seq++);
      this.txBytes += bytes.length;
      this.deliver(bytes, p.ready);
    }
  }

  private tick(): void {
    const now = hostNowMs();
    while (this.clock.hostMs(this.nextSampleDeviceUs) <= now) {
      const sampleHostMs = this.clock.hostMs(this.nextSampleDeviceUs);
      if (this.batch.length === 0) this.batchStartDeviceUs = this.nextSampleDeviceUs;
      const sample = this.sampleAt(sampleHostMs);
      this.batch.push(sample);
      if (this.mode !== ComputeMode.RAW && this.dsp) {
        // On-device DSP. Its time here is host CPU time, not ESP32 time: STATS from a simulator says so only by being simulated.
        const t0 = performance.now();
        const events = this.runDsp(sample, this.nextSampleDeviceUs);
        this.dspUs += (performance.now() - t0) * 1000;
        for (const e of events) this.enqueue(sampleHostMs, (seq) => frame(FrameType.DERIVED, seq, e.tUs, derivedPayload(e.kind, e.value)));
      }
      this.nextSampleDeviceUs += this.periodUs;
      if (this.batch.length === this.batchSize) {
        const ts = this.batchStartDeviceUs;
        const payload = this.samplesPayload(this.batch);
        this.batch = [];
        const send = this.mode === ComputeMode.EDGE ? false : this.mode === ComputeMode.GATED ? this.rawWanted() : true;
        if (send) this.enqueue(sampleHostMs, (seq) => frame(FrameType.SAMPLES, seq, ts, payload));
      }
    }
    this.flushPending(now);
  }
}

/**
 * Node A: ECG over USB-serial. Frames queue on a 115200-baud UART (10 bits per byte, one frame at a time),
 * then the USB bridge forwards them within about a millisecond, in arbitrary chunk sizes.
 */
export class SimulatedNodeATransport extends SimulatedNodeTransport<number> {
  protected readonly periodUs = 4000; // 250 Hz
  protected readonly batchSize = 10;
  private readonly baudRate = 115200;
  private uartFreeAt = 0;
  private ecg: EcgDetector | null = null;
  private lastRUs: number | null = null;

  protected runDsp(pinMv: number, deviceUs: number): DspEvent[] {
    this.ecg ??= this.dsp!.ecg(250);
    // Same quantisation and electrode-mV conversion as the firmware.
    const events = this.ecg.push((Math.round(pinMv) - 1650) / 100, deviceUs);
    for (const e of events) if (e.kind === 1) this.lastRUs = e.tUs;
    return events;
  }

  /** No R-peak for 2 s: send raw ECG so someone can see what is wrong. */
  protected rawWanted(): boolean {
    return this.lastRUs === null || ((this.clock.deviceUs(hostNowMs()) >>> 0) - this.lastRUs) >>> 0 > 2_000_000;
  }

  async close(): Promise<void> {
    this.ecg?.free();
    this.ecg = null;
    await super.close();
  }

  deviceLabel(): string {
    return "Simulated Node A";
  }

  protected start(): void {
    // What an ESP32 prints at reset before our firmware runs; the decoder must skip it.
    this.emitChunk(encoder.encode("ets Jun  8 2016 00:22:57\r\nrst:0x1 (POWERON_RESET),boot:0x13\r\n"), hostNowMs());
    super.start();
  }

  protected sampleAt(hostMs: number): number {
    return 1650 + 100 * this.model.ecgMv(hostMs);
  }

  protected samplesPayload(batch: number[]): Uint8Array {
    return nodeASamplesPayload(this.periodUs, batch);
  }

  protected helloFrame(seq: number, hostMs: number): Uint8Array {
    return frame(
      FrameType.HELLO,
      seq,
      this.clock.deviceUs(hostMs),
      helloPayload({ nodeKind: NodeKind.NODE_A_ECG, sampleRateHz: 250, fwMajor: 0, fwMinor: 1, mac: this.mac })
    );
  }

  protected deliver(bytes: Uint8Array, readyHostMs: number): void {
    const start = Math.max(readyHostMs, this.uartFreeAt);
    this.uartFreeAt = start + (bytes.length * 10 * 1000) / this.baudRate;
    const arrival = this.uartFreeAt + 0.2 + Math.random();
    // Split like a USB-serial bridge would; the deframer must reassemble.
    const cut = 1 + Math.floor(Math.random() * (bytes.length - 1));
    this.deliverAt(arrival, bytes.slice(0, cut));
    this.deliverAt(arrival, bytes.slice(cut));
  }
}

type PpgSample = { red: number; ir: number };

/** Node B: red/IR PPG over BLE. Notifications go out only at connection events (every 15 ms). */
export class SimulatedNodeBTransport extends SimulatedNodeTransport<PpgSample> {
  protected readonly periodUs = 10_000; // 100 Hz
  protected readonly batchSize = 5;
  private readonly connectionIntervalMs = 15;
  private readonly connectionAnchor = hostNowMs();
  private ppg: PpgDetector | null = null;
  private lastSqi = -1;

  protected runDsp(s: PpgSample, deviceUs: number): DspEvent[] {
    this.ppg ??= this.dsp!.ppg(100);
    const events = this.ppg.push(Math.round(s.red), Math.round(s.ir), deviceUs);
    for (const e of events) if (e.kind === 6) this.lastSqi = e.value;
    return events;
  }

  /** SQI below 0.8 (or unknown): send raw PPG. */
  protected rawWanted(): boolean {
    return this.lastSqi < 0.8;
  }

  async close(): Promise<void> {
    this.ppg?.free();
    this.ppg = null;
    await super.close();
  }
  /** Host-side latency per connection event: everything delivered at one event arrives together. */
  private eventJitter = new Map<number, number>();

  deviceLabel(): string {
    return "Simulated Node B";
  }

  groundTruth(): Record<string, number> {
    return { ...super.groundTruth(), connectionIntervalMs: this.connectionIntervalMs };
  }

  protected sampleAt(hostMs: number): PpgSample {
    const { spo2 } = this.model.vitalsAtTime(hostMs);
    const pulse = this.model.ppgPulse(hostMs);
    const wander = 1 + 0.01 * Math.sin((2 * Math.PI * hostMs) / 4000); // respiration
    const dcIr = 120_000 * wander;
    const dcRed = 90_000 * wander;
    const perfusion = 0.02;
    // Ratio-of-ratios R = (AC/DC)red / (AC/DC)ir, with the common linear calibration SpO2 ≈ 110 − 25R.
    const r = (110 - spo2) / 25;
    const noise = () => (Math.random() - 0.5) * 60;
    return {
      ir: dcIr * (1 - perfusion * pulse) + noise(),
      red: dcRed * (1 - r * perfusion * pulse) + noise(),
    };
  }

  protected samplesPayload(batch: PpgSample[]): Uint8Array {
    return nodeBSamplesPayload(this.periodUs, batch);
  }

  protected helloFrame(seq: number, hostMs: number): Uint8Array {
    return frame(
      FrameType.HELLO,
      seq,
      this.clock.deviceUs(hostMs),
      helloPayload({ nodeKind: NodeKind.NODE_B_PPG, sampleRateHz: 100, fwMajor: 0, fwMinor: 1, mac: this.mac })
    );
  }

  protected deliver(bytes: Uint8Array, readyHostMs: number): void {
    // Each frame leaves at the first connection event after it is queued. Frames are keyed by their own
    // ready time, so a frame generated late by the JS tick is not wrongly queued behind a later one.
    const ci = this.connectionIntervalMs;
    const event = Math.ceil((readyHostMs - this.connectionAnchor) / ci);
    let jitter = this.eventJitter.get(event);
    if (jitter === undefined) {
      jitter = 0.3 + Math.random() * 0.7;
      this.eventJitter.set(event, jitter);
      if (this.eventJitter.size > 64) this.eventJitter.delete(this.eventJitter.keys().next().value!);
    }
    this.deliverAt(this.connectionAnchor + event * ci + jitter, bytes);
  }
}
