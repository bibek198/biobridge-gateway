import { useRef, useState } from "react";
import { useAppStore } from "../state/appStore";
import { href, navigate } from "../state/router";
import type { RecordingMeta } from "../session/recording";
import { CLOCK_METHODS, hostNowMs } from "../time/clock";
import { useConfirm } from "../components/ui/ConfirmDialog";
import { DataTable } from "../components/ui/DataTable";
import { download, errorText, fmtBytes, fmtDateTime, fmtDuration } from "../components/ui/format";
import { Icon } from "../components/ui/Icon";
import { Badge, Callout, EmptyState, PageHeader, Panel, TransportBadge } from "../components/ui/primitives";

function sourcesOf(r: RecordingMeta): ("simulated" | "hardware")[] {
  return [...new Set(r.connections.map((c) => (c.transportKind === "simulated" ? ("simulated" as const) : ("hardware" as const))))];
}

const hasTruth = (r: RecordingMeta) => r.connections.some((c) => c.groundTruth && Object.keys(c.groundTruth).length > 0);

function SourceTags({ r }: { r: RecordingMeta }) {
  return (
    <span className="inline-list">
      {sourcesOf(r).map((s) => (
        <Badge key={s} tone={s === "simulated" ? "model" : "live"} icon={s === "simulated" ? "sim" : "usb"}>
          {s}
        </Badge>
      ))}
    </span>
  );
}

