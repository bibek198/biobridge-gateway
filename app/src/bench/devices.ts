import { DESCRIPTORS } from "../descriptors/library";
import type { Descriptor } from "../descriptors/types";
import { validateDescriptor } from "../descriptors/validate";
import { SimulatedMonitorTransport, SimulatedNodeATransport, SimulatedNodeBTransport, type SimEnv } from "../transports/simulatedTransports";
import type { Transport } from "../transports/types";
import {
  AccelImuTransport,
  AsciiEcgTransport,
  BigEndianEcgTransport,
  BleHrsStrapTransport,
  BpMonitorTransport,
  FixedOximeterTransport,
  FloatPpgTransport,
} from "./simDevices";

// The Paper 2 benchmark: devices an integrator (person or LLM) must write a descriptor for, given only the
// datasheet, a raw capture and the platform's channel vocabulary. groundTruth is never shown to the model;
// it is used only to score the result afterwards.

export type BenchDevice = {
  id: string;
  title: string;
  datasheet: string;
  groundTruth: Descriptor;
  /** Vocabulary channels the integration must expose. */
  requiredChannels: string[];
  createTransport(env: SimEnv): Transport;
};

/** A benchmark device as a synthesis target: the transport is known, the ground truth stays hidden. */
export function benchTarget(d: BenchDevice) {
  return { id: d.id, datasheet: d.datasheet, transport: d.groundTruth.transport, requiredChannels: d.requiredChannels, groundTruth: d.groundTruth };
}

function gt(json: unknown): Descriptor {
  const r = validateDescriptor(json);
  if (!r.ok) throw new Error(`benchmark ground truth invalid:\n${r.errors.join("\n")}`);
  return r.descriptor;
}

const SCHEMA = "biobridge.descriptor/v1";

