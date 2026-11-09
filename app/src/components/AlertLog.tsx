import { useAppStore } from "../state/appStore";

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

export function AlertLog() {
  const { session } = useAppStore();

  return (
    <div className="panel">
      <h2>Alert / Event Log</h2>
      {session.alerts.length === 0 ? (
        <p className="hint">No alerts yet. Try the "Desaturation event" or "Tachycardia" scenario on the Devices tab.</p>
      ) : (
        <ul className="alert-list">
          {session.alerts.map((alert) => (
            <li key={alert.id} className={`alert-item alert-${alert.severity}`}>
              <span className="alert-time">{formatTime(alert.timestamp)}</span>
              <span className={`alert-severity-badge alert-${alert.severity}`}>{alert.severity}</span>
              {alert.source && <span className="alert-source">{alert.source}</span>}
              <span className="alert-message">{alert.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
