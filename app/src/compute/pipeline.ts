import type { DeviceReading } from "../drivers/types";
import type { AlertEvent, ComputeModule } from "./types";

export type PipelineModuleEntry = {
  module: ComputeModule;
  enabled: boolean;
};

export class ComputePipeline {
  private entries: PipelineModuleEntry[] = [];

  register(module: ComputeModule, enabled = true): void {
    this.entries.push({ module, enabled });
  }

  getEntries(): PipelineModuleEntry[] {
    return this.entries;
  }

  setEnabled(moduleId: string, enabled: boolean): void {
    const entry = this.entries.find((e) => e.module.id === moduleId);
    if (entry) entry.enabled = enabled;
  }

  process(reading: DeviceReading): { derivedReadings: DeviceReading[]; alerts: AlertEvent[] } {
    const derivedReadings: DeviceReading[] = [];
    const alerts: AlertEvent[] = [];

    for (const entry of this.entries) {
      if (!entry.enabled) continue;
      if (!entry.module.appliesToChannel(reading.channel)) continue;
      const result = entry.module.process(reading);
      if (result.derivedReadings) derivedReadings.push(...result.derivedReadings);
      if (result.alerts) alerts.push(...result.alerts);
    }

    return { derivedReadings, alerts };
  }

  reset(): void {
    for (const entry of this.entries) entry.module.reset();
  }
}
