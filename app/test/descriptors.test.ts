import { describe, expect, it } from "vitest";
import { compileDescriptor } from "../src/descriptors/compile";
import { DESCRIPTORS } from "../src/descriptors/library";
import { validateDescriptor } from "../src/descriptors/validate";
import { computeChecksum, crc16Modbus } from "../src/protocol/checksums";
import { FrameType, frame, nodeASamplesPayload, nodeBSamplesPayload } from "../src/protocol/nodes";

const ascii = (s: string) => new TextEncoder().encode(s);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const ecgFrame = (seq: number, ts: number, mv: number[]) => frame(FrameType.SAMPLES, seq, ts, nodeASamplesPayload(4000, mv));

describe("validateDescriptor", () => {
  it.each(Object.entries(DESCRIPTORS))("accepts bundled descriptor %s", (_, d) => {
    expect(validateDescriptor(d)).toEqual({ ok: true, descriptor: d });
  });

  it("reports path-qualified errors", () => {
    const broken = structuredClone(DESCRIPTORS.nodeA) as unknown as Record<string, any>;
    broken.framing.lengthType = "u64";
    broken.messages[1].fields[0].stride = 0;
    broken.messages[1].fields[0].type = "int16";
    delete broken.transport.baudRate;
    const r = validateDescriptor(broken);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\$\.transport\.baudRate: /),
        expect.stringMatching(/^\$\.framing\.lengthType: /),
        expect.stringMatching(/^\$\.messages\[1\]\.fields\[0\]\.type: /),
        expect.stringMatching(/^\$\.messages\[1\]\.fields\[0\]\.stride: /),
      ])
    );
  });

  it("rejects non-objects and text descriptors without a text block", () => {
    expect(validateDescriptor(null).ok).toBe(false);
    const d = structuredClone(DESCRIPTORS.genericSerialCsv) as unknown as Record<string, unknown>;
    delete d.text;
    const r = validateDescriptor(d);
    expect(!r.ok && r.errors).toEqual(["$.text: is required for delimited framing"]);
  });
});

describe("magic-length-crc decoder (Node A)", () => {
  it("skips an ESP32 boot log, then decodes frames split into 1-byte chunks", () => {
    const dec = compileDescriptor(DESCRIPTORS.nodeA);
    const boot = ascii("ets Jun  8 2016 00:22:57\r\nrst:0x1 (POWERON_RESET)\r\n");
    const stream = concat(boot, ecgFrame(0, 1000, [1650, 1750]), ecgFrame(1, 9000, [1550]));
    const values: number[] = [];
    for (const b of stream) values.push(...dec.push(Uint8Array.of(b)).samples.map((s) => s.value));
    expect(values).toEqual([0, 1, -1]);
    expect(dec.stats).toMatchObject({ framesOk: 2, crcErrors: 0, bytesDiscarded: boot.length, seqGaps: 0 });
  });

  it("drops a corrupted frame, resynchronises on the next, and counts the sequence gap", () => {
    const dec = compileDescriptor(DESCRIPTORS.nodeA);
    const bad = ecgFrame(1, 5000, [1650]);
    bad[bad.length - 3] ^= 0xff; // flip a payload byte
    const out = dec.push(concat(ecgFrame(0, 1000, [1650]), bad, ecgFrame(2, 9000, [1660])));
    expect(out.samples.map((s) => s.deviceTimestampUs)).toEqual([1000, 9000]);
    expect(dec.stats.crcErrors).toBeGreaterThanOrEqual(1);
    expect(dec.stats.framesOk).toBe(2);
    expect(dec.stats.seqGaps).toBe(1);
  });

  it("unwraps the 32-bit µs device clock", () => {
    const dec = compileDescriptor(DESCRIPTORS.nodeA);
    const a = dec.push(ecgFrame(0, 0xffff_f000, [1650]));
    const b = dec.push(ecgFrame(1, 0x0000_1000, [1650]));
    expect(b.samples[0].deviceTimestampUs! - a.samples[0].deviceTimestampUs!).toBe(0x2000);
  });

  it("reports the newest sample time and frame size of each message for clock mapping", () => {
    const dec = compileDescriptor(DESCRIPTORS.nodeA);
    expect(dec.push(ecgFrame(0, 1000, [1650, 1650, 1650])).timedMessages).toEqual([
      { deviceUs: 1000 + 2 * 4000, bytes: 13 + 3 + 6, sentWhenReady: true },
    ]);
  });
});

describe("Node B interleaved samples", () => {
  it("de-interleaves red/IR and orders them by time", () => {
    const dec = compileDescriptor(DESCRIPTORS.nodeB);
    const out = dec.push(
      frame(FrameType.SAMPLES, 0, 100, nodeBSamplesPayload(10_000, [{ red: 1, ir: 2 }, { red: 3, ir: 4 }]))
    );
    expect(out.samples.map((s) => [s.channel, s.value, s.deviceTimestampUs])).toEqual([
      ["ppg_red", 1, 100],
      ["ppg_ir", 2, 100],
      ["ppg_red", 3, 10_100],
      ["ppg_ir", 4, 10_100],
    ]);
  });
});

