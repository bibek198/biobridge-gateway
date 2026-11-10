import { useEffect, useRef, useState } from "react";
import { niceTicks } from "./TimeSeriesChart";

// Histogram of a sample (e.g. sync residuals) with labelled axes. Bin edges are "nice" numbers.

export function Histogram({
  values,
  xLabel,
  height = 180,
  color = "--series-1",
  emptyText = "No data yet",
}: {
  values: number[];
  xLabel: string;
  height?: number;
  color?: string;
  emptyText?: string;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(canvas);
    const C = (n: string) => css.getPropertyValue(n).trim() || "#888";
    const font = css.getPropertyValue("--font-sans") || "sans-serif";
    ctx.fillStyle = C("--chart-bg");
    ctx.fillRect(0, 0, width, height);
    ctx.font = `11px ${font}`;
    ctx.fillStyle = C("--chart-text");

    const P = { l: 44, r: 12, t: 10, b: 34 };
    const pw = width - P.l - P.r;
    const ph = height - P.t - P.b;
    const xs = values.filter(Number.isFinite);
    if (xs.length < 2) {
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(emptyText, width / 2, height / 2);
      return;
    }
    let lo = Math.min(...xs);
    let hi = Math.max(...xs);
    if (hi === lo) {
      lo -= 0.5;
      hi += 0.5;
    }
    const edges = niceTicks(lo, hi, Math.min(30, Math.max(8, Math.round(Math.sqrt(xs.length)))));
    const step = edges.length > 1 ? edges[1] - edges[0] : 1;
    const start = edges[0] > lo ? edges[0] - step : edges[0];
    const nb = Math.max(1, Math.ceil((hi - start) / step + 1e-9));
    const counts = new Array<number>(nb).fill(0);
    for (const v of xs) counts[Math.min(nb - 1, Math.floor((v - start) / step))]++;
    const xlo = start;
    const xhi = start + nb * step;
    const cmax = Math.max(...counts);
    const X = (x: number) => P.l + ((x - xlo) / (xhi - xlo)) * pw;
    const Y = (c: number) => P.t + ph - (c / cmax) * ph;

    ctx.strokeStyle = C("--chart-grid");
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const t of niceTicks(0, cmax, 4).filter((t) => Number.isInteger(t))) {
      const y = Math.round(Y(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(P.l, y);
      ctx.lineTo(P.l + pw, y);
      ctx.stroke();
      ctx.fillText(String(t), P.l - 6, y);
    }
    ctx.fillStyle = C(color);
    counts.forEach((c, i) => {
      if (c === 0) return;
      const x0 = X(xlo + i * step);
      const x1 = X(xlo + (i + 1) * step);
      ctx.fillRect(x0 + 0.5, Y(c), Math.max(1, x1 - x0 - 1), P.t + ph - Y(c));
    });
    ctx.strokeStyle = C("--chart-axis");
    ctx.beginPath();
    ctx.moveTo(P.l + 0.5, P.t);
    ctx.lineTo(P.l + 0.5, P.t + ph + 0.5);
    ctx.lineTo(P.l + pw, P.t + ph + 0.5);
    ctx.stroke();
    ctx.fillStyle = C("--chart-text");
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const t of niceTicks(xlo, xhi, Math.max(2, Math.floor(pw / 70)))) ctx.fillText(String(Number(t.toPrecision(3))), X(t), P.t + ph + 5);
    ctx.fillText(xLabel, P.l + pw / 2, height - 14);
    ctx.save();
    ctx.translate(12, P.t + ph / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textBaseline = "middle";
    ctx.fillText("count", 0, 0);
    ctx.restore();
  });

  return (
    <div className="chart" ref={wrapRef}>
      <canvas ref={canvasRef} role="img" aria-label={`Histogram of ${xLabel}, ${values.length} values`} />
    </div>
  );
}
