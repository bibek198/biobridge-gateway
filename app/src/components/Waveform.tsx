import { useEffect, useRef } from "react";
import { useAppStore } from "../state/appStore";

const WINDOW_MS = 5000;

/** Draws the last few seconds of a channel against its own timestamps, autoscaled. */
export function Waveform({ connectionId, channel, label }: { connectionId: string; channel: string; label: string }) {
  const { session, renderTick } = useAppStore();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = "#0b1220";
    ctx.fillRect(0, 0, width, height);

    const all = session.getBuffer(connectionId, channel);
    const end = all.length > 0 ? all[all.length - 1].timestamp : 0;
    let first = all.length;
    while (first > 0 && all[first - 1].timestamp >= end - WINDOW_MS) first--;
    const readings = all.slice(first);

    if (readings.length < 2) {
      ctx.fillStyle = "#64748b";
      ctx.font = "13px sans-serif";
      ctx.fillText("Waiting for data…", 12, height / 2);
      return;
    }

    let min = Infinity;
    let max = -Infinity;
    for (const r of readings) {
      if (r.value < min) min = r.value;
      if (r.value > max) max = r.value;
    }
    const span = Math.max(max - min, Math.abs(max) * 1e-3, 1e-6);
    const lo = min - span * 0.1;
    const hi = max + span * 0.1;

    ctx.beginPath();
    ctx.strokeStyle = "#4ade80";
    ctx.lineWidth = 1.5;
    readings.forEach((r, i) => {
      const x = ((r.timestamp - (end - WINDOW_MS)) / WINDOW_MS) * width;
      const y = height - ((r.value - lo) / (hi - lo)) * height;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.fillStyle = "#94a3b8";
    ctx.font = "11px sans-serif";
    const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toPrecision(3));
    ctx.fillText(fmt(max), 6, 12);
    ctx.fillText(fmt(min), 6, height - 4);
    ctx.fillText(`${WINDOW_MS / 1000} s`, width - 26, height - 4);
  }, [session, renderTick, connectionId, channel]);

  return (
    <div className="waveform-container">
      <div className="waveform-label">{label}</div>
      <canvas ref={canvasRef} className="waveform-canvas" />
    </div>
  );
}
