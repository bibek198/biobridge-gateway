import { useMemo, useRef, useState } from "react";
import type { CapturedChunk } from "../session/sessionManager";
import { fmt, hex } from "../components/ui/format";
import { Segmented } from "../components/ui/primitives";

// Byte-level view of a raw capture: offsets, hex or decimal, ASCII, chunk boundaries. Click a byte to see the
// bytes from there read as every integer/float type, little- and big-endian; shift-click to select a range.

const MAX_BYTES = 1024;
const PER_ROW = 16;

type Interp = { type: string; value: string };

function interpret(bytes: Uint8Array, at: number): Interp[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const left = bytes.length - at;
  const out: Interp[] = [];
  const add = (type: string, need: number, f: () => number | string) => out.push({ type, value: left >= need ? String(f()) : "—" });
  add("u8", 1, () => dv.getUint8(at));
  add("i8", 1, () => dv.getInt8(at));
  add("u16le", 2, () => dv.getUint16(at, true));
  add("u16be", 2, () => dv.getUint16(at, false));
  add("i16le", 2, () => dv.getInt16(at, true));
  add("i16be", 2, () => dv.getInt16(at, false));
  const u24 = (le: boolean) => (le ? bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) : (bytes[at] << 16) | (bytes[at + 1] << 8) | bytes[at + 2]);
  add("u24le", 3, () => u24(true));
  add("u24be", 3, () => u24(false));
  add("i24le", 3, () => (u24(true) << 8) >> 8);
  add("i24be", 3, () => (u24(false) << 8) >> 8);
  add("u32le", 4, () => dv.getUint32(at, true));
  add("u32be", 4, () => dv.getUint32(at, false));
  add("i32le", 4, () => dv.getInt32(at, true));
  add("i32be", 4, () => dv.getInt32(at, false));
  const f = (le: boolean) => {
    const v = dv.getFloat32(at, le);
    return Number.isFinite(v) && Math.abs(v) < 1e9 && (v === 0 || Math.abs(v) > 1e-9) ? Number(v.toPrecision(7)) : v.toExponential(3);
  };
  add("f32le", 4, () => f(true));
  add("f32be", 4, () => f(false));
  return out;
}

export function PacketInspector({ chunks }: { chunks: CapturedChunk[] }) {
  const [radix, setRadix] = useState<"hex" | "dec">("hex");
  const [sel, setSel] = useState<{ a: number; b: number }>({ a: 0, b: 0 });
  const gridRef = useRef<HTMLDivElement | null>(null);

  const { bytes, boundaries, total, stats } = useMemo(() => {
    const totalLen = chunks.reduce((n, c) => n + c.bytes.length, 0);
    const buf = new Uint8Array(Math.min(MAX_BYTES, totalLen));
    const starts = new Set<number>();
    let o = 0;
    for (const c of chunks) {
      if (o >= buf.length) break;
      starts.add(o);
      buf.set(c.bytes.subarray(0, buf.length - o), o);
      o += c.bytes.length;
    }
    const sizes = chunks.map((c) => c.bytes.length).sort((x, y) => x - y);
    const gaps = chunks.slice(1).map((c, i) => c.t - chunks[i].t).sort((x, y) => x - y);
    const med = (xs: number[]) => (xs.length ? xs[Math.floor(xs.length / 2)] : null);
    return {
      bytes: buf,
      boundaries: starts,
      total: totalLen,
      stats: { n: chunks.length, min: sizes[0] ?? 0, med: med(sizes), max: sizes[sizes.length - 1] ?? 0, gap: med(gaps) },
    };
  }, [chunks]);

  const lo = Math.min(sel.a, sel.b);
  const hi = Math.max(sel.a, sel.b);
  const rows = [];
  for (let r = 0; r < bytes.length; r += PER_ROW) rows.push(r);
  const ascii = (b: number) => (b >= 32 && b < 127 ? String.fromCharCode(b) : "·");

  return (
    <div className="grid main-side">
      <div>
        <div className="row-between" style={{ marginBottom: 6 }}>
          <span className="small muted">
            {total.toLocaleString()} B in {stats.n} chunks · chunk size {stats.min}/{stats.med}/{stats.max} B (min/median/max) · median interval {fmt(stats.gap, 1)} ms
            {total > MAX_BYTES && ` · showing first ${MAX_BYTES} B`}
          </span>
          <Segmented label="Byte format" options={[{ id: "hex", label: "Hex" }, { id: "dec", label: "Dec" }]} value={radix} onChange={setRadix} />
        </div>
        <div ref={gridRef} className="bytes" style={{ maxHeight: 340, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 5, padding: "6px 10px" }} role="grid" aria-label="Captured bytes">
          {rows.map((r) => (
            <div key={r} className="row">
              <span className="off">{r.toString(16).padStart(4, "0")}</span>
              <span>
                {Array.from(bytes.subarray(r, r + PER_ROW), (b, i) => {
                  const k = r + i;
                  const cls = `b ${k >= lo && k <= hi ? "sel" : ""}`;
                  return (
                    <span key={k}>
                      {boundaries.has(k) && k > 0 ? <span className="chunk-mark" title="chunk boundary">|</span> : " "}
                      <span
                        className={cls}
                        role="gridcell"
                        tabIndex={k === lo ? 0 : -1}
                        aria-selected={k >= lo && k <= hi}
                        onClick={(e) => setSel((s) => (e.shiftKey ? { a: s.a, b: k } : { a: k, b: k }))}
                        onKeyDown={(e) => {
                          const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" ? PER_ROW : e.key === "ArrowUp" ? -PER_ROW : 0;
                          if (!d) return;
                          e.preventDefault();
                          const n = Math.max(0, Math.min(bytes.length - 1, k + d));
                          setSel((s) => (e.shiftKey ? { a: s.a, b: n } : { a: n, b: n }));
                          (gridRef.current?.querySelectorAll<HTMLElement>(".b")[n])?.focus();
                        }}
                      >
                        {radix === "hex" ? hex(b) : String(b).padStart(3, "0")}
                      </span>
                    </span>
                  );
                })}
              </span>
              <span className="ascii">{Array.from(bytes.subarray(r, r + PER_ROW), ascii).join("")}</span>
            </div>
          ))}
        </div>
        <div className="small muted" style={{ marginTop: 4 }}>
          Click a byte to interpret from there; shift-click or shift+arrow to select a range. <span className="chunk-mark">|</span> marks a transport chunk boundary.
        </div>
      </div>
      <div>
        <div className="wave-head">
          <strong>Offset 0x{lo.toString(16)}</strong>
          <span className="muted">({lo})</span>
          {hi > lo && <span className="muted">selection {hi - lo + 1} B</span>}
        </div>
        {hi > lo && (
          <div className="mono small" style={{ marginBottom: 8, wordBreak: "break-all" }}>
            {Array.from(bytes.subarray(lo, hi + 1), hex).join(" ")}
            {hi - lo + 1 <= 64 && <div className="muted">“{Array.from(bytes.subarray(lo, hi + 1), ascii).join("")}”</div>}
          </div>
        )}
        <div className="interp">
          {interpret(bytes, lo).map((i) => (
            <div key={i.type}>
              <span>{i.type}</span>
              <span>{i.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
