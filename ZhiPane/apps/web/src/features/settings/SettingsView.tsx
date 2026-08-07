import { useEffect, useState } from 'react';
import { KeyRound, LogOut, Save } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { post, getAiConfig, saveAiConfig } from '../../api';
import type { User } from '../../types';

const DRIVERS = [
  { value: 'mock', label: 'Mock（不调用真实模型）' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'openai-compatible', label: 'OpenAI 兼容（DeepSeek / 智谱 / 自建等）' },
  { value: 'ollama', label: 'Ollama（本地）' },
  { value: 'gemini', label: 'Gemini' }
];

const fieldStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: 13
};
const inputStyle: React.CSSProperties = {
  padding: '6px 8px',
  border: '1px solid var(--border, #d0d4dc)',
  borderRadius: 6,
  background: 'var(--input-bg, #fff)',
  color: 'var(--text, #111)'
};

export function SettingsView({ me, onLogout }: { me: User; onLogout: () => void }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['ai-config'],
    queryFn: getAiConfig
  });

  const [driver, setDriver] = useState('mock');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [completionModel, setCompletionModel] = useState('');
  const [embeddingModel, setEmbeddingModel] = useState('');
  const [embeddingDimension, setEmbeddingDimension] = useState(1536);
  const [personalOverrideEnabled, setPersonalOverrideEnabled] = useState(true);
  // Whether the user typed into the apiKey field. We only send apiKey when
  // touched: sending '' would CLEAR the stored key, which is not the intent
  // of a generic Save that only changed other fields.
  const [touched, setTouched] = useState(false);

  // Hydrate the form once the server config arrives.
  useEffect(() => {
    const cfg = data?.config;
    if (!cfg) return;
    setDriver(cfg.driver);
    setBaseUrl(cfg.baseUrl);
    setCompletionModel(cfg.completionModel);
    setEmbeddingModel(cfg.embeddingModel);
    setEmbeddingDimension(cfg.embeddingDimension);
    setPersonalOverrideEnabled(cfg.personalOverrideEnabled);
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      saveAiConfig({
        driver,
        baseUrl,
        apiKey: touched ? apiKey : undefined,
        completionModel,
        embeddingModel,
        embeddingDimension,
        personalOverrideEnabled
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ai-config'] });
      setApiKey('');
      setTouched(false);
    }
  });

  const logout = useMutation({
    mutationFn: () => post('/api/auth/logout', {}),
    onSuccess: () => {
      qc.clear();
      onLogout();
    }
  });

  const cfg = data?.config;

  return (
    <div className="single-pane">
      <h1 style={{ fontSize: 22, margin: '0 0 4px' }}>设置</h1>
      <p className="muted" style={{ marginTop: 0 }}>账户、登录与 AI 提供方配置。</p>

      <div className="home-card" style={{ marginTop: 16 }}>
        <div className="home-card-head"><span>账户</span></div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 0' }}>
          <div className="rp-info-row"><span>姓名</span><b>{me.name}</b></div>
          <div className="rp-info-row"><span>邮箱</span><b>{me.email}</b></div>
          {me.isInstanceOwner && (
            <div className="rp-info-row"><span>角色</span><b>实例所有者</b></div>
          )}
        </div>
      </div>

      <div className="home-card" style={{ marginTop: 16 }}>
        <div className="home-card-head">
          <span><KeyRound size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />AI 提供方（个人覆盖）</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0' }}>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            配置你自己的 API Key 与模型。密钥加密存储，永不明文返回。留空 Key 字段表示保留已存密钥；输入内容则覆盖。
          </p>

          <label style={fieldStyle}>
            <span>驱动</span>
            <select style={inputStyle} value={driver} onChange={(e) => setDriver(e.target.value)}>
              {DRIVERS.map((d) => (
                <option key={d.value} value={d.value}>{d.label}</option>
              ))}
            </select>
          </label>

          <label style={fieldStyle}>
            <span>Base URL（可选）</span>
            <input style={inputStyle} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" />
          </label>

          <label style={fieldStyle}>
            <span>API Key</span>
            <input
              style={inputStyle}
              type="password"
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); setTouched(true); }}
              placeholder={cfg?.hasApiKey ? `已配置（${cfg.apiKeyMasked}），留空保留` : '输入密钥'}
            />
          </label>

          <label style={fieldStyle}>
            <span>对话模型</span>
            <input style={inputStyle} value={completionModel} onChange={(e) => setCompletionModel(e.target.value)} placeholder="gpt-4o-mini" />
          </label>

          <label style={fieldStyle}>
            <span>嵌入模型</span>
            <input style={inputStyle} value={embeddingModel} onChange={(e) => setEmbeddingModel(e.target.value)} placeholder="text-embedding-3-small" />
          </label>

          <label style={fieldStyle}>
            <span>嵌入维度</span>
            <input
              style={inputStyle}
              type="number"
              value={embeddingDimension}
              onChange={(e) => setEmbeddingDimension(Number(e.target.value) || 1536)}
            />
          </label>

          <label style={{ ...fieldStyle, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={personalOverrideEnabled}
              onChange={(e) => setPersonalOverrideEnabled(e.target.checked)}
            />
            <span>启用个人覆盖（关闭则回退到实例默认配置）</span>
          </label>

          {save.isError && (
            <div className="muted" style={{ color: '#c0392b', fontSize: 12 }}>
              保存失败：{(save.error as Error).message}
            </div>
          )}
          {save.isSuccess && !touched && (
            <div className="muted" style={{ color: '#2e7d32', fontSize: 12 }}>已保存。</div>
          )}

          <div>
            <button className="ghost sm" disabled={save.isPending || isLoading} onClick={() => save.mutate()}>
              <Save size={14} /> {save.isPending ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <button className="ghost danger sm" disabled={logout.isPending} onClick={() => logout.mutate()}>
          <LogOut size={14} /> 退出登录
        </button>
      </div>
    </div>
  );
}
