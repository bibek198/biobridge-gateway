import { useEffect, useRef } from "react";
import { useAppStore } from "../state/appStore";
import { CLOCK_METHODS } from "../time/clock";
import type { SyncPairView } from "../session/sessionManager";

const PLOT_WINDOW_S = 120;

function ErrorPlot({ pair }: { pair: SyncPairView }) {
  const { renderTick } = useAppStore();
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#0b1220";
    ctx.fillRect(0, 0, w, h);

    const pts = pair.series;
    if (pts.length === 0) return;
    const end = pts[pts.length - 1].t;
    const visible = pts.filter((p) => p.t >= end - PLOT_WINDOW_S * 1000);
    const lim = Math.max(1, ...visible.map((p) => Math.abs(p.errMs))) * 1.15;
    const y = (e: number) => h / 2 - (e / lim) * (h / 2);

    ctx.strokeStyle = "#334155";
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    ctx.fillStyle = "#4ade80";
    for (const p of visible) {
      const x = ((p.t - (end - PLOT_WINDOW_S * 1000)) / (PLOT_WINDOW_S * 1000)) * w;
      ctx.fillRect(x - 1.5, y(p.errMs) - 1.5, 3, 3);
    }
    ctx.fillStyle = "#94a3b8";
    ctx.font = "11px sans-serif";
    ctx.fillText(`+${lim.toFixed(1)} ms`, 6, 12);
    ctx.fillText(`−${lim.toFixed(1)} ms`, 6, h - 4);
    ctx.fillText(`${PLOT_WINDOW_S} s`, w - 34, h - 4);
  }, [pair, renderTick]);

  return <canvas ref={ref} className="waveform-canvas" />;
}

export function SyncPanel() {
  const { session } = useAppStore();
  const pairs = session.listSyncPairs();
  const fmt = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : "—");

  return (
    <div className="panel">
      <h2>Clock Sync</h2>
      <p className="panel-subtitle">
        Every device stamps samples with its own clock; a clock-sync method maps those stamps onto this computer's
        time. When devices share a sync rig (one GPIO pulse wired to all of them), each pulse edge is stamped by
        every device, so the gap between their mapped times is the <strong>measured sync error</strong>. Simulated
        Node A and Node B share a simulated rig.
      </p>

      <section className="section">
        <h3>Method for new connections</h3>
        <p className="hint">Connections keep the method they started with. Reconnect, or replay a recording, to compare methods.</p>
        <div className="method-list">
          {CLOCK_METHODS.map((m) => (
            <label key={m.id} className="method-option">
              <input
                type="radio"
                name="clock-method"
                checked={session.clockMethod === m.id}
                onChange={() => session.setClockMethod(m.id)}
              />
              <span>
                <strong>{m.label}</strong> <code>{m.id}</code>
                <span className="hint"> · {m.description}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="section">
        <h3>Measured sync error (device a − device b)</h3>
        {pairs.length === 0 ? (
          <p className="hint">
            No pulse pairs yet. Connect two devices that see the same sync pulses: Simulated Node A and Simulated Node B,
            or two BioBridge nodes with GPIO 4 wired to one pulse source (see firmware/README.md).
          </p>
        ) : (
          pairs.map((p) => (
            <div key={p.key} className="waveform-container">
              <div className="waveform-label">
                <strong>{p.a}</strong> − <strong>{p.b}</strong> · last {p.stats.n} edges: mean {fmt(p.stats.meanMs)} ms ·
                RMSE {fmt(p.stats.rmseMs)} ms · p95 |e| {fmt(p.stats.p95AbsMs)} ms · max |e| {fmt(p.stats.maxAbsMs)} ms
              </div>
              <ErrorPlot pair={p} />
            </div>
          ))
        )}
        <p className="hint">
          The first few seconds use an offset-only estimate; the skew fit starts after 5 s of data and uses a 120 s window.
        </p>
      </section>
    </div>
  );
}
