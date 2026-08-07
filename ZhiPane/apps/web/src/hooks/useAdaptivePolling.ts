import { useEffect, useState } from 'react';

/**
 * Adaptive polling hook (Phase 2 polling rules).
 *
 *  - Stops entirely when the document/tab is hidden (visibilitychange).
 *  - Uses a fast interval when there is activity (e.g. pending jobs /
 *    non-empty inbox) and a slow idle interval otherwise.
 *  - Returns `false` when polling is suppressed so callers can pass it
 *    straight to react-query's `refetchInterval`.
 *
 *  SSE reservation: an optional `stream` may be supplied. When a real
 *  server-sent-events status channel exists (Phase 5), pass it here and
 *  this hook returns `false` so the stream — not polling — drives updates.
 *  The `StatusStream` interface is the contract that future SSE client
 *  must satisfy.
 */
export interface StatusStream {
  subscribe(onEvent: (event: unknown) => void): () => void;
  close(): void;
}

export interface AdaptivePollingOptions {
  enabled?: boolean;
  hasActivity?: boolean;
  idleMs?: number;
  activeMs?: number;
  stream?: StatusStream;
}

export function useAdaptivePolling({
  enabled = true,
  hasActivity = false,
  idleMs = 15000,
  activeMs = 4000,
  stream
}: AdaptivePollingOptions): number | false {
  const [hidden, setHidden] = useState(
    typeof document !== 'undefined' ? document.hidden : false
  );

  useEffect(() => {
    const onVis = () => setHidden(document.hidden);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
    return () => {
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  // A live SSE stream supersedes polling.
  if (stream) return false;
  if (!enabled || hidden) return false;
  return hasActivity ? activeMs : idleMs;
}
