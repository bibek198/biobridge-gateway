import { compileDescriptor } from "../descriptors/compile";
import type { Descriptor } from "../descriptors/types";
import type { RecordedChunk, RecordingMeta } from "../session/recording";
import { PpgUpstrokeDetector, RPeakDetector } from "../signal/landmarks";
import { crossSensorChecks, median, StreamVerifier, verdictOf, type CheckResult, type RateEstimate, type VerificationReport } from "./verifier";

export type RecordingVerification = {
  connections: { key: string; label: string; descriptorId: string; report: VerificationReport }[];
  crossSensor: CheckResult[];
  /** Overall verdict per connection, including the cross-sensor checks it takes part in. */
  verdicts: Record<string, VerificationReport["verdict"]>;
};

/** Median rate (bpm) from a list of beat times (ms); null if too few plausible intervals. */
function rateFromBeats(beats: number[]): number | null {
  const intervals = beats.slice(1).map((t, i) => t - beats[i]).filter((d) => d >= 250 && d <= 2500);
  const m = median(intervals);
  return m === null || intervals.length < 5 ? null : 60000 / m;
}

/**
 * Re-decodes a recording's raw bytes and verifies each connection. `descriptors` overrides the
 * descriptor recorded for a connection: this is how a candidate descriptor (hand-written or
 * LLM-proposed) is scored against a stored capture without the device present.
 */
export function verifyRecording(
  rec: { meta: RecordingMeta; chunks: RecordedChunk[] },
  descriptors: Record<string, Descriptor> = {}
): RecordingVerification {
  const conns = rec.meta.connections.map((c) => {
    const descriptor = descriptors[c.key] ?? c.descriptor;
    return {
      key: c.key,
      label: c.label,
      descriptor,
      decoder: compileDescriptor(descriptor),
      verifier: new StreamVerifier(descriptor),
      info: {} as Record<string, number | string>,
      rBeats: [] as number[],
      ppgBeats: [] as number[],
      deviceHr: [] as number[],
      rDetector: new RPeakDetector(),
      ppgDetector: new PpgUpstrokeDetector(),
    };
  });
  const byKey = new Map(conns.map((c) => [c.key, c]));

  for (const chunk of [...rec.chunks].sort((a, b) => a.t - b.t)) {
    const c = byKey.get(chunk.c);
    if (!c) continue;
    const out = c.decoder.push(chunk.bytes);
    if (out.info) {
      c.info = { ...c.info, ...out.info };
      c.verifier.setInfo(c.info);
    }
    for (const s of out.samples) {
      c.verifier.observe({ channel: s.channel, value: s.value, timestamp: chunk.t, deviceTimestampUs: s.deviceTimestampUs });
      // Beat detection runs on the device clock when there is one: it is what the descriptor claims.
      const t = s.deviceTimestampUs !== undefined ? s.deviceTimestampUs / 1000 : chunk.t;
      if (s.channel === "ecg") {
        const b = c.rDetector.push(t, s.value);
        if (b !== null) c.rBeats.push(b);
      } else if (s.channel === "ppg_ir") {
        const b = c.ppgDetector.push(t, s.value);
        if (b !== null) c.ppgBeats.push(b);
      } else if (s.channel === "heartRate") {
        c.deviceHr.push(s.value);
      }
    }
  }

  const estimates: RateEstimate[] = [];
  for (const c of conns) {
    const ecg = rateFromBeats(c.rBeats);
    const ppg = rateFromBeats(c.ppgBeats);
    const dev = median(c.deviceHr);
    if (ecg !== null) estimates.push({ source: c.label, kind: "ECG R-peak HR", bpm: ecg });
    if (ppg !== null) estimates.push({ source: c.label, kind: "PPG pulse rate", bpm: ppg });
    if (dev !== null) estimates.push({ source: c.label, kind: "device-reported HR", bpm: dev });
  }
  const crossSensor = crossSensorChecks(estimates);

  const connections = conns.map((c) => ({
    key: c.key,
    label: c.label,
    descriptorId: c.descriptor.id,
    report: c.verifier.report(c.decoder.stats),
  }));
  const verdicts: RecordingVerification["verdicts"] = {};
  for (const c of connections) {
    const mine = crossSensor.filter((x) => x.name.includes(`(${c.label})`));
    verdicts[c.key] = verdictOf([...c.report.checks, ...mine]);
  }
  return { connections, crossSensor, verdicts };
}
