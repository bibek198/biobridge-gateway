import { computeChecksum } from "../protocol/checksums";
import { PayloadWriter } from "../protocol/frame";
import { hostNowMs } from "../time/clock";
import { randomDriftPpm, SimDeviceClock, SimulatedTransport, type SimEnv } from "../transports/simulatedTransports";

// Simulated third-party devices for the Paper 2 benchmark. Each speaks a deliberately different protocol
// (framing, checksum, byte order, scaling, timestamps) and records the physical values it meant to send,
// so the ground-truth descriptor can be checked against the generator independently (test/bench.test.ts).
// Generators are hand-written from each device's datasheet, not derived from its descriptor.

const encoder = new TextEncoder();

export abstract class BenchDeviceTransport extends SimulatedTransport {
  protected readonly clock = new SimDeviceClock(randomDriftPpm());
  /** Physical values each channel was meant to carry, in emission order. */
  readonly intended = new Map<string, number[]>();

  protected expect(channel: string, value: number): void {
    if (!this.intended.has(channel)) this.intended.set(channel, []);
    this.intended.get(channel)!.push(value);
  }

  private lastSerialArrival = 0;

  /** Serial-like delivery: a few ms of latency, bytes split at a random point, never reordered. */
  protected sendSerial(bytes: Uint8Array, readyHostMs = hostNowMs()): void {
    const arrival = Math.max(this.lastSerialArrival, readyHostMs + 0.5 + Math.random() * 2);
    this.lastSerialArrival = arrival;
    const cut = 1 + Math.floor(Math.random() * Math.max(1, bytes.length - 1));
    this.deliverAt(arrival, bytes.slice(0, cut));
    if (cut < bytes.length) this.deliverAt(arrival, bytes.slice(cut));
  }

  /** BLE-like delivery: one notification, a connection interval of latency. */
  protected sendNotification(bytes: Uint8Array): void {
    this.deliverAt(hostNowMs() + 3 + Math.random() * 12, bytes);
  }

  /** Runs `fn` for every sample instant (device clock) that has passed, at a fixed device-time period. */
  protected sampler(periodUs: number, onSample: (deviceUs: number, hostMs: number) => void): () => void {
    let next = this.clock.deviceUs(hostNowMs());
    return () => {
      const now = hostNowMs();
      while (this.clock.hostMs(next) <= now) {
        onSample(next, this.clock.hostMs(next));
        next += periodUs;
      }
    };
  }
}

/** Polar-style chest strap: standard BLE Heart Rate Measurement once a second, u8 HR + RR intervals. */
export class BleHrsStrapTransport extends BenchDeviceTransport {
  deviceLabel(): string {
    return "Simulated HR strap";
  }

  protected start(): void {
    this.every(1000, () => {
      const hr = Math.round(this.model.vitalsAtTime(hostNowMs()).hr);
      const rr = Math.round((60 / hr) * 1024); // RR in 1/1024 s
      // flags: bit0=0 (u8 HR), bits1-2=11 (contact supported + detected), bit4=1 (RR present)
      const w = new PayloadWriter().u8(0x16).u8(hr).u16(rr);
      if (hr > 60) w.u16(rr); // two beats fit in a second
      this.expect("heartRate", hr);
      this.sendNotification(w.build());
    });
  }
}

/** Lab ECG amplifier printing CSV at 200 Hz: "t_ms,ecg_uV,lo\r\n" after a header line. */
export class AsciiEcgTransport extends BenchDeviceTransport {
  deviceLabel(): string {
    return "Simulated ASCII ECG amplifier";
  }

  protected start(): void {
    this.deliverAt(hostNowMs(), encoder.encode("t_ms,ecg_uV,lo\r\n"));
    let lines = "";
    const tick = this.sampler(5000, (deviceUs, hostMs) => {
      const uV = Math.round(this.model.ecgMv(hostMs) * 1000);
      lines += `${Math.floor(deviceUs / 1000)},${uV},0\r\n`;
      this.expect("ecg", uV / 1000);
      this.expect("leadsOff", 0);
    });
    this.every(20, () => {
      tick();
      if (lines) this.sendSerial(encoder.encode(lines));
      lines = "";
    });
  }
}

