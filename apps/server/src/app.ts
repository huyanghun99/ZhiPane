import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { existsSync } from 'node:fs';
import { env } from './env';
import { serveStatic } from '@hono/node-server/serve-static';
import { csrfGuard } from './middleware/csrf';
import { authRoutes } from './routes/auth';
import { workspaceRoutes } from './routes/workspaces';
import { spaceRoutes } from './routes/spaces';
import { groupRoutes } from './routes/groups';
import { pageRoutes } from './routes/pages';
import { searchRoutes } from './routes/search';
import { ragRoutes } from './routes/rag';
import { llmWikiRoutes } from './routes/llm-wiki';
import { captureRoutes } from './routes/capture';
import { attachmentRoutes } from './routes/attachments';
import { graphRoutes } from './routes/graph';
import { shareRoutes } from './routes/shares';
import { importExportRoutes } from './routes/import-export';
import { jobRoutes } from './routes/jobs';
import { settingsRoutes } from './routes/settings';
import { publicRoutes } from './routes/public';
import { backupRoutes } from './routes/backups';
import { taskRoutes } from './routes/tasks';
import { navRoutes } from './routes/nav';
import { agentRoutes } from './routes/agent';
import { mcpRoutes } from './routes/mcp';
import { caldavRoutes } from './routes/caldav';
import { healthHandler, diagnosticsHandler, metricsHandler } from './routes/health';
import { requestIdMiddleware } from './middleware/request-id';
import { logger } from './services/logger';

export function createApp() {
  const app = new Hono();
  // In development reflect the request Origin so the UI is reachable via the
  // Vite network URL or an IDE-forwarded port (credentials require a concrete
  // origin, not "*"). Production/test stay on the explicit allow-list.
  const corsOrigin =
    env.NODE_ENV === 'development'
      ? (origin: string | undefined) => origin ?? ''
      : ['http://127.0.0.1:5173', 'http://localhost:5173'];
  app.use('*', cors({
    origin: corsOrigin, credentials: true,
    allowHeaders: ['Content-Type', 'Authorization', 'Depth', 'DAV', 'If-Match', 'If-None-Match', 'Prefer'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'PROPFIND', 'REPORT', 'MKCOL'],
    exposeHeaders: ['DAV', 'ETag', 'Schedule-Tag', 'Content-Type']
  }));
  app.use('*', csrfGuard);
  app.use('*', requestIdMiddleware());
  app.get('/health', healthHandler);
  app.get('/health/', healthHandler);
  app.get('/health/diagnostics', diagnosticsHandler);
  app.get('/health/metrics', metricsHandler);
  app.route('/api/auth', authRoutes);
  app.route('/api/workspaces', workspaceRoutes);
  app.route('/api/spaces', spaceRoutes);
  app.route('/api/groups', groupRoutes);
  app.route('/api/pages', pageRoutes);
  app.route('/api/search', searchRoutes);
  app.route('/api/rag', ragRoutes);
  app.route('/api/llm-wiki', llmWikiRoutes);
  app.route('/api/capture', captureRoutes);
  app.route('/api/attachments', attachmentRoutes);
  app.route('/api/graph', graphRoutes);
  app.route('/api/shares', shareRoutes);
  app.route('/api/io', importExportRoutes);
  app.route('/api/backups', backupRoutes);
  app.route('/api/jobs', jobRoutes);
  app.route('/api/settings', settingsRoutes);
  app.route('/api/public', publicRoutes);
  app.route('/api/tasks', taskRoutes);
  app.route('/api/nav', navRoutes);
  app.route('/api/agent', agentRoutes);
  app.route('/mcp', mcpRoutes);
  app.route('/caldav', caldavRoutes);
  // Serve the built web app only when the production bundle exists.
  // In dev the Vite server (5173) handles the UI; this avoids noisy
  // "root path not found" warnings during tests and dev.
  const webDist = new URL('../../web/dist', import.meta.url);
  if (existsSync(webDist)) {
    app.use('/assets/*', serveStatic({ root: webDist.pathname }));
    app.get('/', serveStatic({ path: new URL('index.html', webDist).pathname }));
  }
  app.notFound((c) => c.json({ error: 'Not found' }, 404));
  app.onError((err, c) => {
    logger.error('unhandled error', { err: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
    return c.json({ error: 'Internal server error', message: err.message }, 500);
  });
  return app;
}
