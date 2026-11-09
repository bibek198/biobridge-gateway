import { compileDescriptor } from "../descriptors/compile";
import type { RecordedChunk, RecordingMeta } from "../session/recording";
import { PpgUpstrokeDetector, RPeakDetector } from "../signal/landmarks";
import { createClockMapper, type ClockMapper, type ClockMethodId } from "../time/clock";
import { PulsePairTracker } from "./pulsePairs";
import { summarize, type ErrorStats } from "./stats";

// Offline, causal evaluation of clock-sync methods on a recording (simulated or hardware).
// Every method sees the same decoded stream and is queried at the moment data arrives, as it would be live.
//
//   pulse pairs  — SYNC_EVENT edges seen by two devices: the hardware ground truth (works on real rigs)
//   absolute     — mapped vs true host time; simulator recordings only (they carry the hidden clock truth)
//   PTT          — ECG R-peak (one device) to PPG max-upstroke (another): the downstream quantity Paper 1 cares
//                  about; with simulator truth, each method's PTT error vs truth-aligned PTT

export const TRUTH = "truth";

export type MethodResult = {
  method: string;
  pulsePairs: { pair: string; stats: ErrorStats }[];
  absolute: { connection: string; stats: ErrorStats }[];
  ptt: { stats: ErrorStats; errorVsTruth: ErrorStats | null } | null;
};

export type SeriesRow = { tS: number; method: string; kind: "pulse" | "absolute" | "ptt"; series: string; valueMs: number };

export type SyncEvalReport = {
  recording: { name: string; durationS: number; connections: { key: string; label: string; transport: string }[] };
  warmupS: number;
  hasTruth: boolean;
  methods: MethodResult[];
  series: SeriesRow[];
};

type Truth = { bootHostMs: number; driftPpm: number };

class TruthMapper implements ClockMapper {
  readonly name = TRUTH;
  private readonly truth: Truth;
  constructor(truth: Truth) {
    this.truth = truth;
  }
  observe(): void {}
  toHostMs(deviceUs: number): number {
    return this.truth.bootHostMs + deviceUs / 1000 / (1 + this.truth.driftPpm * 1e-6);
  }
  reset(): void {}
}

export function evaluateSync(
  rec: { meta: RecordingMeta; chunks: RecordedChunk[] },
  methods: ClockMethodId[],
  opts: { warmupS?: number; seriesEveryS?: number } = {}
): SyncEvalReport {
  const warmupS = opts.warmupS ?? 10;
  const seriesEveryS = opts.seriesEveryS ?? 1;
  const { meta } = rec;
  const chunks = [...rec.chunks].sort((a, b) => a.t - b.t);
  const t0 = chunks.length > 0 ? chunks[0].t : meta.startedAt;
  const tEnd = chunks.length > 0 ? chunks[chunks.length - 1].t : t0;

  const truths = new Map<string, Truth>();
  for (const c of meta.connections) {
    const g = c.groundTruth;
    if (g && typeof g.bootHostMs === "number" && typeof g.driftPpm === "number") {
      truths.set(c.key, { bootHostMs: g.bootHostMs, driftPpm: g.driftPpm });
    }
  }
  const hasTruth = meta.connections.length > 0 && truths.size === meta.connections.length;
  const allMethods: string[] = hasTruth ? [...methods, TRUTH] : [...methods];

  // Per connection: one decoder and landmark detectors (device time), plus one mapper per method.
  const conns = new Map(
    meta.connections.map((c) => [
      c.key,
      {
        label: c.label,
        decoder: compileDescriptor(c.descriptor),
        mappers: new Map<string, ClockMapper>(
          allMethods.map((m) => [m, m === TRUTH ? new TruthMapper(truths.get(c.key)!) : createClockMapper(m as ClockMethodId, c.descriptor)])
        ),
        rDetector: new RPeakDetector(),
        ppgDetector: new PpgUpstrokeDetector(),
      },
    ])
  );

  const trackers = new Map(allMethods.map((m) => [m, new PulsePairTracker()]));
  const absErrors = new Map(allMethods.map((m) => [m, new Map<string, number[]>()]));
  // PTT: R-peaks (mapped) per method; PPG landmarks keyed by device time so methods can be compared beat by beat.
  const rPeaks = new Map(allMethods.map((m) => [m, [] as number[]]));
  const ptts = new Map(allMethods.map((m) => [m, new Map<string, { tS: number; ptt: number }>()]));
  const series: SeriesRow[] = [];
  const lastAbsSeries = new Map<string, number>();
  const tS = (t: number) => (t - t0) / 1000;

  for (const chunk of chunks) {
    const c = conns.get(chunk.c);
    if (!c) continue;
    const out = c.decoder.push(chunk.bytes);
    const elapsed = tS(chunk.t);

    for (const m of out.timedMessages ?? []) {
      for (const [method, mapper] of c.mappers) {
        mapper.observe(m.deviceUs, chunk.t, m);
        if (!hasTruth || method === TRUTH) continue;
        const err = mapper.toHostMs(m.deviceUs) - conns.get(chunk.c)!.mappers.get(TRUTH)!.toHostMs(m.deviceUs);
        if (elapsed >= warmupS) {
          const perConn = absErrors.get(method)!;
          if (!perConn.has(c.label)) perConn.set(c.label, []);
          perConn.get(c.label)!.push(err);
        }
        const k = `${method}|${c.label}`;
        if (elapsed - (lastAbsSeries.get(k) ?? -Infinity) >= seriesEveryS) {
          lastAbsSeries.set(k, elapsed);
          series.push({ tS: elapsed, method, kind: "absolute", series: c.label, valueMs: err });
        }
      }
    }

    for (const s of out.samples) {
      if (s.deviceTimestampUs === undefined) continue;
      const devMs = s.deviceTimestampUs / 1000;
      if (s.channel === "syncEvent") {
        for (const [method, mapper] of c.mappers) trackers.get(method)!.add(chunk.c, s.value, mapper.toHostMs(s.deviceTimestampUs));
      } else if (s.channel === "ecg") {
        const peak = c.rDetector.push(devMs, s.value);
        if (peak !== null) for (const [method, mapper] of c.mappers) rPeaks.get(method)!.push(mapper.toHostMs(peak * 1000));
      } else if (s.channel === "ppg_ir") {
        const lm = c.ppgDetector.push(devMs, s.value);
        if (lm === null) continue;
        for (const [method, mapper] of c.mappers) {
          const tp = mapper.toHostMs(lm * 1000);
          const peaks = rPeaks.get(method)!;
          // The R-peak that launched this pulse: the latest one 100–500 ms earlier.
          for (let i = peaks.length - 1; i >= 0 && i >= peaks.length - 8; i--) {
            const d = tp - peaks[i];
            if (d >= 100 && d <= 500) {
              ptts.get(method)!.set(`${chunk.c}:${lm.toFixed(3)}`, { tS: elapsed, ptt: d });
              break;
            }
          }
        }
      }
    }
  }

  // Assemble results.
  const results: MethodResult[] = allMethods.map((method) => {
    const pulsePairs = trackers.get(method)!.getSeries().map((s) => {
      const label = `${conns.get(s.a)?.label ?? s.a} − ${conns.get(s.b)?.label ?? s.b}`;
      const errs: number[] = [];
      for (const p of s.points) {
        const e = tS(p.t);
        if (e >= warmupS) errs.push(p.errMs);
        series.push({ tS: e, method, kind: "pulse", series: label, valueMs: p.errMs });
      }
      return { pair: label, stats: summarize(errs) };
    });
    const absolute = [...(absErrors.get(method) ?? new Map()).entries()].map(([connection, errs]) => ({
      connection,
      stats: summarize(errs),
    }));

    const mine = ptts.get(method)!;
    let ptt: MethodResult["ptt"] = null;
    if (mine.size > 0) {
      const values: number[] = [];
      const vsTruth: number[] = [];
      const truthPtts = hasTruth ? ptts.get(TRUTH)! : null;
      for (const [k, v] of mine) {
        if (v.tS < warmupS) continue;
        values.push(v.ptt);
        series.push({ tS: v.tS, method, kind: "ptt", series: "ptt", valueMs: v.ptt });
        const tv = truthPtts?.get(k);
        if (tv) vsTruth.push(v.ptt - tv.ptt);
      }
      ptt = { stats: summarize(values), errorVsTruth: truthPtts && method !== TRUTH ? summarize(vsTruth) : null };
    }
    return { method, pulsePairs, absolute, ptt };
  });

  return {
    recording: {
      name: meta.name,
      durationS: (tEnd - t0) / 1000,
      connections: meta.connections.map((c) => ({ key: c.key, label: c.label, transport: c.transportKind })),
    },
    warmupS,
    hasTruth,
    methods: results,
    series,
  };
}

