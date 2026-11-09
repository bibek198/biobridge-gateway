import type { BleTransportSpec } from "../descriptors/types";
import { hostNowMs } from "../time/clock";
import { BaseTransport } from "./types";

export class BleTransport extends BaseTransport {
  readonly kind = "webbluetooth" as const;
  private readonly spec: BleTransportSpec;
  private device: BluetoothDevice | null = null;
  private characteristic: BluetoothRemoteGATTCharacteristic | null = null;
  private closing = false;

  private onValue = (event: Event) => {
    const t = hostNowMs();
    const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
    if (!value) return;
    // Copy: Chrome may reuse the DataView's buffer for the next notification.
    this.emitChunk(new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)), t);
  };

  private onDisconnected = () => {
    if (!this.closing) this.emitClosed("Bluetooth device disconnected.");
  };

  constructor(spec: BleTransportSpec) {
    super();
    this.spec = spec;
  }

  isSupported(): boolean {
    return typeof navigator !== "undefined" && !!navigator.bluetooth;
  }

  async open(): Promise<void> {
    if (!navigator.bluetooth) throw new Error("Web Bluetooth is not supported in this browser.");
    this.closing = false;
    const filter: BluetoothLEScanFilter = { services: [this.spec.service] };
    if (this.spec.namePrefix) filter.namePrefix = this.spec.namePrefix;
    this.device = await navigator.bluetooth.requestDevice({ filters: [filter] });
    this.device.addEventListener("gattserverdisconnected", this.onDisconnected);

    const server = await this.device.gatt?.connect();
    if (!server) throw new Error("Unable to connect to GATT server.");
    const service = await server.getPrimaryService(this.spec.service);
    this.characteristic = await service.getCharacteristic(this.spec.characteristic);
    this.characteristic.addEventListener("characteristicvaluechanged", this.onValue);
    await this.characteristic.startNotifications();
  }

  deviceLabel(): string | null {
    return this.device?.name ?? null;
  }

  async close(): Promise<void> {
    this.closing = true;
    try {
      if (this.characteristic) {
        this.characteristic.removeEventListener("characteristicvaluechanged", this.onValue);
        await this.characteristic.stopNotifications().catch(() => undefined);
      }
      this.device?.removeEventListener("gattserverdisconnected", this.onDisconnected);
      this.device?.gatt?.disconnect();
    } finally {
      this.characteristic = null;
      this.device = null;
    }
  }
}
