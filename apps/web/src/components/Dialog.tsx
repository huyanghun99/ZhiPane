import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Unified dialog system (Phase 3).
 *
 * Provides a promise-based `confirm()` that fully replaces the browser's native
 * window.confirm / window.alert. Callers `await confirm({...})` and branch on
 * the boolean result, so no blocking native modals are ever used.
 */
interface ConfirmOptions {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

interface PromptOptions {
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
  cancelText?: string;
}

interface DialogApi {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  alert: (opts: Omit<ConfirmOptions, 'cancelText'>) => Promise<void>;
  /** Non-native replacement for window.prompt. Resolves to null on cancel. */
  prompt: (opts: PromptOptions) => Promise<string | null>;
}

const DialogContext = createContext<DialogApi | null>(null);

export function useDialog(): DialogApi {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('useDialog must be used within <DialogProvider>');
  return ctx;
}

type DialogVariant = 'confirm' | 'alert' | 'prompt';

interface PendingDialog {
  variant: DialogVariant;
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  placeholder?: string;
}

export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<PendingDialog | null>(null);
  const [inputValue, setInputValue] = useState('');
  const confirmResolve = useRef<((ok: boolean) => void) | null>(null);
  const alertResolve = useRef<(() => void) | null>(null);
  const promptResolve = useRef<((v: string | null) => void) | null>(null);

  const close = useCallback(() => { setPending(null); }, []);

  const settleConfirm = useCallback((ok: boolean) => {
    confirmResolve.current?.(ok); confirmResolve.current = null; close();
  }, [close]);
  const settleAlert = useCallback(() => {
    alertResolve.current?.(); alertResolve.current = null; close();
  }, [close]);
  const settlePrompt = useCallback((v: string | null) => {
    promptResolve.current?.(v); promptResolve.current = null; close();
  }, [close]);

  const confirm = useCallback((opts: ConfirmOptions) => new Promise<boolean>((resolve) => {
    confirmResolve.current = resolve;
    setPending({ variant: 'confirm', ...opts });
  }), []);

  const alert = useCallback((opts: Omit<ConfirmOptions, 'cancelText'>) => new Promise<void>((resolve) => {
    alertResolve.current = resolve;
    setPending({ variant: 'alert', ...opts });
  }), []);

  const prompt = useCallback((opts: PromptOptions) => new Promise<string | null>((resolve) => {
    promptResolve.current = resolve;
    setInputValue(opts.defaultValue ?? '');
    setPending({ variant: 'prompt', ...opts });
  }), []);

  const api = useMemo<DialogApi>(() => ({ confirm, alert, prompt }), [confirm, alert, prompt]);

  const cancel = useCallback(() => {
    if (!pending) return;
    if (pending.variant === 'confirm') settleConfirm(false);
    else if (pending.variant === 'alert') settleAlert();
    else settlePrompt(null);
  }, [pending, settleConfirm, settleAlert, settlePrompt]);

  const accept = useCallback(() => {
    if (!pending) return;
    if (pending.variant === 'confirm') settleConfirm(true);
    else if (pending.variant === 'alert') settleAlert();
    else settlePrompt(inputValue.trim() ? inputValue.trim() : null);
  }, [pending, inputValue, settleConfirm, settleAlert, settlePrompt]);

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel();
      else if (e.key === 'Enter' && pending.variant !== 'prompt') accept();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, cancel, accept]);

  return (
    <DialogContext.Provider value={api}>
      {children}
      {pending && (
        <div className="dialog-backdrop" onClick={cancel}>
          <div className="dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h3 className="dialog-title">{pending.title}</h3>
            {pending.message && <p className="dialog-message">{pending.message}</p>}
            {pending.variant === 'prompt' && (
              <input
                className="dialog-input"
                autoFocus
                value={inputValue}
                placeholder={pending.placeholder}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') accept(); }}
              />
            )}
            <div className="dialog-actions">
              {pending.variant !== 'alert' && (
                <button className="ghost" onClick={cancel}>{pending.cancelText ?? '取消'}</button>
              )}
              <button
                className={pending.danger ? 'primary danger-solid' : 'primary'}
                autoFocus={pending.variant !== 'prompt'}
                onClick={accept}
              >
                {pending.confirmText ?? '确定'}
              </button>
            </div>
          </div>
        </div>
      )}
    </DialogContext.Provider>
  );
}

/** Generic controlled modal for reuse across features. */
export function Modal({ title, onClose, children, wide }: {
  title: React.ReactNode; onClose: () => void; children: React.ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal${wide ? ' modal-wide' : ' modal-auto'}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{title}</span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
