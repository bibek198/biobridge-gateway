import { useState } from "react";
import { useAppStore } from "../state/appStore";
import { href, navigate } from "../state/router";
import type { DeviceFactory, DeviceGroup } from "../drivers/registry";
import type { SimScenario } from "../sim/physiology";
import type { ConnectionView } from "../session/sessionManager";
import { hostNowMs } from "../time/clock";
import { DataTable } from "../components/ui/DataTable";
import { useConfirm } from "../components/ui/ConfirmDialog";
import { errorText, fmt, fmtAge } from "../components/ui/format";
import { Icon } from "../components/ui/Icon";
import { Badge, Callout, EmptyState, PageHeader, Panel, Segmented, SourceBadge, StatusBadge, TransportBadge, VerdictBadge } from "../components/ui/primitives";
import { DeviceInspector } from "./DeviceInspector";

const SCENARIOS: { id: SimScenario; label: string }[] = [
  { id: "normal", label: "Normal" },
  { id: "tachycardia", label: "Tachycardia" },
  { id: "desaturation", label: "Desaturation" },
];

const GROUPS: { group: DeviceGroup; title: string; blurb: string }[] = [
  { group: "simulated", title: "Simulated devices", blurb: "No hardware needed. Emit the same bytes as the real firmware, through the same descriptors." },
  { group: "hardware", title: "Hardware", blurb: "Chrome or Edge on localhost/HTTPS. The browser shows a device picker on Connect." },
  { group: "custom", title: "Your devices", blurb: "Added on Add a Device (synthesized or imported descriptors), saved in this browser." },
  {
    group: "benchmark",
    title: "Benchmark devices (ESP32 impersonation)",
    blurb: "An ESP32 flashed with a firmware/ bench_* build impersonates a third-party device, for descriptor-synthesis evaluation on hardware.",
  },
];

/** Announced sample rate from the device's HELLO, when it sends one. */
function announcedRate(c: ConnectionView): number | null {
  return typeof c.info.sampleRateHz === "number" ? c.info.sampleRateHz : null;
}

function primaryRate(c: ConnectionView): number | null {
  const wave = c.descriptor.channels.filter((ch) => ch.display === "waveform").map((ch) => ch.id);
  const rates = c.channels.filter((ch) => (wave.length ? wave.includes(ch.id) : true) && ch.rateHz !== null).map((ch) => ch.rateHz!);
  return rates.length ? Math.max(...rates) : null;
}

