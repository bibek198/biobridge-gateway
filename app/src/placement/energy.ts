// A first-order power model for compute placement on a BLE node, so modes can be compared before the
// INA219 rig exists. Every parameter is an assumption from datasheet-level figures, NOT a measurement;
// the INA219 measurements are meant to replace them (docs/research-plan.md §5).
//
//   radio:  BLE 1M PHY puts a byte on air in 8 µs; an ESP32 transmitting draws ~130 mA at 3.3 V
//           (~0.43 W), i.e. ~3.4 µJ per payload byte. Packet headers, MIC/CRC, empty packets and the
//           receive window roughly double that: ~7 µJ per payload byte.
//   cpu:    ESP32 at 240 MHz, one core busy: ~45 mA at 3.3 V (~0.15 W) above idle.
// USB-serial nodes are powered by the host, so only BLE links get a radio estimate.

export const ENERGY_MODEL = {
  bleJoulesPerPayloadByte: 7e-6,
  cpuActiveWatts: 0.15,
} as const;

export type PowerEstimate = { radioMw: number | null; dspMw: number; totalMw: number | null };

export function estimatePower(p: { transport: "serial" | "ble"; linkBytesPerS: number; dspUsPerS: number }): PowerEstimate {
  const radioMw = p.transport === "ble" ? p.linkBytesPerS * ENERGY_MODEL.bleJoulesPerPayloadByte * 1000 : null;
  const dspMw = (p.dspUsPerS / 1e6) * ENERGY_MODEL.cpuActiveWatts * 1000;
  return { radioMw, dspMw, totalMw: radioMw === null ? null : radioMw + dspMw };
}
