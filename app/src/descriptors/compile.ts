import { CHECKSUM_WIDTH, computeChecksum } from "../protocol/checksums";
import type {
  ChecksumSpec,
  Condition,
  Descriptor,
  FieldRef,
  MagicFixedFraming,
  MagicLengthCrcFraming,
  MessageSpec,
  NumType,
  TextFormat,
} from "./types";
import { NUM_TYPE_SIZES } from "./validate";

export type DecodedSample = {
  channel: string;
  value: number;
  unit?: string;
  /** Device clock, unwrapped, microseconds. Absent when the device sends no timestamps. */
  deviceTimestampUs?: number;
  seq?: number;
};

/**
 * deviceUs is the device time of the message's newest sample (or its own timestamp). sentWhenReady mirrors
 * the descriptor's timestamp.sentAt === "send": deviceUs is also when the device transmitted it.
 */
export type TimedMessage = { deviceUs: number; bytes: number; sentWhenReady: boolean };

export type DecodeOutput = {
  samples: DecodedSample[];
  info?: Record<string, number | string>;
  /** Per timestamped message: device time of its newest sample (when it was ready to send) and its size. */
  timedMessages?: TimedMessage[];
};

export type DecoderStats = {
  bytesIn: number;
  framesOk: number;
  crcErrors: number;
  /** Bytes skipped while hunting for a frame start (boot logs, line noise, corruption). */
  bytesDiscarded: number;
  /** Frames/lines that framed correctly but matched no message, or were too short for their fields. */
  malformed: number;
  /** Frames missing according to the sequence counter. */
  seqGaps: number;
};

export interface Decoder {
  push(chunk: Uint8Array): DecodeOutput;
  readonly stats: DecoderStats;
  reset(): void;
}

export function readNum(bytes: Uint8Array, offset: number, type: NumType): number | undefined {
  const size = NUM_TYPE_SIZES[type];
  if (offset < 0 || offset + size > bytes.length) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, size);
  switch (type) {
    case "u8":
      return view.getUint8(0);
    case "i8":
      return view.getInt8(0);
    case "u16le":
      return view.getUint16(0, true);
    case "u16be":
      return view.getUint16(0, false);
    case "i16le":
      return view.getInt16(0, true);
    case "i16be":
      return view.getInt16(0, false);
    case "u24le":
    case "i24le": {
      const v = bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
      return type === "i24le" && v & 0x800000 ? v - 0x1000000 : v;
    }
    case "u24be":
    case "i24be": {
      const v = (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
      return type === "i24be" && v & 0x800000 ? v - 0x1000000 : v;
    }
    case "u32le":
      return view.getUint32(0, true);
    case "u32be":
      return view.getUint32(0, false);
    case "i32le":
      return view.getInt32(0, true);
    case "i32be":
      return view.getInt32(0, false);
    case "f32le":
      return view.getFloat32(0, true);
    case "f32be":
      return view.getFloat32(0, false);
  }
}

const isUnsignedInt = (t: NumType) => t.startsWith("u");

function matches(bytes: Uint8Array, conds: Condition[] | undefined): boolean {
  if (!conds) return true;
  return conds.every((c) => {
    const v = readNum(bytes, c.offset, c.type);
    if (v === undefined) return false;
    return (c.mask === undefined ? v : v & c.mask) === c.equals;
  });
}

const applyScale = (raw: number, scale = 1, bias = 0) => raw * scale + bias;
// Remove float noise introduced by scale/bias (e.g. 1770 * 0.01 - 16.5) without hiding real precision.
const tidy = (v: number) => Math.round(v * 1e9) / 1e9;

/** Unwraps a monotonically increasing counter that overflows at 2^bits. */
class Unwrapper {
  private last: number | null = null;
  private epoch = 0;
  private readonly bits: number;

  constructor(bits: number) {
    this.bits = bits;
  }

  next(raw: number): number {
    const span = 2 ** this.bits;
    if (this.last !== null && raw < this.last && this.last - raw > span / 2) this.epoch += span;
    this.last = raw;
    return raw + this.epoch;
  }
}

