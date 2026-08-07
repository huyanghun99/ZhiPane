import { AlertTriangle, Check, Clock, RotateCcw, X } from 'lucide-react';
import { Modal } from '../../components/Dialog';
import type { WikiSuggestion } from '../../types';

const SUGG_LABEL: Record<string, string> = {
  topic_proposal: '主题提案', topic_candidate: '候选主题', cross_link: '关联建议', link_suggestion: '关联建议',
  outdated_topic: '主题待更新', stale_topic: '主题待更新'
};
const RISK_LABEL: Record<string, string> = { low: '低风险', medium: '中风险', high: '高风险' };
const RISK_HINT: Record<string, string> = {
  low: '自动应用，可随时撤销',
  medium: '建议人工确认后应用',
  high: '影响较大，需明确确认'
};

/** Stable, human-readable title + description for any suggestion type. */
export function suggestionTitle(s: WikiSuggestion): { title: string; desc: string } {
  const p = s.payload as { topicTitle?: string; topicSummary?: string; candidateTitle?: string; candidateSummary?: string; targetPageTitle?: string; targetPageId?: string; reason?: string; changes?: string };
  if (s.type === 'topic_proposal') {
    return { title: `提议新主题：${p.topicTitle ?? '未命名'}`, desc: p.topicSummary || 'AI 从笔记中提炼出的候选主题。' };
  }
  if (s.type === 'topic_candidate') {
    return { title: `候选主题：${p.candidateTitle ?? '未命名'}`, desc: p.candidateSummary || 'AI 从笔记中提炼的候选主题，审阅后可晋升为正式知识主题。' };
  }
  if (s.type === 'cross_link' || s.type === 'link_suggestion') {
    return { title: `关联笔记：${p.targetPageTitle ?? '相关页面'}`, desc: p.reason || '内容主题高度相关，建议建立双向链接。' };
  }
  if (s.type === 'outdated_topic' || s.type === 'stale_topic') {
    return { title: `主题待更新：${p.topicTitle ?? '某主题'}`, desc: '源笔记有改动，建议重新生成该主题内容。' };
  }
  return { title: s.type, desc: '' };
}

/** A single suggestion rendered according to its risk level.
 *  - low:   never reaches here (auto-applied by the parent with a toast)
 *  - medium: inline card with 接受 / 忽略 / 稍后
 *  - high:  the 接受 button opens a confirmation modal (impact scope)
 */
export function SuggestionCard({ s, onAccept, onIgnore, onSnooze, onAcceptHigh }: {
  s: WikiSuggestion;
  onAccept: (s: WikiSuggestion) => void;
  onIgnore: (s: WikiSuggestion) => void;
  onSnooze?: (s: WikiSuggestion) => void;
  onAcceptHigh: (s: WikiSuggestion) => void;
}) {
  const { title, desc } = suggestionTitle(s);
  const p = s.payload as { changes?: string; reason?: string; targetPageId?: string };
  const risk = s.risk;
  return (
    <div className={`sugg-card risk-${risk}`}>
      <div className="sugg-card-head">
        <span className="tag">{SUGG_LABEL[s.type] ?? s.type}</span>
        <span className={`risk risk-${risk}`} title={RISK_HINT[risk] ?? ''}>
          {risk === 'high' && <AlertTriangle size={11} />} {RISK_LABEL[risk] ?? risk}
        </span>
      </div>
      <b className="sugg-card-title">{title}</b>
      {p.changes && <p className="sugg-changes">影响范围：{p.changes}</p>}
      {p.reason && !p.changes && <p className="muted small">{p.reason}</p>}
      {!p.changes && !p.reason && desc && <p className="muted small">{desc}</p>}
      <div className="sugg-card-actions">
        {risk === 'high'
          ? <button className="primary sm" onClick={() => onAcceptHigh(s)}><Check size={13} /> 接受</button>
          : <button className="ghost ok sm" onClick={() => onAccept(s)}><Check size={13} /> 接受</button>}
        <button className="ghost danger sm" onClick={() => onIgnore(s)}><X size={13} /> 忽略</button>
        {onSnooze && <button className="ghost sm" onClick={() => onSnooze(s)}><Clock size={13} /> 稍后</button>}
      </div>
    </div>
  );
}

/** "Accepted" feedback row with a brief ✓ animation, optionally undoable. */
export function SuggestionAccepted({ label, onUndo }: { label: string; onUndo?: () => void }) {
  return (
    <div className="sugg-card accepted">
      <div className="accept-row">
        <span className="accept-check"><Check size={14} /> 已接受</span>
        <b>{label}</b>
      </div>
      {onUndo && (
        <button className="ghost sm" onClick={onUndo}><RotateCcw size={13} /> 撤销</button>
      )}
    </div>
  );
}

/** Confirmation modal for high-risk suggestions — shows the impact scope so the
 *  user explicitly approves a change that touches the knowledge graph. */
export function HighRiskModal({ suggestion, onClose, onConfirm }: {
  suggestion: WikiSuggestion; onClose: () => void; onConfirm: () => void;
}) {
  const { title, desc } = suggestionTitle(suggestion);
  const p = suggestion.payload as { changes?: string; reason?: string; targetPageTitle?: string; topicTitle?: string };
  return (
    <Modal title={<span><AlertTriangle size={15} /> 确认接受高风险建议</span>} onClose={onClose}>
      <div className="modal-body">
        <p className="dialog-message">该建议影响范围较大，接受后 AI 会据此修改知识库结构。请确认是否继续。</p>
        <div className="hr-sugg">
          <span className="tag">{suggestion.type}</span>
          <b>{title}</b>
        </div>
        {p.changes && (
          <div className="hr-scope">
            <h5>影响范围</h5>
            <p>{p.changes}</p>
          </div>
        )}
        {p.reason && (
          <div className="hr-scope">
            <h5>理由</h5>
            <p>{p.reason}</p>
          </div>
        )}
        {!p.changes && !p.reason && desc && <p className="muted small">{desc}</p>}
        <div className="modal-footer">
          <button className="ghost" onClick={onClose}>取消</button>
          <button className="primary danger-solid" onClick={onConfirm}>确认接受</button>
        </div>
      </div>
    </Modal>
  );
}
