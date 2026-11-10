import { useAppStore } from "../state/appStore";
import { href } from "../state/router";
import type { ConnectionView, SyncPairView } from "../session/sessionManager";
import { CLOCK_METHODS } from "../time/clock";
import { Histogram } from "../components/charts/Histogram";
import { TimeSeriesChart } from "../components/charts/TimeSeriesChart";
import { DataTable } from "../components/ui/DataTable";
import { fmt, fmtClock } from "../components/ui/format";
import { Icon } from "../components/ui/Icon";
import { Badge, Callout, EmptyState, Metric, PageHeader, Panel, SourceBadge, Tip, TransportBadge } from "../components/ui/primitives";

const PLOT_WINDOW_S = 120;
const HIST_N = 600;

function truthSource(conns: ConnectionView[]): { label: string; simulated: boolean } {
  const kinds = new Set(conns.map((c) => c.source));
  if (kinds.has("simulated")) return { label: "Simulated sync rig (one software pulse seen by every simulated node)", simulated: true };
  if (kinds.has("replay")) return { label: "Sync pulses in a replayed recording", simulated: false };
  return { label: "Hardware sync rig (GPIO pulse wired to every node)", simulated: false };
}

function PairPanel({ pair, conns }: { pair: SyncPairView; conns: ConnectionView[] }) {
  const members = conns.filter((c) => c.label === pair.a || c.label === pair.b);
  const truth = truthSource(members);
  const pts = pair.series;
  const end = pts.length ? pts[pts.length - 1].t : 0;
  const visible = pts.filter((p) => p.t >= end - PLOT_WINDOW_S * 1000).map((p) => ({ x: (p.t - end) / 1000, y: p.errMs }));
  const s = pair.stats;

  return (
    <Panel
      title={
        <>
          {pair.a} <span className="muted">−</span> {pair.b}
        </>
      }
      sub="pulse-edge timestamp difference after clock mapping"
      tools={[...new Set(members.map((m) => m.source))].map((s) => <SourceBadge key={s} source={s} />)}
    >
      <div className="metrics">
        <Metric label="Edges (n)" value={s.n} sub={`last ${HIST_N} max`} />
        <Metric label="Mean (bias)" value={fmt(s.meanMs, 3)} unit="ms" />
        <Metric label="RMSE" value={fmt(s.rmseMs, 3)} unit="ms" tone={s.n ? (s.rmseMs > 5 ? "fail" : s.rmseMs > 2 ? "warn" : "ok") : undefined} tip="Root-mean-square error, including the bias." />
        <Metric label="SD" value={fmt(s.sdMs, 3)} unit="ms" />
        <Metric label="p95 |error|" value={fmt(s.p95AbsMs, 3)} unit="ms" />
        <Metric label="Max |error|" value={fmt(s.maxAbsMs, 3)} unit="ms" />
      </div>
      <div className="grid main-side" style={{ marginTop: 12 }}>
        <div>
          <div className="wave-head">
            <strong>Sync error over time</strong>
            <span className="muted">last {PLOT_WINDOW_S} s</span>
          </div>
          <TimeSeriesChart
            series={[{ label: "error", color: "--series-2", points: visible, mode: "points" }]}
            xDomain={[-PLOT_WINDOW_S, 0]}
            symmetric
            refY={0}
            xLabel="Time relative to newest edge (s)"
            yLabel="Error a − b (ms)"
            yFormat={(v) => String(Number(v.toFixed(2)))}
            height={210}
            emptyText="Waiting for pulse edges…"
          />
        </div>
        <div>
          <div className="wave-head">
            <strong>Residual distribution</strong>
            <span className="muted">last {Math.min(HIST_N, pts.length)} edges</span>
          </div>
          <Histogram values={pts.slice(-HIST_N).map((p) => p.errMs)} xLabel="Error a − b (ms)" color="--series-2" height={210} emptyText="Waiting for pulse edges…" />
        </div>
      </div>
      <div className="inline-list" style={{ marginTop: 10 }}>
        <span>
          <Icon name="info" size={12} /> Ground truth: {truth.label}
        </span>
      </div>
      {truth.simulated && (
        <div style={{ marginTop: 8 }}>
          <Callout tone="model" icon="sim">
            Simulated result. The delays, jitter and clock drift come from the transport models in the simulator; these numbers are not hardware measurements.
          </Callout>
        </div>
      )}
    </Panel>
  );
}