function resolveRef(bytes: Uint8Array, v: number | FieldRef): number | undefined {
  return typeof v === "number" ? v : readNum(bytes, v.offset, v.type);
}

function newStats(): DecoderStats {
  return { bytesIn: 0, framesOk: 0, crcErrors: 0, bytesDiscarded: 0, malformed: 0, seqGaps: 0 };
}

/** Interprets one complete binary message against the descriptor's message specs. */
class MessageInterpreter {
  private readonly messages: MessageSpec[];
  private readonly stats: DecoderStats;
  private tsUnwrappers = new Map<string, Unwrapper>();
  private lastSeq: { value: number; mod: number } | null = null;

  constructor(messages: MessageSpec[], stats: DecoderStats) {
    this.messages = messages;
    this.stats = stats;
  }

  interpret(bytes: Uint8Array, out: DecodeOutput): void {
    const msg = this.messages.find((m) => matches(bytes, m.match));
    if (!msg) {
      this.stats.malformed++;
      return;
    }

    let deviceTimestampUs: number | undefined;
    if (msg.timestamp) {
      const raw = readNum(bytes, msg.timestamp.offset, msg.timestamp.type);
      if (raw === undefined) {
        this.stats.malformed++;
        return;
      }
      // One unwrapper per timestamp field layout: every message sharing the device clock shares it.
      let value = raw;
      if (isUnsignedInt(msg.timestamp.type)) {
        const key = `${msg.timestamp.offset}:${msg.timestamp.type}`;
        let u = this.tsUnwrappers.get(key);
        if (!u) {
          u = new Unwrapper(NUM_TYPE_SIZES[msg.timestamp.type] * 8);
          this.tsUnwrappers.set(key, u);
        }
        value = u.next(raw);
      }
      deviceTimestampUs = msg.timestamp.unit === "ms" ? value * 1000 : value;
    }

    let seq: number | undefined;
    if (msg.seq) {
      seq = readNum(bytes, msg.seq.offset, msg.seq.type);
      if (seq !== undefined) this.trackSeq(seq, 2 ** (NUM_TYPE_SIZES[msg.seq.type] * 8));
    }

    if (msg.info) {
      const info: Record<string, number | string> = {};
      for (const f of msg.fields) {
        if (f.kind === "hex") {
          if (f.offset + f.length > bytes.length) return void this.stats.malformed++;
          info[f.channel] = Array.from(bytes.subarray(f.offset, f.offset + f.length), (b) =>
            b.toString(16).padStart(2, "0")
          ).join("");
        } else if (f.kind === "scalar") {
          if (!matches(bytes, f.when)) continue;
          const raw = readNum(bytes, f.offset, f.type);
          if (raw === undefined) return void this.stats.malformed++;
          info[f.channel] = tidy(applyScale(raw, f.scale, f.bias));
        }
      }
      out.info = { ...out.info, ...info };
      this.stats.framesOk++;
      return;
    }

    const samples: DecodedSample[] = [];
    for (const f of msg.fields) {
      if (f.kind === "scalar") {
        if (!matches(bytes, f.when)) continue;
        const raw = readNum(bytes, f.offset, f.type);
        if (raw === undefined) return void this.stats.malformed++;
        samples.push({ channel: f.channel, value: tidy(applyScale(raw, f.scale, f.bias)), unit: f.unit, deviceTimestampUs, seq });
      } else if (f.kind === "samples") {
        const count = resolveRef(bytes, f.count);
        const periodUs = resolveRef(bytes, f.periodUs);
        if (count === undefined || periodUs === undefined) return void this.stats.malformed++;
        for (let i = 0; i < count; i++) {
          const raw = readNum(bytes, f.offset + i * f.stride, f.type);
          if (raw === undefined) return void this.stats.malformed++;
          samples.push({
            channel: f.channel,
            value: tidy(applyScale(raw, f.scale, f.bias)),
            unit: f.unit,
            deviceTimestampUs: deviceTimestampUs === undefined ? undefined : deviceTimestampUs + i * periodUs,
            seq,
          });
        }
      }
    }
    // Interleaved channels (red/IR) come out grouped per field; order by time so consumers see a stream.
    samples.sort((a, b) => (a.deviceTimestampUs ?? 0) - (b.deviceTimestampUs ?? 0));
    out.samples.push(...samples);
    if (deviceTimestampUs !== undefined) {
      const newest = samples.length > 0 ? samples[samples.length - 1].deviceTimestampUs! : deviceTimestampUs;
      const sentWhenReady = msg.timestamp?.sentAt === "send";
      (out.timedMessages ??= []).push({ deviceUs: newest, bytes: bytes.length, sentWhenReady });
    }
    this.stats.framesOk++;
  }

