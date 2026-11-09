import { DESCRIPTORS } from "../descriptors/library";
import type { Descriptor } from "../descriptors/types";
import { BleTransport } from "../transports/bleTransport";
import { SerialTransport } from "../transports/serialTransport";
import {
  SimulatedMonitorTransport,
  SimulatedNodeATransport,
  SimulatedNodeBTransport,
  type SimEnv,
} from "../transports/simulatedTransports";
import type { Transport } from "../transports/types";

export type DeviceGroup = "simulated" | "hardware";

export type DeviceFactory = {
  id: string;
  label: string;
  description: string;
  group: DeviceGroup;
  descriptor: Descriptor;
  isSupported: () => boolean;
  createTransport: (env: SimEnv) => Transport;
};

/** The transport a real device of this descriptor uses. */
export function hardwareTransport(d: Descriptor): Transport {
  return d.transport.kind === "serial" ? new SerialTransport(d.transport.baudRate) : new BleTransport(d.transport);
}

const hasSerial = () => typeof navigator !== "undefined" && !!navigator.serial;
const hasBluetooth = () => typeof navigator !== "undefined" && !!navigator.bluetooth;

function hardware(id: string, label: string, description: string, descriptor: Descriptor): DeviceFactory {
  return {
    id,
    label,
    description,
    group: "hardware",
    descriptor,
    isSupported: descriptor.transport.kind === "serial" ? hasSerial : hasBluetooth,
    createTransport: () => hardwareTransport(descriptor),
  };
}

export const DEVICE_FACTORIES: DeviceFactory[] = [
  {
    id: "sim-node-a",
    label: "Simulated Node A (ECG)",
    description: "Byte-exact simulation of Node A firmware: 250 Hz ECG frames over a jittery, chunked serial link.",
    group: "simulated",
    descriptor: DESCRIPTORS.nodeA,
    isSupported: () => true,
    createTransport: (env) => new SimulatedNodeATransport(env),
  },
  {
    id: "sim-node-b",
    label: "Simulated Node B (PPG)",
    description: "Byte-exact simulation of Node B firmware: 100 Hz red/IR PPG over BLE notifications (15 ms connection interval).",
    group: "simulated",
    descriptor: DESCRIPTORS.nodeB,
    isSupported: () => true,
    createTransport: (env) => new SimulatedNodeBTransport(env),
  },
  {
    id: "sim-monitor",
    label: "Simulated Monitor (CSV)",
    description: "ECG / SpO2 / heart-rate / blood-pressure as \"channel,value\" text, through the generic CSV descriptor.",
    group: "simulated",
    descriptor: DESCRIPTORS.genericSerialCsv,
    isSupported: () => true,
    createTransport: (env) => new SimulatedMonitorTransport(env),
  },
  hardware(
    "node-a",
    "BioBridge Node A (USB)",
    "ESP32 + AD8232 ECG running firmware/ node_a or node_a_sim, over USB-serial.",
    DESCRIPTORS.nodeA
  ),
  hardware(
    "node-b",
    "BioBridge Node B (BLE)",
    "ESP32 + MAX30102 PPG running firmware/ node_b or node_b_sim, advertising as BioBridge-B.",
    DESCRIPTORS.nodeB
  ),
  hardware(
    "sync-node",
    "BioBridge Sync Node (USB)",
    "ESP32 running firmware/ node_sync: drives the shared sync pulse for the clock-sync rig and reports its own edges.",
    DESCRIPTORS.syncNode
  ),
  hardware(
    "ble-heart-rate",
    "BLE Heart Rate Monitor",
    "Any device advertising the standard Bluetooth Heart Rate Service (0x180D), e.g. a chest strap.",
    DESCRIPTORS.bleHeartRate
  ),
  hardware(
    "generic-serial-csv",
    "Generic Serial Sensor (CSV)",
    "Any USB-serial device sending line-delimited \"channel,value\" readings at 115200 baud.",
    DESCRIPTORS.genericSerialCsv
  ),
];
