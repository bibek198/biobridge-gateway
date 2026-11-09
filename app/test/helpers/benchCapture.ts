import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { vi } from "vitest";
import type { BenchDevice } from "../../src/bench/devices";
import { BenchDeviceTransport } from "../../src/bench/simDevices";
import { DESCRIPTORS } from "../../src/descriptors/library";
import { parseRecording, type RecordedChunk, type RecordingMeta } from "../../src/session/recording";
import { hostNowMs } from "../../src/time/clock";
import { SimulatedNodeATransport } from "../../src/transports/simulatedTransports";
import { seedMathRandom } from "./seededRandom";
import { simEnv } from "./simRecording";

export type BenchCapture = {
  meta: RecordingMeta;
  chunks: RecordedChunk[];
  /** What the device meant to send, per channel (only for benchmark-specific simulated devices). */
  intended: Map<string, number[]> | null;
};

/**
 * Records a benchmark device ("dev") together with a reference Node A ECG ("ref") on one simulated subject,
 * so the cross-sensor oracle has an independent heart rate. Seeded and run on fake timers, so it is
 * reproducible. Call with fake timers enabled.
 */
export async function benchCapture(device: BenchDevice, durationMs: number, seed: number): Promise<BenchCapture> {
  const restore = seedMathRandom(seed);
  try {
    const env = simEnv();
    const dev = device.createTransport(env);
    const ref = new SimulatedNodeATransport(env);
    const chunks: RecordedChunk[] = [];
    dev.onChunk((bytes, t) => chunks.push({ t, c: "dev", bytes: bytes.slice() }));
    ref.onChunk((bytes, t) => chunks.push({ t, c: "ref", bytes: bytes.slice() }));
    const t0 = hostNowMs();
    await dev.open();
    await ref.open();
    await vi.advanceTimersByTimeAsync(durationMs);
    await dev.close();
    await ref.close();
    const meta: RecordingMeta = {
      id: `bench-${device.id}-${seed}`,
      name: `${device.title} (seed ${seed})`,
      startedAt: t0,
      endedAt: t0 + durationMs,
      connections: [
        { key: "dev", factoryId: device.id, label: device.title, transportKind: device.groundTruth.transport.kind, descriptor: device.groundTruth, joinedAt: t0 },
        { key: "ref", factoryId: "sim-node-a", label: "Reference ECG", transportKind: "serial", descriptor: DESCRIPTORS.nodeA, joinedAt: t0 },
      ],
      chunkCount: chunks.length,
      byteCount: chunks.reduce((n, c) => n + c.bytes.length, 0),
    };
    return { meta, chunks, intended: dev instanceof BenchDeviceTransport ? dev.intended : null };
  } finally {
    restore();
  }
}

/**
 * Captures from a hardware recording: one per benchmark board in it (factory "bench-<device id>"), renamed to
 * the "dev"/"ref" keys the loop expects, with a Node A (real or simulated) as the cross-sensor reference.
 */
export function capturesFromRecording(path: string): Map<string, BenchCapture> {
  const { meta, chunks } = parseRecording(readFileSync(resolve(path), "utf8"));
  const ref = meta.connections.find((c) => c.factoryId === "node-a" || c.factoryId === "sim-node-a");
  const out = new Map<string, BenchCapture>();
  for (const c of meta.connections.filter((x) => x.factoryId.startsWith("bench-"))) {
    const id = c.factoryId.slice("bench-".length);
    const rename = (k: string) => (k === c.key ? "dev" : "ref");
    out.set(id, {
      meta: { ...meta, connections: [c, ...(ref ? [ref] : [])].map((x) => ({ ...x, key: rename(x.key) })) },
      chunks: chunks.filter((x) => x.c === c.key || x.c === ref?.key).map((x) => ({ ...x, c: rename(x.c) })),
      intended: null,
    });
  }
  return out;
}

