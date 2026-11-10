import { useAppStore } from "../state/appStore";
import { href, navigate } from "../state/router";
import { validateDescriptor } from "../descriptors/validate";
import type { DescriptorView } from "../session/sessionManager";
import { DescriptorSummary, framingText } from "../components/domain";
import { CodeBlock } from "../components/ui/CodeBlock";
import { useConfirm } from "../components/ui/ConfirmDialog";
import { DataTable } from "../components/ui/DataTable";
import { download } from "../components/ui/format";
import { Icon } from "../components/ui/Icon";
import { Badge, Callout, EmptyState, PageHeader, Panel, TransportBadge } from "../components/ui/primitives";

const keyOf = (v: DescriptorView) => `${v.source}:${v.descriptor.id}`;

function SourceTag({ v }: { v: DescriptorView }) {
  return v.source === "bundled" ? (
    <Badge tone="outline">Bundled</Badge>
  ) : (
    <Badge tone="model" icon="plusBox">
      User-added
    </Badge>
  );
}

function Detail({ v }: { v: DescriptorView }) {
  const { session } = useAppStore();
  const confirm = useConfirm();
  const check = validateDescriptor(v.descriptor);
  const factories = session.listFactories().filter((f) => v.factoryIds.includes(f.id));
  const json = JSON.stringify(v.descriptor, null, 2);

  return (
    <div className="page">
      <PageHeader
        section="DEVICE INTEGRATION · DESCRIPTORS"
        title={v.descriptor.name}
        purpose={v.descriptor.description}
        context={
          <>
            <SourceTag v={v} />
            <TransportBadge kind={v.descriptor.transport.kind} />
            {check.ok ? (
              <Badge tone="ok" icon="check">
                Schema valid
              </Badge>
            ) : (
              <Badge tone="fail" icon="cross">
                Schema invalid
              </Badge>
            )}
          </>
        }
        actions={
          <>
            <a className="btn" href={href("descriptors")}>
              <Icon name="back" /> All descriptors
            </a>
            <button className="btn" onClick={() => download(`${v.descriptor.id}.descriptor.json`, json + "\n")}>
              <Icon name="download" /> Export JSON
            </button>
            {v.source === "user" && (
              <button
                className="btn danger"
                onClick={async () => {
                  if (await confirm({ title: `Remove "${v.descriptor.name}"?`, body: "The device type using this descriptor is removed from this browser.", confirmLabel: "Remove", danger: true })) {
                    for (const id of v.factoryIds) session.removeCustomDevice(id);
                    navigate("descriptors");
                  }
                }}
              >
                <Icon name="trash" /> Remove
              </button>
            )}
          </>
        }
      />
      {!check.ok && (
        <Callout tone="fail">
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {check.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Callout>
      )}
      <div className="grid main-side">
        <Panel title="Descriptor JSON" sub={v.descriptor.schema}>
          <CodeBlock value={json} maxHeight={640} />
        </Panel>
        <div>
          <Panel title="Summary">
            <DescriptorSummary d={v.descriptor} />
          </Panel>
          <Panel title="Used by" flush>
            {factories.map((f) => (
              <div key={f.id} className="catalog-item" style={{ margin: 0, borderRight: 0 }}>
                <div className="ci-body">
                  <div className="ci-title">{f.label}</div>
                  <div className="ci-desc">{f.description}</div>
                </div>
              </div>
            ))}
          </Panel>
          {v.descriptor.plausibility && (
            <Panel title="Plausibility bounds" sub="used by the verifier" flush>
              <DataTable
                rows={Object.entries(v.descriptor.plausibility)}
                rowKey={([k]) => k}
                columns={[
                  { key: "c", header: "Channel", mono: true, cell: ([k]) => k },
                  { key: "min", header: "Min", align: "num", cell: ([, p]) => p.min ?? "—" },
                  { key: "max", header: "Max", align: "num", cell: ([, p]) => p.max ?? "—" },
                  { key: "r", header: "Max rate /s", align: "num", cell: ([, p]) => p.maxRatePerSec ?? "—" },
                ]}
              />
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}

export function DescriptorsPage({ param }: { param: string | null }) {
  const { session } = useAppStore();
  const all = session.listDescriptors();
  const selected = param ? all.find((v) => keyOf(v) === param) : undefined;
  if (param && selected) return <Detail v={selected} />;

  return (
    <div className="page">
      <PageHeader
        section="DEVICE INTEGRATION"
        title="Device Descriptors"
        purpose="A descriptor is a JSON document (schema biobridge.descriptor/v1) that says what a device's bytes mean: transport, framing, messages, fields, channels and commands. Bundled ones ship with BioBridge; user-added ones come from Add a Device."
        actions={
          <a className="btn" href={href("add")}>
            <Icon name="add" /> Add a device
          </a>
        }
      />
      {param && !selected && (
        <div style={{ marginBottom: 12 }}>
          <Callout tone="warn">Descriptor “{param}” was not found.</Callout>
        </div>
      )}
      <Panel title="Descriptors" sub={`${all.length} known`} flush>
        <DataTable
          rows={all}
          rowKey={keyOf}
          onRowClick={(v) => navigate("descriptors", keyOf(v))}
          empty={<EmptyState title="No descriptors" />}
          columns={[
            {
              key: "name",
              header: "Descriptor",
              sort: (v) => v.descriptor.name,
              cell: (v) => (
                <>
                  <div className="cell-main">{v.descriptor.name}</div>
                  <div className="cell-sub mono">{v.descriptor.id}</div>
                </>
              ),
            },
            { key: "src", header: "Source", cell: (v) => <SourceTag v={v} />, sort: (v) => v.source },
            { key: "tr", header: "Transport", cell: (v) => <TransportBadge kind={v.descriptor.transport.kind} /> },
            { key: "fr", header: "Framing", cell: (v) => <span className="cell-sub">{framingText(v.descriptor.framing)}</span> },
            { key: "msg", header: "Messages", align: "num", cell: (v) => v.descriptor.messages?.length ?? (v.descriptor.text ? "text" : 0) },
            { key: "ch", header: "Channels", align: "num", cell: (v) => v.descriptor.channels.length, sort: (v) => v.descriptor.channels.length },
            { key: "cmd", header: "Commands", align: "num", cell: (v) => v.descriptor.commands?.length ?? 0 },
            { key: "use", header: "Device types", align: "num", cell: (v) => v.factoryIds.length },
          ]}
        />
      </Panel>
    </div>
  );
}
