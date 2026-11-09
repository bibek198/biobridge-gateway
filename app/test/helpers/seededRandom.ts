import { vi } from "vitest";

/** Replaces Math.random with a seeded PRNG (mulberry32) so simulator runs are reproducible. */
export function seedMathRandom(seed: number): () => void {
  let a = seed >>> 0;
  const spy = vi.spyOn(Math, "random").mockImplementation(() => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  });
  return () => spy.mockRestore();
}
