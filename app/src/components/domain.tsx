import { VOCABULARY } from "../bench/vocabulary";
import type { Descriptor, FramingSpec } from "../descriptors/types";
import type { CheckResult, Oracle } from "../verify/verifier";
import { DataTable } from "./ui/DataTable";
import { CheckBadge, EmptyState } from "./ui/primitives";

// Domain vocabulary shared by several pages: channel names and where a value was computed, descriptor
// summaries, and verifier check tables.

/** Channels produced by compute modules, with where they were computed. */
export const DERIVED: Record<string, { label: string; source: string }> = {
  heartRate_computed: { label: "Heart rate", source: "computed in browser from ECG (TS peak detector)" },
  spo2_filtered: { label: "SpO2 (filtered)", source: "moving average in browser" },
  pulseRate_ppg: { label: "Pulse rate", source: "computed in browser from PPG (TS)" },
  heartRate_wasm: { label: "Heart rate", source: "firmware DSP, run in browser (Wasm)" },
  pulseRate_wasm: { label: "Pulse rate", source: "firmware DSP, run in browser (Wasm)" },
  spo2_wasm: { label: "SpO2", source: "firmware DSP, run in browser (Wasm)" },
  sqi_wasm: { label: "Signal quality index", source: "firmware DSP, run in browser (Wasm)" },
};

export function channelLabel(id: string, d?: Descriptor): string {
  const spec = d?.channels.find((c) => c.id === id);
  if (spec?.label) return spec.label;
  if (DERIVED[id]) return DERIVED[id].label;
  const v = VOCABULARY[id]?.description;
  return v ? v.charAt(0).toUpperCase() + v.slice(1) : id;
}

/** Where a channel's value comes from, for labelling vitals. */
export function channelSource(id: string): string {
  if (DERIVED[id]) return DERIVED[id].source;
  if (id.endsWith("_edge")) return "computed on the device";
  return "reported by the device";
}

export function framingText(f: FramingSpec): string {
  switch (f.kind) {
    case "delimited":
      return `Delimited text (${JSON.stringify(f.delimiter)})`;
    case "magic-length-crc":
      return `Magic ${f.magic.map((b) => b.toString(16).padStart(2, "0")).join(" ")} + ${f.lengthType} length + ${f.crc.kind}`;
    case "magic-fixed":
      return `Magic ${f.magic.map((b) => b.toString(16).padStart(2, "0")).join(" ")}, fixed ${f.frameLength} B${f.checksum ? ` + ${f.checksum.kind}` : ""}`;
    case "per-chunk":
      return "One message per notification";
  }
}

export function transportText(d: Descriptor): string {
  return d.transport.kind === "serial" ? `USB-serial, ${d.transport.baudRate} baud` : `BLE, service ${d.transport.service}`;
}

export function DescriptorSummary({ d }: { d: Descriptor }) {
  return (
    <dl className="kv">
      <dt>Descriptor</dt>
      <dd>
        <code>{d.id}</code> <span className="muted">· {d.schema}</span>
      </dd>
      <dt>Transport</dt>
      <dd>{transportText(d)}</dd>
      <dt>Framing</dt>
      <dd>{framingText(d.framing)}</dd>
      {d.messages && (
        <>
          <dt>Messages</dt>
          <dd>{d.messages.map((m) => m.name).join(", ")}</dd>
        </>
      )}
      {d.text && (
        <>
          <dt>Text format</dt>
          <dd>
            {d.text.mode} · separator {JSON.stringify(d.text.separator)}
          </dd>
        </>
      )}
      <dt>Channels</dt>
      <dd>
        {d.channels.map((c) => (
          <span key={c.id} style={{ marginRight: 10 }}>
            <code>{c.id}</code>
            {c.unit && <span className="muted"> ({c.unit})</span>}
          </span>
        ))}
      </dd>
      <dt>Commands</dt>
      <dd>{d.commands?.length ? d.commands.map((c) => c.label).join(", ") : <span className="muted">none</span>}</dd>
    </dl>
  );
}

export const ORACLES: { id: Oracle; label: string; question: string }[] = [
  { id: "structural", label: "Structural", question: "Do the frames decode: checksums, lengths, sequence numbers?" },
  { id: "plausibility", label: "Plausibility", question: "Are values and rates within physical bounds for each channel?" },
  { id: "semantic", label: "Semantic", question: "Do channels behave like what they claim to be (distinct, right signal shape)?" },
  { id: "cross-sensor", label: "Cross-sensor", question: "Do independent sensors on the same subject agree (e.g. ECG vs PPG rate)?" },
];

export function CheckTable({ checks, showOracle = true }: { checks: CheckResult[]; showOracle?: boolean }) {
  return (
    <DataTable
      rows={checks}
      rowKey={(c) => c.id}
      empty={<EmptyState title="No checks yet">Checks appear once data arrives.</EmptyState>}
      columns={[
        { key: "status", header: "Result", cell: (c) => <CheckBadge status={c.status} />, sort: (c) => ["fail", "warn", "pending", "pass"].indexOf(c.status), width: 96 },
        ...(showOracle ? [{ key: "oracle", header: "Oracle", cell: (c: CheckResult) => c.oracle, sort: (c: CheckResult) => c.oracle, width: 110 }] : []),
        { key: "name", header: "Check", cell: (c) => <span className="cell-main">{c.name}</span> },
        { key: "detail", header: "Detail", cell: (c) => <span className="cell-sub">{c.detail}</span> },
      ]}
    />
  );
}
