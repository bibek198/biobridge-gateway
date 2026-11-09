import { crc16CcittFalse } from "./frame";

// Checksums found in real sensor protocols. Check values ("123456789"): CRC-16/CCITT-FALSE 0x29B1,
// CRC-16/MODBUS 0x4B37, sum8 0xDD, xor8 0x31.

export type ChecksumKind = "crc16-ccitt-false" | "crc16-modbus" | "sum8" | "xor8";

export const CHECKSUM_WIDTH: Record<ChecksumKind, 1 | 2> = {
  "crc16-ccitt-false": 2,
  "crc16-modbus": 2,
  sum8: 1,
  xor8: 1,
};

/** CRC-16/MODBUS: reflected poly 0x8005 (0xA001), init 0xFFFF, no final xor. */
export function crc16Modbus(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let crc = 0xffff;
  for (let i = start; i < end; i++) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc;
}

export function computeChecksum(kind: ChecksumKind, bytes: Uint8Array, start: number, end: number): number {
  switch (kind) {
    case "crc16-ccitt-false":
      return crc16CcittFalse(bytes, start, end);
    case "crc16-modbus":
      return crc16Modbus(bytes, start, end);
    case "sum8": {
      let s = 0;
      for (let i = start; i < end; i++) s = (s + bytes[i]) & 0xff;
      return s;
    }
    case "xor8": {
      let x = 0;
      for (let i = start; i < end; i++) x ^= bytes[i];
      return x;
    }
  }
}
