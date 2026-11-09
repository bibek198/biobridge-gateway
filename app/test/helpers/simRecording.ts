import { vi } from "vitest";
import { DESCRIPTORS } from "../../src/descriptors/library";
import type { RecordedChunk, RecordingMeta } from "../../src/session/recording";
import { PhysiologyModel } from "../../src/sim/physiology";
import { SimSyncRig } from "../../src/sim/syncRig";
import { hostNowMs } from "../../src/time/clock";
import { SimulatedNodeATransport, SimulatedNodeBTransport, type SimEnv } from "../../src/transports/simulatedTransports";

export const FAKE_TIMERS = { toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "performance", "Date"] } as const;

export function simEnv(opts: { probes?: boolean } = {}): SimEnv {
  return { physiology: new PhysiologyModel(), rig: new SimSyncRig(), probes: opts.probes ?? true };
}

/**
 * Runs simulated Node A + Node B (one subject, one sync rig) for durationMs of fake time and returns a
 * recording exactly as the app would store it, including the simulators' hidden clock truth.
 * Call with fake timers enabled.
 */
export async function simRecording(
  durationMs: number,
  opts: { probes?: boolean } = {}
): Promise<{ meta: RecordingMeta; chunks: RecordedChunk[] }> {
  const env = simEnv(opts);
  const a = new SimulatedNodeATransport(env);
  const b = new SimulatedNodeBTransport(env);
  const chunks: RecordedChunk[] = [];
  a.onChunk((bytes, t) => chunks.push({ t, c: "c1", bytes: bytes.slice() }));
  b.onChunk((bytes, t) => chunks.push({ t, c: "c2", bytes: bytes.slice() }));
  const t0 = hostNowMs();
  await a.open();
  await b.open();
  await vi.advanceTimersByTimeAsync(durationMs);
  await a.close();
  await b.close();
  const conn = (key: string, label: string, transportKind: string, descriptor: typeof DESCRIPTORS.nodeA, gt: Record<string, number>) => ({
    key, factoryId: key === "c1" ? "sim-node-a" : "sim-node-b", label, transportKind, descriptor, joinedAt: t0, groundTruth: gt,
  });
  return {
    meta: {
      id: "sim", name: `simulated Node A + Node B, ${Math.round(durationMs / 1000)} s`, startedAt: t0, endedAt: t0 + durationMs,
      connections: [
        conn("c1", "Node A (serial)", "simulated", DESCRIPTORS.nodeA, a.groundTruth()),
        conn("c2", "Node B (BLE)", "simulated", DESCRIPTORS.nodeB, b.groundTruth()),
      ],
      chunkCount: chunks.length, byteCount: chunks.reduce((n, c) => n + c.bytes.length, 0),
    },
    chunks,
  };
}
