import type { DeviceReading } from "../../drivers/types";
import type { ComputeModule, ComputeResult } from "../types";

export class MovingAverageModule implements ComputeModule {
  readonly id = "moving-average";
  readonly name = "Moving Average Filter";
  readonly description = "Smooths a noisy channel with a rolling average.";

  private window: number[] = [];
  private readonly channel: string;
  private readonly windowSize: number;

  constructor(channel: string, windowSize = 10) {
    this.channel = channel;
    this.windowSize = windowSize;
  }

  appliesToChannel(channel: string): boolean {
    return channel === this.channel;
  }

  process(reading: DeviceReading): ComputeResult {
    this.window.push(reading.value);
    if (this.window.length > this.windowSize) this.window.shift();
    const average = this.window.reduce((sum, v) => sum + v, 0) / this.window.length;
    return {
      derivedReadings: [
        {
          timestamp: reading.timestamp,
          channel: `${reading.channel}_filtered`,
          value: Math.round(average * 100) / 100,
          unit: reading.unit,
        },
      ],
    };
  }

  reset(): void {
    this.window = [];
  }
}
