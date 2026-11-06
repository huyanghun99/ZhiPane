import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Plus, Trash2, Cpu, CalendarDays, Cloud, Save as SaveIcon } from 'lucide-react';
import {
  AGENT_SCOPES, getAgentPreferences, saveAgentPreferences, listAgentTokens,
  createAgentToken, revokeAgentToken, getAgentConfig, type AgentPreferences
} from '../../api';
import { api } from '../../api';
import { useToast } from '../../components/Toast';
import type { Workspace } from '../../types';

const SCOPE_LABEL: Record<string, string> = {
  'kb:read': '知识库读', 'kb:write': '知识库写',
  'tasks:read': '任务读', 'tasks:write': '任务写',
  'ai:claim': '领取 AI 作业', 'ai:submit': '回写 AI 结果',
  'calendar:read': '日历读', 'calendar:write': '日历写'
};

const inputStyle: React.CSSProperties = {
  padding: '6px 8px', border: '1px solid var(--border, #d0d4dc)',
  borderRadius: 6, background: 'var(--input-bg, #fff)', color: 'var(--text, #111)'
};
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' };

function copy(text: string, toast: ReturnType<typeof useToast>) {
  if (!navigator.clipboard) { toast.error('浏览器不支持剪贴板，请手动选择'); return; }
  navigator.clipboard.writeText(text).then(
    () => toast.success('已复制'),
    () => toast.error('复制失败，请手动选择')
  );
}

