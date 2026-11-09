// Payload layouts of the BioBridge reference nodes (see protocol/FRAME.md).
// The app never decodes these by hand: the descriptors in src/descriptors/*.json do.
// These builders exist so the simulator and the test-vector generator emit exactly what firmware emits.

import { crc16CcittFalse, encodeFrame, FrameType, PayloadWriter } from "./frame.ts";

export const NodeKind = {
  NODE_A_ECG: 1,
  NODE_B_PPG: 2,
  SYNC: 3,
} as const;

export const PROTOCOL_VERSION = 1;

export type HelloFields = {
  nodeKind: number;
  sampleRateHz: number;
  fwMajor: number;
  fwMinor: number;
  mac: number[]; // 6 bytes
};

export function helloPayload(h: HelloFields): Uint8Array {
  return new PayloadWriter()
    .u8(PROTOCOL_VERSION)
    .u8(h.nodeKind)
    .u16(h.sampleRateHz)
    .u8(h.fwMajor)
    .u8(h.fwMinor)
    .raw(h.mac)
    .build();
}

/** Node A: count u8 | period_us u16le | adc_mv i16le[count] (AD8232 output pin, millivolts). */
export function nodeASamplesPayload(periodUs: number, adcMv: number[]): Uint8Array {
  const w = new PayloadWriter().u8(adcMv.length).u16(periodUs);
  for (const mv of adcMv) w.i16(Math.round(mv));
  return w.build();
}

/** Node B: count u8 | period_us u16le | (red u24le, ir u24le)[count] (MAX30102 18-bit counts). */
export function nodeBSamplesPayload(periodUs: number, samples: { red: number; ir: number }[]): Uint8Array {
  const w = new PayloadWriter().u8(samples.length).u16(periodUs);
  for (const s of samples) w.u24(Math.round(s.red)).u24(Math.round(s.ir));
  return w.build();
}

/** LEADS_OFF: state u8, bit0 = LO+, bit1 = LO-. */
export function leadsOffPayload(state: number): Uint8Array {
  return Uint8Array.of(state & 0x03);
}

/** SYNC_EVENT: edge u8 (1 rising, 0 falling) | gpio u8. The frame's device_ts_us is the edge time. */
export function syncEventPayload(edge: number, gpio: number): Uint8Array {
  return Uint8Array.of(edge & 1, gpio & 0xff);
}

/** Where a node computes: see protocol/FRAME.md "Compute placement". */
export const ComputeMode = {
  RAW: 0, // stream samples; compute in the browser
  EDGE: 1, // compute on the device; send only DERIVED results
  GATED: 2, // DERIVED always; samples only while signal quality is low
  BOTH: 3, // samples and DERIVED (for comparing device and browser on the same data)
} as const;

/** DERIVED: kind u8 (bbdsp event kind) | value f32le. The frame's device_ts_us is the event time. */
export function derivedPayload(kind: number, value: number): Uint8Array {
  return new PayloadWriter().u8(kind).f32(value).build();
}

/** STATS: mode u8 | dsp_us u32le (CPU time in DSP) | tx_bytes u32le | period_ms u16le, all over the period. */
export function statsPayload(s: { mode: number; dspUs: number; txBytes: number; periodMs: number }): Uint8Array {
  return new PayloadWriter().u8(s.mode).u32(s.dspUs).u32(s.txBytes).u16(s.periodMs).build();
}

/** CONFIG (host → device): mode u8. */
export function configFrame(mode: number): Uint8Array {
  return encodeFrame({ type: FrameType.CONFIG, seq: 0, deviceTsUs: 0, payload: Uint8Array.of(mode) });
}

/** The mode in a CONFIG frame (as the firmware's bb_decoder would accept it), or null. */
export function parseConfigFrame(bytes: Uint8Array): number | null {
  for (let i = 0; i + 13 <= bytes.length; i++) {
    if (bytes[i] !== 0xb1 || bytes[i + 1] !== 0x0b || bytes[i + 2] !== 1) continue;
    const len = bytes[i + 10];
    const end = i + 11 + len;
    if (end + 2 > bytes.length) return null;
    const crc = bytes[end] | (bytes[end + 1] << 8);
    if (crc16CcittFalse(bytes, i + 2, end) !== crc) continue;
    return bytes[i + 3] === FrameType.CONFIG && len >= 1 && bytes[i + 11] <= ComputeMode.BOTH ? bytes[i + 11] : null;
  }
  return null;
}

export function frame(type: number, seq: number, deviceTsUs: number, payload: Uint8Array): Uint8Array {
  return encodeFrame({ type, seq, deviceTsUs, payload });
}

export { FrameType };
