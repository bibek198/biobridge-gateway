// BioBridge frame v1. Spec: protocol/FRAME.md (repo root). Firmware mirror: firmware/lib/bbframe.
//
//   0xB1 0x0B | ver u8 | type u8 | seq u16le | device_ts_us u32le | len u8 | payload[len] | crc16 u16le
//
// CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) over ver..end of payload (magic excluded).

export const FRAME_MAGIC = [0xb1, 0x0b] as const;
export const FRAME_VERSION = 1;
export const FRAME_HEADER_LEN = 11;
export const FRAME_CRC_LEN = 2;
export const FRAME_MAX_PAYLOAD = 255;

export const FrameType = {
  HELLO: 0x01,
  SAMPLES: 0x02,
  SYNC_EVENT: 0x03,
  LEADS_OFF: 0x04,
  TIME_PROBE: 0x05,
} as const;

export function crc16CcittFalse(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let crc = 0xffff;
  for (let i = start; i < end; i++) {
    crc ^= bytes[i] << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

export type FrameFields = {
  type: number;
  seq: number;
  deviceTsUs: number;
  payload: Uint8Array;
};

export function encodeFrame({ type, seq, deviceTsUs, payload }: FrameFields): Uint8Array {
  if (payload.length > FRAME_MAX_PAYLOAD) throw new Error(`payload too long: ${payload.length}`);
  const out = new Uint8Array(FRAME_HEADER_LEN + payload.length + FRAME_CRC_LEN);
  const view = new DataView(out.buffer);
  out[0] = FRAME_MAGIC[0];
  out[1] = FRAME_MAGIC[1];
  out[2] = FRAME_VERSION;
  out[3] = type;
  view.setUint16(4, seq & 0xffff, true);
  view.setUint32(6, deviceTsUs >>> 0, true);
  out[10] = payload.length;
  out.set(payload, FRAME_HEADER_LEN);
  const crcAt = FRAME_HEADER_LEN + payload.length;
  view.setUint16(crcAt, crc16CcittFalse(out, 2, crcAt), true);
  return out;
}

/** Little-endian payload builder used by the simulator and test-vector generator. */
export class PayloadWriter {
  private bytes: number[] = [];

  u8(v: number): this {
    this.bytes.push(v & 0xff);
    return this;
  }

  u16(v: number): this {
    return this.u8(v).u8(v >> 8);
  }

  i16(v: number): this {
    return this.u16(v < 0 ? v + 0x10000 : v);
  }

  u24(v: number): this {
    return this.u8(v).u8(v >> 8).u8(v >> 16);
  }

  u32(v: number): this {
    return this.u16(v & 0xffff).u16((v >>> 16) & 0xffff);
  }

  raw(b: ArrayLike<number>): this {
    for (let i = 0; i < b.length; i++) this.bytes.push(b[i] & 0xff);
    return this;
  }

  build(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}
