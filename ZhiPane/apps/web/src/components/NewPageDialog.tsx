import { useEffect } from 'react';
import { PAGE_TEMPLATES } from '../editor/templates';

/**
 * New-page template picker (Phase 6 — task 2).
 *
 * Presented as a modal (opened from the sidebar "+", the Home "新建" button,
 * Cmd/Ctrl+N, or the command palette). Picking a template hands the id back to
 * the caller, which performs `POST /api/pages` with the pre-filled contentJson.
 */
export function NewPageDialog({
  onClose,
  onCreate
}: {
  onClose: () => void;
  onCreate: (templateId: string) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal new-page-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>新建页面</span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <p className="muted small new-page-hint">选择一个模板开始，或新建空白页。</p>
          <div className="template-grid">
            {PAGE_TEMPLATES.map((t) => (
              <button
                key={t.id}
                className="template-card"
                onClick={() => onCreate(t.id)}
              >
                <span className="template-icon">{t.icon}</span>
                <span className="template-name">{t.name}</span>
                <span className="template-desc">{t.desc}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