  private trackSeq(seq: number, mod: number): void {
    if (this.lastSeq !== null) {
      const gap = (seq - this.lastSeq.value - 1 + mod) % mod;
      // A large "gap" is far more likely a device reboot than thousands of lost frames.
      if (gap > 0 && gap < mod / 2) this.stats.seqGaps += gap;
    }
    this.lastSeq = { value: seq, mod };
  }

  reset(): void {
    this.tsUnwrappers.clear();
    this.lastSeq = null;
  }
}

/**
 * Binary frames that start with magic bytes: either length-prefixed (magic-length-crc) or fixed-size
 * (magic-fixed), with a trailing checksum. Hunts for the magic, waits for the whole frame, checks it,
 * and on any failure skips one byte and hunts again, so line noise or a false magic inside payload
 * data costs at most one frame.
 */
class MagicFrameDecoder implements Decoder {
  readonly stats = newStats();
  private buf = new Uint8Array(0);
  private readonly framing: MagicLengthCrcFraming | MagicFixedFraming;
  private readonly checksum: ChecksumSpec | undefined;
  private readonly checksumWidth: number;
  private readonly interpreter: MessageInterpreter;

  constructor(framing: MagicLengthCrcFraming | MagicFixedFraming, messages: MessageSpec[]) {
    this.framing = framing;
    this.checksum = framing.kind === "magic-length-crc" ? framing.crc : framing.checksum;
    this.checksumWidth = this.checksum ? CHECKSUM_WIDTH[this.checksum.kind] : 0;
    this.interpreter = new MessageInterpreter(messages, this.stats);
  }

  /** Total frame length starting at pos; null = need more bytes; -1 = impossible length (resync). */
  private frameLength(buf: Uint8Array, pos: number): number | null {
    const f = this.framing;
    if (f.kind === "magic-fixed") return f.frameLength;
    if (buf.length - pos < f.headerLength) return null;
    const total = f.headerLength + readNum(buf, pos + f.lengthOffset, f.lengthType)! + this.checksumWidth;
    return total > f.maxFrameLength ? -1 : total;
  }

  private checksumOk(frame: Uint8Array): boolean {
    const c = this.checksum;
    if (!c) return true;
    const at = frame.length - this.checksumWidth;
    const expected = computeChecksum(c.kind, frame, c.start, at);
    const actual = this.checksumWidth === 1 ? frame[at] : readNum(frame, at, c.endian === "be" ? "u16be" : "u16le");
    return expected === actual;
  }

  push(chunk: Uint8Array): DecodeOutput {
    this.stats.bytesIn += chunk.length;
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);

    const out: DecodeOutput = { samples: [] };
    const { magic } = this.framing;
    let pos = 0;

    while (pos < merged.length) {
      // Hunt for the magic; a partial magic at the very end is kept for the next chunk.
      const start = findMagic(merged, pos, magic);
      if (start < 0) {
        const keep = partialMagicSuffix(merged, pos, magic);
        this.stats.bytesDiscarded += merged.length - pos - keep;
        pos = merged.length - keep;
        break;
      }
      this.stats.bytesDiscarded += start - pos;
      pos = start;

      const total = this.frameLength(merged, pos);
      if (total === null) break;
      if (total < 0) {
        this.stats.bytesDiscarded++;
        pos++;
        continue;
      }
      if (merged.length - pos < total) break;

      const frameBytes = merged.subarray(pos, pos + total);
      if (!this.checksumOk(frameBytes)) {
        // Could be a false magic inside other data: skip one byte and keep hunting.
        this.stats.crcErrors++;
        this.stats.bytesDiscarded++;
        pos++;
        continue;
      }
      this.interpreter.interpret(frameBytes.slice(), out);
      pos += total;
    }

