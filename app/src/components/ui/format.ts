// Number and time formatting for measurements. A missing value is always shown as "—", never as 0.

export const DASH = "—";

export function fmt(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined || !Number.isFinite(v) ? DASH : v.toFixed(digits);
}

/** Device-computed values arrive as float32; show them at a precision a person can read. */
export function readable(v: number): string {
  if (Number.isInteger(v)) return String(v);
  const a = Math.abs(v);
  return String(Number(v.toFixed(a >= 100 ? 1 : a >= 1 ? 2 : 3)));
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** "0.4 s ago", "12 s ago", "3 min ago". */
export function fmtAge(ms: number | null): string {
  if (ms === null) return DASH;
  if (ms < 1000) return `${(ms / 1000).toFixed(1)} s ago`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s ago`;
  return `${Math.round(ms / 60_000)} min ago`;
}

export function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

export function fmtDateTime(ts: number): string {
  return new Date(ts).toLocaleString([], { hour12: false, year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function hex(b: number): string {
  return b.toString(16).padStart(2, "0");
}

export function download(filename: string, text: string, type = "application/json"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
