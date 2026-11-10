import { useEffect, useState } from "react";

// Availability of the local synthesis service (vite-plugin-synth.ts). Fetched once per page load and shared.
// The service holds the API keys; the browser only learns which models exist.

export type SynthModel = { id: string; label: string };
export type SynthServiceState = { status: "checking" } | { status: "unavailable" } | { status: "ready"; models: SynthModel[] };

let cached: Promise<SynthServiceState> | null = null;

function check(): Promise<SynthServiceState> {
  cached ??= fetch("/api/synth/models")
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((d: { models: SynthModel[] }) => ({ status: "ready" as const, models: d.models }))
    .catch(() => ({ status: "unavailable" as const }));
  return cached;
}

export function useSynthService(): SynthServiceState {
  const [state, setState] = useState<SynthServiceState>({ status: "checking" });
  useEffect(() => {
    let live = true;
    void check().then((s) => live && setState(s));
    return () => {
      live = false;
    };
  }, []);
  return state;
}
