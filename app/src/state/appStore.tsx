import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { SessionManager } from "../session/sessionManager";

type AppStoreValue = {
  session: SessionManager;
  /** Increments ~15×/s so canvases and live tiles redraw without re-rendering on every sample. */
  renderTick: number;
};

const AppStoreContext = createContext<AppStoreValue | null>(null);

export function AppStoreProvider({ children }: { children: ReactNode }) {
  const [session] = useState(() => new SessionManager());
  const [renderTick, setRenderTick] = useState(0);

  // Structural changes (connections, status, alerts, recordings) re-render immediately.
  useSyncExternalStore(session.subscribe, session.getVersion);

  useEffect(() => {
    void session.refreshRecordings();
    session.connectDefaultOnce();
    // Connections persist across StrictMode's dev-only double effect; they are torn down on page unload.
  }, [session]);

  useEffect(() => {
    let raf = 0;
    let lastRender = 0;
    const loop = (t: number) => {
      if (t - lastRender > 66) {
        lastRender = t;
        setRenderTick((v) => v + 1);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <AppStoreContext.Provider value={{ session, renderTick }}>{children}</AppStoreContext.Provider>;
}

export function useAppStore(): AppStoreValue {
  const ctx = useContext(AppStoreContext);
  if (!ctx) throw new Error("useAppStore must be used within AppStoreProvider");
  return ctx;
}
