import { useEffect } from 'react';
import { X } from 'lucide-react';

const GROUPS: { title: string; items: { keys: string; desc: string }[] }[] = [
  {
    title: '全局',
    items: [
      { keys: '⌘/Ctrl + K', desc: '打开命令面板（搜索笔记 / 执行命令）' },
      { keys: '⌘/Ctrl + N', desc: '新建笔记' },
      { keys: '⌘/Ctrl + P', desc: '快速切换笔记' },
      { keys: '⌘/Ctrl + S', desc: '保存当前笔记' },
      { keys: '?', desc: '打开本快捷键面板' },
      { keys: 'Esc', desc: '关闭弹层 / 面板' }
    ]
  },
  {
    title: '编辑器',
    items: [
      { keys: '/', desc: '唤起块命令（插入标题 / 表格 / 图片等）' },
      { keys: '# / ## / ###', desc: 'Markdown 快捷输入标题' },
      { keys: '> / - / 1.', desc: 'Markdown 快捷输入引用 / 列表' },
      { keys: '```', desc: 'Markdown 快捷输入代码块' }
    ]
  },
  {
    title: '导航',
    items: [
      { keys: '点击面包屑', desc: '回到空间 / 首页' },
      { keys: '关系图 / 归档中心', desc: '在左侧导航切换不同视图' }
    ]
  }
];

export function ShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="cmdk-backdrop" onClick={onClose}>
      <div className="shortcuts" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="键盘快捷键">
        <div className="shortcuts-head">
          <h3>键盘快捷键</h3>
          <button className="icon-btn" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </div>
        <div className="shortcuts-body">
          {GROUPS.map((g) => (
            <div key={g.title} className="shortcuts-group">
              <h4>{g.title}</h4>
              {g.items.map((it) => (
                <div key={it.keys} className="shortcuts-row">
                  <kbd>{it.keys}</kbd>
                  <span>{it.desc}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
