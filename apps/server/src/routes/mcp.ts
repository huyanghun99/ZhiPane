import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { authMiddleware, type AppEnv } from '../middleware/auth';
import { audit, withIdempotency } from '../middleware/agent-auth';
import { isMcpEnabled } from '../services/app-preferences';
import { toolDescriptors, callTool } from '../mcp/tools';

/**
 * Minimal MCP over Streamable HTTP (JSON-RPC 2.0).
 *
 * Hand-written instead of pulling in an SDK so it maps 1:1 onto Hono's Web
 * Standard Request/Response and has zero new runtime dependencies. Covers the
 * surface every desktop agent needs: initialize, ping, tools/list, tools/call.
 * Cloud deployment: POST https://<host>/mcp with Authorization: Bearer <agent token>.
 */
export const mcpRoutes = new Hono<AppEnv>();
mcpRoutes.use('*', authMiddleware);

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'zhipane', version: '0.1.0' };

type RpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

function reply(id: RpcRequest['id'], result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function failure(id: RpcRequest['id'], code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

mcpRoutes.post('/', async (c) => {
  if (!(await isMcpEnabled())) return c.json({ error: 'MCP endpoint is disabled' }, 403);
  let req: RpcRequest;
  try { req = await c.req.json(); } catch { return c.json(failure(null, -32700, 'Parse error'), 400); }
  if (req.jsonrpc !== '2.0' || !req.method) {
    return c.json(failure(req.id, -32600, 'Invalid Request'));
  }
  // Notifications have no id and must not receive a response body.
  const isNotification = req.id === undefined || req.id === null;

  switch (req.method) {
    case 'initialize': {
      const sessionId = c.req.header('mcp-session-id') ?? randomUUID();
      c.header('Mcp-Session-Id', sessionId);
      return c.json(reply(req.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO
      }));
    }
    case 'ping':
      return isNotification ? c.body(null, 204) : c.json(reply(req.id, {}));
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return c.body(null, 204);
    case 'tools/list':
      return c.json(reply(req.id, { tools: toolDescriptors() }));
    case 'tools/call': {
      const params = req.params ?? {};
      const name = String(params.name ?? '');
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const userId = c.get('user').id;
      const tokenId = c.get('agentTokenId');
      try {
        const data = await withIdempotency(
          tokenId, args.idempotencyKey as string | undefined,
          () => callTool(c, name, args)
        );
        void audit(userId, tokenId, name, args, 'ok');
        return c.json(reply(req.id, {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
        }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void audit(userId, tokenId, name, args, 'error', message);
        return c.json(reply(req.id, {
          content: [{ type: 'text', text: `Error: ${message}` }],
          isError: true
        }));
      }
    }
    default:
      return isNotification
        ? c.body(null, 204)
        : c.json(failure(req.id, -32601, `Method not found: ${req.method}`));
  }
});

// A GET lets an agent verify reachability without issuing a JSON-RPC call.
mcpRoutes.get('/', (c) => c.json({ name: SERVER_INFO.name, protocolVersion: PROTOCOL_VERSION, transport: 'streamable-http' }));
