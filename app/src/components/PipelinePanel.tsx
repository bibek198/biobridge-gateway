import { useState } from "react";
import { useAppStore } from "../state/appStore";
import { ThresholdAlertModule, type ChannelThresholds } from "../compute/modules/thresholdAlert";

function ThresholdEditor({ module }: { module: ThresholdAlertModule }) {
  const [, forceRender] = useState(0);
  const thresholds = module.getThresholds();

  function update(channel: string, key: keyof ChannelThresholds, raw: string) {
    const value = raw === "" ? undefined : Number(raw);
    module.setThreshold(channel, key, value);
    forceRender((v) => v + 1);
  }

  return (
    <div className="threshold-editor">
      {Object.entries(thresholds).map(([channel, t]) => (
        <div key={channel} className="threshold-row">
          <span className="threshold-channel">{channel}</span>
          {(["warningMin", "warningMax", "criticalMin", "criticalMax"] as const).map((key) => (
            <label key={key}>
              {key}
              <input
                type="number"
                value={t[key] ?? ""}
                onChange={(e) => update(channel, key, e.target.value)}
              />
            </label>
          ))}
        </div>
      ))}
    </div>
  );
}

export function PipelinePanel() {
  const { session } = useAppStore();

  return (
    <div className="panel">
      <h2>Compute Pipeline</h2>
      <p className="panel-subtitle">
        Every connected device gets its own instance of these pluggable compute modules, fed with every reading
        it produces, real or simulated. Settings here apply to all devices.
      </p>
      <div className="module-list">
        {session.modulePrototypes.map((module) => (
          <div key={module.id} className="module-card">
            <div className="module-card-header">
              <label>
                <input
                  type="checkbox"
                  checked={session.isModuleEnabled(module.id)}
                  onChange={(e) => session.setModuleEnabled(module.id, e.target.checked)}
                />
                <strong>{module.name}</strong>
              </label>
            </div>
            <p>{module.description}</p>
            {module instanceof ThresholdAlertModule && <ThresholdEditor module={module} />}
          </div>
        ))}
      </div>
    </div>
  );
}
