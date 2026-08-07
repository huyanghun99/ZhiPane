import { AlertTriangle, RefreshCw } from 'lucide-react';

/**
 * Unified error state (Phase 3).
 *
 * Every async surface that can fail renders this instead of leaking a raw
 * error string, giving users a consistent message + retry affordance.
 */
export function ErrorState({ title, message, onRetry }: {
  title?: string;
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="error-state">
      <div className="error-state-icon"><AlertTriangle size={30} /></div>
      <p className="error-state-title">{title ?? '加载失败'}</p>
      {message && <p className="error-state-msg">{message}</p>}
      {onRetry && (
        <button className="ghost" onClick={onRetry}>
          <RefreshCw size={15} /> 重试
        </button>
      )}
    </div>
  );
}
