import type { Descriptor } from "../types";
import { validateDescriptor } from "../validate";
import nodeA from "./biobridge-node-a.json";
import nodeB from "./biobridge-node-b.json";
import syncNode from "./biobridge-sync.json";
import bleHeartRate from "./ble-heart-rate.json";
import genericSerialCsv from "./generic-serial-csv.json";

function load(json: unknown): Descriptor {
  const result = validateDescriptor(json);
  if (!result.ok) throw new Error(`Bundled descriptor is invalid:\n${result.errors.join("\n")}`);
  return result.descriptor;
}

export const DESCRIPTORS = {
  nodeA: load(nodeA),
  nodeB: load(nodeB),
  syncNode: load(syncNode),
  bleHeartRate: load(bleHeartRate),
  genericSerialCsv: load(genericSerialCsv),
};
