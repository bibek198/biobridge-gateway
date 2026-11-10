import { useEffect, useRef, useState, type ReactNode } from "react";
import { BENCH_DEVICES } from "../bench/devices";
import { VOCABULARY } from "../bench/vocabulary";
import type { Descriptor, TransportSpec } from "../descriptors/types";
import { validateDescriptor } from "../descriptors/validate";
import { bytesToBase64 } from "../session/recording";
import type { CaptureResult, CaptureSource } from "../session/sessionManager";
import { useAppStore } from "../state/appStore";
import { href } from "../state/router";
import { useSynthService } from "../state/synthService";
import { ORACLES } from "../components/domain";
import { CodeBlock } from "../components/ui/CodeBlock";
import { download, errorText } from "../components/ui/format";
import { Icon } from "../components/ui/Icon";
import { Badge, Callout, CheckBadge, EmptyState, PageHeader, Panel, Segmented, Tip } from "../components/ui/primitives";
import { PacketInspector } from "./PacketInspector";

// Device-integration workbench: capture an unknown device's raw bytes, inspect them, describe the device, and
// let a model propose a descriptor that the verifier checks independently. The model runs in the dev server
// (vite-plugin-synth.ts), which holds the API keys; this page only talks to /api/synth.
//
// Model output is never presented as verified: each attempt shows the model's reply, schema validation,
// decoding and the independent oracle checks as separate lanes, and only the verifier's verdict counts.

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

type LaneState = "pass" | "fail" | "skip";

function Lane({ title, icon, state, model, children }: { title: string; icon: "sparkle" | "descriptor" | "bytes" | "shield"; state: LaneState | "info"; model?: boolean; children: ReactNode }) {
  return (
    <div className={model ? "lane model" : "lane"}>
      <h4>
        <Icon name={icon} size={12} /> {title}
      </h4>
      <div style={{ marginBottom: 6 }}>
        {state === "info" ? (
          <Badge tone="model" icon="sparkle">
            Unverified
          </Badge>
        ) : state === "skip" ? (
          <Badge tone="muted">Not reached</Badge>
        ) : (
          <CheckBadge status={state} />
        )}
      </div>
      {children}
    </div>
  );
}

function AttemptLanes({ a }: { a: AttemptView }) {
  const [showReply, setShowReply] = useState(false);
  const parsed = a.outcome !== "no-json";
  const valid = parsed && a.outcome !== "invalid";
  const decoded = valid && a.missingChannels.length === 0;
  const problems = a.findings.filter((f) => f.status === "fail" || f.status === "warn");
  return (
    <div className="attempt">
      <div className="attempt-head">
        <strong>Attempt {a.iteration}</strong>
        <span className="muted small">
          {(a.latencyMs / 1000).toFixed(0)} s{a.retries ? ` · ${a.retries} rate-limit retries` : ""}
        </span>
        <span style={{ marginLeft: "auto" }}>
          {a.outcome === "accepted" ? (
            <Badge tone="ok" icon="shield">
              Accepted by verifier
            </Badge>
          ) : (
            <Badge tone="fail" icon="cross">
              {a.outcome === "no-json" ? "No descriptor in reply" : a.outcome === "invalid" ? "Schema invalid" : "Rejected by verifier"}
            </Badge>
          )}
        </span>
      </div>
      <div className="lanes">
        <Lane title="Model output" icon="sparkle" state="info" model>
          <div className="small">{parsed ? "Reply contained a JSON descriptor." : "No JSON object found in the reply."}</div>
          <button className="btn small ghost" style={{ marginTop: 4, paddingLeft: 0 }} onClick={() => setShowReply(!showReply)} aria-expanded={showReply}>
            <Icon name={showReply ? "collapse" : "chevron"} size={12} /> {showReply ? "Hide" : "Show"} reply
          </button>
        </Lane>
        <Lane title="Schema validation" icon="descriptor" state={!parsed ? "skip" : valid ? "pass" : "fail"}>
          {!parsed ? (
            <span className="small muted">Nothing to validate.</span>
          ) : valid ? (
            <span className="small">Valid biobridge.descriptor/v1.</span>
          ) : (
            <ul className="small">{a.validationErrors.slice(0, 6).map((e) => <li key={e}>{e}</li>)}</ul>
          )}
        </Lane>
        <Lane title="Decoding the capture" icon="bytes" state={!valid ? "skip" : decoded ? "pass" : "fail"}>
          {!valid ? (
            <span className="small muted">Needs a valid descriptor.</span>
          ) : decoded ? (
            <span className="small">Every required channel produced values.</span>
          ) : (
            <span className="small">No values for: {a.missingChannels.join(", ")}</span>
          )}
        </Lane>
        <Lane title="Independent verification" icon="shield" state={!valid ? "skip" : a.outcome === "accepted" ? "pass" : problems.length || !decoded ? "fail" : "pass"}>
          {!valid ? (
            <span className="small muted">Needs a valid descriptor.</span>
          ) : problems.length === 0 ? (
            <span className="small">{a.outcome === "accepted" ? "All oracle checks passed." : "No oracle findings."}</span>
          ) : (
            <ul className="small">
              {problems.map((f) => (
                <li key={f.id}>
                  <strong>{f.oracle}</strong> · {f.name}
                  <div className="muted">{f.detail}</div>
                </li>
              ))}
            </ul>
          )}
        </Lane>
      </div>
      {showReply && (
        <div style={{ padding: "0 12px 12px" }}>
          <div className="small muted" style={{ margin: "6px 0" }}>
            Raw model reply (unverified)
          </div>
          <CodeBlock value={a.replyText} json={false} wrap maxHeight={320} />
        </div>
      )}
    </div>
  );
}

