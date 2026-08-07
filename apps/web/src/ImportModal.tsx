import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { post } from './api';

export function ImportModal({
  workspaceId, spaceId, spaceName, onClose, onImported
}: {
  workspaceId: string;
  spaceId: string;
  spaceName: string;
  onClose: () => void;
  onImported: (pageId: string) => void;
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');

  const imp = useMutation({
    mutationFn: () => post<{ page: { id: string } }>('/api/import/markdown', {
      workspaceId, spaceId, title: title.trim() || '导入的笔记', content
    }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['pages', spaceId] });
      onImported(res.page.id);
      onClose();
    }
  });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal import-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>导入 Markdown 到「{spaceName}」</span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <label className="field-label">标题（可选）</label>
          <input className="text-input" value={title} placeholder="留空则使用文件名/首行" onChange={(e) => setTitle(e.target.value)} />
          <label className="field-label">Markdown 内容</label>
          <textarea
            className="import-area"
            value={content}
            placeholder={'# 标题\n\n在这里粘贴 Markdown 内容…'}
            onChange={(e) => setContent(e.target.value)}
          />
          {imp.isError && <div className="error-text">{(imp.error as Error).message}</div>}
          <div className="modal-footer">
            <button className="ghost" onClick={onClose}>取消</button>
            <button className="primary" disabled={imp.isPending || !content.trim()} onClick={() => imp.mutate()}>
              {imp.isPending ? '导入中…' : '导入为笔记'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
