import { useEffect, useRef, useState, type MouseEvent } from "react";

// Canvas time-series chart for measurements: labelled axes with units, nice ticks, light grid, legend,
// gaps where data is missing, and a hover read-out with exact values. Colours come from CSS tokens, so it
// follows the theme. Large series are decimated to min/max per pixel column (peaks are preserved).

export type Series = {
  label: string;
  /** CSS custom property, e.g. "--series-1". */
  color: string;
  points: { x: number; y: number }[];
  mode?: "line" | "points";
};

export type ChartProps = {
  series: Series[];
  height?: number;
  /** Visible x range; defaults to the data extent. */
  xDomain?: [number, number];
  yDomain?: [number, number];
  /** Make the y range symmetric about zero (error plots). */
  symmetric?: boolean;
  xLabel: string;
  yLabel: string;
  xFormat?: (x: number) => string;
  yFormat?: (y: number) => string;
  /** Horizontal reference line (e.g. 0 ms error). */
  refY?: number;
  /** A jump in x larger than this breaks the line (missing data). */
  gapX?: number;
  emptyText?: string;
  legend?: boolean;
};

const PAD = { l: 56, r: 12, t: 10, b: 34 };

export function niceTicks(lo: number, hi: number, target = 5): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => raw <= s) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

const defaultFmt = (v: number) => {
  const a = Math.abs(v);
  if (a === 0) return "0";
  if (a >= 1000) return v.toFixed(0);
  if (a >= 10) return String(Number(v.toFixed(1)));
  if (a >= 1) return String(Number(v.toFixed(2)));
  return String(Number(v.toPrecision(2)));
};

function cssVar(el: Element, name: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || "#888";
}

