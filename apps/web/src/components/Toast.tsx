import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Info, X, AlertTriangle, XCircle } from 'lucide-react';

/**
 * Unified toast + undo system (Phase 3, extended Phase 6 with `warning`).
 *
 * Replaces ad-hoc feedback and native alert() with a consistent, dismissible
 * notification surface. A toast may carry a single action button — the primary
 * use is an "撤销" (undo) affordance so destructive operations always feel
 * reversible.
 */
export type ToastKind = 'success' | 'error' | 'info' | 'warning';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  action?: ToastAction;
}

interface ToastOptions {
  action?: ToastAction;
  /** Auto-dismiss delay in ms. Defaults to 4000 (6000 when an action exists). */
  duration?: number;
}

interface ToastApi {
  show: (kind: ToastKind, message: string, opts?: ToastOptions) => number;
  success: (message: string, opts?: ToastOptions) => number;
  error: (message: string, opts?: ToastOptions) => number;
  info: (message: string, opts?: ToastOptions) => number;
  warning: (message: string, opts?: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>');
  return ctx;
}

const ICONS: Record<ToastKind, React.ReactNode> = {
  success: <CheckCircle2 size={17} />,
  error: <XCircle size={17} />,
  info: <Info size={17} />,
  warning: <AlertTriangle size={17} />
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) { clearTimeout(timer); timers.current.delete(id); }
  }, []);

  const show = useCallback((kind: ToastKind, message: string, opts?: ToastOptions) => {
    const id = ++seq.current;
    setItems((prev) => [...prev, { id, kind, message, action: opts?.action }]);
    const duration = opts?.duration ?? (opts?.action ? 6000 : 4000);
    const timer = setTimeout(() => dismiss(id), duration);
    timers.current.set(id, timer);
    return id;
  }, [dismiss]);

  const api = useMemo<ToastApi>(() => ({
    show,
    success: (m, o) => show('success', m, o),
    error: (m, o) => show('error', m, o),
    info: (m, o) => show('info', m, o),
    warning: (m, o) => show('warning', m, o),
    dismiss
  }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <span className="toast-icon">{ICONS[t.kind]}</span>
            <span className="toast-msg">{t.message}</span>
            {t.action && (
              <button
                className="toast-action"
                onClick={() => { t.action!.onClick(); dismiss(t.id); }}
              >
                {t.action.label}
              </button>
            )}
            <button className="toast-close" aria-label="关闭" onClick={() => dismiss(t.id)}>
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