const STEPS = ["Capture", "Inspect bytes", "Describe", "Generate & verify", "Save"];

export function AddDevicePage() {
  const { session } = useAppStore();
  const synth = useSynthService();

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
  const [chosenModel, setModel] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  // 4. use
  const [label, setLabel] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [importText, setImportText] = useState("");
  const [importErrors, setImportErrors] = useState<string[]>([]);

  const models = synth.status === "ready" ? synth.models : [];
  // Default to the models the benchmark evaluates, when available.
  const model = chosenModel || ["claude-opus-5-5", "gemini:gemini-3.8-flash"].find((id) => models.some((m) => m.id === id)) || models[0]?.id || "";

  useEffect(
    () => () => {
      if (poll.current) clearInterval(poll.current);
    },
    []
  );

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
      setCaptureError(errorText(err));
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
      setJobError(errorText(err));
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
      setImportErrors([errorText(err)]);
    }
  }

  const described = datasheet.trim() !== "" && channels.length > 0;
  const ready = !!capture && described && !!model && job?.status !== "running";
  const done = [!!capture, !!capture, described, !!job && job.status !== "running", !!saved];
  const current = done.findIndex((d) => !d);

  return (
    <div className="page">
      <PageHeader
        section="DEVICE INTEGRATION"
        title="Add a Device"
        purpose="For a device BioBridge does not know yet: capture its raw output, inspect the bytes, describe it, and let a language model propose a descriptor. The verifier decodes the capture with every proposal and checks it independently; only its verdict counts."
        context={
          <>
            <Badge tone="outline" icon="shield">
              API keys stay on the dev server
            </Badge>
            {synth.status === "ready" ? (
              <Badge tone={models.length ? "ok" : "warn"}>{models.length ? `${models.length} models available` : "No API key configured"}</Badge>
            ) : synth.status === "unavailable" ? (
              <Badge tone="warn" icon="warn">
                Synthesis service offline
              </Badge>
            ) : (
              <Badge tone="muted">Checking synthesis service…</Badge>
            )}
          </>
        }
      />

      <ol className="stepper" aria-label="Progress">
        {STEPS.map((s, i) => (
          <li key={s} className={`step ${done[i] ? "done" : ""} ${i === current ? "current" : ""}`} aria-current={i === current ? "step" : undefined}>
            <span className="n">{done[i] ? <Icon name="check" size={11} /> : i + 1}</span>
            {s}
          </li>
        ))}
      </ol>

      <Panel title="1 · Capture raw output" sub="no descriptor is applied: bytes are recorded as they arrive">
        <div className="toolbar">
          <div className="field">
            <span>Source</span>
            <Segmented
              label="Capture source"
              value={sourceKind}
              onChange={setSourceKind}
              options={[
                { id: "sim-bench", label: "Simulated benchmark device" },
                { id: "serial", label: "USB-serial" },
                { id: "ble", label: "Bluetooth LE" },
              ]}
            />
          </div>
          {sourceKind === "sim-bench" && (
            <label className="field">
              <span>Device</span>
              <select className="input" value={benchId} onChange={(e) => setBenchId(e.target.value)}>
                {BENCH_DEVICES.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          {sourceKind === "serial" && (
            <label className="field">
              <span>Baud rate</span>
              <input className="input num" type="number" value={baud} onChange={(e) => setBaud(Number(e.target.value))} style={{ width: 110 }} />
            </label>
          )}
          {sourceKind === "ble" && (
            <>
              <label className="field">
                <span>Service UUID</span>
                <input className="input mono" value={service} onChange={(e) => setService(e.target.value)} placeholder="0000180d-0000-1000-8000-00805f9b34fb" style={{ width: 300 }} />
              </label>
              <label className="field">
                <span>Notify characteristic UUID</span>
                <input className="input mono" value={characteristic} onChange={(e) => setCharacteristic(e.target.value)} style={{ width: 300 }} />
              </label>
            </>
          )}
          <label className="field">
            <span>Duration (s)</span>
            <input className="input num" type="number" min={5} max={120} value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} style={{ width: 80 }} />
          </label>
          <button className="btn primary" disabled={capturing || (sourceKind === "ble" && (!service || !characteristic))} onClick={() => void runCapture()}>
            <Icon name={capturing ? "clock" : "record"} /> {capturing ? `Capturing ${seconds} s…` : "Capture"}
          </button>
        </div>
        {sourceKind === "sim-bench" && (
          <p className="small muted" style={{ margin: "8px 0 0" }}>
            <Icon name="sim" size={12} /> A software device with a hidden ground-truth descriptor, used by the synthesis benchmark. Its datasheet can be filled in below.
          </p>
        )}
        {captureError && (
          <div style={{ marginTop: 10 }}>
            <Callout tone="fail">{captureError}</Callout>
          </div>
        )}
        {capture && (
          <div style={{ marginTop: 10 }}>
            <Callout tone="ok">
              Captured {capture.chunks.reduce((n, c) => n + c.bytes.length, 0).toLocaleString()} bytes in {capture.chunks.length} chunks
              {capture.deviceLabel ? ` from ${capture.deviceLabel}` : ""}.{" "}
              {capture.reference
                ? `${capture.reference.label} was captured alongside as the ECG reference for the cross-sensor oracle.`
                : "No ECG reference (connect a Node A first to enable the cross-sensor oracle)."}
            </Callout>
          </div>
        )}
      </Panel>

      <Panel title="2 · Inspect bytes" sub="find magic bytes, lengths, counters and sample fields">
        {capture ? <PacketInspector chunks={capture.chunks} /> : <EmptyState icon="bytes" title="Nothing captured yet">Capture the device first; its bytes appear here.</EmptyState>}
      </Panel>

      <Panel
        title="3 · Describe the device"
        sub="what the model gets: the datasheet text, the capture and the required channels"
        tools={
          sourceKind === "sim-bench" && (
            <button className="btn small" onClick={fillFromBenchmark}>
              Fill in the benchmark datasheet
            </button>
          )
        }
      >
        <div className="toolbar" style={{ marginBottom: 10 }}>
          <label className="field">
            <span>Device id</span>
            <input className="input mono" value={deviceId} onChange={(e) => setDeviceId(e.target.value.replace(/[^a-z0-9-]/gi, "-").toLowerCase())} />
          </label>
        </div>
        <label className="field" style={{ display: "flex" }}>
          <span>Datasheet / protocol documentation</span>
          <textarea
            className="input"
            rows={8}
            value={datasheet}
            onChange={(e) => setDatasheet(e.target.value)}
            placeholder="Paste the protocol section of the device's datasheet or manual: frame layout, field meanings, units, checksum…"
          />
        </label>
        <div className="field" style={{ display: "flex", marginTop: 12 }}>
          <span>
            Required channels{" "}
            <Tip icon>The platform vocabulary: the descriptor must produce these channel ids, in these units. Plausibility bounds per channel come from the same table.</Tip>
          </span>
          <div className="channel-grid" style={{ marginTop: 4 }}>
            {Object.entries(VOCABULARY).map(([id, v]) => (
              <label key={id} className="check" title={v.description}>
                <input type="checkbox" checked={channels.includes(id)} onChange={(e) => setChannels((cs) => (e.target.checked ? [...cs, id] : cs.filter((c) => c !== id)))} />
                <code>{id}</code> {v.unit && <span className="muted small">({v.unit})</span>}
              </label>
            ))}
          </div>
        </div>
      </Panel>

      <Panel title="4 · Generate and verify" sub="each attempt: model output → schema validation → decoding → independent oracle checks; findings go back to the model">
        {synth.status === "unavailable" ? (
          <Callout tone="warn">
            The synthesis service is not available. Run the app with <code>npm run dev</code>, which serves <code>/api/synth</code>.
          </Callout>
        ) : synth.status === "ready" && models.length === 0 ? (
          <Callout tone="warn">
            No API key found. Add <code>ANTHROPIC_API_KEY</code> or <code>GEMINI_API_KEY</code> to the repo-root <code>.env</code> and restart <code>npm run dev</code>.
          </Callout>
        ) : (
          <div className="toolbar">
            <label className="field">
              <span>Model</span>
              <select className="input" value={model} onChange={(e) => setModel(e.target.value)} disabled={synth.status !== "ready"}>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn primary" disabled={!ready} onClick={() => void start()}>
              <Icon name="sparkle" /> {job?.status === "running" ? "Working…" : "Generate descriptor"}
            </button>
            {!capture ? <span className="small muted">Capture the device first.</span> : !described ? <span className="small muted">Add the datasheet and at least one channel.</span> : null}
          </div>
        )}
        <div className="spaced" style={{ marginTop: 12 }}>
          <div className="small muted">
            Verifier oracles: {ORACLES.map((o) => o.label).join(" · ")}.{" "}
            <Tip label="What do they check?">
              {ORACLES.map((o) => (
                <span key={o.id} style={{ display: "block" }}>
                  <strong>{o.label}:</strong> {o.question}
                </span>
              ))}
            </Tip>
          </div>
          {jobError && <Callout tone="fail">{jobError}</Callout>}
          {job && (
            <div className="panel" style={{ boxShadow: "none" }}>
              {job.attempts.map((a) => (
                <AttemptLanes key={a.iteration} a={a} />
              ))}
              {job.status === "running" && (
                <div className="attempt-head muted">
                  <Icon name="clock" size={13} /> Waiting for the model (attempt {job.attempts.length + 1})…
                </div>
              )}
            </div>
          )}
          {job && (
            <div
              className={`verdict ${job.status === "running" ? "pending" : job.accepted ? "ok" : "fail"}`}
              role="status"
            >
              <Icon name={job.status === "running" ? "clock" : job.accepted ? "shield" : "cross"} size={18} />
              <div>
                {job.status === "running"
                  ? "Verdict pending: no attempt has passed the verifier yet."
                  : job.accepted
                    ? `Accepted by the verifier after ${job.attempts.length} attempt${job.attempts.length === 1 ? "" : "s"}.`
                    : job.error
                      ? `Stopped: ${job.error}`
                      : "Rejected: no attempt passed the verifier."}
                <div className="small" style={{ fontWeight: 400, opacity: 0.9 }}>
                  {job.accepted
                    ? "Verified against this capture by the oracles. It has not been compared with ground truth or tested on other units of the device."
                    : job.status !== "running"
                      ? "Any descriptor shown below is unverified. Check it by hand before relying on it."
                      : ""}
                </div>
              </div>
            </div>
          )}
        </div>
      </Panel>

      <Panel title="5 · Save the descriptor" sub="saved devices appear on Devices → Your devices">
        {job?.descriptor ? (
          <div className="spaced">
            <div className="inline-list">
              {job.accepted ? (
                <Badge tone="ok" icon="shield">
                  Accepted by verifier
                </Badge>
              ) : (
                <Badge tone="warn" icon="warn">
                  Unverified: last schema-valid attempt
                </Badge>
              )}
              <code className="small">{job.descriptor.id}</code>
            </div>
            <CodeBlock value={JSON.stringify(job.descriptor, null, 2)} />
            <div className="toolbar">
              <label className="field">
                <span>Device name</span>
                <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={deviceId} />
              </label>
              <button className="btn primary" onClick={() => save(job.descriptor!)}>
                <Icon name="add" /> Save as a device
              </button>
              <button className="btn" onClick={() => download(`${deviceId}.descriptor.json`, JSON.stringify(job.descriptor, null, 2) + "\n")}>
                <Icon name="download" /> Download JSON
              </button>
            </div>
          </div>
        ) : (
          <div className="muted small">A descriptor appears here once an attempt produces a schema-valid one.</div>
        )}
        {saved && (
          <div style={{ marginTop: 10 }}>
            <Callout tone="ok">
              Saved “{saved}”. Connect it from <a href={href("devices")}>Devices</a>, under Your devices.
            </Callout>
          </div>
        )}
      </Panel>

      <Panel title="Or import a descriptor" sub={`connects to the device chosen in step 1 (${sourceKind === "sim-bench" ? `the simulated ${bench.title}` : "real hardware"})`}>
        <textarea className="input" rows={6} value={importText} onChange={(e) => setImportText(e.target.value)} placeholder='{"schema": "biobridge.descriptor/v1", …}' />
        <div className="toolbar" style={{ marginTop: 8 }}>
          <button className="btn" disabled={!importText.trim()} onClick={importDescriptor}>
            <Icon name="check" /> Validate and add
          </button>
          <span className="small muted">Schema validation only. Live verification starts when the device is connected.</span>
        </div>
        {importErrors.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <Callout tone="fail">
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {importErrors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </Callout>
          </div>
        )}
      </Panel>
    </div>
  );
}