describe("BLE Heart Rate Measurement (0x2A37)", () => {
  const dec = compileDescriptor(DESCRIPTORS.bleHeartRate);

  it("reads a u8 heart rate when flags bit0 = 0", () => {
    expect(dec.push(Uint8Array.of(0x00, 72)).samples).toEqual([
      { channel: "heartRate", value: 72, unit: "bpm", deviceTimestampUs: undefined, seq: undefined },
    ]);
  });

  it("reads a u16 heart rate when flags bit0 = 1 (and ignores trailing RR intervals)", () => {
    expect(dec.push(Uint8Array.of(0x11, 0x2c, 0x01, 0x00, 0x04)).samples.map((s) => s.value)).toEqual([300]);
  });

  it("counts a truncated notification as malformed", () => {
    const before = dec.stats.malformed;
    expect(dec.push(Uint8Array.of(0x01, 0x2c)).samples).toEqual([]);
    expect(dec.stats.malformed).toBe(before + 1);
  });
});

describe("delimited text decoder (generic CSV)", () => {
  it("reassembles lines across chunks and skips junk", () => {
    const dec = compileDescriptor(DESCRIPTORS.genericSerialCsv);
    const got = [
      ...dec.push(ascii("ecg,0.4")).samples,
      ...dec.push(ascii("2\r\nhello\nspo2,97\n,5\nhr,\n")).samples,
    ];
    expect(got.map((s) => [s.channel, s.value, s.unit])).toEqual([
      ["ecg", 0.42, "mV"],
      ["spo2", 97, "%"],
    ]);
    expect(dec.stats.malformed).toBe(3);
  });
});

describe("checksums", () => {
  const ascii9 = new TextEncoder().encode("123456789");
  it.each([
    ["crc16-ccitt-false", 0x29b1],
    ["crc16-modbus", 0x4b37],
    ["sum8", 0xdd],
    ["xor8", 0x31],
  ] as const)("%s matches its standard check value", (kind, check) => {
    expect(computeChecksum(kind, ascii9, 0, ascii9.length)).toBe(check);
  });
});

describe("magic-fixed framing", () => {
  // 6-byte frames: AA 55 | value u16be | counter u8 | xor8 over bytes 2..4
  const d = validateDescriptor({
    schema: "biobridge.descriptor/v1",
    id: "fixed-test",
    name: "fixed",
    transport: { kind: "serial", baudRate: 9600 },
    framing: { kind: "magic-fixed", magic: [0xaa, 0x55], frameLength: 6, checksum: { kind: "xor8", start: 2 } },
    messages: [{ name: "m", fields: [{ kind: "scalar", offset: 2, type: "u16be", channel: "v" }] }],
    channels: [{ id: "v" }],
  });
  if (!d.ok) throw new Error(d.errors.join("\n"));
  const fr = (v: number, n: number) => {
    const b = Uint8Array.of(0xaa, 0x55, v >> 8, v & 0xff, n, 0);
    b[5] = b[2] ^ b[3] ^ b[4];
    return b;
  };

  it("decodes fixed frames across chunk boundaries and drops a corrupted one", () => {
    const dec = compileDescriptor(d.descriptor);
    const bad = fr(999, 1);
    bad[3] ^= 0x10;
    const stream = concat(Uint8Array.of(0x00, 0xaa), fr(300, 0), bad, fr(301, 2));
    const values: number[] = [];
    for (let i = 0; i < stream.length; i += 4) values.push(...dec.push(stream.subarray(i, i + 4)).samples.map((s) => s.value));
    expect(values).toEqual([300, 301]);
    expect(dec.stats.crcErrors).toBeGreaterThanOrEqual(1);
  });

  it("rejects a fixed frame no longer than its magic and a 16-bit checksum without endian", () => {
    const r = validateDescriptor({ ...d.descriptor, framing: { kind: "magic-fixed", magic: [1, 2], frameLength: 2, checksum: { kind: "crc16-modbus", start: 0 } } });
    expect(!r.ok && r.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/^\$\.framing\.frameLength/), expect.stringMatching(/^\$\.framing\.checksum\.endian/)])
    );
  });
});

describe("magic-length-crc with a big-endian length and CRC-16/MODBUS", () => {
  it("decodes", () => {
    const r = validateDescriptor({
      schema: "biobridge.descriptor/v1",
      id: "be-test",
      name: "be",
      transport: { kind: "serial", baudRate: 9600 },
      framing: {
        kind: "magic-length-crc",
        magic: [0x5a],
        lengthOffset: 1,
        lengthType: "u16be",
        headerLength: 3,
        crc: { kind: "crc16-modbus", start: 0, endian: "le" },
        maxFrameLength: 64,
      },
      messages: [{ name: "m", fields: [{ kind: "scalar", offset: 3, type: "i16be", channel: "x" }] }],
      channels: [{ id: "x" }],
    });
    if (!r.ok) throw new Error(r.errors.join("\n"));
    const body = Uint8Array.of(0x5a, 0x00, 0x02, 0xff, 0xfe); // x = -2
    const crc = crc16Modbus(body);
    const out = compileDescriptor(r.descriptor).push(concat(body, Uint8Array.of(crc & 0xff, crc >> 8)));
    expect(out.samples.map((s) => s.value)).toEqual([-2]);
  });
});