/** Budget fingertip oximeter: fixed 9-byte frames at 50 Hz, AA 55 sync, XOR checksum. */
export class FixedOximeterTransport extends BenchDeviceTransport {
  private seq = 0;

  deviceLabel(): string {
    return "Simulated fingertip oximeter";
  }

  protected start(): void {
    this.every(20, () => {
      const now = hostNowMs();
      const v = this.model.vitalsAtTime(now);
      const pleth = Math.round(10 + 80 * Math.min(1, this.model.ppgPulse(now)));
      const spo2 = Math.round(v.spo2);
      const pr = Math.round(v.hr);
      const pi = 20; // 2.0 % in 0.1 % units
      const f = Uint8Array.of(0xaa, 0x55, 0x00, pleth, spo2, pr, pi, this.seq++ & 0xff, 0);
      f[8] = computeChecksum("xor8", f, 2, 8);
      this.expect("pleth", pleth);
      this.expect("spo2", spo2);
      this.expect("heartRate", pr);
      this.expect("perfusion", 2);
      this.sendSerial(f, now);
    });
  }
}

/** ECG front-end board: big-endian frames, 24-bit samples at 500 Hz (0.5 µV/LSB), SUM8 checksum, no timestamps. */
export class BigEndianEcgTransport extends BenchDeviceTransport {
  deviceLabel(): string {
    return "Simulated big-endian ECG board";
  }

  private frame(payload: Uint8Array): Uint8Array {
    const f = new Uint8Array(4 + payload.length + 1);
    f.set([0x5a, 0xa5, payload.length >> 8, payload.length & 0xff]);
    f.set(payload, 4);
    f[f.length - 1] = computeChecksum("sum8", f, 2, f.length - 1);
    return f;
  }

  protected start(): void {
    const batch: number[] = [];
    const tick = this.sampler(2000, (_deviceUs, hostMs) => {
      const raw = Math.round(this.model.ecgMv(hostMs) / 0.0005);
      batch.push(raw);
      this.expect("ecg", raw * 0.0005);
    });
    this.every(50, () => {
      tick();
      while (batch.length >= 25) {
        const part = batch.splice(0, 25);
        const w = new PayloadWriter().u8(0x10).u8(part.length);
        for (const r of part) {
          const u = r < 0 ? r + 0x1000000 : r;
          w.u8(u >> 16).u8(u >> 8).u8(u); // i24 big-endian
        }
        this.sendSerial(this.frame(w.build()));
      }
    });
    this.every(5000, () => {
      this.expect("battery", 87);
      this.sendSerial(this.frame(Uint8Array.of(0x20, 87)));
    });
  }
}

/** Upper-arm BP monitor: one result every 10 s plus 1 Hz cuff-pressure status; CRC-16/MODBUS; ms timestamps. */
export class BpMonitorTransport extends BenchDeviceTransport {
  private cycleStart = 0;

  deviceLabel(): string {
    return "Simulated BP monitor";
  }

  private frame(payload: Uint8Array): Uint8Array {
    const f = new Uint8Array(3 + payload.length + 2);
    f.set([0x42, 0x50, payload.length]);
    f.set(payload, 3);
    const crc = computeChecksum("crc16-modbus", f, 0, f.length - 2);
    f[f.length - 2] = crc & 0xff;
    f[f.length - 1] = crc >> 8;
    return f;
  }

  /** Inflate to 180 mmHg over 3 s, deflate to 0 by 9 s, report at 10 s. */
  private cuff(t: number): number {
    const s = (t - this.cycleStart) / 1000;
    if (s < 3) return (180 * s) / 3;
    if (s < 9) return 180 * (1 - (s - 3) / 6);
    return 0;
  }