export function SyncPage() {
  const { session } = useAppStore();
  const pairs = session.listSyncPairs();
  const conns = session.listConnections();
  const timed = conns.filter((c) => c.clock !== null && c.clock.observations > 0);

  return (
    <div className="page">
      <PageHeader
        section="RESEARCH"
        title="Clock Synchronization"
        purpose={
          <>
            Each device stamps samples with its own clock; a clock-sync method maps those stamps onto this computer's time. When devices share a sync rig, every pulse
            edge is stamped by each of them, so the gap between their mapped times is the <strong>measured sync error</strong>.
          </>
        }
        context={
          <Badge tone="outline" icon="clock">
            New connections use: {CLOCK_METHODS.find((m) => m.id === session.clockMethod)?.label}
          </Badge>
        }
      />

      <Panel title="Method for new connections" sub="connections keep the method they started with; reconnect or replay a recording to compare methods" flush>
        <div className="method-grid" role="radiogroup" aria-label="Clock-sync method">
          {CLOCK_METHODS.map((m) => {
            const on = session.clockMethod === m.id;
            return (
              <button key={m.id} role="radio" aria-checked={on} className={on ? "method selected" : "method"} onClick={() => session.setClockMethod(m.id)}>
                <span className="m-radio" aria-hidden>
                  {on ? "◉" : "○"}
                </span>
                <span>
                  <span className="cell-main">{m.label}</span>
                  <code className="small muted" style={{ display: "block" }}>{m.id}</code>
                  <span className="cell-sub" style={{ display: "block" }}>
                    {m.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </Panel>

      <Panel title="Per-device clock estimates" sub="current state of each connection's clock mapper" flush>
        <DataTable
          rows={timed}
          rowKey={(c) => c.id}
          onRowClick={(c) => (window.location.hash = href("devices", c.id))}
          empty={<EmptyState icon="clock" title="No timestamped connections">Devices that timestamp their data (Node A, Node B, sync node, some benchmark devices) appear here.</EmptyState>}
          columns={[
            { key: "dev", header: "Device", cell: (c) => <span className="cell-main">{c.label}</span>, sort: (c) => c.label },
            { key: "src", header: "Source", cell: (c) => <SourceBadge source={c.source} /> },
            { key: "tr", header: "Transport", cell: (c) => <TransportBadge kind={c.descriptor.transport.kind} /> },
            { key: "m", header: "Method", mono: true, cell: (c) => c.clockMapper },
            {
              key: "zero",
              header: <Tip label="Device clock zero">Host time at which the device clock read 0 (the estimated offset between the clocks).</Tip>,
              align: "num",
              mono: true,
              cell: (c) => (c.clock?.bootHostMs == null ? "—" : `${fmtClock(c.clock.bootHostMs)}.${String(Math.floor(c.clock.bootHostMs % 1000)).padStart(3, "0")}`),
            },
            {
              key: "skew",
              header: <Tip label="Skew (ppm)">Device clock rate relative to the host. Offset-only methods do not estimate it.</Tip>,
              align: "num",
              cell: (c) => (c.clock?.skewPpm == null ? <span className="muted">not estimated</span> : fmt(c.clock.skewPpm, 1)),
              sort: (c) => c.clock?.skewPpm ?? 0,
            },
            {
              key: "ci",
              header: <Tip label="BLE CI (ms)">BLE connection interval inferred from notification arrival phase (transport-aware method only).</Tip>,
              align: "num",
              cell: (c) => (c.descriptor.transport.kind !== "ble" ? <span className="muted">n/a</span> : c.clock?.ciMs == null ? <span className="muted">not inferred</span> : fmt(c.clock.ciMs, 2)),
            },
            { key: "obs", header: "Observations", align: "num", cell: (c) => (c.clock?.observations ?? 0).toLocaleString(), sort: (c) => c.clock?.observations ?? 0 },
          ]}
        />
      </Panel>

      {pairs.length === 0 ? (
        <Panel title="Measured sync error">
          <EmptyState icon="clock" title="No pulse pairs yet" action={<a className="btn" href={href("devices")}>Connect devices</a>}>
            Connect two devices that see the same sync pulses: Simulated Node A and Simulated Node B, or two BioBridge nodes with GPIO 4 wired to one pulse source
            (firmware/README.md).
          </EmptyState>
        </Panel>
      ) : (
        pairs.map((p) => <PairPanel key={p.key} pair={p} conns={conns} />)
      )}
      <p className="small muted" style={{ marginTop: 12 }}>
        The first seconds use an offset-only estimate; the skew fit starts after 5 s of data and uses a 120 s window. Offline evaluation over many seeds:{" "}
        <code>npm run eval:sync</code>.
      </p>
    </div>
  );
}
