import { useState } from "react";
import { useAppStore } from "../state/appStore";
import { href } from "../state/router";
import { ENERGY_MODEL } from "../placement/energy";
import type { PlacementView } from "../session/sessionManager";
import { DataTable } from "../components/ui/DataTable";
import { errorText, fmt } from "../components/ui/format";
import { Badge, Callout, EmptyState, Metric, ModelledBadge, NotMeasured, PageHeader, Panel, SourceBadge, TransportBadge } from "../components/ui/primitives";

const MODES = [
  { id: 0, name: "Raw", where: "Browser", link: "All samples", tradeoff: "Most radio traffic; the node does no DSP. Results computed here in Wasm." },
  { id: 1, name: "Edge", where: "Device", link: "Results only", tradeoff: "Least traffic; the node runs the DSP. No waveform reaches the browser." },
  { id: 2, name: "Gated", where: "Device", link: "Results + samples on low quality", tradeoff: "Raw samples sent only while the node's signal-quality check wants a person to look." },
  { id: 3, name: "Both", where: "Both", link: "Samples + results", tradeoff: "Most traffic and both DSP costs. For comparing the two placements on the same data." },
];
const COMMAND_MODE: Record<string, number> = { "mode-raw": 0, "mode-edge": 1, "mode-gated": 2, "mode-both": 3 };

