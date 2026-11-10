import { useAppStore } from "../state/appStore";
import { href } from "../state/router";
import type { ConnectionView } from "../session/sessionManager";
import { CheckTable, ORACLES } from "../components/domain";
import { DataTable } from "../components/ui/DataTable";
import { Badge, CheckBadge, EmptyState, Metric, PageHeader, Panel, SourceBadge, VerdictBadge } from "../components/ui/primitives";

function ConnectionReport({ conn }: { conn: ConnectionView }) {
  const checks = conn.verification.checks;
  return (
    <Panel
      title={conn.label}
      sub={conn.descriptor.id}
      tools={
        <>
          <SourceBadge source={conn.source} />
          <VerdictBadge verdict={conn.verification.verdict} />
          <a className="btn small" href={href("devices", conn.id)}>
            Inspect
          </a>
        </>
      }
      flush
    >
      <div className="oracle-grid">
        {ORACLES.map((o) => {
          const mine = checks.filter((c) => c.oracle === o.id);
          const worst = mine.find((c) => c.status === "fail") ?? mine.find((c) => c.status === "warn") ?? mine.find((c) => c.status === "pending") ?? mine[0];
          return (
            <div key={o.id} className="oracle-cell">
              <div className="row-between">
                <strong>{o.label}</strong>
                {worst ? <CheckBadge status={worst.status} /> : <Badge tone="muted">No checks</Badge>}
              </div>
              <div className="cell-sub">{o.question}</div>
              <div className="small" style={{ marginTop: 4 }}>
                {mine.length} check{mine.length === 1 ? "" : "s"} · {mine.filter((c) => c.status === "pass").length} pass
              </div>
            </div>
          );
        })}
      </div>
      <CheckTable checks={checks} />
    </Panel>
  );
}

export function VerificationPage() {
  const { session } = useAppStore();
  const conns = session.listConnections();
  const cross = session.listCrossSensorChecks();
  const count = (v: string) => conns.filter((c) => c.verification.verdict === v).length;

  return (
    <div className="page">
      <PageHeader
        section="DEVICE INTEGRATION"
        title="Verification"
        purpose="The verifier checks each connection's descriptor against the live data it decodes, with four independent oracles. It runs on every connection, whether the descriptor is bundled, imported or model-generated."
      />
      <div className="metrics">
        <Metric label="Verified" value={count("verified")} tone={count("verified") ? "ok" : undefined} />
        <Metric label="Suspect" value={count("suspect")} tone={count("suspect") ? "warn" : undefined} />
        <Metric label="Failed" value={count("failed")} tone={count("failed") ? "fail" : undefined} />
        <Metric label="Pending" value={count("pending")} sub="not enough data yet" />
        <Metric label="Cross-sensor checks" value={cross.length} sub="pairs of independent rate estimates" />
      </div>

      <Panel
        title="Cross-sensor agreement"
        sub="heart/pulse-rate estimates from physically different measurements, median over the last 15 s"
        flush
        foot="A descriptor that mis-reads timing or channels usually breaks this even when every value looks plausible on its own."
      >
        {cross.length === 0 ? (
          <EmptyState icon="shield" title="No cross-sensor pairs">
            Needs two rate sources on the same subject, e.g. Node A (ECG) and Node B (PPG), or the simulated pair.
          </EmptyState>
        ) : (
          <DataTable
            rows={cross}
            rowKey={(c) => c.id}
            columns={[
              { key: "s", header: "Result", cell: (c) => <CheckBadge status={c.status} />, width: 96 },
              { key: "n", header: "Comparison", cell: (c) => <span className="cell-main">{c.name}</span> },
              { key: "d", header: "Detail", cell: (c) => <span className="cell-sub">{c.detail}</span> },
            ]}
          />
        )}
      </Panel>

      {conns.length === 0 ? (
        <Panel>
          <EmptyState icon="shield" title="No connections to verify" action={<a className="btn" href={href("devices")}>Connect a device</a>} />
        </Panel>
      ) : (
        conns.map((c) => <ConnectionReport key={c.id} conn={c} />)
      )}
    </div>
  );
}