function extent(series: Series[], key: "x" | "y", within?: [number, number]): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of series) {
    for (const p of s.points) {
      if (within && (p.x < within[0] || p.x > within[1])) continue;
      const v = p[key];
      if (!Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

export function TimeSeriesChart(props: ChartProps) {
  const { series, height = 180, xLabel, yLabel, emptyText = "No data yet", legend = true } = props;
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** Written straight to the DOM: the chart redraws every frame and must not re-render itself. */
  const showTip = (t: { left: number; top: number; lines: string[] } | null) => {
    const el = tipRef.current;
    if (!el) return;
    if (!t) {
      el.style.display = "none";
      return;
    }
    el.style.display = "block";
    el.style.left = `${t.left}px`;
    el.style.top = `${t.top}px`;
    el.textContent = t.lines.join("\n");
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const C = (n: string) => cssVar(canvas, n);
    const font = getComputedStyle(canvas).getPropertyValue("--font-sans") || "sans-serif";
    ctx.fillStyle = C("--chart-bg");
    ctx.fillRect(0, 0, width, height);

    const pw = width - PAD.l - PAD.r;
    const ph = height - PAD.t - PAD.b;
    const xd = props.xDomain ?? extent(series, "x");
    const yRaw = props.yDomain ?? (xd ? extent(series, "y", xd) : null);

    ctx.font = `11px ${font}`;
    ctx.fillStyle = C("--chart-text");
    ctx.textBaseline = "middle";

    if (!xd || !yRaw || pw < 40 || ph < 30) {
      ctx.textAlign = "center";
      ctx.fillText(emptyText, width / 2, height / 2);
      showTip(null);
      return;
    }

    let [ylo, yhi] = yRaw;
    if (props.symmetric) {
      const m = Math.max(Math.abs(ylo), Math.abs(yhi), 1e-9);
      ylo = -m;
      yhi = m;
    }
    if (!props.yDomain) {
      const span = Math.max(yhi - ylo, Math.abs(yhi) * 1e-3, 1e-6);
      ylo -= span * 0.08;
      yhi += span * 0.08;
    }
    const [xlo, xhi] = xd[1] > xd[0] ? xd : [xd[0] - 1, xd[0] + 1];
    const X = (x: number) => PAD.l + ((x - xlo) / (xhi - xlo)) * pw;
    const Y = (y: number) => PAD.t + ph - ((y - ylo) / (yhi - ylo)) * ph;
    const xf = props.xFormat ?? defaultFmt;
    const yf = props.yFormat ?? defaultFmt;

    // grid + ticks
    ctx.strokeStyle = C("--chart-grid");
    ctx.lineWidth = 1;
    ctx.textAlign = "right";
    for (const t of niceTicks(ylo, yhi, Math.max(2, Math.floor(ph / 36)))) {
      const y = Math.round(Y(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(PAD.l, y);
      ctx.lineTo(PAD.l + pw, y);
      ctx.stroke();
      ctx.fillText(yf(t), PAD.l - 6, y);
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const t of niceTicks(xlo, xhi, Math.max(2, Math.floor(pw / 90)))) {
      const x = Math.round(X(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, PAD.t);
      ctx.lineTo(x, PAD.t + ph);
      ctx.stroke();
      ctx.fillText(xf(t), x, PAD.t + ph + 5);
    }

    // axes
    ctx.strokeStyle = C("--chart-axis");
    ctx.beginPath();
    ctx.moveTo(PAD.l + 0.5, PAD.t);
    ctx.lineTo(PAD.l + 0.5, PAD.t + ph + 0.5);
    ctx.lineTo(PAD.l + pw, PAD.t + ph + 0.5);
    ctx.stroke();

    ctx.fillStyle = C("--chart-text");
    ctx.fillText(xLabel, PAD.l + pw / 2, height - 14);
    ctx.save();
    ctx.translate(12, PAD.t + ph / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textBaseline = "middle";
    ctx.fillText(yLabel, 0, 0);
    ctx.restore();

    if (props.refY !== undefined && props.refY >= ylo && props.refY <= yhi) {
      ctx.strokeStyle = C("--chart-axis");
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(PAD.l, Math.round(Y(props.refY)) + 0.5);
      ctx.lineTo(PAD.l + pw, Math.round(Y(props.refY)) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // data
    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD.l, PAD.t, pw, ph);
    ctx.clip();
    for (const s of series) {
      const color = C(s.color);
      const pts = s.points.filter((p) => p.x >= xlo && p.x <= xhi && Number.isFinite(p.y));
      if (s.mode === "points") {
        ctx.fillStyle = color;
        for (const p of pts) ctx.fillRect(X(p.x) - 1.5, Y(p.y) - 1.5, 3, 3);
        continue;
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.25;
      ctx.lineJoin = "round";
      ctx.beginPath();
      if (pts.length > pw * 2) {
        // decimate: min/max per pixel column
        let col = -1;
        let mn = 0;
        let mx = 0;
        let started = false;
        const flush = () => {
          if (col < 0) return;
          const x = PAD.l + col + 0.5;
          if (!started) {
            ctx.moveTo(x, Y(mn));
            started = true;
          } else ctx.lineTo(x, Y(mn));
          ctx.lineTo(x, Y(mx));
        };
        for (const p of pts) {
          const c = Math.floor(X(p.x) - PAD.l);
          if (c !== col) {
            flush();
            col = c;
            mn = mx = p.y;
          } else {
            if (p.y < mn) mn = p.y;
            if (p.y > mx) mx = p.y;
          }
        }
        flush();
      } else {
        let prev: number | null = null;
        for (const p of pts) {
          if (prev === null || (props.gapX !== undefined && p.x - prev > props.gapX)) ctx.moveTo(X(p.x), Y(p.y));
          else ctx.lineTo(X(p.x), Y(p.y));
          prev = p.x;
        }
      }
      ctx.stroke();
    }
    ctx.restore();

    // hover read-out
    if (hoverX !== null && hoverX >= PAD.l && hoverX <= PAD.l + pw) {
      const xv = xlo + ((hoverX - PAD.l) / pw) * (xhi - xlo);
      ctx.strokeStyle = C("--chart-axis");
      ctx.beginPath();
      ctx.moveTo(Math.round(hoverX) + 0.5, PAD.t);
      ctx.lineTo(Math.round(hoverX) + 0.5, PAD.t + ph);
      ctx.stroke();
      const lines = [`${xLabel.replace(/\s*\(.*\)/, "")}: ${xf(xv)}`];
      let topY = PAD.t + ph;
      for (const s of series) {
        let best: { x: number; y: number } | null = null;
        for (const p of s.points) if (!best || Math.abs(p.x - xv) < Math.abs(best.x - xv)) best = p;
        if (!best || Math.abs(X(best.x) - hoverX) > 24) continue;
        ctx.fillStyle = C(s.color);
        ctx.beginPath();
        ctx.arc(X(best.x), Y(best.y), 3, 0, Math.PI * 2);
        ctx.fill();
        topY = Math.min(topY, Y(best.y));
        lines.push(`${s.label}: ${yf(best.y)}`);
      }
      showTip(lines.length > 1 ? { left: hoverX + 12 > width - 170 ? hoverX - 170 : hoverX + 12, top: Math.max(0, topY - 20) + canvas.offsetTop, lines } : null);
    } else showTip(null);
  });

  const onMove = (e: MouseEvent<HTMLCanvasElement>) => setHoverX(e.clientX - e.currentTarget.getBoundingClientRect().left);

  return (
    <div className="chart" ref={wrapRef}>
      {legend && series.length > 1 && (
        <div className="chart-legend">
          {series.map((s) => (
            <span key={s.label}>
              <span className="swatch" style={{ background: `var(${s.color})` }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`${yLabel} against ${xLabel}${series.length ? `: ${series.map((s) => s.label).join(", ")}` : ""}`}
        onMouseMove={onMove}
        onMouseLeave={() => setHoverX(null)}
      />
      <div className="chart-tooltip" ref={tipRef} style={{ display: "none" }} />
    </div>
  );
}
