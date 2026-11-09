export type ErrorStats = {
  n: number;
  meanMs: number;
  /** Root-mean-square error, including the mean (bias). */
  rmseMs: number;
  sdMs: number;
  p95AbsMs: number;
  maxAbsMs: number;
};

export function summarize(errors: number[]): ErrorStats {
  const n = errors.length;
  if (n === 0) return { n: 0, meanMs: NaN, rmseMs: NaN, sdMs: NaN, p95AbsMs: NaN, maxAbsMs: NaN };
  const mean = errors.reduce((s, e) => s + e, 0) / n;
  const ms = errors.reduce((s, e) => s + e * e, 0) / n;
  const abs = errors.map(Math.abs).sort((a, b) => a - b);
  return {
    n,
    meanMs: mean,
    rmseMs: Math.sqrt(ms),
    sdMs: Math.sqrt(Math.max(0, ms - mean * mean)),
    p95AbsMs: abs[Math.min(n - 1, Math.floor(0.95 * n))],
    maxAbsMs: abs[n - 1],
  };
}
