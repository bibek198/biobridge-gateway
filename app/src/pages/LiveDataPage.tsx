import { useState } from "react";
import { useAppStore } from "../state/appStore";
import { href } from "../state/router";
import type { DeviceReading } from "../drivers/types";
import type { ConnectionView } from "../session/sessionManager";
import { channelLabel, channelSource } from "../components/domain";
import { TimeSeriesChart } from "../components/charts/TimeSeriesChart";
import { fmt, readable } from "../components/ui/format";
import { Icon } from "../components/ui/Icon";
import { Badge, EmptyState, PageHeader, Panel, Segmented, SourceBadge, StatusBadge } from "../components/ui/primitives";

type Snapshot = Map<string, DeviceReading[]>;
const WINDOWS = [
  { id: "2", label: "2 s" },
  { id: "5", label: "5 s" },
  { id: "10", label: "10 s" },
] as const;

function DeviceSection({ conn, windowS, snapshot }: { conn: ConnectionView; windowS: number; snapshot: Snapshot | null }) {
  const { session } = useAppStore();
  const declared = new Map(conn.descriptor.channels.map((c) => [c.id, c]));
  const channels = session.getChannels(conn.id);
  const waveforms = conn.descriptor.channels.filter((c) => c.display === "waveform" && channels.includes(c.id));
  const scalars = channels.filter((ch) => {
    const spec = declared.get(ch);
    return spec ? spec.display !== "waveform" && spec.display !== "hidden" : true;
  });
  const rate = new Map(conn.channels.map((c) => [c.id, c.rateHz]));
  const severity = (ch: string) => session.alerts.find((a) => a.source === conn.label && a.channel === ch)?.severity ?? "info";
  const buf = (ch: string) => snapshot?.get(`${conn.id}:${ch}`) ?? session.getBuffer(conn.id, ch);
  const latest = (ch: string) => {
    const b = snapshot?.get(`${conn.id}:${ch}`);
    return b ? b[b.length - 1] : session.getLatest(conn.id, ch);
  };

  return (
    <Panel
      title={conn.label}
      sub={conn.descriptor.id}
      tools={
        <>
          <SourceBadge source={conn.source} />
          <StatusBadge status={conn.status} />
          <a className="btn small" href={href("devices", conn.id)}>
            Inspect
          </a>
        </>
      }
    >
      {channels.length === 0 && <div className="muted">Waiting for data…</div>}
      <div className="spaced">
        {waveforms.map((c) => {
          const data = buf(c.id);
          const end = data.length ? data[data.length - 1].timestamp : 0;
          const pts = data.filter((r) => r.timestamp >= end - windowS * 1000).map((r) => ({ x: (r.timestamp - end) / 1000, y: r.value }));
          const r = rate.get(c.id);
          return (
            <div key={c.id}>
              <div className="wave-head">
                <strong>{c.label ?? c.id}</strong>
                <code className="small">{c.id}</code>
                <span className="muted">{r == null ? "rate —" : `${fmt(r, 1)} Hz measured`}</span>
                <span className="value">{pts.length ? `${readable(pts[pts.length - 1].y)} ${c.unit ?? ""}` : "—"}</span>
              </div>
              <TimeSeriesChart
                series={[{ label: c.label ?? c.id, color: "--series-1", points: pts }]}
                xDomain={[-windowS, 0]}
                xLabel="Time relative to newest sample (s)"
                yLabel={c.unit ? `${c.id} (${c.unit})` : c.id}
                gapX={0.25}
                height={170}
                emptyText="Waiting for samples…"
              />
            </div>
          );
        })}
      </div>
      {scalars.length > 0 && (
        <div className="vitals" style={{ marginTop: waveforms.length ? 16 : 0, border: "1px solid var(--border)", borderRadius: 5 }}>
          {scalars.map((ch) => {
            const reading = latest(ch);
            const sev = severity(ch);
            return (
              <div key={ch} className={`vital ${sev}`}>
                <div className="v-label">
                  {channelLabel(ch, conn.descriptor)}
                  {sev !== "info" && (
                    <>
                      {" "}
                      <Badge tone={sev === "critical" ? "fail" : "warn"} icon="warn">
                        {sev}
                      </Badge>
                    </>
                  )}
                </div>
                <div className="v-value">
                  {reading ? readable(reading.value) : "—"}
                  <span className="v-unit">{reading?.unit ?? declared.get(ch)?.unit ?? ""}</span>
                </div>
                <div className="v-src">
                  {channelSource(ch)}
                  {rate.get(ch) != null && ` · ${fmt(rate.get(ch)!, rate.get(ch)! < 10 ? 2 : 1)} Hz`}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

export function LiveDataPage() {
  const { session } = useAppStore();
  const conns = session.listConnections();
  const [selected, setSelected] = useState<string>("all");
  const [windowS, setWindowS] = useState<"2" | "5" | "10">("5");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const shown = selected === "all" ? conns : conns.filter((c) => c.id === selected);
  const sources = [...new Set(shown.map((c) => c.source))];

  function togglePause() {
    if (snapshot) return setSnapshot(null);
    const snap: Snapshot = new Map();
    for (const c of conns) for (const ch of session.getChannels(c.id)) snap.set(`${c.id}:${ch}`, session.getBuffer(c.id, ch));
    setSnapshot(snap);
  }

  return (
    <div className="page">
      <PageHeader
        section="MONITOR"
        title="Live Data"
        purpose="Decoded waveforms and derived values per device, on the host timeline after clock mapping. Values are labelled with where they were computed."
        context={
          <>
            {sources.map((s) => (
              <SourceBadge key={s} source={s} />
            ))}
            {snapshot ? (
              <Badge tone="warn" icon="pause">
                Paused · still buffering
              </Badge>
            ) : (
              <Badge tone="live" pulse>
                Live
              </Badge>
            )}
          </>
        }
        actions={
          <>
            <label className="field">
              <span>Device</span>
              <select className="input" value={selected} onChange={(e) => setSelected(e.target.value)}>
                <option value="all">All devices ({conns.length})</option>
                {conns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="field">
              <span>Window</span>
              <Segmented label="Time window" options={[...WINDOWS]} value={windowS} onChange={setWindowS} />
            </div>
            <div className="field">
              <span>&nbsp;</span>
              <button className={snapshot ? "btn primary" : "btn"} onClick={togglePause} aria-pressed={!!snapshot}>
                <Icon name={snapshot ? "play" : "pause"} /> {snapshot ? "Resume" : "Pause"}
              </button>
            </div>
          </>
        }
      />
      {sources.includes("simulated") && (
        <p className="small muted" style={{ margin: "-4px 0 12px" }}>
          <Icon name="sim" size={12} /> Simulated devices show synthetic physiology from the software subject model, not measurements of a person.
        </p>
      )}
      {shown.length === 0 ? (
        <Panel>
          <EmptyState icon="live" title="No devices connected" action={<a className="btn" href={href("devices")}>Go to Devices</a>}>
            Connect a simulated or hardware device to see its data here.
          </EmptyState>
        </Panel>
      ) : (
        shown.map((c) => <DeviceSection key={c.id} conn={c} windowS={Number(windowS)} snapshot={snapshot} />)
      )}
    </div>
  );
}