export function AgentSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const prefsQ = useQuery({ queryKey: ['agent-preferences'], queryFn: getAgentPreferences });
  const tokensQ = useQuery({ queryKey: ['agent-tokens'], queryFn: listAgentTokens });
  const configQ = useQuery({ queryKey: ['agent-config'], queryFn: getAgentConfig });
  const workspacesQ = useQuery<{ workspaces: Workspace[] }>({ queryKey: ['workspaces'], queryFn: () => api('/api/workspaces') });

  const p = prefsQ.data;
  const [mode, setMode] = useState<'internal' | 'external'>('internal');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [dimension, setDimension] = useState(1536);
  const [apiKey, setApiKey] = useState('');
  const [mcpEnabled, setMcpEnabled] = useState(true);
  const [caldavEnabled, setCaldavEnabled] = useState(true);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!p || loaded) return;
    setMode(p.aiExecutionMode);
    setBaseUrl(p.embedding.baseUrl);
    setModel(p.embedding.model);
    setDimension(p.embedding.dimension);
    setMcpEnabled(p.mcpEnabled);
    setCaldavEnabled(p.caldavEnabled);
    setLoaded(true);
  }, [p, loaded]);

  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['kb:read', 'kb:write', 'tasks:read', 'tasks:write']);
  const [workspaceId, setWorkspaceId] = useState('');
  const [ttlDays, setTtlDays] = useState(90);
  const [newToken, setNewToken] = useState<string | null>(null);

  const savePrefs = useMutation({
    mutationFn: () => saveAgentPreferences({
      aiExecutionMode: mode, mcpEnabled, caldavEnabled,
      embedding: { baseUrl, model, dimension, ...(apiKey ? { apiKey } : {}) }
    }),
    onSuccess: (data: AgentPreferences) => {
      qc.setQueryData(['agent-preferences'], data);
      setApiKey('');
      toast.success('设置已保存');
    },
    onError: (e: Error) => toast.error(`保存失败：${e.message}`)
  });

  const create = useMutation({
    mutationFn: () => createAgentToken({
      name: name.trim() || 'WorkBuddy', scopes,
      workspaceId: workspaceId || null, ttlDays
    }),
    onSuccess: (r) => {
      setNewToken(r.token);
      setName('');
      qc.invalidateQueries({ queryKey: ['agent-tokens'] });
      toast.success('Token 已创建，请立即保存');
    },
    onError: (e: Error) => toast.error(`创建失败：${e.message}`)
  });

  const revoke = useMutation({
    mutationFn: (id: string) => revokeAgentToken(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['agent-tokens'] }); toast.success('Token 已撤销'); },
    onError: (e: Error) => toast.error(`撤销失败：${e.message}`)
  });

  const mcpJson = useMemo(() => JSON.stringify(configQ.data?.workbuddy ?? {}, null, 2), [configQ.data]);
  const workspaces = workspacesQ.data?.workspaces ?? [];

  return (
    <>
      <div className="home-card" style={{ marginTop: 16 }}>
        <div className="home-card-head"><span><Cpu size={15} /> AI 整理与 Embedding 接口</span></div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0' }}>
          <label style={fieldStyle}>
            <span>AI 整理（LLM Wiki 推理）执行方式</span>
            <select style={inputStyle} value={mode} onChange={(e) => setMode(e.target.value as 'internal' | 'external')}>
              <option value="internal">系统接口（服务端调用已配置的模型）</option>
              <option value="external">WorkBuddy / 桌面智能体（外部作业，服务端不调大模型）</option>
            </select>
          </label>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            两种模式下 <b>向量化都由服务端 embedding 接口完成</b>；external 模式只把「文本 → 结构化 Wiki 结果」交给智能体，服务端负责校验与落库。
          </p>
          <label style={fieldStyle}><span>Embedding 接口 Base URL</span><input style={inputStyle} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" /></label>
          <div style={row}>
            <label style={{ ...fieldStyle, flex: 1, minWidth: 160 }}><span>模型</span><input style={inputStyle} value={model} onChange={(e) => setModel(e.target.value)} placeholder="text-embedding-3-small" /></label>
            <label style={{ ...fieldStyle, width: 120 }}><span>维度</span><input type="number" style={inputStyle} value={dimension} onChange={(e) => setDimension(Number(e.target.value) || 1536)} /></label>
          </div>
          <label style={fieldStyle}>
            <span>API Key {p?.embedding.hasApiKey ? `（已配置：${p.embedding.apiKeyMasked}）` : '（未配置）'}</span>
            <input type="password" style={inputStyle} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="留空保留现有密钥" />
          </label>
          <div style={row}>
            <label style={row}><input type="checkbox" checked={mcpEnabled} onChange={(e) => setMcpEnabled(e.target.checked)} /><span>启用云端 MCP</span></label>
            <label style={row}><input type="checkbox" checked={caldavEnabled} onChange={(e) => setCaldavEnabled(e.target.checked)} /><span>启用 CalDAV</span></label>
          </div>
          <div><button className="ghost sm" disabled={savePrefs.isPending} onClick={() => savePrefs.mutate()}><SaveIcon size={14} /> 保存设置</button></div>
        </div>
      </div>

      <div className="home-card" style={{ marginTop: 16 }}>
        <div className="home-card-head"><span><KeyRound size={15} /> Agent Token（跨设备接入）</span></div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 0' }}>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>Token 只显示一次，仅保存哈希；可限定知识库、权限范围、有效期，随时撤销。</p>
          <div style={row}>
            <input style={{ ...inputStyle, flex: 1, minWidth: 140 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="名称，如 MacBook / WorkBuddy" />
            <select style={inputStyle} value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
              <option value="">不限知识库</option>
              {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
            <input type="number" style={{ ...inputStyle, width: 90 }} value={ttlDays} onChange={(e) => setTtlDays(Number(e.target.value) || 90)} title="有效天数" />
          </div>
          <div style={row}>
            {AGENT_SCOPES.map((s) => (
              <label key={s} style={{ ...row, fontSize: 12, gap: 4 }}>
                <input type="checkbox" checked={scopes.includes(s)} onChange={(e) =>
                  setScopes((prev) => e.target.checked ? [...prev, s] : prev.filter((x) => x !== s))} />
                {SCOPE_LABEL[s]}
              </label>
            ))}
          </div>
          <div><button className="primary sm" disabled={create.isPending || scopes.length === 0} onClick={() => create.mutate()}><Plus size={14} /> 创建 Token</button></div>
          {newToken && (
            <div className="agent-token-reveal">
              <code>{newToken}</code>
              <button className="ghost sm" onClick={() => copy(newToken, toast)}><Copy size={13} /> 复制</button>
              <button className="ghost sm" onClick={() => setNewToken(null)}>我已保存</button>
            </div>
          )}
          {(tokensQ.data?.tokens ?? []).map((t) => (
            <div key={t.id} className="agent-token-row">
              <div style={{ minWidth: 0 }}>
                <b>{t.name}</b>
                <div className="muted small">{t.scopes.join('、')} · {t.revoked_at ? '已撤销' : `至 ${t.expires_at ? new Date(t.expires_at).toLocaleDateString() : '长期'}`}</div>
              </div>
              {!t.revoked_at && <button className="ghost sm danger" onClick={() => revoke.mutate(t.id)}><Trash2 size={13} /> 撤销</button>}
            </div>
          ))}
        </div>
      </div>

      <div className="home-card" style={{ marginTop: 16 }}>
        <div className="home-card-head"><span><Cloud size={15} /> 接入配置</span></div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 0' }}>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            把下面内容写入 <code>~/.workbuddy/mcp.json</code>（或连接器 → 自定义连接器 → 配置 MCP），并把 <code>{'${ZHIPANE_AGENT_TOKEN}'}</code> 替换为上一步创建的 Token。云端部署时请确保 HTTPS。
          </p>
          <pre className="agent-code">{mcpJson}</pre>
          <div><button className="ghost sm" onClick={() => copy(mcpJson, toast)}><Copy size={13} /> 复制配置</button></div>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            <CalendarDays size={13} style={{ verticalAlign: '-2px' }} /> CalDAV：账户 URL 为 <code>/caldav/</code>，用户名任意，密码填 Agent Token（需 <code>calendar:read</code> / <code>calendar:write</code> 权限）；也可订阅 <code>/caldav/calendars/&lt;知识库ID&gt;/feed.ics</code>。
          </p>
        </div>
      </div>
    </>
  );
}


const fieldStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 };
