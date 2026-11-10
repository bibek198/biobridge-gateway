import type { Descriptor } from "../descriptors/types";
import { validateDescriptor } from "../descriptors/validate";

// Devices the user added through the Add a Device page (synthesized or imported descriptors). Kept in this
// browser's localStorage: a convenience, not the record. Export the descriptor JSON to keep or share it.

export type CustomDeviceSource = { kind: "hardware" } | { kind: "sim-bench"; benchId: string };

export type CustomDevice = { id: string; label: string; descriptor: Descriptor; source: CustomDeviceSource; addedAt: number };

const KEY = "biobridge.customDevices.v1";

export function loadCustomDevices(): CustomDevice[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    // Anything that no longer validates (schema changed, edited by hand) is dropped rather than crashing the app.
    return raw.filter((d) => d && typeof d.id === "string" && validateDescriptor(d.descriptor).ok);
  } catch {
    return [];
  }
}

export function saveCustomDevices(devices: CustomDevice[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(devices));
  } catch {
    // Storage unavailable (private window, quota): the devices last for this session only.
  }
}
