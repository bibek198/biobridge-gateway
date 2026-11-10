import type { ReactNode } from "react";
import { useAppStore } from "../state/appStore";
import { usePref, useTheme } from "../state/prefs";
import { href, type PageId } from "../state/router";
import { useSynthService } from "../state/synthService";
import { Icon, Logo, type IconName } from "./ui/Icon";

type NavItem = { id: PageId; label: string; icon: IconName };

export const NAV: { title: string; items: NavItem[] }[] = [
  {
    title: "MONITOR",
    items: [
      { id: "overview", label: "Overview", icon: "overview" },
      { id: "devices", label: "Devices", icon: "devices" },
      { id: "live", label: "Live Data", icon: "live" },
      { id: "alerts", label: "Alerts", icon: "alert" },
    ],
  },
  {
    title: "RESEARCH",
    items: [
      { id: "sync", label: "Clock Synchronization", icon: "clock" },
      { id: "placement", label: "Compute Placement", icon: "cpu" },
      { id: "recordings", label: "Recordings", icon: "record" },
      { id: "pipeline", label: "Processing Pipeline", icon: "pipeline" },
    ],
  },
  {
    title: "DEVICE INTEGRATION",
    items: [
      { id: "add", label: "Add a Device", icon: "plusBox" },
      { id: "descriptors", label: "Device Descriptors", icon: "descriptor" },
      { id: "verification", label: "Verification", icon: "shield" },
    ],
  },
];

function SystemStatus({ collapsed }: { collapsed: boolean }) {
  const { session } = useAppStore();
  const synth = useSynthService();
  const conns = session.listConnections();
  const connected = conns.filter((c) => c.status === "connected");
  const streams = connected.reduce((n, c) => n + c.channels.filter((ch) => ch.rateHz !== null).length, 0);
  const pairs = session.listSyncPairs().filter((p) => p.stats.n > 0);
  const rec = session.activeRecording;

  const lines: { dot: string; label: string; title: string }[] = [
    { dot: connected.length ? "ok" : "", label: `${connected.length} device${connected.length === 1 ? "" : "s"} · ${streams} stream${streams === 1 ? "" : "s"}`, title: "Connected devices and channels currently streaming" },
    { dot: pairs.length ? "live" : "", label: pairs.length ? `Sync: ${pairs.length} pair${pairs.length === 1 ? "" : "s"} measured` : "Sync: no pulse pairs", title: "Device pairs whose clock-sync error is being measured" },
    { dot: session.dsp ? "ok" : "warn", label: session.dsp ? "Wasm DSP loaded" : "Wasm DSP loading", title: "The firmware signal-processing library, compiled to WebAssembly" },
    {
      dot: synth.status === "ready" && synth.models.length ? "ok" : synth.status === "checking" ? "" : "warn",
      label: synth.status === "ready" ? (synth.models.length ? `Synthesis: ${synth.models.length} models` : "Synthesis: no API key") : synth.status === "checking" ? "Synthesis: checking" : "Synthesis: offline",
      title: "Local descriptor-synthesis service (npm run dev)",
    },
  ];
  if (rec) lines.unshift({ dot: "warn", label: `Recording · ${rec.connections.length} dev`, title: `Recording "${rec.name}"` });

  return (
    <div className="sidebar-status" aria-label="System status">
      {lines.map((l) => (
        <div key={l.label} className="status-line" title={collapsed ? `${l.label}. ${l.title}` : l.title}>
          <span className={`dot ${l.dot}`} />
          <span className="label">{l.label}</span>
        </div>
      ))}
    </div>
  );
}

export function AppShell({ page, children }: { page: PageId; children: ReactNode }) {
  const { session } = useAppStore();
  const [theme, setTheme] = useTheme();
  const [collapsedPref, setCollapsed] = usePref<"0" | "1">("biobridge.sidebar", "0", ["0", "1"]);
  const collapsed = collapsedPref === "1";

  const diags = session.diagnostics();
  const critical = diags.filter((d) => d.severity === "critical").length;
  const counts: Partial<Record<PageId, { n: number; alert?: boolean }>> = {
    devices: { n: session.listConnections().length },
    alerts: diags.length ? { n: diags.length, alert: critical > 0 } : undefined,
    recordings: session.recordings.length ? { n: session.recordings.length } : undefined,
  };

  return (
    <div className={collapsed ? "shell collapsed" : "shell"}>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <Logo className="logo" />
          <div className="text">
            <div className="name">BioBridge</div>
            <div className="version">v{__APP_VERSION__} · research build</div>
          </div>
        </div>
        <nav className="sidebar-nav" aria-label="Main">
          {NAV.map((section) => (
            <div key={section.title} className="nav-section">
              <div className="nav-section-title">{section.title}</div>
              {section.items.map((item) => {
                const c = counts[item.id];
                return (
                  <a
                    key={item.id}
                    href={href(item.id)}
                    className={item.id === page ? "nav-item active" : "nav-item"}
                    aria-current={item.id === page ? "page" : undefined}
                    title={collapsed ? item.label : undefined}
                  >
                    <Icon name={item.icon} />
                    <span className="label">{item.label}</span>
                    {c && c.n > 0 && <span className={c.alert ? "count alert" : "count"}>{c.n}</span>}
                  </a>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <SystemStatus collapsed={collapsed} />
          <div className="sidebar-tools">
            <button
              className="icon-button"
              onClick={() => setTheme(theme === "light" ? "dark" : "light")}
              aria-label={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
              title={theme === "light" ? "Dark theme" : "Light theme"}
            >
              <Icon name={theme === "light" ? "moon" : "sun"} />
            </button>
            <button
              className="icon-button"
              onClick={() => setCollapsed(collapsed ? "0" : "1")}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              <Icon name={collapsed ? "expand" : "collapse"} />
            </button>
          </div>
        </div>
      </aside>
      <main className="workspace">{children}</main>
    </div>
  );
}