function NodePanel({ view, source }: { view: PlacementView; source: "simulated" | "hardware" | "replay" }) {
  const { session } = useAppStore();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(id: string) {
    setBusy(true);
    setError(null);
    try {
      await session.sendCommand(view.id, id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const power = view.power?.totalMw ?? view.power?.dspMw ?? null;
  return (
    <Panel
      title={view.label}
      sub={view.mode === null ? "mode unknown: no STATS frame yet" : `reported mode: ${MODES[view.mode]?.name ?? view.mode}`}
      tools={
        <>
          <SourceBadge source={source} />
          <TransportBadge kind={view.transport} />
        </>
      }
    >
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <div className="field">
          <span>Placement mode (sent as a CONFIG command)</span>
          <div className="btn-group" role="radiogroup" aria-label="Placement mode">
            {view.commands.map((c) => (
              <button
                key={c.id}
                role="radio"
                aria-checked={COMMAND_MODE[c.id] === view.mode}
                title={c.description}
                className={`btn small ${COMMAND_MODE[c.id] === view.mode ? "selected" : ""}`}
                disabled={busy}
                onClick={() => void send(c.id)}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>
        {busy && <span className="muted small">sending…</span>}
        {error && <span className="error-text">{error}</span>}
      </div>
      <div className="metrics">
        <Metric label="Link traffic" value={fmt(view.linkBytesPerS, 0)} unit="B/s" sub="device-reported (STATS)" />
        <Metric
          label="DSP on device"
          value={fmt(view.deviceDspUsPerS === null ? null : view.deviceDspUsPerS / 1000, 2)}
          unit="ms/s"
          sub={source === "simulated" ? "simulator: this computer's CPU time" : "device-reported (STATS)"}
        />
        <Metric label="DSP in browser" value={fmt(view.browserDspMsPerS, 2)} unit="ms/s" sub="Wasm, measured here" />
        <Metric
          label="Node power"
          value={fmt(power, 2)}
          unit="mW"
          sub={
            <>
              <ModelledBadge /> {view.transport === "ble" ? "radio + DSP" : "DSP only; USB powers the link"}
            </>
          }
          tip={`First-order model, not a measurement: BLE ${ENERGY_MODEL.bleJoulesPerPayloadByte * 1e6} µJ per payload byte and ${ENERGY_MODEL.cpuActiveWatts * 1000} mW of CPU while the DSP runs (src/placement/energy.ts).`}
        />
        <Metric label="Memory" value={<NotMeasured why="Neither the firmware nor the browser reports DSP memory use" />} sub="not reported by the node" />
      </div>
      {view.results.length > 0 && (
        <div style={{ marginTop: 12, border: "1px solid var(--border)", borderRadius: 5 }}>
          <DataTable
            rows={view.results}
            rowKey={(r) => r.label}
            columns={[
              { key: "l", header: "Result", cell: (r) => <span className="cell-main">{r.label}</span> },
              { key: "d", header: "On device", align: "num", cell: (r) => (r.device === null ? "—" : `${fmt(r.device, r.unit ? 1 : 2)} ${r.unit}`) },
              { key: "b", header: "In browser (Wasm)", align: "num", cell: (r) => (r.browser === null ? "—" : `${fmt(r.browser, r.unit ? 1 : 2)} ${r.unit}`) },
              {
                key: "diff",
                header: "Difference",
                align: "num",
                cell: (r) => (r.device === null || r.browser === null ? <span className="muted">needs both</span> : `${fmt(r.browser - r.device, r.unit ? 1 : 3)} ${r.unit}`),
              },
            ]}
          />
        </div>
      )}
    </Panel>
  );
}

export function PlacementPage() {
  const { session } = useAppStore();
  const views = session.listPlacement();
  const conns = session.listConnections();
  const sourceOf = (id: string) => conns.find((c) => c.id === id)?.source ?? "hardware";

  return (
    <div className="page">
      <PageHeader
        section="RESEARCH"
        title="Compute Placement"
        purpose="The ECG/PPG processing is one C library (bbdsp). It runs on the node, or compiled to WebAssembly in this browser, or both. Compare link traffic, compute cost and results per placement."
        context={<ModelledBadge />}
      />

      <Panel title="Placement modes" flush>
        <DataTable
          rows={MODES}
          rowKey={(m) => m.name}
          columns={[
            { key: "n", header: "Mode", cell: (m) => <span className="cell-main">{m.name}</span>, width: 90 },
            { key: "w", header: "DSP runs on", cell: (m) => m.where, width: 120 },
            { key: "l", header: "Sent over the link", cell: (m) => m.link, width: 230 },
            { key: "t", header: "Trade-off", cell: (m) => <span className="cell-sub">{m.tradeoff}</span> },
            {
              key: "on",
              header: "Nodes in mode",
              align: "num",
              cell: (m) => {
                const n = views.filter((v) => v.mode === m.id).length;
                return n ? <Badge tone="ok">{n}</Badge> : <span className="muted">0</span>;
              },
            },
          ]}
        />
      </Panel>

      {views.length > 1 && (
        <Panel title="Comparison" sub="all placement-capable nodes" flush>
          <DataTable
            rows={views}
            rowKey={(v) => v.id}
            columns={[
              { key: "n", header: "Node", cell: (v) => <span className="cell-main">{v.label}</span> },
              { key: "m", header: "Mode", cell: (v) => (v.mode === null ? "—" : MODES[v.mode]?.name) },
              { key: "l", header: "Link (B/s)", align: "num", cell: (v) => fmt(v.linkBytesPerS, 0), sort: (v) => v.linkBytesPerS ?? -1 },
              { key: "d", header: "Device DSP (ms/s)", align: "num", cell: (v) => fmt(v.deviceDspUsPerS === null ? null : v.deviceDspUsPerS / 1000, 2) },
              { key: "b", header: "Browser DSP (ms/s)", align: "num", cell: (v) => fmt(v.browserDspMsPerS, 2) },
              { key: "p", header: "Power, modelled (mW)", align: "num", cell: (v) => fmt(v.power?.totalMw ?? v.power?.dspMw ?? null, 2) },
            ]}
          />
        </Panel>
      )}

      {views.length === 0 ? (
        <Panel>
          <EmptyState icon="cpu" title="No placement-capable node connected" action={<a className="btn" href={href("devices")}>Connect a node</a>}>
            Connect Simulated Node A or B, or a BioBridge node with current firmware.
          </EmptyState>
        </Panel>
      ) : (
        views.map((v) => <NodePanel key={v.id} view={v} source={sourceOf(v.id)} />)
      )}
      <div style={{ marginTop: 12 }}>
        <Callout icon="info">
          Power is <strong>modelled</strong>, not measured: the INA219 current-sense rig will replace the model with measurements. Simulated nodes report this computer's CPU
          time as "device" DSP time, so device-side costs for simulated nodes do not represent an ESP32.
        </Callout>
      </div>
    </div>
  );
}
