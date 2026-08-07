import { UploadCloud, X, RotateCw, AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { UploadItem } from './useUploads';

const KIND_LABEL: Record<string, string> = {
  image: '图片', video: '视频', audio: '音频', pdf: 'PDF', file: '文件'
};

/**
 * Floating upload tray (Phase4 — task 7). Lists every in-flight or failed
 * upload with a live progress bar, a cancel button while uploading, and a
 * retry / dismiss pair on failure. A failed upload is never destructive to
 * the document — it simply stays here until retried or dismissed.
 */
export function UploadOverlay({ items, onCancel, onRetry, onDismiss }: {
  items: UploadItem[];
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="upload-tray" role="status" aria-live="polite">
      <div className="upload-tray-head">
        <UploadCloud size={14} />
        <span>附件上传</span>
        <span className="upload-count">{items.length}</span>
      </div>
      {items.map((it) => (
        <div key={it.id} className={`upload-row status-${it.status}`}>
          <div className="upload-meta">
            <span className="upload-name" title={it.fileName}>
              {KIND_LABEL[it.kind] ?? '文件'} · {it.fileName}
            </span>
            {it.status === 'uploading' && <span className="upload-pct">{it.progress}%</span>}
            {it.status === 'done' && (
              <span className="upload-ok"><CheckCircle2 size={12} /> 已完成</span>
            )}
            {it.status === 'error' && (
              <span className="upload-err"><AlertTriangle size={12} /> {it.error ?? '失败'}</span>
            )}
          </div>

          {it.status === 'uploading' && (
            <div className="upload-bar"><div className="upload-fill" style={{ width: `${it.progress}%` }} /></div>
          )}

          <div className="upload-actions">
            {it.status === 'uploading' && (
              <button type="button" className="upload-btn" title="取消" onClick={() => onCancel(it.id)}><X size={13} /></button>
            )}
            {it.status === 'error' && (
              <>
                <button type="button" className="upload-btn" title="重试" onClick={() => onRetry(it.id)}><RotateCw size={13} /></button>
                <button type="button" className="upload-btn" title="忽略" onClick={() => onDismiss(it.id)}><X size={13} /></button>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
