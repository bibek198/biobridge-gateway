import type { Descriptor } from "../descriptors/types";
import { validateDescriptor } from "../descriptors/validate";

// A recording keeps the raw bytes each connection received (pre-decode) with host arrival times,
// plus a snapshot of each connection's descriptor. Decoding is redone at replay/analysis time, so a
// fixed descriptor or a new sync method can be applied to old data.
//
// File format (.bbrec.jsonl): line 1 is the header object (format, version, meta); every further
// line is one chunk {"t": hostMs, "c": connectionKey, "b": base64 bytes}.

export const RECORDING_FORMAT = "biobridge.recording";
export const RECORDING_VERSION = 1;

export type RecordingConnection = {
  key: string;
  factoryId: string;
  label: string;
  transportKind: string;
  descriptor: Descriptor;
  joinedAt: number;
  /** Simulated devices only: hidden clock/PTT truth for evaluating sync. */
  groundTruth?: Record<string, number> | null;
};

export type RecordingMeta = {
  id: string;
  name: string;
  startedAt: number;
  endedAt: number | null;
  connections: RecordingConnection[];
  chunkCount: number;
  byteCount: number;
};

export type RecordedChunk = { t: number; c: string; bytes: Uint8Array };

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function serializeRecording(meta: RecordingMeta, chunks: RecordedChunk[]): string {
  const lines = [JSON.stringify({ format: RECORDING_FORMAT, version: RECORDING_VERSION, meta })];
  for (const ch of chunks) lines.push(JSON.stringify({ t: ch.t, c: ch.c, b: bytesToBase64(ch.bytes) }));
  return lines.join("\n") + "\n";
}

export function parseRecording(text: string): { meta: RecordingMeta; chunks: RecordedChunk[] } {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) throw new Error("Empty recording file.");

  const header = JSON.parse(lines[0]);
  if (header?.format !== RECORDING_FORMAT) throw new Error("Not a BioBridge recording (bad header).");
  if (header.version !== RECORDING_VERSION) throw new Error(`Unsupported recording version ${header.version}.`);
  const meta = header.meta as RecordingMeta;
  if (!meta || !Array.isArray(meta.connections)) throw new Error("Recording header has no connections.");

  for (const c of meta.connections) {
    const v = validateDescriptor(c.descriptor);
    if (!v.ok) throw new Error(`Connection "${c.label}" has an invalid descriptor:\n${v.errors.join("\n")}`);
  }
  const keys = new Set(meta.connections.map((c) => c.key));

  const chunks: RecordedChunk[] = [];
  for (let i = 1; i < lines.length; i++) {
    const row = JSON.parse(lines[i]);
    if (typeof row.t !== "number" || typeof row.c !== "string" || typeof row.b !== "string") {
      throw new Error(`Line ${i + 1}: expected {"t","c","b"}.`);
    }
    if (!keys.has(row.c)) throw new Error(`Line ${i + 1}: unknown connection "${row.c}".`);
    chunks.push({ t: row.t, c: row.c, bytes: base64ToBytes(row.b) });
  }
  return { meta, chunks };
}
