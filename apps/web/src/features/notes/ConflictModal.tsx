import { GitMerge, Server, Laptop, X } from 'lucide-react';

function preview(text?: string, max = 600): string {
  const t = (text ?? '').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/**
 * Version conflict recovery UI (Phase4 — task 9).
 *
 * Shown when a save returns 409 (the page was updated elsewhere). Instead
 * of a bare confirm() we present both versions side by side and let the
 * user decide: keep their local edits (overwrite), take the server
 * version, or defer the decision.
 */
export function ConflictModal({
  serverVersion,
  myTitle,
  myText,
  serverTitle,
  serverText,
  onKeepMine,
  onUseTheirs,
  onSaveCopy,
  onCancel
}: {
  serverVersion: number;
  myTitle: string;
  myText?: string;
  serverTitle?: string;
  serverText?: string;
  onKeepMine: () => void;
  onUseTheirs: () => void;
  onSaveCopy: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog conflict-dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="conflict-head">
          <GitMerge size={18} />
          <div>
            <h3 className="dialog-title">有人修改了此页面</h3>
            <p className="dialog-message">
              服务器当前版本为 v{serverVersion}。你可以用本地修改覆盖，查看并切换到最新版，或把本地修改另存为一篇新笔记的副本。本地草稿不会因刷新而丢失。
            </p>
          </div>
          <button className="modal-close" onClick={onCancel} aria-label="关闭"><X size={16} /></button>
        </div>

        <div className="conflict-cols">
          <div className="conflict-col mine">
            <div className="conflict-col-head"><Laptop size={14} /> 我的版本（本地未保存）</div>
            <div className="conflict-title">{myTitle || '未命名笔记'}</div>
            <pre className="conflict-preview">{preview(myText) || '（空）'}</pre>
          </div>
          <div className="conflict-col theirs">
            <div className="conflict-col-head"><Server size={14} /> 服务器版本（v{serverVersion}）</div>
            <div className="conflict-title">{serverTitle || '未命名笔记'}</div>
            <pre className="conflict-preview">{preview(serverText) || '（空）'}</pre>
          </div>
        </div>

        <div className="dialog-actions">
          <button className="ghost" onClick={onCancel}>稍后处理</button>
          <button className="ghost" onClick={onSaveCopy}>另存副本</button>
          <button className="ghost" onClick={onUseTheirs}>查看最新版</button>
          <button className="primary" onClick={onKeepMine}>覆盖</button>
        </div>
      </div>
    </div>
  );
}