export const BENCH_DEVICES: BenchDevice[] = [
  {
    id: "biobridge-node-a",
    title: "BioBridge Node A (ECG, USB-serial)",
    requiredChannels: ["ecg"],
    groundTruth: DESCRIPTORS.nodeA,
    createTransport: (env) => new SimulatedNodeATransport(env),
    datasheet: `# BioBridge Node A: single-lead ECG over USB-serial

Link: USB-serial, 115200 baud, 8N1. On reset the ESP32 ROM prints a short ASCII boot log first; ignore it.

## Frame format (all multi-byte fields little-endian)
| Offset | Size | Field |
|---|---|---|
| 0 | 2 | sync: 0xB1 0x0B |
| 2 | 1 | protocol version = 1 |
| 3 | 1 | frame type |
| 4 | 2 | sequence number (u16, +1 per frame of any type) |
| 6 | 4 | device time, µs since boot (u32, wraps) |
| 10 | 1 | payload length N |
| 11 | N | payload |
| 11+N | 2 | CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) over bytes 2 … 10+N, little-endian |

## Frame types
- 0x01 HELLO (every 5 s): protocol u8, node kind u8, sample rate Hz u16, fw major u8, fw minor u8, MAC[6].
- 0x02 SAMPLES (every 40 ms): count u8, sample period µs u16, then count × i16 samples. Each sample is the AD8232 output pin voltage in millivolts. Electrode voltage in mV = (pin_mV − 1650) / 100. Device time is the time of the first sample; it is sent as soon as the batch is complete.
- 0x03 SYNC_EVENT: edge u8, gpio u8 (device time = edge time).
- 0x04 LEADS_OFF: flags u8 (bit0 LO+, bit1 LO−).
- 0x05 TIME_PROBE: empty payload; device time = time of sending.
- 0x06 DERIVED (only when on-device processing is enabled): kind u8 (1 R-peak amplitude in mV, 2 heart rate in bpm), value float32. Device time = event time.
- 0x07 STATS (every 5 s): mode u8, DSP time µs u32, bytes sent u32, period ms u16.
`,
  },
  {
    id: "biobridge-node-b",
    title: "BioBridge Node B (PPG, BLE)",
    requiredChannels: ["ppg_ir", "ppg_red"],
    groundTruth: DESCRIPTORS.nodeB,
    createTransport: (env) => new SimulatedNodeBTransport(env),
    datasheet: `# BioBridge Node B: red/IR PPG over Bluetooth LE

Link: BLE GATT. Service 6b1e0001-b19b-4b1d-9e0a-0b1b2d3c4e5f, characteristic 6b1e0002-b19b-4b1d-9e0a-0b1b2d3c4e5f (notify). Advertised name prefix "BioBridge-B". Exactly one frame per notification.

Frame header, CRC and frame types are identical to BioBridge Node A (sync 0xB1 0x0B, version, type, u16 seq, u32 µs device time, length, payload, CRC-16/CCITT-FALSE little-endian over bytes 2 … end of payload). No LEADS_OFF frames.

## SAMPLES (type 0x02), every 50 ms
count u8, sample period µs u16 (10000 = 100 Hz), then count × { red u24, IR u24 } (little-endian, interleaved). Values are raw MAX30102 18-bit ADC counts. Device time is the first sample's time; frames are sent as soon as the batch completes.

## Other frames
- 0x01 HELLO (every 5 s), 0x03 SYNC_EVENT, 0x05 TIME_PROBE: as on Node A.
- 0x06 DERIVED (only when on-device processing is enabled): kind u8 (3 pulse, 4 pulse rate bpm, 5 SpO2 %, 6 signal quality 0–1), value float32.
- 0x07 STATS (every 5 s): mode u8, DSP time µs u32, bytes sent u32, period ms u16.
`,
  },
  {
    id: "ble-hrs-strap",
    title: "Chest strap, standard BLE Heart Rate Service",
    requiredChannels: ["heartRate"],
    groundTruth: DESCRIPTORS.bleHeartRate,
    createTransport: (env) => new BleHrsStrapTransport(env),
    datasheet: `# Chest strap HR monitor

Implements the Bluetooth SIG Heart Rate Service (0x180D). Notifications on Heart Rate Measurement (0x2A37), about once a second.

Heart Rate Measurement value (Bluetooth SIG): byte 0 = flags. Flags bit 0: heart-rate value format (0 = u8, 1 = u16 little-endian). Bits 1–2: sensor contact status. Bit 3: energy expended present (u16). Bit 4: RR intervals present (u16 each, 1/1024 s). The heart-rate value follows the flags byte. Web Bluetooth names: service "heart_rate", characteristic "heart_rate_measurement".
`,
  },
  {
    id: "csv-monitor",
    title: "Bedside monitor, CSV text over USB-serial",
    requiredChannels: ["ecg", "heartRate", "spo2", "bp_systolic", "bp_diastolic"],
    groundTruth: DESCRIPTORS.genericSerialCsv,
    createTransport: (env) => new SimulatedMonitorTransport(env),
    datasheet: `# Bedside monitor serial output

USB-serial, 115200 baud. ASCII, one reading per line, "<name>,<value>\\n".
Names: ecg (mV, 50 Hz), heartRate (bpm, 1 Hz), spo2 (%, 1 Hz), bp_systolic and bp_diastolic (mmHg, every 3 s). No timestamps.
`,
  },
  {
    id: "ascii-ecg-amp",
    title: "Lab ECG amplifier, ASCII columns",
    requiredChannels: ["ecg", "leadsOff"],
    createTransport: (env) => new AsciiEcgTransport(env),
    groundTruth: gt({
      schema: SCHEMA,
      id: "ascii-ecg-amp",
      name: "Lab ECG amplifier (ASCII)",
      transport: { kind: "serial", baudRate: 115200 },
      framing: { kind: "delimited", delimiter: "\n" },
      text: {
        separator: ",",
        mode: "columns",
        columns: [
          { index: 1, channel: "ecg", scale: 0.001, unit: "mV" },
          { index: 2, channel: "leadsOff" },
        ],
      },
      channels: [
        { id: "ecg", unit: "mV", display: "waveform" },
        { id: "leadsOff", display: "scalar" },
      ],
    }),
    datasheet: `# ECG-200 lab amplifier: serial output

USB-serial (CDC), 115200 baud. Plain ASCII, CR LF line endings. On start it prints one header line:
\`t_ms,ecg_uV,lo\`
then one line per sample at 200 Hz:
- t_ms: amplifier time in milliseconds (integer)
- ecg_uV: ECG lead I in microvolts (signed integer)
- lo: leads-off indicator (0 = electrodes attached, 1/2/3 = LO+/LO−/both off)
`,
  },
  {
    id: "fingertip-oximeter",
    title: "Fingertip pulse oximeter, fixed binary frames",
    requiredChannels: ["pleth", "spo2", "heartRate", "perfusion"],
    createTransport: (env) => new FixedOximeterTransport(env),
    groundTruth: gt({
      schema: SCHEMA,
      id: "fingertip-oximeter",
      name: "Fingertip pulse oximeter",
      transport: { kind: "serial", baudRate: 19200 },
      framing: { kind: "magic-fixed", magic: [0xaa, 0x55], frameLength: 9, checksum: { kind: "xor8", start: 2 } },
      messages: [
        {
          name: "status",
          fields: [
            { kind: "scalar", offset: 3, type: "u8", channel: "pleth" },
            { kind: "scalar", offset: 4, type: "u8", channel: "spo2", unit: "%" },
            { kind: "scalar", offset: 5, type: "u8", channel: "heartRate", unit: "bpm" },
            { kind: "scalar", offset: 6, type: "u8", channel: "perfusion", scale: 0.1, unit: "%" },
          ],
        },
      ],
      channels: [
        { id: "pleth", display: "waveform" },
        { id: "spo2", unit: "%" },
        { id: "heartRate", unit: "bpm" },
        { id: "perfusion", unit: "%" },
      ],
    }),
    datasheet: `# PO-60 fingertip oximeter: USB data cable protocol

USB-UART, 19200 baud 8N1. The device streams fixed-size 9-byte packets at 50 packets/s:

| Byte | Meaning |
|---|---|
| 0 | 0xAA (sync) |
| 1 | 0x55 (sync) |
| 2 | status flags (bit0 finger out, bit1 searching) |
| 3 | plethysmogram sample, 0–100 |
| 4 | SpO2 in %, 0x7F = invalid |
| 5 | pulse rate in bpm, 0xFF = invalid |
| 6 | perfusion index in units of 0.1 % |
| 7 | packet counter (wraps) |
| 8 | checksum: XOR of bytes 2 to 7 |
`,
  },
  {
    id: "be-ecg-board",
    title: "ECG front-end board, big-endian 24-bit frames",
    requiredChannels: ["ecg", "battery"],
    createTransport: (env) => new BigEndianEcgTransport(env),
    groundTruth: gt({
      schema: SCHEMA,
      id: "be-ecg-board",
      name: "ECG front-end board",
      transport: { kind: "serial", baudRate: 230400 },
      framing: {
        kind: "magic-length-crc",
        magic: [0x5a, 0xa5],
        lengthOffset: 2,
        lengthType: "u16be",
        headerLength: 4,
        crc: { kind: "sum8", start: 2 },
        maxFrameLength: 1024,
      },
      messages: [
        {
          name: "samples",
          match: [{ offset: 4, type: "u8", equals: 0x10 }],
          fields: [
            {
              kind: "samples",
              offset: 6,
              type: "i24be",
              stride: 3,
              count: { offset: 5, type: "u8" },
              periodUs: 2000,
              channel: "ecg",
              scale: 0.0005,
              unit: "mV",
            },
          ],
        },
        {
          name: "status",
          match: [{ offset: 4, type: "u8", equals: 0x20 }],
          fields: [{ kind: "scalar", offset: 5, type: "u8", channel: "battery", unit: "%" }],
        },
      ],
      channels: [
        { id: "ecg", unit: "mV", display: "waveform" },
        { id: "battery", unit: "%" },
      ],
    }),
    datasheet: `# ADS-ECG eval board: streaming protocol v2

UART over USB, 230400 baud. Sampling at 500 Hz. All multi-byte integers are BIG-endian.

Packet: \`5A A5 | LEN (2 bytes) | BODY (LEN bytes) | CHK (1 byte)\`
CHK = (sum of the two LEN bytes and all BODY bytes) mod 256.

BODY starts with a message ID:
- 0x10 ECG data: ID, N (1 byte, number of samples, typically 25), then N samples of 3 bytes each (signed 24-bit two's complement). 1 LSB = 0.5 µV. Samples are consecutive at 500 Hz. Packets carry no timestamp.
- 0x20 Status (every 5 s): ID, battery level in % (1 byte).
`,
  },
  {
    id: "bp-monitor",
    title: "Upper-arm blood-pressure monitor",
    requiredChannels: ["bp_systolic", "bp_diastolic", "bp_mean", "heartRate", "cuffPressure"],
    createTransport: (env) => new BpMonitorTransport(env),
    groundTruth: gt({
      schema: SCHEMA,
      id: "bp-monitor",
      name: "Upper-arm BP monitor",
      transport: { kind: "serial", baudRate: 9600 },
      framing: {
        kind: "magic-length-crc",
        magic: [0x42, 0x50],
        lengthOffset: 2,
        lengthType: "u8",
        headerLength: 3,
        crc: { kind: "crc16-modbus", start: 0, endian: "le" },
        maxFrameLength: 64,
      },
      messages: [
        {
          name: "result",
          match: [{ offset: 3, type: "u8", equals: 1 }],
          timestamp: { offset: 4, type: "u32le", unit: "ms", sentAt: "event" },
          fields: [
            { kind: "scalar", offset: 8, type: "u16le", channel: "bp_systolic", scale: 0.1, unit: "mmHg" },
            { kind: "scalar", offset: 10, type: "u16le", channel: "bp_diastolic", scale: 0.1, unit: "mmHg" },
            { kind: "scalar", offset: 12, type: "u16le", channel: "bp_mean", scale: 0.1, unit: "mmHg" },
            { kind: "scalar", offset: 14, type: "u8", channel: "heartRate", unit: "bpm" },
          ],
        },
        {
          name: "status",
          match: [{ offset: 3, type: "u8", equals: 2 }],
          timestamp: { offset: 4, type: "u32le", unit: "ms", sentAt: "event" },
          fields: [{ kind: "scalar", offset: 8, type: "u16le", channel: "cuffPressure", scale: 0.1, unit: "mmHg" }],
        },
      ],
      channels: [
        { id: "bp_systolic", unit: "mmHg" },
        { id: "bp_diastolic", unit: "mmHg" },
        { id: "bp_mean", unit: "mmHg" },
        { id: "heartRate", unit: "bpm" },
        { id: "cuffPressure", unit: "mmHg" },
      ],
    }),
    datasheet: `# BPM-3 blood-pressure monitor: PC link

RS-232 via USB adapter, 9600 baud 8N1. Little-endian integers.

Frame: \`'B' 'P' (0x42 0x50) | LEN (1 byte) | PAYLOAD (LEN bytes) | CRC (2 bytes)\`
CRC is CRC-16/MODBUS (poly 0xA001 reflected, init 0xFFFF) over every byte from the first 'B' through the end of PAYLOAD, sent low byte first.

PAYLOAD byte 0 = message type; bytes 1–4 = device uptime in milliseconds (u32).
- Type 0x01 measurement result (after each measurement): systolic u16, diastolic u16, mean arterial pressure u16 (all in 0.1 mmHg), pulse rate u8 (bpm).
- Type 0x02 status (1 Hz): cuff pressure u16 in 0.1 mmHg.
`,
  },
  {
    id: "wrist-imu",
    title: "Wrist IMU, BLE accelerometer",
    requiredChannels: ["accel_x", "accel_y", "accel_z"],
    createTransport: (env) => new AccelImuTransport(env),
    groundTruth: gt({
      schema: SCHEMA,
      id: "wrist-imu",
      name: "Wrist IMU",
      transport: {
        kind: "ble",
        service: "0000fe40-cc7a-482a-984a-7f2ed5b3e58f",
        characteristic: "0000fe41-8e22-4541-9d4c-21edae82ed19",
      },
      framing: {
        kind: "magic-length-crc",
        magic: [0xc3],
        lengthOffset: 1,
        lengthType: "u8",
        headerLength: 2,
        crc: { kind: "crc16-ccitt-false", start: 1, endian: "be" },
        maxFrameLength: 128,
      },
      messages: [
        {
          name: "accel",
          timestamp: { offset: 2, type: "u32le", unit: "ms", sentAt: "send" },
          fields: [
            { kind: "samples", offset: 7, type: "i16le", stride: 6, count: { offset: 6, type: "u8" }, periodUs: 20000, channel: "accel_x", scale: 0.001, unit: "g" },
            { kind: "samples", offset: 9, type: "i16le", stride: 6, count: { offset: 6, type: "u8" }, periodUs: 20000, channel: "accel_y", scale: 0.001, unit: "g" },
            { kind: "samples", offset: 11, type: "i16le", stride: 6, count: { offset: 6, type: "u8" }, periodUs: 20000, channel: "accel_z", scale: 0.001, unit: "g" },
          ],
        },
      ],
      channels: [
        { id: "accel_x", unit: "g", display: "waveform" },
        { id: "accel_y", unit: "g", display: "waveform" },
        { id: "accel_z", unit: "g", display: "waveform" },
      ],
    }),
    datasheet: `# MotionTag wrist sensor: data notifications

BLE service 0000fe40-cc7a-482a-984a-7f2ed5b3e58f, characteristic 0000fe41-8e22-4541-9d4c-21edae82ed19 (notify). One packet per notification, 10 packets/s.

Packet: \`0xC3 | LEN (u8, bytes of payload) | PAYLOAD | CRC16 (big-endian)\`
CRC: CRC-16/CCITT-FALSE (0x1021, init 0xFFFF) over LEN and PAYLOAD.

PAYLOAD (little-endian): timestamp of the first sample in ms (u32), N (u8, samples in this packet), then N × { x i16, y i16, z i16 } in milli-g. Accelerometer runs at 50 Hz; a packet is sent as soon as N samples are collected.
`,
  },
  {
    id: "float-ppg",
    title: "USB PPG module, float32 samples",
    requiredChannels: ["ppg_ir"],
    createTransport: (env) => new FloatPpgTransport(env),
    groundTruth: gt({
      schema: SCHEMA,
      id: "float-ppg",
      name: "USB PPG module",
      transport: { kind: "serial", baudRate: 230400 },
      framing: {
        kind: "magic-length-crc",
        magic: [0xa0, 0x0a],
        lengthOffset: 2,
        lengthType: "u16le",
        headerLength: 4,
        crc: { kind: "crc16-ccitt-false", start: 2, endian: "le" },
        maxFrameLength: 1024,
      },
      messages: [
        {
          name: "samples",
          timestamp: { offset: 4, type: "u32le", unit: "us", sentAt: "send" },
          fields: [
            { kind: "samples", offset: 9, type: "f32le", stride: 4, count: { offset: 8, type: "u8" }, periodUs: 10000, channel: "ppg_ir" },
          ],
        },
      ],
      channels: [{ id: "ppg_ir", display: "waveform" }],
    }),
    datasheet: `# OptoPulse USB module: binary stream

USB CDC serial, 230400 baud. Infrared PPG at 100 Hz, 10 samples per packet.

Packet: \`A0 0A | LEN (u16 LE) | BODY (LEN bytes) | CRC (u16 LE)\`
CRC = CRC-16/CCITT-FALSE over LEN and BODY.

BODY: timestamp of the first sample in µs since power-on (u32 LE), sample count (u8), then that many IEEE-754 float32 (LE) samples: normalised IR intensity (around 1.0; it falls as blood volume rises). A packet is sent as soon as its last sample is taken.
`,
  },
];
