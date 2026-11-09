import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileDescriptor, type DecodedSample } from "../src/descriptors/compile";
import { DESCRIPTORS } from "../src/descriptors/library";
import type { Descriptor } from "../src/descriptors/types";
import { crc16CcittFalse, encodeFrame } from "../src/protocol/frame";

const vectors = JSON.parse(readFileSync(new URL("../../protocol/test-vectors.json", import.meta.url), "utf8"));
const fromHex = (h: string) => Uint8Array.from((h.match(/../g) ?? []).map((b) => parseInt(b, 16)));
const byId: Record<string, Descriptor> = {
  "biobridge-node-a": DESCRIPTORS.nodeA,
  "biobridge-node-b": DESCRIPTORS.nodeB,
};

type Vector = {
  name: string;
  descriptor: string;
  type: number;
  seq: number;
  device_ts_us: number;
  payload_hex: string;
  frame_hex: string;
  expect: { samples: DecodedSample[]; info?: Record<string, number | string> };
};

describe("BioBridge frame v1", () => {
  it("uses CRC-16/CCITT-FALSE (standard check value 0x29B1)", () => {
    expect(crc16CcittFalse(new TextEncoder().encode(vectors.crc_check.ascii))).toBe(0x29b1);
  });

  it.each(vectors.frames as Vector[])("encodes $name byte-exactly", (v) => {
    const bytes = encodeFrame({ type: v.type, seq: v.seq, deviceTsUs: v.device_ts_us, payload: fromHex(v.payload_hex) });
    expect(Buffer.from(bytes).toString("hex")).toBe(v.frame_hex);
  });

  it("decodes every golden frame through its descriptor", () => {
    const decoders = new Map(Object.entries(byId).map(([id, d]) => [id, compileDescriptor(d)]));
    for (const v of vectors.frames as Vector[]) {
      const out = decoders.get(v.descriptor)!.push(fromHex(v.frame_hex));
      const got = out.samples.map(({ channel, value, deviceTimestampUs }) => ({ channel, value, deviceTimestampUs }));
      // node_b_hello follows a frame stamped just before the u32 wrap; its timestamp is unwrapped, not checked here.
      expect(got, v.name).toEqual(v.expect.samples);
      if (v.expect.info) expect(out.info, v.name).toEqual(v.expect.info);
    }
  });
});
