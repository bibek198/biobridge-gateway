import type { DeviceReading } from "../../drivers/types";
import { PpgUpstrokeDetector } from "../../signal/landmarks";
import type { ComputeModule, ComputeResult } from "../types";

/** Pulse rate from the PPG waveform: median of recent beat-to-beat intervals between upstroke landmarks. */
export class PpgPulseRateModule implements ComputeModule {
  readonly id = "ppg-pulse-rate";
  readonly name = "PPG Pulse-Rate Detector";
  readonly description = "Finds each pulse's maximum-upstroke point in the IR PPG and derives pulse rate.";

  private detector = new PpgUpstrokeDetector();
  private beats: number[] = [];
  private readonly channel: string;

  constructor(channel = "ppg_ir") {
    this.channel = channel;
  }

  appliesToChannel(channel: string): boolean {
    return channel === this.channel;
  }

  process(reading: DeviceReading): ComputeResult {
    const beat = this.detector.push(reading.timestamp, reading.value);
    if (beat === null) return {};
    this.beats.push(beat);
    if (this.beats.length > 6) this.beats.shift();
    if (this.beats.length < 3) return {};
    const intervals = this.beats.slice(1).map((t, i) => t - this.beats[i]).sort((a, b) => a - b);
    const median = intervals[intervals.length >> 1];
    if (median < 250 || median > 2500) return {}; // outside 24-240 bpm: a detection glitch, not a pulse
    return {
      derivedReadings: [{ timestamp: beat, channel: "pulseRate_ppg", value: Math.round(60000 / median), unit: "bpm" }],
    };
  }

  reset(): void {
    this.detector = new PpgUpstrokeDetector();
    this.beats = [];
  }
}
