import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

// Replaces window.confirm: an accessible modal with an explicit action label. Escape cancels.

type Request = { title: string; body?: ReactNode; confirmLabel: string; danger?: boolean; resolve: (ok: boolean) => void };
type ConfirmFn = (opts: { title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean }) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<Request | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  const confirm = useCallback<ConfirmFn>(
    (opts) => new Promise((resolve) => setReq({ confirmLabel: "Confirm", ...opts, resolve })),
    []
  );

  const close = (ok: boolean) => {
    req?.resolve(ok);
    setReq(null);
  };

  useEffect(() => {
    if (!req) return;
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        req.resolve(false);
        setReq(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [req]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {req && (
        <div className="dialog-backdrop" onClick={() => close(false)}>
          <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" onClick={(e) => e.stopPropagation()}>
            <h2 id="confirm-title">{req.title}</h2>
            {req.body && <p>{req.body}</p>}
            <div className="dialog-actions">
              <button className="btn" onClick={() => close(false)}>
                Cancel
              </button>
              <button ref={confirmRef} className={req.danger ? "btn primary danger-fill" : "btn primary"} onClick={() => close(true)}>
                {req.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const c = useContext(ConfirmContext);
  if (!c) throw new Error("useConfirm must be used within ConfirmProvider");
  return c;
}
