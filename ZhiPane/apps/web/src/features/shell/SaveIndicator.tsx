import { Check, Cloud, CloudOff, Loader2, Zap } from 'lucide-react';
import type { SaveState } from './editorStatus';

/**
 * Save-state pill (Phase 3 — task 1). Shown both in the top bar and at the
 * top-right of the editor so the current state is always visible and credible:
 *   ✓ 已保存 · ● 保存中… · ⚠ 未保存 · ⚡ 版本冲突 · 保存失败
 */
export function SaveIndicator({ state }: { state: SaveState }) {
  if (state === 'saving') return <span className="save-ind"><Loader2 className="spin" size={14} /> 保存中…</span>;
  if (state === 'dirty') return <span className="save-ind dirty"><Cloud size={14} /> 未保存</span>;
  if (state === 'conflict') return <span className="save-ind err"><Zap size={14} /> 版本冲突</span>;
  if (state === 'error') return <span className="save-ind err"><CloudOff size={14} /> 保存失败</span>;
  if (state === 'saved') return <span className="save-ind ok"><Check size={14} /> 已保存</span>;
  return null;
}