export function RecordingsPage({ param }: { param: string | null }) {
  const { session } = useAppStore();
  const confirm = useConfirm();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const active = session.activeRecording;
  const live = session.listConnections().filter((c) => c.group !== "replay" && c.status === "connected");
  const selected = param ? session.recordings.find((r) => r.id === param) ?? null : null;

  async function run(action: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const replay = (r: RecordingMeta) =>
    run(async () => {
      await session.replayRecording(r.id);
      navigate("live");
    });
  const exportIt = (r: RecordingMeta) =>
    run(async () => {
      const { filename, text } = await session.exportRecording(r.id);
      download(filename, text, "application/x-ndjson");
    });
  const remove = async (r: RecordingMeta) => {
    if (await confirm({ title: `Delete "${r.name}"?`, body: "The recording is removed from this browser's storage. This cannot be undone; export it first to keep a copy.", confirmLabel: "Delete", danger: true }))
      await run(async () => {
        await session.deleteRecording(r.id);
        if (param === r.id) navigate("recordings");
      });
  };

  if (!session.recordingsSupported) {
    return (
      <div className="page">
        <PageHeader section="RESEARCH" title="Recordings" />
        <EmptyState icon="record" title="Recordings unavailable">This browser has no IndexedDB.</EmptyState>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        section="RESEARCH"
        title={selected ? selected.name : "Recordings"}
        purpose={
          selected ? undefined : (
            <>
              Each recording is an experiment: the <strong>raw bytes</strong> every device sent with host arrival times, and each device's descriptor. Replay decodes them
              again, so a recording stays useful after a descriptor or sync method changes. Exports (<code>.bbrec.jsonl</code>) load with <code>eval/read_bbrec.py</code>.
            </>
          )
        }
        actions={
          selected ? (
            <a className="btn" href={href("recordings")}>
              <Icon name="back" /> All recordings
            </a>
          ) : (
            <>
              <button className="btn" disabled={busy} onClick={() => fileRef.current?.click()}>
                <Icon name="upload" /> Import…
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".jsonl,.bbrec,application/x-ndjson"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void run(async () => session.importRecording(await file.text()));
                }}
              />
            </>
          )
        }
      />
      {session.recorderError && <Callout tone="fail">Storage error: {session.recorderError}</Callout>}
      {error && <Callout tone="fail">{error}</Callout>}

      {!selected && (
        <Panel title="Recorder" sub={active ? undefined : "devices connected later are added to an active recording"}>
          {active ? (
            <div className="row-between">
              <div className="inline-list" style={{ alignItems: "center", fontSize: 13 }}>
                <span className="rec-dot" aria-hidden />
                <strong>Recording “{active.name}”</strong>
                <span className="num">{fmtDuration(hostNowMs() - active.startedAt)}</span>
                <span>{active.connections.length} device(s)</span>
                <span className="num">{fmtBytes(active.byteCount)}</span>
              </div>
              <button className="btn primary" disabled={busy} onClick={() => void run(() => session.stopRecording())}>
                <Icon name="stop" /> Stop
              </button>
            </div>
          ) : (
            <div className="toolbar">
              <label className="field" style={{ flex: 1, minWidth: 220 }}>
                <span>Name</span>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={`Session ${new Date().toLocaleString()}`} />
              </label>
              <button className="btn primary" disabled={busy || live.length === 0} onClick={() => void run(() => session.startRecording(name.trim() || undefined).then(() => setName("")))}>
                <Icon name="record" /> Start recording
              </button>
              <span className="small muted" style={{ alignSelf: "center" }}>
                {live.length === 0 ? "Connect a device first." : `Records ${live.map((c) => c.label).join(", ")}.`}
              </span>
            </div>
          )}
        </Panel>
      )}

      {selected ? (
        <>
          <Panel
            title="Experiment"
            tools={
              <>
                <button className="btn small" disabled={busy || selected.endedAt === null} onClick={() => void replay(selected)}>
                  <Icon name="replay" size={13} /> Replay
                </button>
                <button className="btn small" disabled={busy} onClick={() => void exportIt(selected)}>
                  <Icon name="download" size={13} /> Export
                </button>
                <button className="btn small danger" disabled={busy || active?.id === selected.id} onClick={() => void remove(selected)}>
                  <Icon name="trash" size={13} /> Delete
                </button>
              </>
            }
          >
            <dl className="kv">
              <dt>Id</dt>
              <dd className="mono">{selected.id}</dd>
              <dt>Started</dt>
              <dd>{fmtDateTime(selected.startedAt)}</dd>
              <dt>Duration</dt>
              <dd className="num">{selected.endedAt ? fmtDuration(selected.endedAt - selected.startedAt) : "in progress"}</dd>
              <dt>Data</dt>
              <dd className="num">
                {fmtBytes(selected.byteCount)} in {selected.chunkCount.toLocaleString()} chunks
              </dd>
              <dt>Sources</dt>
              <dd>
                <SourceTags r={selected} />
              </dd>
              <dt>Ground truth</dt>
              <dd>{hasTruth(selected) ? "Present (simulated devices: hidden clock and PTT truth)" : <span className="muted">none (hardware devices have no hidden truth)</span>}</dd>
              <dt>Clock method</dt>
              <dd>
                Not fixed by the recording; replay applies the current method ({CLOCK_METHODS.find((m) => m.id === session.clockMethod)?.label}).{" "}
                <a href={href("sync")}>Change</a>
              </dd>
            </dl>
          </Panel>
          <Panel title="Devices in this recording" flush>
            <DataTable
              rows={selected.connections}
              rowKey={(c) => c.key}
              columns={[
                { key: "l", header: "Device", cell: (c) => <span className="cell-main">{c.label}</span> },
                { key: "f", header: "Device type", mono: true, cell: (c) => c.factoryId },
                { key: "t", header: "Transport", cell: (c) => <TransportBadge kind={c.transportKind === "simulated" ? "simulated" : c.descriptor.transport.kind} /> },
                { key: "d", header: "Descriptor", mono: true, cell: (c) => c.descriptor.id },
                { key: "j", header: "Joined at", align: "num", cell: (c) => `+${((c.joinedAt - selected.startedAt) / 1000).toFixed(1)} s` },
                { key: "g", header: "Ground truth", cell: (c) => (c.groundTruth ? Object.keys(c.groundTruth).join(", ") : <span className="muted">—</span>) },
              ]}
            />
          </Panel>
        </>
      ) : param ? (
        <EmptyState icon="record" title="Recording not found" action={<a className="btn" href={href("recordings")}>All recordings</a>} />
      ) : (
        <Panel title="Saved recordings" sub={`${session.recordings.length} in this browser`} flush>
          <DataTable
            rows={session.recordings}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate("recordings", r.id)}
            initialSort={{ key: "start", dir: -1 }}
            empty={<EmptyState icon="record" title="No recordings yet">Start a recording above, or import a .bbrec.jsonl file.</EmptyState>}
            columns={[
              { key: "name", header: "Name", cell: (r) => <span className="cell-main">{r.name}</span>, sort: (r) => r.name },
              { key: "start", header: "Started", cell: (r) => fmtDateTime(r.startedAt), sort: (r) => r.startedAt },
              { key: "dur", header: "Duration", align: "num", cell: (r) => (r.endedAt ? fmtDuration(r.endedAt - r.startedAt) : "in progress"), sort: (r) => (r.endedAt ?? hostNowMs()) - r.startedAt },
              { key: "dev", header: "Devices", cell: (r) => <span className="cell-sub">{r.connections.map((c) => c.label).join(", ")}</span> },
              { key: "src", header: "Source", cell: (r) => <SourceTags r={r} /> },
              { key: "size", header: "Size", align: "num", cell: (r) => fmtBytes(r.byteCount), sort: (r) => r.byteCount },
              { key: "gt", header: "Ground truth", cell: (r) => (hasTruth(r) ? "yes" : <span className="muted">no</span>) },
              {
                key: "act",
                header: "",
                cell: (r) => (
                  <div className="inline-list" onClick={(e) => e.stopPropagation()}>
                    <button className="btn small" disabled={busy || r.endedAt === null} onClick={() => void replay(r)} title="Decode the recorded bytes again as new connections">
                      Replay
                    </button>
                    <button className="btn small" disabled={busy} onClick={() => void exportIt(r)}>
                      Export
                    </button>
                    <button className="btn small ghost danger" disabled={busy || active?.id === r.id} onClick={() => void remove(r)} aria-label={`Delete ${r.name}`}>
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                ),
              },
            ]}
          />
        </Panel>
      )}
    </div>
  );
}
