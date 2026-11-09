import { useState } from "react";
import { useAppStore } from "../state/appStore";
import { ENERGY_MODEL } from "../placement/energy";
import type { PlacementView } from "../session/sessionManager";

const MODE_NAMES = ["Raw", "Edge", "Gated", "Both"];
const COMMAND_MODE: Record<string, number> = { "mode-raw": 0, "mode-edge": 1, "mode-gated": 2, "mode-both": 3 };

const fmt = (v: number | null, digits = 1) => (v === null || !Number.isFinite(v) ? "—" : v.toFixed(digits));

function DeviceCard({ view }: { view: PlacementView }) {
  const { session } = useAppStore();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(id: string) {
    setBusy(true);
    setError(null);
    try {
      await session.sendCommand(view.id, id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section">
      <h3>
        {view.label}{" "}
        <span className="chip">{view.mode === null ? "mode unknown (no STATS yet)" : `mode: ${MODE_NAMES[view.mode] ?? view.mode}`}</span>
      </h3>
      <div className="row-actions">
        {view.commands.map((c) => (
          <button
            key={c.id}
            title={c.description}
            className={COMMAND_MODE[c.id] === view.mode ? "primary-button" : "secondary-button"}
            disabled={busy}
            onClick={() => void send(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>
      {error && <p className="error-text">{error}</p>}

      <div className="tile-grid placement-tiles">
        <div className="tile">
          <div className="tile-label">Link traffic (device-reported)</div>
          <div className="tile-value">
            {fmt(view.linkBytesPerS, 0)}
            <span className="tile-unit">B/s</span>
          </div>
        </div>
        <div className="tile">
          <div className="tile-label">DSP on the device</div>
          <div className="tile-value">
            {fmt(view.deviceDspUsPerS === null ? null : view.deviceDspUsPerS / 1000, 2)}
            <span className="tile-unit">ms/s</span>
          </div>
        </div>
        <div className="tile">
          <div className="tile-label">DSP in this browser (Wasm)</div>
          <div className="tile-value">
            {fmt(view.browserDspMsPerS, 2)}
            <span className="tile-unit">ms/s</span>
          </div>
        </div>
        <div className="tile">
          <div className="tile-label">Node power, modelled ({view.transport === "ble" ? "radio + DSP" : "DSP; USB powers the link"})</div>
          <div className="tile-value">
            {fmt(view.power?.totalMw ?? view.power?.dspMw ?? null, 2)}
            <span className="tile-unit">mW</span>
          </div>
        </div>
      </div>

      {view.results.length > 0 && (
        <table className="placement-table">
          <thead>
            <tr>
              <th>Result</th>
              <th>Computed on device</th>
              <th>Computed in browser (Wasm)</th>
            </tr>
          </thead>
          <tbody>
            {view.results.map((r) => (
              <tr key={r.label}>
                <td>{r.label}</td>
                <td>
                  {fmt(r.device, r.unit ? 1 : 2)} {r.device !== null && r.unit}
                </td>
                <td>
                  {fmt(r.browser, r.unit ? 1 : 2)} {r.browser !== null && r.unit}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function PlacementPanel() {
  const { session } = useAppStore();
  const views = session.listPlacement();

  return (
    <div className="panel">
      <h2>Compute Placement</h2>
      <p className="panel-subtitle">
        The ECG/PPG processing (R-peaks and heart rate; pulse rate, SpO2 and signal quality) is one C library. It runs
        on the node in <strong>Edge</strong> mode and, compiled to WebAssembly, in this browser when the node streams
        <strong> Raw</strong> samples. <strong>Gated</strong> sends results always and raw samples only while the
        node's own quality check wants a person to look; <strong>Both</strong> does both, so the two placements can be
        compared on the same data.
      </p>
      {views.length === 0 ? (
        <p className="hint">
          No device that supports compute placement is connected. Connect Simulated Node A or B, or a BioBridge node with
          current firmware, on the Devices tab.
        </p>
      ) : (
        views.map((v) => <DeviceCard key={v.id} view={v} />)
      )}
      <p className="hint">
        Power is a first-order model, not a measurement: BLE {ENERGY_MODEL.bleJoulesPerPayloadByte * 1e6} µJ per
        payload byte and {ENERGY_MODEL.cpuActiveWatts * 1000} mW of CPU while the DSP runs (assumptions in
        src/placement/energy.ts). The INA219 rig replaces them with measured values. Simulated nodes report this
        computer's CPU time as "device" DSP time.
      </p>
    </div>
  );
}
