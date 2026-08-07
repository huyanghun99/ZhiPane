import { X, AlertTriangle, Trash2, Info } from 'lucide-react';

interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  type?: 'danger' | 'warning' | 'info';
  onConfirm: () => void;
  onCancel: () => void;
}

const ICONS = {
  danger: Trash2,
  warning: AlertTriangle,
  info: Info
} as const;

export function ConfirmModal({
  isOpen, title, message, confirmText = '确定', cancelText = '取消',
  type = 'danger', onConfirm, onCancel
}: ConfirmModalProps) {
  if (!isOpen) return null;
  const Icon = ICONS[type];

  return (
    <div className="tm-overlay" onClick={onCancel}>
      <div className="tm-dialog is-sm" onClick={(e) => e.stopPropagation()}>
        <div className="tm-confirm">
          <span className={`tm-confirm-icon is-${type}`}><Icon size={24} /></span>
          <div className="tm-confirm-text">
            <h3>{title}</h3>
            <p>{message}</p>
          </div>
          <button className="icon-btn" onClick={onCancel}><X size={16} /></button>
        </div>

        <div className="tm-foot">
          <button className="btn-ghost" onClick={onCancel}>{cancelText}</button>
          <button
            className={`btn-primary is-${type}`}
            onClick={() => { onConfirm(); onCancel(); }}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
