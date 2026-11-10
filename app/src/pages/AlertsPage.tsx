import { useState } from "react";
import { useAppStore } from "../state/appStore";
import { href } from "../state/router";
import type { DiagnosticCategory } from "../session/sessionManager";
import { DataTable } from "../components/ui/DataTable";
import { fmtClock } from "../components/ui/format";
import { EmptyState, Metric, PageHeader, Panel, Segmented, SeverityBadge } from "../components/ui/primitives";

const CATEGORIES: { id: DiagnosticCategory | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "connection", label: "Connection" },
  { id: "packets", label: "Packets" },
  { id: "verification", label: "Verification" },
  { id: "signal", label: "Signal" },
  { id: "sync", label: "Sync" },
  { id: "physiology", label: "Physiology" },
];

const SEVERITIES = [
  { id: "all", label: "All" },
  { id: "critical", label: "Critical" },
  { id: "warning", label: "Warning" },
  { id: "info", label: "Info" },
] as const;

const RANK = { critical: 0, warning: 1, info: 2 } as const;

export function AlertsPage() {
  const { session } = useAppStore();
  const [cat, setCat] = useState<DiagnosticCategory | "all">("all");
  const [sev, setSev] = useState<(typeof SEVERITIES)[number]["id"]>("all");
  const all = session.diagnostics();
  const rows = all.filter((d) => (cat === "all" || d.category === cat) && (sev === "all" || d.severity === sev));
  const count = (c: DiagnosticCategory) => all.filter((d) => d.category === c).length;

  return (
    <div className="page">
      <PageHeader
        section="MONITOR"
        title="Alerts"
        purpose="Structured diagnostics: link and decoding problems, failed verification checks, high sync error and low signal quality (re-evaluated live), plus physiological threshold alerts (logged when they fire)."
      />
      <div className="metrics">
        <Metric label="Critical" value={all.filter((d) => d.severity === "critical").length} tone={all.some((d) => d.severity === "critical") ? "fail" : undefined} />
        <Metric label="Warning" value={all.filter((d) => d.severity === "warning").length} tone={all.some((d) => d.severity === "warning") ? "warn" : undefined} />
        <Metric label="Link & decoding" value={count("connection") + count("packets")} />
        <Metric label="Verification" value={count("verification")} />
        <Metric label="Sync & signal" value={count("sync") + count("signal")} />
        <Metric label="Physiology" value={count("physiology")} sub="threshold alerts, last 100" />
      </div>
      <Panel
        title="Diagnostics"
        sub={`${rows.length} of ${all.length}`}
        tools={
          <>
            <Segmented label="Category" options={CATEGORIES} value={cat} onChange={setCat} />
            <Segmented label="Severity" options={[...SEVERITIES]} value={sev} onChange={setSev} />
          </>
        }
        flush
        foot={
          <>
            Thresholds are set on <a href={href("pipeline")}>Processing Pipeline</a>. Try the Desaturation or Tachycardia scenario on <a href={href("devices")}>Devices</a> to trigger
            physiological alerts with simulated data.
          </>
        }
      >
        <DataTable
          rows={rows}
          rowKey={(d) => d.id}
          initialSort={{ key: "sev", dir: 1 }}
          empty={<EmptyState icon="check" title={all.length ? "Nothing matches the filters" : "No diagnostics"}>{all.length ? "Change the category or severity filter." : "Links, decoding, verification and sync are all within limits."}</EmptyState>}
          columns={[
            { key: "sev", header: "Severity", cell: (d) => <SeverityBadge severity={d.severity} />, sort: (d) => RANK[d.severity] * 1e13 - d.time, width: 110 },
            {
              key: "time",
              header: "Time",
              mono: true,
              cell: (d) => (d.category === "physiology" ? fmtClock(d.time) : <span title="Re-evaluated from the current state">live</span>),
              sort: (d) => -d.time,
              width: 90,
            },
            { key: "cat", header: "Category", cell: (d) => d.category, sort: (d) => d.category, width: 110 },
            { key: "dev", header: "Device", cell: (d) => d.device ?? <span className="muted">system</span>, sort: (d) => d.device ?? "" },
            {
              key: "msg",
              header: "Message",
              cell: (d) => (
                <>
                  <div className="cell-main">{d.message}</div>
                  {d.context && <div className="cell-sub">{d.context}</div>}
                </>
              ),
            },
          ]}
        />
      </Panel>
    </div>
  );
}
