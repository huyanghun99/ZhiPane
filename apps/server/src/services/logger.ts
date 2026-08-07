/**
 * Structured logger (Phase H N2).
 *
 * Zero-dependency pino-like logger: emits one JSON line per call to stdout /
 * stderr with level, timestamp, message, optional fields and (when available)
 * the current request id. Replaces the 18 ad-hoc `console.*` call sites so
 * logs can be ingested by ELK / Loki / CloudWatch without parsing.
 *
 * Why not import pino directly? The project runs in WSL with intermittent
 * registry access; we avoid `pnpm add pino` and the native worker_thread
 * transport. The shape matches pino so a future `import pino from 'pino'`
 * swap-in is a one-line change.
 */
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const DEFAULT_LEVEL: LogLevel =
  (process.env.LOG_LEVEL as LogLevel | undefined) ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

// AsyncLocalStorage carries the request id across async hops without threading
// it through every function signature. Populated by the requestId middleware.
interface RequestCtx {
  requestId: string;
  userId?: string;
  workspaceId?: string;
}
export const requestContext = new AsyncLocalStorage<RequestCtx>();

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[DEFAULT_LEVEL]) return;
  const ctx = requestContext.getStore();
  const line = {
    level,
    time: Date.now(),
    msg,
    ...(ctx?.requestId ? { requestId: ctx.requestId } : {}),
    ...(ctx?.userId ? { userId: ctx.userId } : {}),
    ...(ctx?.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
    ...(fields ?? {})
  };
  const serialized = JSON.stringify(line);
  if (level === 'error' || level === 'warn') {
    process.stderr.write(serialized + '\n');
  } else {
    process.stdout.write(serialized + '\n');
  }
}

function createLogger(bindings: Record<string, unknown> = {}): Logger {
  return {
    debug: (msg, fields) => emit('debug', msg, { ...bindings, ...fields }),
    info: (msg, fields) => emit('info', msg, { ...bindings, ...fields }),
    warn: (msg, fields) => emit('warn', msg, { ...bindings, ...fields }),
    error: (msg, fields) => emit('error', msg, { ...bindings, ...fields }),
    child: (more) => createLogger({ ...bindings, ...more })
  };
}

export const logger = createLogger();

export function newRequestId(): string {
  return randomUUID();
}

export function setRequestContext(ctx: RequestCtx): RequestCtx {
  return ctx;
}
