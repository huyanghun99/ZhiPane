import type { MiddlewareHandler } from 'hono';
import { randomUUID } from 'node:crypto';
import { requestContext } from '../services/logger';
import type { AppEnv } from './auth';

/**
 * Phase H (N2): tag every request with an id and run the rest of the pipeline
 * inside an AsyncLocalStorage so structured logs pick it up automatically.
 * Also surfaces the id via the `x-request-id` response header for client /
 * support correlation.
 */
export const requestIdMiddleware = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const incoming = c.req.header('x-request-id');
  const requestId = incoming && /^[0-9a-f-]{36}$/i.test(incoming) ? incoming : randomUUID();
  c.header('x-request-id', requestId);
  await requestContext.run({ requestId }, async () => {
    await next();
  });
};