function CatalogItem({ factory }: { factory: DeviceFactory }) {
  const { session } = useAppStore();
  const confirm = useConfirm();
  const [error, setError] = useState<string | null>(null);
  const supported = factory.isSupported();
  const active = session.listConnections().filter((c) => c.factoryId === factory.id && c.group !== "replay").length;
  const kind = factory.group === "simulated" ? "simulated" : factory.descriptor.transport.kind;

  async function connect() {
    setError(null);
    try {
      const id = await session.connect(factory.id);
      if (factory.group !== "simulated") navigate("devices", id);
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <div className="catalog-item">
      <div className="ci-body">
        <div className="ci-title">
          {factory.label} {active > 0 && <Badge tone="ok">{active} connected</Badge>}
        </div>
        <div className="ci-desc">{factory.description}</div>
        <div className="inline-list" style={{ marginTop: 4 }}>
          <TransportBadge kind={kind} />
          <code className="small">{factory.descriptor.id}</code>
        </div>
        {!supported && <div className="ci-desc" style={{ color: "var(--warn)" }}>Not available in this browser (needs Web Serial / Web Bluetooth: Chrome or Edge).</div>}
        {error && <div className="error-text">{error}</div>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <button className="btn small" disabled={!supported} onClick={() => void connect()}>
          {active > 0 ? "Connect another" : "Connect"}
        </button>
        {factory.group === "custom" && (
          <button
            className="btn small ghost danger"
            onClick={async () => {
              if (await confirm({ title: `Remove "${factory.label}"?`, body: "The device type and its descriptor are removed from this browser. Open connections stay until disconnected.", confirmLabel: "Remove", danger: true }))
                session.removeCustomDevice(factory.id);
            }}
          >
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

export function DevicesPage({ param }: { param: string | null }) {
  const { session } = useAppStore();
  const conns = session.listConnections();
  const factories = session.listFactories();
  const now = hostNowMs();

  if (param) {
    const conn = conns.find((c) => c.id === param);
    return conn ? (
      <DeviceInspector conn={conn} />
    ) : (
      <div className="page">
        <PageHeader section="MONITOR · DEVICES" title="Device not found" />
        <EmptyState icon="devices" title={`No connection "${param}"`} action={<a className="btn" href={href("devices")}>Back to devices</a>}>
          It was disconnected, or the page was reloaded (connections do not survive a reload).
        </EmptyState>
      </div>
    );
  }


  return (
    <div className="page">
      <PageHeader
        section="MONITOR"
        title="Devices"
        purpose={
          <>
            Every device is a <strong>descriptor</strong> (what its bytes mean) over a <strong>transport</strong> (how they arrive). Several devices can run at
            once; each gets its own decoder, clock mapper, verifier and compute pipeline.
          </>
        }
      />

      <Panel title="Connections" sub={`${conns.length} in session · select a row to inspect`} flush>
        <DataTable
          rows={conns}
          rowKey={(c) => c.id}
          onRowClick={(c) => navigate("devices", c.id)}
          empty={<EmptyState icon="devices" title="No devices connected">Connect one from the catalogue below. Simulated devices need no hardware.</EmptyState>}
          columns={[
            {
              key: "label",
              header: "Device",
              sort: (c) => c.label,
              cell: (c) => (
                <>
                  <div className="cell-main nowrap">{c.label}</div>
                  <div className="cell-sub">
                    {c.id}
                    {c.info.fwMajor !== undefined && ` · fw ${c.info.fwMajor}.${c.info.fwMinor}`}
                  </div>
                </>
              ),
            },
            {
              key: "src",
              header: "Source / link",
              sort: (c) => c.source,
              cell: (c) => (
                <div className="stack">
                  <SourceBadge source={c.source} />
                  <TransportBadge kind={c.descriptor.transport.kind} />
                </div>
              ),
            },
            { key: "status", header: "Status", cell: (c) => <StatusBadge status={c.status} />, sort: (c) => c.status },
            {
              key: "rate",
              header: "Sample rate",
              align: "num",
              sort: (c) => primaryRate(c) ?? -1,
              cell: (c) => {
                const m = primaryRate(c);
                const a = announcedRate(c);
                return (
                  <span className="nowrap" title="Measured from device timestamps; announced value from the device's HELLO frame">
                    {m === null ? "—" : `${fmt(m, 1)} Hz`}
                    {a !== null && <div className="cell-sub">announced {a}</div>}
                  </span>
                );
              },
            },
            { key: "last", header: "Last packet", align: "num", cell: (c) => fmtAge(c.lastChunkAt === null ? null : now - c.lastChunkAt), sort: (c) => c.lastChunkAt ?? 0 },
            {
              key: "frames",
              header: "Frames / errors",
              align: "num",
              sort: (c) => c.stats.framesOk,
              cell: (c) => {
                const errs = c.stats.crcErrors + c.stats.malformed + c.stats.seqGaps;
                return (
                  <>
                    {c.stats.framesOk.toLocaleString()}
                    <div className="cell-sub" style={errs ? { color: "var(--warn)" } : undefined}>
                      {errs} error{errs === 1 ? "" : "s"}
                    </div>
                  </>
                );
              },
            },
            {
              key: "desc",
              header: "Descriptor",
              mono: true,
              cell: (c) => c.descriptor.id,
            },
            { key: "ver", header: "Check", cell: (c) => <VerdictBadge verdict={c.verification.verdict} />, sort: (c) => c.verification.verdict },
          ]}
        />
      </Panel>

      <Panel
        title="Simulated subject"
        sub="Shared by every simulated device, so simulated ECG and PPG come from the same heartbeat"
        tools={<Segmented label="Simulated scenario" options={SCENARIOS} value={session.getScenario()} onChange={(s) => session.setScenario(s)} />}
      >
        <Callout tone="model" icon="sim">
          Simulated devices produce synthetic physiology. Their values are for exercising the pipeline and are labelled <strong>Simulated</strong> everywhere; they are not
          measurements of a person.
        </Callout>
      </Panel>

      {GROUPS.filter(({ group }) => factories.some((f) => f.group === group)).map(({ group, title, blurb }) => (
        <Panel key={group} title={title} sub={blurb} flush>
          <div className="catalog">
            {factories
              .filter((f) => f.group === group)
              .map((f) => (
                <CatalogItem key={f.id} factory={f} />
              ))}
          </div>
        </Panel>
      ))}
      <p className="small muted" style={{ marginTop: 12 }}>
        <Icon name="info" size={12} /> Add an unknown device on <a href={href("add")}>Add a Device</a>.
      </p>
    </div>
  );
}
