import { compileDescriptor, type DecodedSample } from "../descriptors/compile";
import type { Descriptor } from "../descriptors/types";
import type { RecordedChunk } from "../session/recording";

// Ground-truth scoring of a synthesized descriptor. Runs only after the synthesis loop has finished and is
// never shown to the model: the loop itself sees only the validator and the verifier.

export type ChannelScore = {
  channel: string;
  expected: number;
  decoded: number;
  /** Samples equal to ground truth in value (and in device timestamp, when ground truth has one), by position. */
  matched: number;
  fraction: number;
};

export type SynthScore = {
  channels: ChannelScore[];
  /** Mean per-channel match fraction over the required channels. */
  fieldAccuracy: number;
  /** Every required channel matches on at least 99% of samples. */
  success: boolean;
};

function decodeAll(d: Descriptor, chunks: RecordedChunk[]): Map<string, DecodedSample[]> {
  const out = new Map<string, DecodedSample[]>();
  const dec = compileDescriptor(d);
  for (const c of chunks) {
    for (const s of dec.push(c.bytes).samples) {
      if (!out.has(s.channel)) out.set(s.channel, []);
      out.get(s.channel)!.push(s);
    }
  }
  return out;
}

const sameValue = (a: number, b: number) => Math.abs(a - b) <= 1e-6 + 1e-4 * Math.abs(b);

export function scoreDescriptor(
  candidate: Descriptor | null,
  groundTruth: Descriptor,
  deviceChunks: RecordedChunk[],
  requiredChannels: string[]
): SynthScore {
  const truth = decodeAll(groundTruth, deviceChunks);
  let got = new Map<string, DecodedSample[]>();
  if (candidate) {
    try {
      got = decodeAll(candidate, deviceChunks);
    } catch {
      // A descriptor that crashes the decoder scores zero.
    }
  }
  const channels = requiredChannels.map((channel) => {
    const want = truth.get(channel) ?? [];
    const have = got.get(channel) ?? [];
    let matched = 0;
    for (let i = 0; i < want.length && i < have.length; i++) {
      const tsOk =
        want[i].deviceTimestampUs === undefined ||
        (have[i].deviceTimestampUs !== undefined && Math.abs(have[i].deviceTimestampUs! - want[i].deviceTimestampUs!) <= 1);
      if (tsOk && sameValue(have[i].value, want[i].value)) matched++;
    }
    return { channel, expected: want.length, decoded: have.length, matched, fraction: want.length ? matched / want.length : 0 };
  });
  const fieldAccuracy = channels.reduce((s, c) => s + c.fraction, 0) / Math.max(1, channels.length);
  return { channels, fieldAccuracy, success: channels.every((c) => c.fraction >= 0.99) };
}
