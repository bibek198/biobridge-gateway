import { useState } from "react";
import { useAppStore } from "../state/appStore";
import { ThresholdAlertModule, type ChannelThresholds } from "../compute/modules/thresholdAlert";
import { channelLabel } from "../components/domain";
import { DataTable } from "../components/ui/DataTable";
import { Badge, PageHeader, Panel } from "../components/ui/primitives";

const KEYS: { key: keyof ChannelThresholds; label: string }[] = [
  { key: "criticalMin", label: "Critical below" },
  { key: "warningMin", label: "Warning below" },
  { key: "warningMax", label: "Warning above" },
  { key: "criticalMax", label: "Critical above" },
];

function ThresholdEditor({ module }: { module: ThresholdAlertModule }) {
  const [, forceRender] = useState(0);
  const rows = Object.entries(module.getThresholds());

  function update(channel: string, key: keyof ChannelThresholds, raw: string) {
    module.setThreshold(channel, key, raw === "" ? undefined : Number(raw));
    forceRender((v) => v + 1);
  }

  return (
    <DataTable
      rows={rows}
      rowKey={([ch]) => ch}
      columns={[
        { key: "ch", header: "Channel", cell: ([ch]) => (<><div className="cell-main">{channelLabel(ch)}</div><div className="cell-sub mono">{ch}</div></>) },
        ...KEYS.map(({ key, label }) => ({
          key,
          header: label,
          align: "num" as const,
          cell: ([ch, t]: [string, ChannelThresholds]) => (
            <input
              className="input num"
              style={{ width: 90, textAlign: "right" }}
              type="number"
              aria-label={`${ch} ${label}`}
              value={t[key] ?? ""}
              placeholder="off"
              onChange={(e) => update(ch, key, e.target.value)}
            />
          ),
        })),
      ]}
    />
  );
}

export function PipelinePage() {
  const { session } = useAppStore();
  const thresholds = session.modulePrototypes.find((m): m is ThresholdAlertModule => m instanceof ThresholdAlertModule);

  return (
    <div className="page">
      <PageHeader
        section="RESEARCH"
        title="Processing Pipeline"
        purpose="Every connection gets its own instance of these compute modules, fed with every reading it produces. Settings here apply to all connections."
      />
      <Panel title="Modules" sub="in processing order" flush>
        <DataTable
          rows={session.modulePrototypes}
          rowKey={(m) => m.id}
          columns={[
            {
              key: "on",
              header: "Enabled",
              width: 90,
              cell: (m) => (
                <label className="check">
                  <input type="checkbox" checked={session.isModuleEnabled(m.id)} onChange={(e) => session.setModuleEnabled(m.id, e.target.checked)} aria-label={`Enable ${m.name}`} />
                  {session.isModuleEnabled(m.id) ? <Badge tone="ok">On</Badge> : <Badge tone="muted">Off</Badge>}
                </label>
              ),
            },
            { key: "name", header: "Module", cell: (m) => (<><div className="cell-main">{m.name}</div><div className="cell-sub mono">{m.id}</div></>) },
            { key: "desc", header: "What it does", cell: (m) => <span className="cell-sub">{m.description}</span> },
          ]}
        />
      </Panel>
      {thresholds && (
        <Panel title="Alert thresholds" sub="leave a field empty to disable that bound" flush>
          <ThresholdEditor module={thresholds} />
        </Panel>
      )}
    </div>
  );
}
