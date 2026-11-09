import { DspEventKind, type DspEvent, type EcgDetector, type EdgeDsp, type PpgDetector } from "../../dsp/edgeDsp";
import type { DeviceReading } from "../../drivers/types";
import type { ComputeModule, ComputeResult } from "../types";

// Browser-side placement of the firmware's DSP (WebAssembly build of firmware/lib/bbdsp). These modules
// produce *_wasm channels; a node in EDGE/BOTH mode produces the matching *_edge channels from the same C
// code running on the ESP32, which is what the Compute Placement tab compares.

/** Sample rate from the median spacing of the first readings (device timestamps if present). */
class RateEstimator {
  private times: number[] = [];

  /** Returns the rate once known (after 9 samples), else null. */
  push(r: DeviceReading): number | null {
    if (this.times.length < 9) this.times.push(r.deviceTimestampUs ?? r.timestamp * 1000);
    if (this.times.length < 9) return null;
    const dts = this.times.slice(1).map((t, i) => t - this.times[i]).sort((a, b) => a - b);
    const dt = dts[dts.length >> 1];
    return dt > 0 ? Math.round(1e6 / dt) : null;
  }
}

const deviceUs = (r: DeviceReading) => Math.round(r.deviceTimestampUs ?? r.timestamp * 1000);

/** Event time back on the host timeline, relative to the reading that triggered it. */
const eventTimestamp = (r: DeviceReading, e: DspEvent) => r.timestamp - (((deviceUs(r) >>> 0) - e.tUs) | 0) / 1000;

abstract class WasmModule implements ComputeModule {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly description: string;
  protected readonly getDsp: () => EdgeDsp | null;

  constructor(getDsp: () => EdgeDsp | null) {
    this.getDsp = getDsp;
  }

  abstract appliesToChannel(channel: string): boolean;
  abstract process(reading: DeviceReading): ComputeResult;
  abstract reset(): void;
  /** Wall time spent in Wasm by this module so far, ms. */
  abstract cpuMs(): number;
}

export class WasmEcgModule extends WasmModule {
  readonly id = "wasm-ecg";
  readonly name = "ECG R-peaks / heart rate (firmware DSP, Wasm)";
  readonly description = "Pan-Tompkins R-peak detection from the node firmware, compiled to WebAssembly. Emits heartRate_wasm.";
  private rate = new RateEstimator();
  private det: EcgDetector | null = null;
  private spent = 0;

  appliesToChannel(channel: string): boolean {
    return channel === "ecg";
  }

  process(r: DeviceReading): ComputeResult {
    if (!this.det) {
      const dsp = this.getDsp();
      const fs = this.rate.push(r);
      if (!dsp || fs === null) return {};
      this.det = dsp.ecg(fs);
    }
    const events = this.det.push(r.value, deviceUs(r));
    const out: DeviceReading[] = [];
    for (const e of events) {
      if (e.kind === DspEventKind.HEART_RATE) out.push({ timestamp: eventTimestamp(r, e), channel: "heartRate_wasm", value: Math.round(e.value * 10) / 10, unit: "bpm" });
    }
    return out.length ? { derivedReadings: out } : {};
  }

  cpuMs(): number {
    return this.spent + (this.det?.cpuMs ?? 0);
  }

  reset(): void {
    this.spent += this.det?.cpuMs ?? 0;
    this.det?.free();
    this.det = null;
    this.rate = new RateEstimator();
  }
}

export class WasmPpgModule extends WasmModule {
  readonly id = "wasm-ppg";
  readonly name = "PPG pulse rate / SpO2 / quality (firmware DSP, Wasm)";
  readonly description =
    "Pulse detection, ratio-of-ratios SpO2 and beat-shape signal quality from the node firmware, compiled to WebAssembly. Emits pulseRate_wasm, spo2_wasm, sqi_wasm.";
  private rate = new RateEstimator();
  private det: PpgDetector | null = null;
  private pendingRed: { tUs: number; value: number } | null = null;
  private spent = 0;

  appliesToChannel(channel: string): boolean {
    return channel === "ppg_red" || channel === "ppg_ir";
  }

  process(r: DeviceReading): ComputeResult {
    // Red and IR of one sample arrive as two readings with the same device time: pair them.
    if (r.channel === "ppg_red") {
      this.pendingRed = { tUs: deviceUs(r), value: r.value };
      return {};
    }
    const red = this.pendingRed;
    this.pendingRed = null;
    if (!red || red.tUs !== deviceUs(r)) return {};
    if (!this.det) {
      const dsp = this.getDsp();
      const fs = this.rate.push(r);
      if (!dsp || fs === null) return {};
      this.det = dsp.ppg(fs);
    }
    const out: DeviceReading[] = [];
    for (const e of this.det.push(red.value, r.value, deviceUs(r))) {
      const t = eventTimestamp(r, e);
      if (e.kind === DspEventKind.PULSE_RATE) out.push({ timestamp: t, channel: "pulseRate_wasm", value: Math.round(e.value * 10) / 10, unit: "bpm" });
      if (e.kind === DspEventKind.SPO2) out.push({ timestamp: t, channel: "spo2_wasm", value: Math.round(e.value * 10) / 10, unit: "%" });
      if (e.kind === DspEventKind.SQI) out.push({ timestamp: t, channel: "sqi_wasm", value: Math.round(e.value * 100) / 100 });
    }
    return out.length ? { derivedReadings: out } : {};
  }

  cpuMs(): number {
    return this.spent + (this.det?.cpuMs ?? 0);
  }

  reset(): void {
    this.spent += this.det?.cpuMs ?? 0;
    this.det?.free();
    this.det = null;
    this.pendingRed = null;
    this.rate = new RateEstimator();
  }
}
