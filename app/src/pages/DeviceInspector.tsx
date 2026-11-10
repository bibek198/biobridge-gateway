import { useState } from "react";
import { useAppStore } from "../state/appStore";
import { href, navigate } from "../state/router";
import type { ConnectionView } from "../session/sessionManager";
import { hostNowMs } from "../time/clock";
import { channelLabel, CheckTable, DescriptorSummary } from "../components/domain";
import { useConfirm } from "../components/ui/ConfirmDialog";
import { DataTable } from "../components/ui/DataTable";
import { fmt, fmtAge, fmtBytes, fmtClock, hex } from "../components/ui/format";
import { Icon } from "../components/ui/Icon";
import { Callout, Metric, PageHeader, Panel, Segmented, SourceBadge, StatusBadge, Tip, TransportBadge, VerdictBadge } from "../components/ui/primitives";

function msClock(t: number): string {
  return `${fmtClock(t)}.${String(Math.floor(t % 1000)).padStart(3, "0")}`;
}

function RecentPackets({ conn }: { conn: ConnectionView }) {
  const [radix, setRadix] = useState<"hex" | "dec">("hex");
  const [frozen, setFrozen] = useState<ConnectionView["recentChunks"] | null>(null);
  const chunks = frozen ?? conn.recentChunks;
  const text = conn.descriptor.framing.kind === "delimited";

  return (
    <Panel
      title="Recent packets"
      sub={`last ${chunks.length} transport chunks, as received`}
      tools={
        <>
          <Segmented label="Byte format" options={[{ id: "hex", label: "Hex" }, { id: "dec", label: "Dec" }]} value={radix} onChange={setRadix} />
          <button className="btn small" onClick={() => setFrozen(frozen ? null : conn.recentChunks)} aria-pressed={!!frozen}>
            <Icon name={frozen ? "play" : "pause"} size={12} /> {frozen ? "Resume" : "Freeze"}
          </button>
        </>
      }
      flush
    >
      {chunks.length === 0 ? (
        <div className="panel-body muted">No bytes received yet.</div>
      ) : (
        <div className="bytes panel-body">
          {[...chunks].reverse().map((c, i) => (
            <div key={`${c.t}-${i}`} style={{ marginBottom: 6 }}>
              <div className="cell-sub">
                {msClock(c.t)} · {c.bytes.length} B
              </div>
              <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                {Array.from(c.bytes.slice(0, 96), (b) => (radix === "hex" ? hex(b) : String(b).padStart(3, " "))).join(" ")}
                {c.bytes.length > 96 && <span className="muted"> … +{c.bytes.length - 96} B</span>}
              </div>
              {text && <div className="ascii">{new TextDecoder().decode(c.bytes.slice(0, 96)).replace(/[\r\n]/g, "⏎")}</div>}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

export function DeviceInspector({ conn }: { conn: ConnectionView }) {
  const { session } = useAppStore();
  const confirm = useConfirm();
  const now = hostNowMs();
  const s = conn.stats;
  const frames = s.framesOk + s.crcErrors + s.malformed;
  const live = conn.status === "connected" || conn.status === "connecting";
  const clock = conn.clock;
  const info = Object.entries(conn.info);
  const timestamped = conn.descriptor.messages?.some((m) => m.timestamp) ?? false;

  return (
    <div className="page">
      <PageHeader
        section="MONITOR · DEVICES"
        title={conn.label}
        purpose={conn.deviceLabel ? `Physical/transport identity: ${conn.deviceLabel}` : undefined}
        context={
          <>
            <StatusBadge status={conn.status} />
            <SourceBadge source={conn.source} />
            <TransportBadge kind={conn.descriptor.transport.kind} />
            <VerdictBadge verdict={conn.verification.verdict} />
          </>
        }
        actions={
          <>
            <a className="btn" href={href("devices")}>
              <Icon name="back" /> All devices
            </a>
            <a className="btn" href={href("live")}>
              <Icon name="live" /> Live data
            </a>
            <button
              className="btn danger"
              onClick={async () => {
                if (!live || (await confirm({ title: `Disconnect ${conn.label}?`, body: "Its buffers and live analysis are discarded.", confirmLabel: "Disconnect" }))) {
                  await session.disconnect(conn.id);
                  navigate("devices");
                }
              }}
            >
              {live ? "Disconnect" : "Remove"}
            </button>
          </>
        }
      />

      {conn.status === "error" && conn.lastError && (
        <Callout tone="fail">
          <strong>Connection error.</strong> {conn.lastError}
        </Callout>
      )}

      <div className="metrics" style={{ marginTop: conn.status === "error" ? 12 : 0 }}>
        <Metric label="Frames decoded" value={s.framesOk.toLocaleString()} sub={`${fmtBytes(s.bytesIn)} received`} />
        <Metric label="Checksum failures" value={s.crcErrors} tone={s.crcErrors ? "warn" : undefined} sub={frames ? `${fmt((100 * s.crcErrors) / frames, 2)} % of frames` : "—"} />
        <Metric label="Lost (sequence)" value={s.seqGaps} tone={s.seqGaps ? "warn" : undefined} sub="gaps in frame sequence numbers" />
        <Metric label="Malformed" value={s.malformed} tone={s.malformed ? "warn" : undefined} sub="frames matching no message" />
        <Metric label="Bytes skipped" value={s.bytesDiscarded.toLocaleString()} sub="while resynchronising" />
        <Metric label="Last packet" value={fmtAge(conn.lastChunkAt === null ? null : now - conn.lastChunkAt)} sub={`connected ${fmtClock(conn.connectedAt)}`} />
      </div>

      <div className="grid cols-2">
        <Panel title="Device">
          <dl className="kv">
            <dt>Connection id</dt>
            <dd className="mono">{conn.id}</dd>
            <dt>Device type</dt>
            <dd className="mono">{conn.factoryId}</dd>
            <dt>Data source</dt>
            <dd>
              {conn.source === "simulated" ? "Software simulator (no hardware)" : conn.source === "replay" ? "Replayed recording" : "Physical device"}
            </dd>
            {info.length === 0 ? (
              <>
                <dt>Device info</dt>
                <dd className="muted">The device has not reported any (no HELLO / info message).</dd>
              </>
            ) : (
              info.map(([k, v]) => (
                <span key={k} style={{ display: "contents" }}>
                  <dt>{k}</dt>
                  <dd className="mono">{k === "mac" ? String(v).match(/../g)?.join(":") : String(v)}</dd>
                </span>
              ))
            )}
          </dl>
        </Panel>
        <Panel title="Descriptor" tools={<a className="btn small" href={href("descriptors", `${conn.factoryId.startsWith("custom-") ? "user" : "bundled"}:${conn.descriptor.id}`)}>Open descriptor</a>}>
          <DescriptorSummary d={conn.descriptor} />
        </Panel>
      </div>

      <div className="grid cols-2">
        <Panel title="Streams" sub={timestamped ? "rates measured from device timestamps" : "rates measured from arrival times (the device sends no timestamps)"} flush>
          <DataTable
            rows={conn.channels}
            rowKey={(c) => c.id}
            empty={<div className="panel-body muted">Waiting for data…</div>}
            columns={[
              { key: "id", header: "Channel", cell: (c) => (<><div className="cell-main">{channelLabel(c.id, conn.descriptor)}</div><div className="cell-sub mono">{c.id}</div></>), sort: (c) => c.id },
              { key: "unit", header: "Unit", cell: (c) => c.unit ?? <span className="muted">—</span> },
              { key: "n", header: "Samples", align: "num", cell: (c) => c.count.toLocaleString(), sort: (c) => c.count },
              { key: "rate", header: "Rate", align: "num", cell: (c) => (c.rateHz === null ? "—" : `${fmt(c.rateHz, c.rateHz < 10 ? 2 : 1)} Hz`), sort: (c) => c.rateHz ?? -1 },
            ]}
          />
        </Panel>
        <Panel
          title="Clock mapping"
          sub="device clock → host timeline"
          tools={<a className="btn small" href={href("sync")}>Clock sync</a>}
        >
          {!timestamped ? (
            <div className="muted small">
              This device does not timestamp its data, so there is no device clock to map: samples are placed on the host timeline at arrival. Clock sync applies to
              devices whose descriptor declares a message timestamp.
            </div>
          ) : (
          <dl className="kv">
            <dt>Method</dt>
            <dd className="mono">{conn.clockMapper}</dd>
            <dt>
              <Tip label="Device clock zero">Host time at which the device clock read 0, as currently estimated. Offset between the two clocks.</Tip>
            </dt>
            <dd className="num">{clock?.bootHostMs == null ? "—" : msClock(clock.bootHostMs)}</dd>
            <dt>
              <Tip label="Skew">Rate difference between device and host clocks, in parts per million. Only affine methods estimate it.</Tip>
            </dt>
            <dd className="num">{clock?.skewPpm == null ? <span className="muted">not estimated by this method</span> : `${fmt(clock.skewPpm, 1)} ppm`}</dd>
            {conn.descriptor.transport.kind === "ble" && (
              <>
                <dt>
                  <Tip label="BLE connection interval">Inferred from arrival-time phase; bounds the delay of each notification.</Tip>
                </dt>
                <dd className="num">{clock?.ciMs == null ? <span className="muted">not inferred</span> : `${fmt(clock.ciMs, 2)} ms`}</dd>
              </>
            )}
            <dt>Observations</dt>
            <dd className="num">{clock ? clock.observations.toLocaleString() : "—"}</dd>
            {conn.clockDetail && (
              <>
                <dt>Detail</dt>
                <dd className="mono small">{conn.clockDetail}</dd>
              </>
            )}
          </dl>
          )}
        </Panel>
      </div>

      <Panel title="Verification" sub="the verifier re-checks this descriptor against live data, once per second" tools={<a className="btn small" href={href("verification")}>All verification</a>} flush>
        <CheckTable checks={conn.verification.checks} />
      </Panel>

      <RecentPackets conn={conn} />
    </div>
  );
}
