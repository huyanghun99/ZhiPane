/**
 * F4: Editor top toolbar — sticky formatting bar with text color, highlight,
 * heading, insert actions. Shown only when the editor is focused/active.
 *
 * Active states are read through `useEditorState` (a narrow selector) instead
 * of reading `editor.isActive(...)` during render. This keeps the toolbar
 * updating with the selection while the editor itself does NOT re-render on
 * every transaction (we set `shouldRerenderOnTransaction: false` in RichEditor
 * for performance), matching docmost's pattern.
 */
import { useEditorState, type Editor } from '@tiptap/react';
import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough, Code,
  Heading1, Heading2, Heading3, List, ListOrdered, ListChecks,
  Quote, Code2, Minus, Image as ImageIcon, Table as TableIcon,
  Palette, Highlighter, Link2, Undo2, Redo2
} from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import { useDialog } from '../components/Dialog';

const TEXT_COLORS = [
  { label: '默认', value: '' },
  { label: '红色', value: '#dc2626' },
  { label: '橙色', value: '#ea580c' },
  { label: '黄色', value: '#ca8a04' },
  { label: '绿色', value: '#16a34a' },
  { label: '蓝色', value: '#2563eb' },
  { label: '紫色', value: '#7c3aed' },
  { label: '灰色', value: '#6b7280' },
];

const HIGHLIGHT_COLORS = [
  { label: '黄色', value: '#fef08a' },
  { label: '绿色', value: '#bbf7d0' },
  { label: '蓝色', value: '#bfdbfe' },
  { label: '红色', value: '#fecaca' },
  { label: '紫色', value: '#e9d5ff' },
];

