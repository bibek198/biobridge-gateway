import { useAppStore } from "../state/appStore";
import { href } from "../state/router";
import { CLOCK_METHODS } from "../time/clock";
import { hostNowMs } from "../time/clock";
import { ArchitectureDiagram } from "./ArchitectureDiagram";
import { DataTable } from "../components/ui/DataTable";
import { fmt, fmtAge, fmtClock } from "../components/ui/format";
import { Icon } from "../components/ui/Icon";
import { Badge, EmptyState, Metric, PageHeader, Panel, SeverityBadge, SourceBadge, StatusBadge, VerdictBadge } from "../components/ui/primitives";

const MODE_NAMES = ["Raw", "Edge", "Gated", "Both"];

export function OverviewPage() {
  const { session } = useAppStore();
  const conns = session.listConnections();
  const live = conns.filter((c) => c.status === "connected");
  const streams = live.flatMap((c) => c.channels.filter((ch) => ch.rateHz !== null));
  const pairs = session.listSyncPairs().filter((p) => p.stats.n > 0);
  const best = pairs.length ? pairs.reduce((a, b) => (a.stats.rmseMs <= b.stats.rmseMs ? a : b)) : null;
  const placement = session.listPlacement();
  const diags = session.diagnostics();
  const crit = diags.filter((d) => d.severity === "critical").length;
  const warn = diags.filter((d) => d.severity === "warning").length;
  const method = CLOCK_METHODS.find((m) => m.id === session.clockMethod);
  const sources = [...new Set(live.map((c) => c.source))];
  const now = hostNowMs();
  const rec = session.activeRecording;

  return (
    <div className="page">
      <PageHeader
        section="MONITOR"
        title="Overview"
        purpose="Current state of the acquisition session: connected devices, their streams, clock-sync quality, compute placement and open diagnostics."
        context={
          <>
            {sources.length === 0 ? <Badge tone="muted">No live data</Badge> : sources.map((s) => <SourceBadge key={s} source={s} />)}
            <Badge tone="outline" icon="clock">
              Clock method: {method?.label}
            </Badge>
            {rec && (
              <Badge tone="fail" pulse>
                Recording
              </Badge>
            )}
          </>
        }
        actions={
          <a className="btn" href={href("devices")}>
            <Icon name="add" /> Connect a device
          </a>
        }
      />

      <div className="metrics">
        <Metric label="Connected devices" value={live.length} sub={`${conns.length} connection${conns.length === 1 ? "" : "s"} in session`} />
        <Metric
          label="Active streams"
          value={streams.length}
          sub={streams.length ? `${fmt(Math.max(...streams.map((s) => s.rateHz ?? 0)), 0)} Hz fastest (measured)` : "no channel streaming"}
        />
        <Metric
          label="Sync error (RMS)"
          value={best ? fmt(best.stats.rmseMs, 2) : "—"}
          unit={best ? "ms" : undefined}
          tone={best ? (best.stats.rmseMs > 5 ? "fail" : best.stats.rmseMs > 2 ? "warn" : "ok") : undefined}
          sub={best ? `${best.a} − ${best.b}, ${best.stats.n} edges` : "no synced device pair"}
          tip="Root-mean-square difference between two devices' mapped timestamps of the same sync-pulse edge. Needs two devices on one sync rig."
        />
        <Metric
          label="Compute placement"
          value={placement.length ? placement.map((p) => (p.mode === null ? "?" : MODE_NAMES[p.mode] ?? p.mode)).join(" / ") : "—"}
          sub={placement.length ? `${placement.length} node${placement.length > 1 ? "s" : ""} accept mode commands` : "no placement-capable node"}
        />
        <Metric label="Diagnostics" value={diags.length} tone={crit ? "fail" : warn ? "warn" : undefined} sub={`${crit} critical · ${warn} warning`} />
        <Metric label="Recordings" value={session.recordings.length} sub={rec ? `recording ${rec.connections.length} device(s)` : "not recording"} />
      </div>

      <Panel title="System architecture" sub="Blocks light up when data flows through them in this session" tools={<span className="small muted">● active · ○ idle · ▲ needs attention</span>}>
        <ArchitectureDiagram conns={conns} syncPairs={pairs.length} recording={!!rec} dspLoaded={!!session.dsp} />
      </Panel>

      <div className="grid main-side">
        <Panel title="Devices" tools={<a className="btn small" href={href("devices")}>All devices</a>} flush>
          <DataTable
            rows={conns}
            rowKey={(c) => c.id}
            onRowClick={(c) => (window.location.hash = href("devices", c.id))}
            empty={<EmptyState icon="devices" title="No devices connected">Connect a simulated or hardware device on the Devices page.</EmptyState>}
            columns={[
              { key: "label", header: "Device", cell: (c) => <span className="cell-main">{c.label}</span>, sort: (c) => c.label },
              { key: "src", header: "Source", cell: (c) => <SourceBadge source={c.source} /> },
              { key: "status", header: "Status", cell: (c) => <StatusBadge status={c.status} /> },
              { key: "frames", header: "Frames", align: "num", cell: (c) => c.stats.framesOk.toLocaleString(), sort: (c) => c.stats.framesOk },
              { key: "last", header: "Last packet", align: "num", cell: (c) => fmtAge(c.lastChunkAt === null ? null : now - c.lastChunkAt) },
              { key: "ver", header: "Descriptor check", cell: (c) => <VerdictBadge verdict={c.verification.verdict} /> },
            ]}
          />
        </Panel>
        <Panel title="Recent diagnostics" tools={<a className="btn small" href={href("alerts")}>All alerts</a>} flush>
          {diags.length === 0 ? (
            <EmptyState icon="check" title="No open diagnostics" />
          ) : (
            <div className="diag-list">
              {[...diags]
                .sort((a, b) => ["critical", "warning", "info"].indexOf(a.severity) - ["critical", "warning", "info"].indexOf(b.severity) || b.time - a.time)
                .slice(0, 6)
                .map((d) => (
                  <div key={d.id} className="diag-row">
                    <SeverityBadge severity={d.severity} />
                    <div>
                      <div className="cell-main">{d.message}</div>
                      <div className="cell-sub">
                        {d.category} · {d.device ?? "system"} · {fmtClock(d.time)}
                      </div>
                    </div>
                  </div>
                ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
