// Declarative device descriptor, schema "biobridge.descriptor/v1".
//
// A descriptor says what a device's bytes *mean*; a Transport says how they *arrive*.
// Descriptors are plain JSON so they can be written by hand, diffed, recorded alongside data,
// and (Paper 2) proposed by an LLM and checked by validateDescriptor() before use.

export const DESCRIPTOR_SCHEMA = "biobridge.descriptor/v1";

export type NumType =
  | "u8"
  | "i8"
  | "u16le"
  | "u16be"
  | "i16le"
  | "i16be"
  | "u24le"
  | "u24be"
  | "i24le"
  | "i24be"
  | "u32le"
  | "u32be"
  | "i32le"
  | "i32be"
  | "f32le"
  | "f32be";

export type SerialTransportSpec = { kind: "serial"; baudRate: number };

export type BleTransportSpec = {
  kind: "ble";
  /** 128-bit UUID string or a Web Bluetooth alias such as "heart_rate". */
  service: string;
  characteristic: string;
  namePrefix?: string;
};

export type TransportSpec = SerialTransportSpec | BleTransportSpec;

/** Text lines separated by a delimiter (e.g. "ecg,0.42\n"). */
export type DelimitedFraming = { kind: "delimited"; delimiter: string };

/** Integrity check over part of a frame. `endian` is required for 16-bit checksums. */
export type ChecksumSpec = {
  kind: "crc16-ccitt-false" | "crc16-modbus" | "sum8" | "xor8";
  /** First byte (frame offset) covered; coverage ends right before the checksum itself. */
  start: number;
  endian?: "le" | "be";
};

/** Binary stream: magic bytes, a length field, a checksum. Resynchronises after garbage or corruption. */
export type MagicLengthCrcFraming = {
  kind: "magic-length-crc";
  magic: number[];
  lengthOffset: number;
  lengthType: "u8" | "u16le" | "u16be";
  /** Bytes before the payload, including the magic. Total frame = headerLength + length + checksum width. */
  headerLength: number;
  crc: ChecksumSpec;
  maxFrameLength: number;
};

/** Binary stream of fixed-size frames that start with magic bytes; an optional checksum ends each frame. */
export type MagicFixedFraming = {
  kind: "magic-fixed";
  magic: number[];
  frameLength: number;
  checksum?: ChecksumSpec;
};

/** Every transport chunk is one message (typical for BLE notifications). */
export type PerChunkFraming = { kind: "per-chunk" };

export type FramingSpec = DelimitedFraming | MagicLengthCrcFraming | MagicFixedFraming | PerChunkFraming;

/** True when (value(offset, type) & mask) === equals. Offsets are from the start of the frame. */
export type Condition = { offset: number; type: NumType; mask?: number; equals: number };

export type FieldRef = { offset: number; type: NumType };

export type ScalarField = {
  kind: "scalar";
  offset: number;
  type: NumType;
  /** Output channel; for info messages, the info key. */
  channel: string;
  scale?: number;
  bias?: number;
  unit?: string;
  when?: Condition[];
};

/** A run of evenly spaced samples, e.g. 10 ECG samples in one frame. */
export type SamplesField = {
  kind: "samples";
  offset: number;
  type: NumType;
  /** Bytes between consecutive samples of this channel (lets channels interleave). */
  stride: number;
  count: number | FieldRef;
  periodUs: number | FieldRef;
  channel: string;
  scale?: number;
  bias?: number;
  unit?: string;
};

/** Raw bytes rendered as lowercase hex, for info messages (e.g. a MAC address). */
export type HexField = { kind: "hex"; offset: number; length: number; channel: string };

export type FieldSpec = ScalarField | SamplesField | HexField;

export type MessageSpec = {
  name: string;
  match?: Condition[];
  /**
   * Device timestamp of the message (first sample for SamplesField). Integer types wrap and are unwrapped.
   * sentAt: "send" means the device transmits the message the moment its newest timestamp is reached
   * (sample batches, timing probes), so arrival − timestamp is pure transport delay; clock sync relies
   * on this. "event" (default) means the message may wait first (e.g. sync edges queued for a main loop).
   */
  timestamp?: FieldRef & { unit: "us" | "ms"; sentAt?: "send" | "event" };
  seq?: FieldRef;
  /** Info messages update device info instead of emitting readings. */
  info?: boolean;
  fields: FieldSpec[];
};

export type TextColumn = { index: number; channel: string; scale?: number; bias?: number; unit?: string };

export type TextFormat =
  | { separator: string; mode: "channel-value" }
  | { separator: string; mode: "columns"; columns: TextColumn[] };

export type ChannelSpec = {
  id: string;
  label?: string;
  unit?: string;
  display?: "waveform" | "scalar" | "hidden";
};

export type PlausibilitySpec = { min?: number; max?: number; maxRatePerSec?: number };

export type Descriptor = {
  schema: typeof DESCRIPTOR_SCHEMA;
  id: string;
  name: string;
  description?: string;
  transport: TransportSpec;
  framing: FramingSpec;
  /** Binary devices. */
  messages?: MessageSpec[];
  /** Text devices (delimited framing). */
  text?: TextFormat;
  channels: ChannelSpec[];
  /** Physical-plausibility bounds per channel. Not enforced yet; consumed by the Paper 2 verifier. */
  plausibility?: Record<string, PlausibilitySpec>;
};