  protected start(): void {
    this.cycleStart = hostNowMs();
    this.every(1000, () => {
      const now = hostNowMs();
      const tms = Math.floor(this.clock.deviceUs(now) / 1000);
      const cuff = Math.round(this.cuff(now) * 10);
      this.expect("cuffPressure", cuff / 10);
      this.sendSerial(this.frame(new PayloadWriter().u8(0x02).u32(tms).u16(cuff).build()));
      if ((now - this.cycleStart) / 1000 >= 9.5) {
        const v = this.model.vitalsAtTime(now);
        const sys = Math.round(v.bpSys * 10);
        const dia = Math.round(v.bpDia * 10);
        const map = Math.round(dia + (sys - dia) / 3);
        const pulse = Math.round(v.hr);
        this.expect("bp_systolic", sys / 10);
        this.expect("bp_diastolic", dia / 10);
        this.expect("bp_mean", map / 10);
        this.expect("heartRate", pulse);
        this.sendSerial(this.frame(new PayloadWriter().u8(0x01).u32(tms).u16(sys).u16(dia).u16(map).u8(pulse).build()));
        this.cycleStart = now + 500;
      }
    });
  }
}

/** Wrist IMU: 3-axis accelerometer at 50 Hz over BLE, 5 samples per notification, CRC big-endian, mg units. */
export class AccelImuTransport extends BenchDeviceTransport {
  deviceLabel(): string {
    return "Simulated wrist IMU";
  }

  protected start(): void {
    const batch: Array<{ t: number; xyz: number[] }> = [];
    const tick = this.sampler(20_000, (deviceUs, hostMs) => {
      const s = hostMs / 1000;
      const xyz = [
        Math.round(50 * Math.sin(2 * Math.PI * 1.8 * s) + (Math.random() - 0.5) * 10),
        Math.round(20 * Math.sin(2 * Math.PI * 0.9 * s) + (Math.random() - 0.5) * 10),
        Math.round(1000 + 100 * Math.sin(2 * Math.PI * 1.8 * s) + (Math.random() - 0.5) * 10),
      ];
      batch.push({ t: deviceUs, xyz });
    });
    this.every(100, () => {
      tick();
      while (batch.length >= 5) {
        const part = batch.splice(0, 5);
        const w = new PayloadWriter().u32(Math.floor(part[0].t / 1000)).u8(part.length);
        for (const p of part) {
          for (const v of p.xyz) w.i16(v);
          this.expect("accel_x", p.xyz[0] / 1000);
          this.expect("accel_y", p.xyz[1] / 1000);
          this.expect("accel_z", p.xyz[2] / 1000);
        }
        const payload = w.build();
        const f = new Uint8Array(2 + payload.length + 2);
        f.set([0xc3, payload.length]);
        f.set(payload, 2);
        const crc = computeChecksum("crc16-ccitt-false", f, 1, f.length - 2);
        f[f.length - 2] = crc >> 8; // big-endian
        f[f.length - 1] = crc & 0xff;
        this.sendNotification(f);
      }
    });
  }
}

/** USB PPG module streaming float32 samples at 100 Hz with µs timestamps. */
export class FloatPpgTransport extends BenchDeviceTransport {
  deviceLabel(): string {
    return "Simulated float PPG module";
  }

  protected start(): void {
    const batch: Array<{ t: number; v: number }> = [];
    const tick = this.sampler(10_000, (deviceUs, hostMs) => {
      const wander = 0.01 * Math.sin((2 * Math.PI * hostMs) / 4000);
      const v = Math.fround(1 + wander - 0.02 * this.model.ppgPulse(hostMs) + (Math.random() - 0.5) * 0.0004);
      batch.push({ t: deviceUs, v });
    });
    this.every(100, () => {
      tick();
      while (batch.length >= 10) {
        const part = batch.splice(0, 10);
        const body = new Uint8Array(5 + 4 * part.length);
        const dv = new DataView(body.buffer);
        dv.setUint32(0, part[0].t >>> 0, true);
        body[4] = part.length;
        part.forEach((p, i) => {
          dv.setFloat32(5 + 4 * i, p.v, true);
          this.expect("ppg_ir", p.v);
        });
        const f = new Uint8Array(4 + body.length + 2);
        f.set([0xa0, 0x0a, body.length & 0xff, body.length >> 8]);
        f.set(body, 4);
        const crc = computeChecksum("crc16-ccitt-false", f, 2, f.length - 2);
        f[f.length - 2] = crc & 0xff;
        f[f.length - 1] = crc >> 8;
        // Ready when the batch's last sample is taken.
        this.sendSerial(f, this.clock.hostMs(part[part.length - 1].t));
      }
    });
  }
}

export type { SimEnv };
