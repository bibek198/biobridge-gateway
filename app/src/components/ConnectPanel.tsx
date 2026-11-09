import { useAppStore } from "../state/appStore";
import { DEVICE_FACTORIES, type DeviceFactory, type DeviceGroup } from "../drivers/registry";
import type { SimScenario } from "../sim/physiology";
import type { ConnectionView } from "../session/sessionManager";
import type { CheckResult, Verdict } from "../verify/verifier";

const SCENARIOS: { value: SimScenario; label: string }[] = [
  { value: "normal", label: "Normal" },
  { value: "tachycardia", label: "Tachycardia" },
  { value: "desaturation", label: "Desaturation event" },
];

const GROUPS: { group: DeviceGroup; title: string; blurb: string }[] = [
  {
    group: "simulated",
    title: "Simulated devices",
    blurb: "No hardware needed. These emit the same bytes as the real firmware and go through the same descriptors.",
  },
  {
    group: "hardware",
    title: "Hardware",
    blurb: "Requires Chrome or Edge on localhost/HTTPS. The browser shows a device picker on Connect.",
  },
];

const TRANSPORT_LABEL = { serial: "USB-serial", ble: "Bluetooth LE" } as const;

function DeviceCard({ factory }: { factory: DeviceFactory }) {
  const { session } = useAppStore();
  const supported = factory.isSupported();
  const active = session.listConnections().filter((c) => c.factoryId === factory.id && c.group !== "replay");
  const transport = factory.group === "simulated" ? "simulated" : TRANSPORT_LABEL[factory.descriptor.transport.kind];

  return (
    <div className={`driver-card ${supported ? "" : "unsupported"}`}>
      <div className="driver-card-header">
        <strong>{factory.label}</strong>
        <span className="chip">{transport}</span>
      </div>
      <p>{factory.description}</p>
      <p className="hint">
        Descriptor: <code>{factory.descriptor.id}</code>
      </p>
      {!supported && (
        <p className="hint">Not available in this browser. Use Chrome or Edge over HTTPS or localhost.</p>
      )}
      <div className="driver-card-actions">
        <button disabled={!supported} onClick={() => void session.connect(factory.id)}>
          {active.length > 0 ? "Connect another" : "Connect"}
        </button>
      </div>
    </div>
  );
}

function infoSummary(info: ConnectionView["info"]): string | null {
  if (Object.keys(info).length === 0) return null;
  const parts: string[] = [];
  if (info.sampleRateHz !== undefined) parts.push(`${info.sampleRateHz} Hz`);
  if (info.fwMajor !== undefined) parts.push(`fw ${info.fwMajor}.${info.fwMinor}`);
  if (info.mac !== undefined) parts.push(String(info.mac).match(/../g)!.join(":"));
  return parts.join(" · ");
}

const VERDICT_LABEL: Record<Verdict, string> = {
  verified: "verified",
  suspect: "suspect",
  failed: "failed checks",
  pending: "verifying…",
};

function CheckList({ checks }: { checks: CheckResult[] }) {
  return (
    <ul className="check-list">
      {checks.map((c) => (
        <li key={c.id} className={`check check-${c.status}`}>
          <span className="check-status">{c.status}</span>
          <span className="check-oracle">{c.oracle}</span>
          <span>{c.name}</span>
          <span className="hint">{c.detail}</span>
        </li>
      ))}
    </ul>
  );
}

function ConnectionRow({ conn }: { conn: ConnectionView }) {
  const { session } = useAppStore();
  const { stats } = conn;
  const info = infoSummary(conn.info);
  const live = conn.status === "connected" || conn.status === "connecting";

  return (
    <li className="connection-row">
      <div className="connection-main">
        <div className="connection-title">
          <strong>{conn.label}</strong>
          <span className={`status-badge status-${conn.status}`}>{conn.status}</span>
        </div>
        <div className="hint">
          {[conn.deviceLabel, info, `clock: ${conn.clockMapper}${conn.clockDetail ? ` (${conn.clockDetail})` : ""}`]
            .filter(Boolean)
            .join(" · ")}
        </div>
        <div className="connection-stats">
          <span>{stats.framesOk} frames</span>
          <span>{(stats.bytesIn / 1024).toFixed(1)} KiB</span>
          <span className={stats.crcErrors > 0 ? "stat-bad" : ""}>{stats.crcErrors} CRC errors</span>
          <span className={stats.seqGaps > 0 ? "stat-bad" : ""}>{stats.seqGaps} lost (seq)</span>
          <span>{stats.bytesDiscarded} bytes skipped</span>
          <span className={stats.malformed > 0 ? "stat-bad" : ""}>{stats.malformed} malformed</span>
        </div>
        {conn.status === "error" && conn.lastError && <p className="error-text">{conn.lastError}</p>}
        <details className="verification">
          <summary>
            Descriptor check: <span className={`verdict verdict-${conn.verification.verdict}`}>{VERDICT_LABEL[conn.verification.verdict]}</span>
          </summary>
          <CheckList checks={conn.verification.checks} />
        </details>
      </div>
      <button className="secondary-button" onClick={() => void session.disconnect(conn.id)}>
        {live ? "Disconnect" : "Remove"}
      </button>
    </li>
  );
}

export function ConnectPanel() {
  const { session } = useAppStore();
  const connections = session.listConnections();
  const crossSensor = session.listCrossSensorChecks();

  return (
    <div className="panel">
      <h2>Devices</h2>
      <p className="panel-subtitle">
        Every device is a <strong>descriptor</strong> (what its bytes mean) over a <strong>transport</strong> (how
        the bytes arrive). You can connect several devices at once; each one gets its own compute pipeline.
      </p>

      <section className="section">
        <h3>Active connections</h3>
        {connections.length === 0 ? (
          <p className="hint">Nothing connected.</p>
        ) : (
          <ul className="connection-list">
            {connections.map((c) => (
              <ConnectionRow key={c.id} conn={c} />
            ))}
          </ul>
        )}
      </section>

      {crossSensor.length > 0 && (
        <section className="section">
          <h3>Cross-sensor agreement</h3>
          <p className="hint">
            Heart-rate estimates from physically different measurements, compared over the last 15 s. A descriptor
            that mis-reads timing or channels usually breaks this even when every value looks plausible.
          </p>
          <CheckList checks={crossSensor} />
        </section>
      )}

      <section className="section">
        <h3>Simulated subject</h3>
        <p className="hint">Shared by every simulated device, so simulated ECG and PPG come from the same heartbeat.</p>
        <div className="scenario-picker">
          {SCENARIOS.map((s) => (
            <label key={s.value}>
              <input
                type="radio"
                name="scenario"
                checked={session.getScenario() === s.value}
                onChange={() => session.setScenario(s.value)}
              />
              {s.label}
            </label>
          ))}
        </div>
      </section>

      {GROUPS.map(({ group, title, blurb }) => (
        <section className="section" key={group}>
          <h3>{title}</h3>
          <p className="hint">{blurb}</p>
          <div className="driver-cards">
            {DEVICE_FACTORIES.filter((f) => f.group === group).map((f) => (
              <DeviceCard key={f.id} factory={f} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