    this.buf = merged.slice(pos);
    return out;
  }

  reset(): void {
    this.buf = new Uint8Array(0);
    this.interpreter.reset();
    Object.assign(this.stats, newStats());
  }
}

function findMagic(bytes: Uint8Array, from: number, magic: number[]): number {
  outer: for (let i = from; i <= bytes.length - magic.length; i++) {
    for (let j = 0; j < magic.length; j++) if (bytes[i + j] !== magic[j]) continue outer;
    return i;
  }
  return -1;
}

function partialMagicSuffix(bytes: Uint8Array, from: number, magic: number[]): number {
  for (let k = Math.min(magic.length - 1, bytes.length - from); k > 0; k--) {
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (bytes[bytes.length - k + j] !== magic[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return k;
  }
  return 0;
}

class PerChunkDecoder implements Decoder {
  readonly stats = newStats();
  private readonly interpreter: MessageInterpreter;

  constructor(messages: MessageSpec[]) {
    this.interpreter = new MessageInterpreter(messages, this.stats);
  }

  push(chunk: Uint8Array): DecodeOutput {
    this.stats.bytesIn += chunk.length;
    const out: DecodeOutput = { samples: [] };
    this.interpreter.interpret(chunk, out);
    return out;
  }

  reset(): void {
    this.interpreter.reset();
    Object.assign(this.stats, newStats());
  }
}

class DelimitedTextDecoder implements Decoder {
  readonly stats = newStats();
  private pending = "";
  private readonly textDecoder = new TextDecoder();
  private readonly delimiter: string;
  private readonly format: TextFormat;
  private readonly units: Map<string, string | undefined>;

  constructor(delimiter: string, format: TextFormat, units: Map<string, string | undefined>) {
    this.delimiter = delimiter;
    this.format = format;
    this.units = units;
  }

  push(chunk: Uint8Array): DecodeOutput {
    this.stats.bytesIn += chunk.length;
    this.pending += this.textDecoder.decode(chunk, { stream: true });
    const lines = this.pending.split(this.delimiter);
    this.pending = lines.pop() ?? "";
    const out: DecodeOutput = { samples: [] };
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      const before = out.samples.length;
      this.parseLine(line, out);
      if (out.samples.length === before) this.stats.malformed++;
      else this.stats.framesOk++;
    }
    return out;
  }

  private parseLine(line: string, out: DecodeOutput): void {
    const parts = line.split(this.format.separator).map((p) => p.trim());
    if (this.format.mode === "channel-value") {
      if (parts.length < 2 || !parts[0]) return;
      const value = Number(parts[1]);
      if (parts[1] === "" || Number.isNaN(value)) return;
      out.samples.push({ channel: parts[0], value, unit: this.units.get(parts[0]) });
      return;
    }
    for (const col of this.format.columns) {
      const text = parts[col.index];
      if (text === undefined || text === "") continue;
      const raw = Number(text);
      if (Number.isNaN(raw)) continue;
      out.samples.push({ channel: col.channel, value: tidy(applyScale(raw, col.scale, col.bias)), unit: col.unit });
    }
  }

  reset(): void {
    this.pending = "";
    Object.assign(this.stats, newStats());
  }
}

/** Builds a streaming decoder. Assumes the descriptor passed validateDescriptor(). */
export function compileDescriptor(d: Descriptor): Decoder {
  switch (d.framing.kind) {
    case "magic-length-crc":
    case "magic-fixed":
      return new MagicFrameDecoder(d.framing, d.messages ?? []);
    case "per-chunk":
      return new PerChunkDecoder(d.messages ?? []);
    case "delimited": {
      const units = new Map(d.channels.map((c) => [c.id, c.unit]));
      return new DelimitedTextDecoder(d.framing.delimiter, d.text!, units);
    }
  }
}
