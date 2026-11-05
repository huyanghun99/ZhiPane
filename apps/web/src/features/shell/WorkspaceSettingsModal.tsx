import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Settings2, X } from 'lucide-react';
import { api, patch } from '../../api';
import { useToast } from '../../components/Toast';
import type { Space, Workspace } from '../../types';

const PRIVACY_OPTIONS = [
  { value: 'inherit_workspace', label: '跟随知识库默认' },
  { value: 'cloud_allowed', label: '允许云端模型' },
  { value: 'local_only', label: '仅本地模型' },
  { value: 'disabled', label: '禁用 AI 整理' }
];

/**
 * Knowledge-base level settings, opened from the gear next to the workspace
 * picker (and from the breadcrumb). Deliberately separate from /settings,
 * which is the user/global settings page.
 */
export function WorkspaceSettingsModal({ workspace, space, onClose }: {
  workspace: Workspace;
  space: Space | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(workspace.name);
  const [privacy, setPrivacy] = useState('inherit_workspace');
  const [autoLlm, setAutoLlm] = useState(true);

  const spacesQ = useQuery<{ spaces: Array<Record<string, unknown>> }>({
    queryKey: ['spaces', workspace.id],
    enabled: !!space,
    queryFn: () => api(`/api/spaces?workspaceId=${workspace.id}`)
  });

  useEffect(() => {
    const row = spacesQ.data?.spaces.find((s) => s.id === space?.id);
    if (!row) return;
    const p = (row.ai_privacy_policy ?? row.aiPrivacyPolicy) as string | undefined;
    const a = row.auto_llm_processing ?? row.autoLlmProcessing;
    if (p) setPrivacy(p);
    if (typeof a === 'boolean') setAutoLlm(a);
  }, [spacesQ.data, space?.id]);

  const save = useMutation({
    mutationFn: async () => {
      if (name.trim() && name.trim() !== workspace.name) {
        await patch(`/api/workspaces/${workspace.id}`, { name: name.trim() });
      }
      if (space) {
        await patch(`/api/spaces/${space.id}`, {
          aiPrivacyPolicy: privacy,
          autoLlmProcessing: autoLlm
        });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workspaces'] });
      qc.invalidateQueries({ queryKey: ['spaces', workspace.id] });
      toast.success('知识库设置已保存');
      onClose();
    },
    onError: (e) => toast.error(`保存失败：${(e as Error).message}`)
  });

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ width: 'min(460px, 92vw)', height: 'auto', maxHeight: '80vh' }}>
        <div className="modal-head">
          <span><Settings2 size={15} style={{ verticalAlign: '-3px', marginRight: 6 }} />知识库设置</span>
          <button className="modal-close" onClick={onClose}><X size={15} /></button>
        </div>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
            <span>知识库名称</span>
            <input value={name} onChange={(e) => setName(e.target.value)}
              style={{ padding: '7px 9px', border: '1px solid var(--border-strong)', borderRadius: 8, background: 'var(--surface)', color: 'var(--text)' }} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
            <span>当前空间的 AI 隐私策略</span>
            <select value={privacy} disabled={!space} onChange={(e) => setPrivacy(e.target.value)}
              style={{ padding: '7px 9px', border: '1px solid var(--border-strong)', borderRadius: 8, background: 'var(--surface)', color: 'var(--text)' }}>
              {PRIVACY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <input type="checkbox" checked={autoLlm} disabled={!space} onChange={(e) => setAutoLlm(e.target.checked)} />
            <span>新笔记自动进入 AI 整理队列</span>
          </label>
          <p className="muted small" style={{ margin: 0 }}>
            账号、登录、AI 提供方、每日整理时间等属于全局设置，请在右上角用户菜单的「全局设置」中修改。
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="ghost sm" onClick={onClose}>取消</button>
            <button className="primary sm" disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
