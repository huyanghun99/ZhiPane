import { useState, useEffect } from 'react';
import { X, Check } from 'lucide-react';
import type { Project } from '../api';
import { PRESET_COLORS } from '../api';

interface ProjectModalProps {
  project?: Project | null;
  isOpen: boolean;
  onClose: () => void;
  onSave: (name: string, color: string) => void;
}

export function ProjectModal({ project, isOpen, onClose, onSave }: ProjectModalProps) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(PRESET_COLORS[0]);

  useEffect(() => {
    setName(project?.name ?? '');
    setColor(project?.color ?? PRESET_COLORS[0]);
  }, [project, isOpen]);

  if (!isOpen) return null;

  const save = () => {
    if (!name.trim()) return;
    onSave(name.trim(), color);
    onClose();
  };

  return (
    <div className="tm-overlay" onClick={onClose}>
      <div className="tm-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="tm-head">
          <h3>{project ? '编辑项目' : '新建项目'}</h3>
          <button className="icon-btn" onClick={onClose}><X size={20} /></button>
        </div>

        <div className="tm-body">
          <div className="tm-field">
            <label>项目名称</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && save()}
              placeholder="输入项目名称…"
            />
          </div>

          <div className="tm-field">
            <label>标志颜色</label>
            <div className="tm-colors">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  className={`tm-color${color === c ? ' is-active' : ''}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                  aria-label={`选择颜色 ${c}`}
                >
                  {color === c && <Check size={14} />}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="tm-foot">
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" onClick={save} disabled={!name.trim()}>保存项目</button>
        </div>
      </div>
    </div>
  );
}
