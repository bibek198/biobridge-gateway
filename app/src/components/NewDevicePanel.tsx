import { useEffect, useRef, useState } from "react";
import { BENCH_DEVICES } from "../bench/devices";
import { VOCABULARY } from "../bench/vocabulary";
import type { Descriptor, TransportSpec } from "../descriptors/types";
import { validateDescriptor } from "../descriptors/validate";
import { bytesToBase64 } from "../session/recording";
import type { CaptureResult, CaptureSource } from "../session/sessionManager";
import { useAppStore } from "../state/appStore";

// "Add a device": capture an unknown device's raw bytes, describe it, and let a model write its descriptor
// while the verifier checks every attempt. The model runs in the dev server (vite-plugin-synth.ts), which
// holds the API keys; this page only talks to /api/synth.

type Model = { id: string; label: string };
type AttemptView = {
  iteration: number;
  outcome: "no-json" | "invalid" | "rejected" | "accepted";
  replyText: string;
  validationErrors: string[];
  findings: { id: string; oracle: string; name: string; status: string; detail: string }[];
  missingChannels: string[];
  latencyMs: number;
  retries: number;
};
type Job = { id: string; status: "running" | "done" | "error"; attempts: AttemptView[]; accepted: boolean; descriptor: Descriptor | null; error: string | null };

const OUTCOME: Record<AttemptView["outcome"], string> = {
  "no-json": "no descriptor in the reply",
  invalid: "did not validate",
  rejected: "verifier found problems",
  accepted: "verified",
};