export function EditorToolbar({ editor }: { editor: Editor }) {
  const [showColors, setShowColors] = useState(false);
  const [showHighlights, setShowHighlights] = useState(false);
  const colorRef = useRef<HTMLDivElement>(null);
  const hlRef = useRef<HTMLDivElement>(null);
  const { prompt } = useDialog();

  // Narrow subscription: only re-renders this toolbar (not the editor tree)
  // when the active marks/nodes actually change.
  const state = useEditorState({
    editor,
    selector: ({ editor }) => ({
      h1: editor.isActive('heading', { level: 1 }),
      h2: editor.isActive('heading', { level: 2 }),
      h3: editor.isActive('heading', { level: 3 }),
      bold: editor.isActive('bold'),
      italic: editor.isActive('italic'),
      underline: editor.isActive('underline'),
      strike: editor.isActive('strike'),
      code: editor.isActive('code'),
      highlight: editor.isActive('highlight'),
      bulletList: editor.isActive('bulletList'),
      orderedList: editor.isActive('orderedList'),
      taskList: editor.isActive('taskList'),
      blockquote: editor.isActive('blockquote'),
      codeBlock: editor.isActive('codeBlock'),
      link: editor.isActive('link'),
      table: editor.isActive('table'),
    }),
  });
  const s = state ?? {};

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (colorRef.current && !colorRef.current.contains(e.target as Node)) setShowColors(false);
      if (hlRef.current && !hlRef.current.contains(e.target as Node)) setShowHighlights(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, []);

  if (!editor) return null;

  const btn = (icon: React.ReactNode, action: () => void, isActive = false, title: string) => (
    <button
      type="button"
      className={`tb-btn${isActive ? ' active' : ''}`}
      title={title}
      onMouseDown={(e) => { e.preventDefault(); action(); }}
    >
      {icon}
    </button>
  );

  const sep = () => <span className="tb-sep" />;

  const setLink = async () => {
    const prev = editor.getAttributes('link').href as string | undefined;
    const url = await prompt({ title: '链接地址', defaultValue: prev ?? 'https://', placeholder: 'https://…' });
    if (url === null) return;
    if (url === '') { editor.chain().focus().extendMarkRange('link').unsetLink().run(); return; }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  };

  const insertImage = async () => {
    const url = await prompt({ title: '插入图片', message: '输入图片地址', placeholder: 'https://… 或 /uploads/…' });
    if (url) editor.chain().focus().setImage({ src: url, alt: '' }).run();
  };

  const insertTable = () => {
    editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
  };

  return (
    <div className="editor-toolbar" contentEditable={false}>
      <div className="tb-group">
        {btn(<Undo2 size={15} />, () => editor.chain().focus().undo().run(), false, '撤销')}
        {btn(<Redo2 size={15} />, () => editor.chain().focus().redo().run(), false, '重做')}
      </div>

      {sep()}

      <div className="tb-group">
        {btn(<Heading1 size={15} />, () => editor.chain().focus().toggleHeading({ level: 1 }).run(), s.h1, '标题 1')}
        {btn(<Heading2 size={15} />, () => editor.chain().focus().toggleHeading({ level: 2 }).run(), s.h2, '标题 2')}
        {btn(<Heading3 size={15} />, () => editor.chain().focus().toggleHeading({ level: 3 }).run(), s.h3, '标题 3')}
      </div>

      {sep()}

      <div className="tb-group">
        {btn(<Bold size={15} />, () => editor.chain().focus().toggleBold().run(), s.bold, '加粗')}
        {btn(<Italic size={15} />, () => editor.chain().focus().toggleItalic().run(), s.italic, '斜体')}
        {btn(<UnderlineIcon size={15} />, () => editor.chain().focus().toggleUnderline().run(), s.underline, '下划线')}
        {btn(<Strikethrough size={15} />, () => editor.chain().focus().toggleStrike().run(), s.strike, '删除线')}
        {btn(<Code size={15} />, () => editor.chain().focus().toggleCode().run(), s.code, '行内代码')}
      </div>

      {sep()}

      {/* Text color dropdown */}
      <div className="tb-color-wrap" ref={colorRef}>
        {btn(<Palette size={15} />, () => { setShowColors((v) => !v); setShowHighlights(false); }, false, '文字颜色')}
        {showColors && (
          <div className="tb-dropdown">
            {TEXT_COLORS.map((c) => (
              <button
                key={c.value}
                className="tb-color-item"
                onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().setColor(c.value || 'unset').run(); setShowColors(false); }}
              >
                <span className="tb-color-swatch" style={{ background: c.value || 'transparent', border: c.value ? 'none' : '1px solid var(--border)' }} />
                {c.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Highlight dropdown */}
      <div className="tb-color-wrap" ref={hlRef}>
        {btn(<Highlighter size={15} />, () => { setShowHighlights((v) => !v); setShowColors(false); }, s.highlight, '高亮')}
        {showHighlights && (
          <div className="tb-dropdown">
            {HIGHLIGHT_COLORS.map((c) => (
              <button
                key={c.value}
                className="tb-color-item"
                onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleHighlight({ color: c.value }).run(); setShowHighlights(false); }}
              >
                <span className="tb-color-swatch" style={{ background: c.value }} />
                {c.label}
              </button>
            ))}
            <button
              className="tb-color-item"
              onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().unsetHighlight().run(); setShowHighlights(false); }}
            >
              <span className="tb-color-swatch" style={{ background: 'transparent', border: '1px solid var(--border)' }} />
              清除高亮
            </button>
          </div>
        )}
      </div>

      {sep()}

      <div className="tb-group">
        {btn(<List size={15} />, () => editor.chain().focus().toggleBulletList().run(), s.bulletList, '无序列表')}
        {btn(<ListOrdered size={15} />, () => editor.chain().focus().toggleOrderedList().run(), s.orderedList, '有序列表')}
        {btn(<ListChecks size={15} />, () => editor.chain().focus().toggleTaskList().run(), s.taskList, '任务列表')}
      </div>

      {sep()}

      <div className="tb-group">
        {btn(<Quote size={15} />, () => editor.chain().focus().toggleBlockquote().run(), s.blockquote, '引用')}
        {btn(<Code2 size={15} />, () => editor.chain().focus().toggleCodeBlock().run(), s.codeBlock, '代码块')}
        {btn(<Minus size={15} />, () => editor.chain().focus().setHorizontalRule().run(), false, '分割线')}
        {btn(<Link2 size={15} />, setLink, s.link, '链接')}
      </div>

      {sep()}

      <div className="tb-group">
        {btn(<ImageIcon size={15} />, insertImage, false, '插入图片')}
        {btn(<TableIcon size={15} />, insertTable, s.table, '插入表格')}
      </div>
    </div>
  );
}
