// Browser side of compute placement: the firmware's own DSP library (firmware/lib/bbdsp), compiled to
// WebAssembly by scripts/build-wasm.mjs. The same C runs on the ESP32 in "edge" mode, so moving a stage
// between device and browser moves the identical algorithm.

export const DspEventKind = {
  R_PEAK: 1,
  HEART_RATE: 2,
  PULSE: 3,
  PULSE_RATE: 4,
  SPO2: 5,
  SQI: 6,
} as const;

export type DspEvent = { kind: number; value: number; tUs: number };

type Exports = {
  ecg_create(fs: number): number;
  ecg_free(h: number): void;
  ecg_push(h: number, mv: number, tUs: number): number;
  ppg_create(fs: number): number;
  ppg_free(h: number): void;
  ppg_push(h: number, red: number, ir: number, tUs: number): number;
  ev_kind(i: number): number;
  ev_value(i: number): number;
  ev_t(i: number): number;
};

export class EdgeDsp {
  private readonly x: Exports;

  private constructor(x: Exports) {
    this.x = x;
  }

  static async fromBytes(bytes: BufferSource): Promise<EdgeDsp> {
    const { instance } = await WebAssembly.instantiate(bytes);
    return new EdgeDsp(instance.exports as unknown as Exports);
  }

  /** For the browser: `const dsp = await EdgeDsp.fromUrl(wasmUrl)` with `import wasmUrl from "./bbdsp.wasm?url"`. */
  static async fromUrl(url: string): Promise<EdgeDsp> {
    return EdgeDsp.fromBytes(await (await fetch(url)).arrayBuffer());
  }

  private collect(n: number): DspEvent[] {
    const out: DspEvent[] = [];
    for (let i = 0; i < n; i++) out.push({ kind: this.x.ev_kind(i), value: this.x.ev_value(i), tUs: this.x.ev_t(i) >>> 0 });
    return out;
  }

  ecg(fsHz: number): EcgDetector {
    const h = this.x.ecg_create(fsHz);
    if (h < 0) throw new Error("EdgeDsp: no free ECG detector (pool of 32)");
    const d: EcgDetector = {
      cpuMs: 0,
      push: (mv, tUs) => {
        const t0 = performance.now();
        const n = this.x.ecg_push(h, mv, tUs >>> 0);
        d.cpuMs += performance.now() - t0;
        return n ? this.collect(n) : [];
      },
      free: () => this.x.ecg_free(h),
    };
    return d;
  }

  ppg(fsHz: number): PpgDetector {
    const h = this.x.ppg_create(fsHz);
    if (h < 0) throw new Error("EdgeDsp: no free PPG detector (pool of 32)");
    const d: PpgDetector = {
      cpuMs: 0,
      push: (red, ir, tUs) => {
        const t0 = performance.now();
        const n = this.x.ppg_push(h, red, ir, tUs >>> 0);
        d.cpuMs += performance.now() - t0;
        return n ? this.collect(n) : [];
      },
      free: () => this.x.ppg_free(h),
    };
    return d;
  }
}

/** cpuMs: wall time spent inside this detector's Wasm calls (the browser's share of the compute cost). */
export type EcgDetector = { cpuMs: number; push(mv: number, tUs: number): DspEvent[]; free(): void };
export type PpgDetector = { cpuMs: number; push(red: number, ir: number, tUs: number): DspEvent[]; free(): void };
