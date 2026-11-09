import { useAppStore } from "../state/appStore";
import { Waveform } from "./Waveform";
import { VOCABULARY } from "../bench/vocabulary";
import type { AlertSeverity } from "../compute/types";
import type { ConnectionView } from "../session/sessionManager";

/** Labels for channels produced by compute modules rather than devices. */
const DERIVED_LABELS: Record<string, string> = {
  heartRate_computed: "Heart Rate (computed from ECG)",
  spo2_filtered: "SpO2 (filtered)",
  pulseRate_ppg: "Pulse Rate (computed from PPG)",
  heartRate_wasm: "Heart Rate (firmware DSP in browser)",
  pulseRate_wasm: "Pulse Rate (firmware DSP in browser)",
  spo2_wasm: "SpO2 (firmware DSP in browser)",
  sqi_wasm: "Signal quality (firmware DSP in browser)",
};

/** Fallback for channels a descriptor did not label (e.g. synthesized ones): the platform vocabulary. */
function vocabularyLabel(ch: string): string {
  const d = VOCABULARY[ch]?.description;
  return d ? d.charAt(0).toUpperCase() + d.slice(1) : ch;
}

/** Device-computed values arrive as float32; show them at a precision a person can read. */
function displayValue(v: number): string {
  if (Number.isInteger(v)) return String(v);
  const a = Math.abs(v);
  return String(Number(v.toFixed(a >= 100 ? 1 : a >= 1 ? 2 : 3)));
}

function DeviceSection({ conn }: { conn: ConnectionView }) {
  const { session } = useAppStore();
  const declared = new Map(conn.descriptor.channels.map((c) => [c.id, c]));
  const channels = session.getChannels(conn.id);
  const waveforms = conn.descriptor.channels.filter((c) => c.display === "waveform" && channels.includes(c.id));
  const scalars = channels.filter((ch) => {
    const spec = declared.get(ch);
    return spec ? spec.display !== "waveform" && spec.display !== "hidden" : true;
  });

  const severity = (channel: string): AlertSeverity =>
    session.alerts.find((a) => a.source === conn.label && a.channel === channel)?.severity ?? "info";

  return (
    <section className="section">
      <h3>
        {conn.label} <span className={`status-badge status-${conn.status}`}>{conn.status}</span>
      </h3>
      {channels.length === 0 && <p className="hint">Waiting for data…</p>}
      {waveforms.map((c) => (
        <Waveform key={c.id} connectionId={conn.id} channel={c.id} label={`${c.label ?? c.id}${c.unit ? ` (${c.unit})` : ""}`} />
      ))}
      {scalars.length > 0 && (
        <div className="tile-grid">
          {scalars.map((ch) => {
            const reading = session.getLatest(conn.id, ch);
            return (
              <div key={ch} className={`tile tile-${severity(ch)}`}>
                <div className="tile-label">{declared.get(ch)?.label ?? DERIVED_LABELS[ch] ?? vocabularyLabel(ch)}</div>
                <div className="tile-value">
                  {reading ? displayValue(reading.value) : "—"}
                  <span className="tile-unit">{reading?.unit ?? ""}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function LiveDataPanel() {
  const { session } = useAppStore();
  const connections = session.listConnections();

  return (
    <div className="panel">
      <h2>Live Data</h2>
      {connections.length === 0 && <p className="hint">No devices connected. Add one on the Devices tab.</p>}
      {connections.map((c) => (
        <DeviceSection key={c.id} conn={c} />
      ))}
    </div>
  );
}
