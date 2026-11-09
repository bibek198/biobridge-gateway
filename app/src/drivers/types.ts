export type DeviceReading = {
  /** Host-timeline epoch ms. Device-timestamped samples are mapped through the driver's ClockMapper. */
  timestamp: number;
  channel: string;
  value: number;
  unit?: string;
  /** Host arrival time of the chunk that carried this reading (epoch ms, sub-ms precision). */
  hostTimestamp?: number;
  /** Device clock, unwrapped µs, when the device timestamps its data. */
  deviceTimestampUs?: number;
  seq?: number;
};

export type DeviceStatus = "disconnected" | "connecting" | "connected" | "error";

export type DriverKind = "webserial" | "webbluetooth" | "simulated" | "replay" | "webusb";

export interface DeviceMetadata {
  id: string;
  name: string;
  driverType: DriverKind;
  channels: string[];
}

export interface DeviceDriver {
  readonly metadata: DeviceMetadata;
  isSupported(): boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): DeviceStatus;
  getLastError(): string | null;
  onData(callback: (reading: DeviceReading) => void): () => void;
  onStatusChange(callback: (status: DeviceStatus) => void): () => void;
}

export abstract class BaseDriver implements DeviceDriver {
  abstract readonly metadata: DeviceMetadata;
  protected status: DeviceStatus = "disconnected";
  protected lastError: string | null = null;
  private dataListeners = new Set<(reading: DeviceReading) => void>();
  private statusListeners = new Set<(status: DeviceStatus) => void>();

  abstract isSupported(): boolean;
  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;

  getStatus(): DeviceStatus {
    return this.status;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  onData(callback: (reading: DeviceReading) => void): () => void {
    this.dataListeners.add(callback);
    return () => this.dataListeners.delete(callback);
  }

  onStatusChange(callback: (status: DeviceStatus) => void): () => void {
    this.statusListeners.add(callback);
    return () => this.statusListeners.delete(callback);
  }

  protected emitReading(reading: DeviceReading): void {
    for (const listener of this.dataListeners) listener(reading);
  }

  protected setStatus(status: DeviceStatus, error: string | null = null): void {
    this.status = status;
    this.lastError = error;
    for (const listener of this.statusListeners) listener(status);
  }
}
