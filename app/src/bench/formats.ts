import { computeChecksum } from "../protocol/checksums.ts";
import { PayloadWriter } from "../protocol/frame.ts";

// Byte formats of the benchmark's third-party-style devices, as pure functions. The simulators
// (simDevices.ts) and the golden vectors (scripts/gen-test-vectors.ts) both use them, and the ESP32
// benchmark firmware (firmware/lib/bbbench) is tested against those vectors, so a benchmark device behaves
// the same whether it is simulated or flashed onto a board. Each format follows its datasheet in devices.ts.

/** Fingertip oximeter: AA 55 | status | pleth | SpO2 | pulse | PI (0.1 %) | counter | XOR(bytes 2..7). */
export function oximeterFrame(v: { status: number; pleth: number; spo2: number; pulse: number; pi10: number; counter: number }): Uint8Array {
  const f = Uint8Array.of(0xaa, 0x55, v.status, v.pleth, v.spo2, v.pulse, v.pi10, v.counter & 0xff, 0);
  f[8] = computeChecksum("xor8", f, 2, 8);
  return f;
}

/** ECG front-end board: 5A A5 | LEN u16be | BODY | SUM8 over LEN and BODY. */
function beFrame(body: Uint8Array): Uint8Array {
  const f = new Uint8Array(4 + body.length + 1);
  f.set([0x5a, 0xa5, body.length >> 8, body.length & 0xff]);
  f.set(body, 4);
  f[f.length - 1] = computeChecksum("sum8", f, 2, f.length - 1);
  return f;
}

/** BODY = 0x10 | N | N × i24be samples (0.5 µV per LSB). */
export function beEcgSamplesFrame(raw: number[]): Uint8Array {
  const w = new PayloadWriter().u8(0x10).u8(raw.length);
  for (const r of raw) {
    const u = r < 0 ? r + 0x1000000 : r;
    w.u8(u >> 16).u8(u >> 8).u8(u);
  }
  return beFrame(w.build());
}

/** BODY = 0x20 | battery %. */
export function beEcgStatusFrame(batteryPct: number): Uint8Array {
  return beFrame(Uint8Array.of(0x20, batteryPct));
}

/** BP monitor: 'B' 'P' | LEN | PAYLOAD | CRC-16/MODBUS (LE) over everything before it. */
function bpFrame(payload: Uint8Array): Uint8Array {
  const f = new Uint8Array(3 + payload.length + 2);
  f.set([0x42, 0x50, payload.length]);
  f.set(payload, 3);
  const crc = computeChecksum("crc16-modbus", f, 0, f.length - 2);
  f[f.length - 2] = crc & 0xff;
  f[f.length - 1] = crc >> 8;
  return f;
}

/** Result: 0x01 | uptime ms u32 | sys, dia, map u16 (0.1 mmHg) | pulse u8. */
export function bpResultFrame(v: { uptimeMs: number; sys10: number; dia10: number; map10: number; pulse: number }): Uint8Array {
  return bpFrame(new PayloadWriter().u8(0x01).u32(v.uptimeMs).u16(v.sys10).u16(v.dia10).u16(v.map10).u8(v.pulse).build());
}

/** Status: 0x02 | uptime ms u32 | cuff pressure u16 (0.1 mmHg). */
export function bpStatusFrame(v: { uptimeMs: number; cuff10: number }): Uint8Array {
  return bpFrame(new PayloadWriter().u8(0x02).u32(v.uptimeMs).u16(v.cuff10).build());
}

/** Wrist IMU (BLE): C3 | LEN | t_ms u32 | N | N × (x, y, z i16, milli-g) | CRC-16/CCITT-FALSE big-endian over LEN..payload. */
export function imuFrame(firstSampleMs: number, xyz: number[][]): Uint8Array {
  const w = new PayloadWriter().u32(firstSampleMs).u8(xyz.length);
  for (const s of xyz) for (const v of s) w.i16(v);
  const payload = w.build();
  const f = new Uint8Array(2 + payload.length + 2);
  f.set([0xc3, payload.length]);
  f.set(payload, 2);
  const crc = computeChecksum("crc16-ccitt-false", f, 1, f.length - 2);
  f[f.length - 2] = crc >> 8;
  f[f.length - 1] = crc & 0xff;
  return f;
}

/** USB PPG module: A0 0A | LEN u16le | t_us u32 | N | N × f32le | CRC-16/CCITT-FALSE (LE) over LEN..body. */
export function floatPpgFrame(firstSampleUs: number, samples: number[]): Uint8Array {
  const body = new Uint8Array(5 + 4 * samples.length);
  const dv = new DataView(body.buffer);
  dv.setUint32(0, firstSampleUs >>> 0, true);
  body[4] = samples.length;
  samples.forEach((s, i) => dv.setFloat32(5 + 4 * i, s, true));
  const f = new Uint8Array(4 + body.length + 2);
  f.set([0xa0, 0x0a, body.length & 0xff, body.length >> 8]);
  f.set(body, 4);
  const crc = computeChecksum("crc16-ccitt-false", f, 2, f.length - 2);
  f[f.length - 2] = crc & 0xff;
  f[f.length - 1] = crc >> 8;
  return f;
}

/** Lab ECG amplifier: "t_ms,ecg_uV,lo\r\n" lines after a header line. */
export const ASCII_ECG_HEADER = "t_ms,ecg_uV,lo\r\n";
export function asciiEcgLine(tMs: number, uV: number, leadsOff: number): string {
  return `${Math.floor(tMs)},${Math.round(uV)},${leadsOff}\r\n`;
}
