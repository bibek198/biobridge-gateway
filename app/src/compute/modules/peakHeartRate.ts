import type { DeviceReading } from "../../drivers/types";
import type { ComputeModule, ComputeResult } from "../types";

const PEAK_THRESHOLD = 0.5;
const REFRACTORY_MS = 250;

export class PeakHeartRateModule implements ComputeModule {
  readonly id = "peak-heart-rate";
  readonly name = "ECG Peak / Heart-Rate Detector";
  readonly description = "Detects R-peaks in the ECG waveform and derives instantaneous heart rate.";

  private aboveThreshold = false;
  private peakValue = -Infinity;
  private peakTimestamp = 0;
  private lastAcceptedPeakTimestamp: number | null = null;

  appliesToChannel(channel: string): boolean {
    return channel === "ecg";
  }

  process(reading: DeviceReading): ComputeResult {
    const { value, timestamp } = reading;

    if (value >= PEAK_THRESHOLD) {
      this.aboveThreshold = true;
      if (value > this.peakValue) {
        this.peakValue = value;
        this.peakTimestamp = timestamp;
      }
      return {};
    }

    if (this.aboveThreshold) {
      this.aboveThreshold = false;
      const candidateTimestamp = this.peakTimestamp;
      this.peakValue = -Infinity;

      const sinceLastPeak = this.lastAcceptedPeakTimestamp === null
        ? Infinity
        : candidateTimestamp - this.lastAcceptedPeakTimestamp;

      if (sinceLastPeak >= REFRACTORY_MS) {
        const bpm = this.lastAcceptedPeakTimestamp === null ? null : 60000 / sinceLastPeak;
        this.lastAcceptedPeakTimestamp = candidateTimestamp;
        if (bpm !== null) {
          return {
            derivedReadings: [
              {
                timestamp: candidateTimestamp,
                channel: "heartRate_computed",
                value: Math.round(bpm),
                unit: "bpm",
              },
            ],
          };
        }
      }
    }

    return {};
  }

  reset(): void {
    this.aboveThreshold = false;
    this.peakValue = -Infinity;
    this.peakTimestamp = 0;
    this.lastAcceptedPeakTimestamp = null;
  }
}
