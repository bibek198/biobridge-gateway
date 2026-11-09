import { useRef, useState } from "react";
import { useAppStore } from "../state/appStore";
import { hostNowMs } from "../time/clock";

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/x-ndjson" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function RecordingsPanel() {
  const { session } = useAppStore();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const active = session.activeRecording;
  const live = session.listConnections().filter((c) => c.group !== "replay" && c.status === "connected");

  async function run(action: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!session.recordingsSupported) {
    return (
      <div className="panel">
        <h2>Recordings</h2>
        <p className="hint">This browser has no IndexedDB, so recordings are unavailable.</p>
      </div>
    );
  }

  return (
    <div className="panel">
      <h2>Recordings</h2>
      <p className="panel-subtitle">
        A recording keeps the <strong>raw bytes</strong> every device sent, with host arrival times and each device's
        descriptor. Replay decodes them again, so recordings stay useful after a descriptor or sync method changes.
        Export gives a <code>.bbrec.jsonl</code> file that <code>eval/read_bbrec.py</code> can load.
      </p>

      <section className="section record-bar">
        {active ? (
          <>
            <span className="rec-dot" /> Recording <strong>{active.name}</strong> ·{" "}
            {formatDuration(hostNowMs() - active.startedAt)} · {active.connections.length} device(s) ·{" "}
            {(active.byteCount / 1024).toFixed(1)} KiB
            <button className="primary-button" disabled={busy} onClick={() => run(() => session.stopRecording())}>
              Stop
            </button>
          </>
        ) : (
          <>
            <span className="hint">
              {live.length === 0
                ? "Connect a device first."
                : `Will record ${live.map((c) => c.label).join(", ")}. Devices connected later are added too.`}
            </span>
            <button className="primary-button" disabled={busy || live.length === 0} onClick={() => run(() => session.startRecording())}>
              Start recording
            </button>
          </>
        )}
      </section>
      {session.recorderError && <p className="error-text">Storage error: {session.recorderError}</p>}
      {error && <p className="error-text">{error}</p>}

      <section className="section">
        <div className="section-header">
          <h3>Saved</h3>
          <button className="secondary-button" disabled={busy} onClick={() => fileRef.current?.click()}>
            Import…
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
        </div>
        {session.recordings.length === 0 ? (
          <p className="hint">No recordings yet.</p>
        ) : (
          <ul className="connection-list">
            {session.recordings.map((r) => (
              <li key={r.id} className="connection-row">
                <div className="connection-main">
                  <strong>{r.name}</strong>
                  <div className="hint">
                    {new Date(r.startedAt).toLocaleString()} ·{" "}
                    {r.endedAt ? formatDuration(r.endedAt - r.startedAt) : "in progress"} ·{" "}
                    {(r.byteCount / 1024).toFixed(1)} KiB · {r.connections.map((c) => c.label).join(", ")}
                  </div>
                </div>
                <div className="row-actions">
                  <button
                    className="secondary-button"
                    disabled={busy || r.endedAt === null}
                    onClick={() => run(() => session.replayRecording(r.id))}
                  >
                    Replay
                  </button>
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        const { filename, text } = await session.exportRecording(r.id);
                        download(filename, text);
                      })
                    }
                  >
                    Export
                  </button>
                  <button
                    className="secondary-button danger"
                    disabled={busy || active?.id === r.id}
                    onClick={() => {
                      if (window.confirm(`Delete "${r.name}"? This cannot be undone.`)) void run(() => session.deleteRecording(r.id));
                    }}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
