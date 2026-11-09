import type { ChannelSpec, Descriptor, PlausibilitySpec } from "../descriptors/types";

// The platform's canonical channel vocabulary: names, units and physical bounds that every integration
// must use. Bounds come from physiology/physics, not from the device or the descriptor under test, so the
// plausibility oracle cannot be satisfied by a candidate that simply declares loose bounds.

export type VocabularyEntry = {
  unit: string;
  description: string;
  display: "waveform" | "scalar";
  bounds?: PlausibilitySpec;
};

export const VOCABULARY: Record<string, VocabularyEntry> = {
  ecg: { unit: "mV", description: "ECG at the electrodes", display: "waveform", bounds: { min: -10, max: 10 } },
  leadsOff: { unit: "", description: "leads-off flags (bit0 LO+, bit1 LO−)", display: "scalar", bounds: { min: 0, max: 3 } },
  ppg_ir: { unit: "a.u.", description: "infrared PPG intensity (raw, any scale)", display: "waveform" },
  ppg_red: { unit: "a.u.", description: "red PPG intensity (raw, any scale)", display: "waveform" },
  pleth: { unit: "a.u.", description: "plethysmogram waveform from an oximeter", display: "waveform" },
  heartRate: { unit: "bpm", description: "heart/pulse rate as reported by the device", display: "scalar", bounds: { min: 25, max: 250 } },
  spo2: { unit: "%", description: "oxygen saturation", display: "scalar", bounds: { min: 50, max: 100 } },
  perfusion: { unit: "%", description: "perfusion index", display: "scalar", bounds: { min: 0, max: 20 } },
  bp_systolic: { unit: "mmHg", description: "systolic blood pressure", display: "scalar", bounds: { min: 50, max: 260 } },
  bp_diastolic: { unit: "mmHg", description: "diastolic blood pressure", display: "scalar", bounds: { min: 30, max: 160 } },
  bp_mean: { unit: "mmHg", description: "mean arterial pressure", display: "scalar", bounds: { min: 40, max: 200 } },
  cuffPressure: { unit: "mmHg", description: "instantaneous cuff pressure", display: "scalar", bounds: { min: 0, max: 320 } },
  accel_x: { unit: "g", description: "acceleration, x axis", display: "waveform", bounds: { min: -16, max: 16 } },
  accel_y: { unit: "g", description: "acceleration, y axis", display: "waveform", bounds: { min: -16, max: 16 } },
  accel_z: { unit: "g", description: "acceleration, z axis", display: "waveform", bounds: { min: -16, max: 16 } },
  battery: { unit: "%", description: "battery level", display: "scalar", bounds: { min: 0, max: 100 } },
};

/**
 * What the verifier trusts about a candidate descriptor's channels: the platform vocabulary, not the
 * candidate's own claims. Display hints and plausibility bounds are replaced for every vocabulary channel.
 */
export function withPlatformChannelSemantics(d: Descriptor): Descriptor {
  const channels: ChannelSpec[] = d.channels.map((c) => {
    const v = VOCABULARY[c.id];
    return v ? { ...c, unit: v.unit, display: v.display } : c;
  });
  // Channels can appear without being declared (text formats emit whatever names they read), so every
  // vocabulary id gets its semantics, declared or not.
  for (const [id, v] of Object.entries(VOCABULARY)) {
    if (!channels.some((c) => c.id === id)) channels.push({ id, unit: v.unit, display: v.display });
  }
  const plausibility: Record<string, PlausibilitySpec> = {};
  for (const [id, v] of Object.entries(VOCABULARY)) if (v.bounds) plausibility[id] = v.bounds;
  return { ...d, channels, plausibility };
}