function hexPreview(chunks: CaptureResult["chunks"], max = 96): string {
  const bytes: number[] = [];
  for (const c of chunks) {
    for (const b of c.bytes) {
      if (bytes.length >= max) break;
      bytes.push(b);
    }
  }
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function NewDevicePanel() {
  const { session } = useAppStore();

  // 1. capture
  const [sourceKind, setSourceKind] = useState<CaptureSource["kind"]>("sim-bench");
  const [baud, setBaud] = useState(115200);
  const [service, setService] = useState("");
  const [characteristic, setCharacteristic] = useState("");
  const [benchId, setBenchId] = useState("fingertip-oximeter");
  const [seconds, setSeconds] = useState(20);
  const [capture, setCapture] = useState<CaptureResult | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);

  // 2. describe
  const [deviceId, setDeviceId] = useState("my-device");
  const [datasheet, setDatasheet] = useState("");
  const [channels, setChannels] = useState<string[]>([]);

  // 3. synthesize
  const [models, setModels] = useState<Model[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  // 4. use
  const [label, setLabel] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [importText, setImportText] = useState("");
  const [importErrors, setImportErrors] = useState<string[]>([]);

  useEffect(() => {
    fetch("/api/synth/models")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { models: Model[] }) => {
        setModels(d.models);
        // Default to the models the benchmark evaluates, when available.
        const preferred = ["claude-opus-5-5", "gemini:gemini-3.8-flash"].find((id) => d.models.some((m) => m.id === id));
        if (d.models.length) setModel((m) => m || preferred || d.models[0].id);
      })
      .catch(() => setModelsError("The synthesis service is not available. Run the app with `npm run dev` (it serves /api/synth)."));
    return () => {
      if (poll.current) clearInterval(poll.current);
    };
  }, []);

  const bench = BENCH_DEVICES.find((b) => b.id === benchId)!;

  function transportSpec(): TransportSpec {
    if (sourceKind === "serial") return { kind: "serial", baudRate: baud };
    if (sourceKind === "ble") return { kind: "ble", service, characteristic };
    return bench.groundTruth.transport;
  }

  async function runCapture() {
    setCaptureError(null);
    setCapturing(true);
    setCapture(null);
    const source: CaptureSource =
      sourceKind === "serial" ? { kind: "serial", baudRate: baud } : sourceKind === "ble" ? { kind: "ble", service, characteristic } : { kind: "sim-bench", benchId };
    try {
      const result = await session.capture(source, seconds * 1000);
      if (result.chunks.length === 0) throw new Error("No bytes arrived. Is the device running, and is the baud rate / characteristic right?");
      setCapture(result);
    } catch (err) {
      setCaptureError(err instanceof Error ? err.message : String(err));
    } finally {
      setCapturing(false);
    }
  }

  function fillFromBenchmark() {
    setDeviceId(bench.id);
    setDatasheet(bench.datasheet);
    setChannels(bench.requiredChannels);
    setLabel(bench.title);
  }

  async function start() {
    if (!capture) return;
    setJobError(null);
    setJob(null);
    setSaved(null);
    const wire = (cs: CaptureResult["chunks"]) => cs.map((c) => ({ t: c.t, b64: bytesToBase64(c.bytes) }));
    try {
      const res = await fetch("/api/synth/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          task: { id: deviceId, datasheet, transport: transportSpec(), requiredChannels: channels },
          model,
          chunks: wire(capture.chunks),
          reference: capture.reference ? { label: capture.reference.label, descriptor: capture.reference.descriptor, chunks: wire(capture.reference.chunks) } : undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      const tick = async () => {
        const j: Job = await (await fetch(`/api/synth/jobs/${body.id}`)).json();
        setJob(j);
        if (j.status !== "running" && poll.current) {
          clearInterval(poll.current);
          poll.current = null;
        }
      };
      poll.current = setInterval(() => void tick(), 1500);
      void tick();
    } catch (err) {
      setJobError(err instanceof Error ? err.message : String(err));
    }
  }

  /** Saved devices connect to the device chosen in step 1: the simulated benchmark device, or real hardware. */
  const savedSource = () => (sourceKind === "sim-bench" ? ({ kind: "sim-bench", benchId } as const) : ({ kind: "hardware" } as const));

  function save(descriptor: Descriptor) {
    const name = label.trim() || deviceId;
    session.addCustomDevice(name, descriptor, savedSource());
    setSaved(name);
  }

  function importDescriptor() {
    try {
      const v = validateDescriptor(JSON.parse(importText));
      if (!v.ok) return setImportErrors(v.errors);
      setImportErrors([]);
      session.addCustomDevice(v.descriptor.name || v.descriptor.id, v.descriptor, savedSource());
      setSaved(v.descriptor.name || v.descriptor.id);
    } catch (err) {
      setImportErrors([err instanceof Error ? err.message : String(err)]);
    }
  }

  const ready = !!capture && datasheet.trim() !== "" && channels.length > 0 && !!model && job?.status !== "running";

  return (
    <div className="panel">
      <h2>Add a Device</h2>
      <p className="panel-subtitle">
        For a device BioBridge does not know yet: capture its raw output, paste its documentation, and let a language model
        write the descriptor. Every attempt is decoded and checked by the verifier; problems go back to the model until the
        descriptor passes. The model runs on this computer's dev server with the API key from <code>.env</code>; the key
        never reaches this page.
      </p>

      <section className="section">
        <h3>1. Capture the device's raw output</h3>
        <div className="scenario-picker">
          {(
            [
              ["sim-bench", "Simulated benchmark device (no hardware)"],
              ["serial", "USB-serial"],
              ["ble", "Bluetooth LE"],
            ] as const
          ).map(([k, text]) => (
            <label key={k}>
              <input type="radio" name="capture-source" checked={sourceKind === k} onChange={() => setSourceKind(k)} />
              {text}
            </label>
          ))}
        </div>
        <div className="form-row">
          {sourceKind === "sim-bench" && (
            <>
              <select value={benchId} onChange={(e) => setBenchId(e.target.value)}>
                {BENCH_DEVICES.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.title}
                  </option>
                ))}
              </select>
              <button className="secondary-button" onClick={fillFromBenchmark}>
                Fill in its datasheet and channels
              </button>
            </>
          )}
          {sourceKind === "serial" && (
            <label>
              Baud rate <input type="number" value={baud} onChange={(e) => setBaud(Number(e.target.value))} />
            </label>
          )}
          {sourceKind === "ble" && (
            <>
              <label>
                Service UUID <input value={service} onChange={(e) => setService(e.target.value)} placeholder="e.g. 0000180d-0000-1000-8000-00805f9b34fb" />
              </label>
              <label>
                Notify characteristic UUID <input value={characteristic} onChange={(e) => setCharacteristic(e.target.value)} />
              </label>
            </>
          )}
          <label>
            Seconds <input type="number" min={5} max={120} value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} />
          </label>
          <button className="primary-button" disabled={capturing || (sourceKind === "ble" && (!service || !characteristic))} onClick={() => void runCapture()}>
            {capturing ? `Capturing ${seconds} s…` : "Capture"}
          </button>
        </div>
        {captureError && <p className="error-text">{captureError}</p>}
        {capture && (
          <p className="hint">
            Captured {capture.chunks.reduce((n, c) => n + c.bytes.length, 0)} bytes in {capture.chunks.length} chunks
            {capture.deviceLabel ? ` from ${capture.deviceLabel}` : ""}.{" "}
            {capture.reference
              ? `With ${capture.reference.label} as the ECG reference for the cross-sensor check.`
              : "No ECG reference (connect a Node A first to enable the cross-sensor check)."}
            <br />
            <code className="hex-preview">{hexPreview(capture.chunks)} …</code>
          </p>
        )}
      </section>

      <section className="section">
        <h3>2. Describe it</h3>
        <div className="form-row">
          <label>
            Device id <input value={deviceId} onChange={(e) => setDeviceId(e.target.value.replace(/[^a-z0-9-]/gi, "-").toLowerCase())} />
          </label>
        </div>
        <textarea
          className="datasheet"
          value={datasheet}
          onChange={(e) => setDatasheet(e.target.value)}
          placeholder="Paste the protocol section of the device's datasheet or manual: frame layout, field meanings, units, checksum…"
        />
        <p className="hint">Channels the device must provide (in these units):</p>
        <div className="channel-grid">
          {Object.entries(VOCABULARY).map(([id, v]) => (
            <label key={id} title={v.description}>
              <input
                type="checkbox"
                checked={channels.includes(id)}
                onChange={(e) => setChannels((cs) => (e.target.checked ? [...cs, id] : cs.filter((c) => c !== id)))}
              />
              <code>{id}</code> {v.unit && <span className="hint">({v.unit})</span>}
            </label>
          ))}
        </div>
      </section>

      <section className="section">
        <h3>3. Write the descriptor</h3>
        {modelsError ? (
          <p className="hint">{modelsError}</p>
        ) : models && models.length === 0 ? (
          <p className="hint">No API key found. Add ANTHROPIC_API_KEY or GEMINI_API_KEY to the repo-root .env and restart `npm run dev`.</p>
        ) : (
          <div className="form-row">
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {(models ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <button className="primary-button" disabled={!ready} onClick={() => void start()}>
              {job?.status === "running" ? "Working…" : "Start"}
            </button>
            {!capture && <span className="hint">Capture the device first.</span>}
          </div>
        )}
        {jobError && <p className="error-text">{jobError}</p>}
        {job && (
          <ol className="attempt-list">
            {job.attempts.map((a) => (
              <li key={a.iteration} className={`attempt attempt-${a.outcome}`}>
                <div>
                  <strong>Attempt {a.iteration}</strong>: {OUTCOME[a.outcome]}{" "}
                  <span className="hint">
                    ({(a.latencyMs / 1000).toFixed(0)} s{a.retries ? `, ${a.retries} rate-limit retries` : ""})
                  </span>
                </div>
                {a.validationErrors.length > 0 && (
                  <ul className="hint">
                    {a.validationErrors.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                )}
                {(a.findings.length > 0 || a.missingChannels.length > 0) && (
                  <ul className="hint">
                    {a.missingChannels.length > 0 && <li>No values for: {a.missingChannels.join(", ")}</li>}
                    {a.findings.map((f) => (
                      <li key={f.id}>
                        [{f.status}] {f.oracle}: {f.name}. {f.detail}
                      </li>
                    ))}
                  </ul>
                )}
                <details>
                  <summary className="hint">Model reply</summary>
                  <pre className="reply">{a.replyText}</pre>
                </details>
              </li>
            ))}
            {job.status === "running" && <li className="hint">Waiting for the model…</li>}
          </ol>
        )}
        {job && job.status !== "running" && (
          <p className={job.accepted ? "" : "error-text"}>
            {job.accepted
              ? "The verifier accepted the descriptor."
              : job.error
                ? `Stopped: ${job.error}`
                : "No attempt passed the verifier. You can still inspect or save the last valid descriptor, but check it by hand."}
          </p>
        )}
      </section>

      {job?.descriptor && (
        <section className="section">
          <h3>4. Use it</h3>
          <pre className="descriptor-json">{JSON.stringify(job.descriptor, null, 2)}</pre>
          <div className="form-row">
            <label>
              Name <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={deviceId} />
            </label>
            <button className="primary-button" onClick={() => save(job.descriptor!)}>
              Save as a device
            </button>
            <button className="secondary-button" onClick={() => download(`${deviceId}.descriptor.json`, JSON.stringify(job.descriptor, null, 2) + "\n")}>
              Download JSON
            </button>
          </div>
        </section>
      )}
      {saved && <p className="hint">Saved "{saved}". Connect it from the Devices tab, under "Your devices".</p>}

      <section className="section">
        <h3>Or import a descriptor</h3>
        <p className="hint">
          It connects to the device chosen in step 1 ({sourceKind === "sim-bench" ? `the simulated ${bench.title}` : "real hardware"}).
        </p>
        <textarea className="datasheet small" value={importText} onChange={(e) => setImportText(e.target.value)} placeholder="Paste descriptor JSON" />
        <div className="form-row">
          <button className="secondary-button" disabled={!importText.trim()} onClick={importDescriptor}>
            Validate and add
          </button>
        </div>
        {importErrors.length > 0 && (
          <ul className="error-text">
            {importErrors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