/** Plain-text table of a report, for terminals and notes. */
export function formatReport(r: SyncEvalReport): string {
  const f = (v: number) => (Number.isFinite(v) ? v.toFixed(2).padStart(8) : "     n/a");
  const lines = [
    `${r.recording.name}: ${r.recording.durationS.toFixed(0)} s, warm-up ${r.warmupS} s excluded, ${r.hasTruth ? "simulator truth available" : "no clock truth (hardware)"}`,
    "",
    "Pulse-pair sync error (device a − device b), ms",
    `${"method".padEnd(24)}${"n".padStart(7)}${"mean".padStart(8)}${"rmse".padStart(8)}${"sd".padStart(8)}${"p95|e|".padStart(8)}${"max|e|".padStart(8)}`,
  ];
  for (const m of r.methods) {
    for (const p of m.pulsePairs) {
      const s = p.stats;
      lines.push(`${m.method.padEnd(24)}${String(s.n).padStart(7)}${f(s.meanMs)}${f(s.rmseMs)}${f(s.sdMs)}${f(s.p95AbsMs)}${f(s.maxAbsMs)}`);
    }
  }
  if (r.hasTruth) {
    lines.push("", "Absolute mapping error vs simulator truth, ms (includes the unobservable minimum one-way delay)");
    for (const m of r.methods) {
      for (const a of m.absolute) {
        const s = a.stats;
        lines.push(`${(m.method + " / " + a.connection).padEnd(48)} mean${f(s.meanMs)} rmse${f(s.rmseMs)} max${f(s.maxAbsMs)}`);
      }
    }
  }
  lines.push("", "Pulse transit time (ECG R-peak → PPG max upstroke), ms");
  for (const m of r.methods) {
    if (!m.ptt) continue;
    const s = m.ptt.stats;
    const e = m.ptt.errorVsTruth;
    lines.push(
      `${m.method.padEnd(24)} n=${String(s.n).padStart(5)} mean${f(s.meanMs)} sd${f(s.sdMs)}` +
        (e ? `   error vs truth: mean${f(e.meanMs)} rmse${f(e.rmseMs)} max${f(e.maxAbsMs)}` : "")
    );
  }
  return lines.join("\n");
}

export function seriesToCsv(rows: SeriesRow[]): string {
  return ["t_s,method,kind,series,value_ms", ...rows.map((r) => `${r.tS.toFixed(3)},${r.method},${r.kind},"${r.series}",${r.valueMs.toFixed(4)}`)].join("\n") + "\n";
}
