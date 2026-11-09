import type { DeviceReading } from "../../drivers/types";
import type { AlertSeverity, ComputeModule, ComputeResult } from "../types";

export type ChannelThresholds = {
  warningMin?: number;
  warningMax?: number;
  criticalMin?: number;
  criticalMax?: number;
};

export const DEFAULT_THRESHOLDS: Record<string, ChannelThresholds> = {
  spo2: { warningMin: 92, criticalMin: 88 },
  heartRate_computed: { warningMin: 50, warningMax: 120, criticalMin: 40, criticalMax: 150 },
  bp_systolic: { warningMax: 140, criticalMax: 160 },
};

function classify(value: number, t: ChannelThresholds): AlertSeverity {
  if ((t.criticalMin !== undefined && value < t.criticalMin) || (t.criticalMax !== undefined && value > t.criticalMax)) {
    return "critical";
  }
  if ((t.warningMin !== undefined && value < t.warningMin) || (t.warningMax !== undefined && value > t.warningMax)) {
    return "warning";
  }
  return "info";
}

let alertCounter = 0;

export class ThresholdAlertModule implements ComputeModule {
  readonly id = "threshold-alert";
  readonly name = "Threshold Alerting";
  readonly description = "Flags channel readings that cross configurable warning/critical thresholds.";

  private thresholds: Record<string, ChannelThresholds>;
  private lastSeverity = new Map<string, AlertSeverity>();

  /** Pass a shared record to keep several instances (one per connection) on the same thresholds. */
  constructor(thresholds: Record<string, ChannelThresholds> = { ...DEFAULT_THRESHOLDS }) {
    this.thresholds = thresholds;
  }

  getThresholds(): Record<string, ChannelThresholds> {
    return this.thresholds;
  }

  setThreshold(channel: string, key: keyof ChannelThresholds, value: number | undefined): void {
    this.thresholds[channel] = { ...this.thresholds[channel], [key]: value };
  }

  appliesToChannel(channel: string): boolean {
    return channel in this.thresholds;
  }

  process(reading: DeviceReading): ComputeResult {
    const t = this.thresholds[reading.channel];
    if (!t) return {};

    const severity = classify(reading.value, t);
    const previous = this.lastSeverity.get(reading.channel);
    this.lastSeverity.set(reading.channel, severity);

    if (severity === previous) return {};

    if (severity === "info") {
      if (previous === undefined) return {};
      return {
        alerts: [
          {
            id: `${reading.channel}-${reading.timestamp}-${alertCounter++}`,
            timestamp: reading.timestamp,
            severity: "info",
            channel: reading.channel,
            message: `${reading.channel} back to normal range (${reading.value}${reading.unit ?? ""})`,
          },
        ],
      };
    }

    return {
      alerts: [
        {
          id: `${reading.channel}-${reading.timestamp}-${alertCounter++}`,
          timestamp: reading.timestamp,
          severity,
          channel: reading.channel,
          message: `${reading.channel} ${severity === "critical" ? "CRITICAL" : "warning"}: ${reading.value}${reading.unit ?? ""}`,
        },
      ],
    };
  }

  reset(): void {
    this.lastSeverity.clear();
  }
}
