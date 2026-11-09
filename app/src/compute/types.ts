import type { DeviceReading } from "../drivers/types";

export type AlertSeverity = "info" | "warning" | "critical";

export type AlertEvent = {
  id: string;
  timestamp: number;
  severity: AlertSeverity;
  message: string;
  channel: string;
  /** Label of the connection the reading came from, when several devices are connected. */
  source?: string;
};

export type ComputeResult = {
  derivedReadings?: DeviceReading[];
  alerts?: AlertEvent[];
};

export interface ComputeModule {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  appliesToChannel(channel: string): boolean;
  process(reading: DeviceReading): ComputeResult;
  reset(): void;
}
