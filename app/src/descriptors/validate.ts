import { CHECKSUM_WIDTH, type ChecksumKind } from "../protocol/checksums";
import { DESCRIPTOR_SCHEMA, type Descriptor, type NumType } from "./types";

// Runtime validation for descriptors from untrusted sources (imported files, recordings, LLM output).
// Errors are path-qualified so they can be shown to a person or fed back to a model verbatim.

export const NUM_TYPE_SIZES: Record<NumType, number> = {
  u8: 1,
  i8: 1,
  u16le: 2,
  u16be: 2,
  i16le: 2,
  i16be: 2,
  u24le: 3,
  u24be: 3,
  i24le: 3,
  i24be: 3,
  u32le: 4,
  u32be: 4,
  i32le: 4,
  i32be: 4,
  f32le: 4,
  f32be: 4,
};

export type ValidationResult = { ok: true; descriptor: Descriptor } | { ok: false; errors: string[] };

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

export function validateDescriptor(input: unknown): ValidationResult {
  const errors: string[] = [];
  const err = (path: string, msg: string) => errors.push(`${path}: ${msg}`);

  const numType = (path: string, v: unknown) => {
    if (typeof v !== "string" || !(v in NUM_TYPE_SIZES)) {
      err(path, `must be one of ${Object.keys(NUM_TYPE_SIZES).join(", ")}`);
    }
  };
  const offset = (path: string, v: unknown) => {
    if (!isNonNegInt(v)) err(path, "must be a non-negative integer");
  };
  const optNumber = (path: string, v: unknown) => {
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) err(path, "must be a finite number");
  };
  const str = (path: string, v: unknown) => {
    if (typeof v !== "string" || v.length === 0) err(path, "must be a non-empty string");
  };
  const magicBytes = (path: string, v: unknown) => {
    if (!Array.isArray(v) || v.length === 0 || !v.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
      err(path, "must be a non-empty array of bytes (0-255)");
    }
  };
  const checksum = (path: string, v: unknown, required: boolean) => {
    if (!isObj(v)) {
      if (required) err(path, "must be an object { kind, start, endian? }");
      return;
    }
    if (!(typeof v.kind === "string" && v.kind in CHECKSUM_WIDTH)) err(`${path}.kind`, `must be one of ${Object.keys(CHECKSUM_WIDTH).join(", ")}`);
    offset(`${path}.start`, v.start);
    const width = CHECKSUM_WIDTH[v.kind as ChecksumKind];
    if (width === 2 && v.endian !== "le" && v.endian !== "be") err(`${path}.endian`, 'must be "le" or "be" for a 16-bit checksum');
  };
  const fieldRef = (path: string, v: unknown) => {
    if (!isObj(v)) return err(path, "must be an object { offset, type }");
    offset(`${path}.offset`, v.offset);
    numType(`${path}.type`, v.type);
  };
  const conditions = (path: string, v: unknown) => {
    if (v === undefined) return;
    if (!Array.isArray(v)) return err(path, "must be an array");
    v.forEach((c, i) => {
      if (!isObj(c)) return err(`${path}[${i}]`, "must be an object");
      offset(`${path}[${i}].offset`, c.offset);
      numType(`${path}[${i}].type`, c.type);
      if (c.mask !== undefined && !isNonNegInt(c.mask)) err(`${path}[${i}].mask`, "must be a non-negative integer");
      if (typeof c.equals !== "number") err(`${path}[${i}].equals`, "must be a number");
    });
  };

  if (!isObj(input)) return { ok: false, errors: ["$: descriptor must be a JSON object"] };
  const d = input;

  if (d.schema !== DESCRIPTOR_SCHEMA) err("$.schema", `must be "${DESCRIPTOR_SCHEMA}"`);
  str("$.id", d.id);
  str("$.name", d.name);

  // transport
  if (!isObj(d.transport)) err("$.transport", "must be an object");
  else if (d.transport.kind === "serial") {
    if (!isNonNegInt(d.transport.baudRate) || d.transport.baudRate === 0) {
      err("$.transport.baudRate", "must be a positive integer");
    }
  } else if (d.transport.kind === "ble") {
    str("$.transport.service", d.transport.service);
    str("$.transport.characteristic", d.transport.characteristic);
  } else err("$.transport.kind", 'must be "serial" or "ble"');

  // framing
  const framing = d.framing;
  let framingKind: string | undefined;
  if (!isObj(framing)) err("$.framing", "must be an object");
  else {
    framingKind = framing.kind as string;
    if (framing.kind === "delimited") {
      str("$.framing.delimiter", framing.delimiter);
    } else if (framing.kind === "magic-length-crc" || framing.kind === "magic-fixed") {
      magicBytes("$.framing.magic", framing.magic);
      if (framing.kind === "magic-length-crc") {
        offset("$.framing.lengthOffset", framing.lengthOffset);
        const lengthTypes = ["u8", "u16le", "u16be"];
        if (!lengthTypes.includes(framing.lengthType as string)) err("$.framing.lengthType", 'must be "u8", "u16le" or "u16be"');
        offset("$.framing.headerLength", framing.headerLength);
        offset("$.framing.maxFrameLength", framing.maxFrameLength);
        if (
          isNonNegInt(framing.lengthOffset) &&
          isNonNegInt(framing.headerLength) &&
          lengthTypes.includes(framing.lengthType as string) &&
          framing.lengthOffset + NUM_TYPE_SIZES[framing.lengthType as NumType] > framing.headerLength
        ) {
          err("$.framing.lengthOffset", "length field must lie inside the header");
        }
        checksum("$.framing.crc", framing.crc, true);
      } else {
        if (!isNonNegInt(framing.frameLength) || framing.frameLength === 0) err("$.framing.frameLength", "must be a positive integer");
        else if (Array.isArray(framing.magic) && framing.frameLength <= framing.magic.length) {
          err("$.framing.frameLength", "must be longer than the magic");
        }
        if (framing.checksum !== undefined) checksum("$.framing.checksum", framing.checksum, true);
      }
    } else if (framing.kind !== "per-chunk") {
      err("$.framing.kind", 'must be "delimited", "magic-length-crc", "magic-fixed" or "per-chunk"');
    }
  }

  // payload interpretation: text for delimited framing, messages otherwise
  if (framingKind === "delimited") {
    if (!isObj(d.text)) err("$.text", "is required for delimited framing");
    else {
      str("$.text.separator", d.text.separator);
      if (d.text.mode === "columns") {
        if (!Array.isArray(d.text.columns) || d.text.columns.length === 0) {
          err("$.text.columns", "must be a non-empty array");
        } else {
          d.text.columns.forEach((c, i) => {
            if (!isObj(c)) return err(`$.text.columns[${i}]`, "must be an object");
            offset(`$.text.columns[${i}].index`, c.index);
            str(`$.text.columns[${i}].channel`, c.channel);
            optNumber(`$.text.columns[${i}].scale`, c.scale);
            optNumber(`$.text.columns[${i}].bias`, c.bias);
          });
        }
      } else if (d.text.mode !== "channel-value") err("$.text.mode", 'must be "channel-value" or "columns"');
    }
  } else if (framingKind !== undefined) {
    if (!Array.isArray(d.messages) || d.messages.length === 0) err("$.messages", "must be a non-empty array");
    else {
      d.messages.forEach((m, mi) => {
        const mp = `$.messages[${mi}]`;
        if (!isObj(m)) return err(mp, "must be an object");
        str(`${mp}.name`, m.name);
        conditions(`${mp}.match`, m.match);
        if (m.timestamp !== undefined) {
          fieldRef(`${mp}.timestamp`, m.timestamp);
          if (isObj(m.timestamp) && m.timestamp.unit !== "us" && m.timestamp.unit !== "ms") {
            err(`${mp}.timestamp.unit`, 'must be "us" or "ms"');
          }
          if (isObj(m.timestamp) && m.timestamp.sentAt !== undefined && m.timestamp.sentAt !== "send" && m.timestamp.sentAt !== "event") {
            err(`${mp}.timestamp.sentAt`, 'must be "send" or "event"');
          }
        }
        if (m.seq !== undefined) fieldRef(`${mp}.seq`, m.seq);
        // A message may carry only its timestamp (e.g. a timing probe); otherwise it needs fields.
        if (!Array.isArray(m.fields) || (m.fields.length === 0 && m.timestamp === undefined)) {
          return err(`${mp}.fields`, "must be a non-empty array (or the message must have a timestamp)");
        }
        m.fields.forEach((f, fi) => {
          const fp = `${mp}.fields[${fi}]`;
          if (!isObj(f)) return err(fp, "must be an object");
          str(`${fp}.channel`, f.channel);
          offset(`${fp}.offset`, f.offset);
          if (f.kind === "scalar") {
            numType(`${fp}.type`, f.type);
            optNumber(`${fp}.scale`, f.scale);
            optNumber(`${fp}.bias`, f.bias);
            conditions(`${fp}.when`, f.when);
          } else if (f.kind === "samples") {
            numType(`${fp}.type`, f.type);
            if (!isNonNegInt(f.stride) || f.stride === 0) err(`${fp}.stride`, "must be a positive integer");
            if (typeof f.count === "number") offset(`${fp}.count`, f.count);
            else fieldRef(`${fp}.count`, f.count);
            if (typeof f.periodUs === "number") {
              if (!(f.periodUs > 0)) err(`${fp}.periodUs`, "must be positive");
            } else fieldRef(`${fp}.periodUs`, f.periodUs);
            optNumber(`${fp}.scale`, f.scale);
            optNumber(`${fp}.bias`, f.bias);
          } else if (f.kind === "hex") {
            if (!isNonNegInt(f.length) || f.length === 0) err(`${fp}.length`, "must be a positive integer");
            if (m.info !== true) err(`${fp}.kind`, '"hex" fields are only allowed in info messages');
          } else err(`${fp}.kind`, 'must be "scalar", "samples" or "hex"');
        });
      });
    }
  }

  if (!Array.isArray(d.channels)) err("$.channels", "must be an array");
  else {
    d.channels.forEach((c, i) => {
      if (!isObj(c)) return err(`$.channels[${i}]`, "must be an object");
      str(`$.channels[${i}].id`, c.id);
      if (c.display !== undefined && !["waveform", "scalar", "hidden"].includes(c.display as string)) {
        err(`$.channels[${i}].display`, 'must be "waveform", "scalar" or "hidden"');
      }
    });
  }

  if (d.commands !== undefined) {
    if (!Array.isArray(d.commands)) err("$.commands", "must be an array");
    else {
      d.commands.forEach((c, i) => {
        if (!isObj(c)) return err(`$.commands[${i}]`, "must be an object");
        str(`$.commands[${i}].id`, c.id);
        str(`$.commands[${i}].label`, c.label);
        if (typeof c.hex !== "string" || !/^([0-9a-fA-F]{2})+$/.test(c.hex)) err(`$.commands[${i}].hex`, "must be a non-empty hex byte string");
      });
    }
  }

  if (d.plausibility !== undefined) {
    if (!isObj(d.plausibility)) err("$.plausibility", "must be an object keyed by channel");
    else {
      for (const [ch, p] of Object.entries(d.plausibility)) {
        if (!isObj(p)) {
          err(`$.plausibility.${ch}`, "must be an object");
          continue;
        }
        optNumber(`$.plausibility.${ch}.min`, p.min);
        optNumber(`$.plausibility.${ch}.max`, p.max);
        optNumber(`$.plausibility.${ch}.maxRatePerSec`, p.maxRatePerSec);
      }
    }
  }

  return errors.length === 0 ? { ok: true, descriptor: input as Descriptor } : { ok: false, errors };
}
