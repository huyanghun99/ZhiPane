import { Extension, type Editor, type Range } from '@tiptap/react';
import Suggestion, { type SuggestionOptions, type SuggestionProps } from '@tiptap/suggestion';
import { ReactRenderer } from '@tiptap/react';
import { SlashMenu, type SlashMenuRef } from './SlashMenu';
import type { AiActionKind } from './ai-actions';

export type MediaKind = 'image' | 'video' | 'audio' | 'pdf' | 'file';
export type SlashGroup = 'basic' | 'media' | 'advanced' | 'ai';

export const GROUP_LABELS: Record<SlashGroup, string> = {
  basic: '基础',
  media: '媒体',
  advanced: '高级',
  ai: 'AI'
};

const GROUP_ORDER: SlashGroup[] = ['basic', 'media', 'advanced', 'ai'];

export interface SlashItem {
  title: string;
  description: string;
  icon: string;
  group: SlashGroup;
  searchTerms: string[];
  command: (props: { editor: Editor; range: Range }) => void;
}

const pickFile = (editor: Editor, kind: MediaKind) =>
  (editor.storage.slashCommand?.onPickFile as ((k: MediaKind) => void) | undefined)?.(kind);
const aiAction = (editor: Editor, range: Range, kind: AiActionKind) =>
  (editor.storage.slashCommand?.onAiAction as ((k: AiActionKind, r: Range) => void) | undefined)?.(kind, range);

const ITEMS: SlashItem[] = [
  {
    title: '正文', description: '普通段落文本', icon: '¶', group: 'basic',
    searchTerms: ['text', 'paragraph', 'zhengwen', '文本', '段落'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setParagraph().run()
  },
  {
    title: '标题 1', description: '大号章节标题', icon: 'H1', group: 'basic',
    searchTerms: ['h1', 'heading', 'title', 'biaoti', '标题'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setNode('heading', { level: 1 }).run()
  },
  {
    title: '标题 2', description: '中号小节标题', icon: 'H2', group: 'basic',
    searchTerms: ['h2', 'heading', 'biaoti', '标题'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setNode('heading', { level: 2 }).run()
  },
  {
    title: '标题 3', description: '小号子标题', icon: 'H3', group: 'basic',
    searchTerms: ['h3', 'heading', 'biaoti', '标题'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setNode('heading', { level: 3 }).run()
  },
  {
    title: '待办列表', description: '可勾选的任务清单', icon: '☑', group: 'basic',
    searchTerms: ['todo', 'task', 'check', 'daiban', '待办', '任务'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleTaskList().run()
  },
  {
    title: '无序列表', description: '圆点项目符号', icon: '•', group: 'basic',
    searchTerms: ['bullet', 'list', 'liebiao', '列表'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBulletList().run()
  },
  {
    title: '有序列表', description: '带编号的列表', icon: '1.', group: 'basic',
    searchTerms: ['ordered', 'number', 'liebiao', '列表', '编号'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleOrderedList().run()
  },
  {
    title: '引用', description: '引用块', icon: '❝', group: 'basic',
    searchTerms: ['quote', 'blockquote', 'yinyong', '引用'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBlockquote().run()
  },
  {
    title: '代码块', description: '等宽代码段', icon: '</>', group: 'basic',
    searchTerms: ['code', 'codeblock', 'daima', '代码'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleCodeBlock().run()
  },
  {
    title: '分割线', description: '水平分隔线', icon: '—', group: 'basic',
    searchTerms: ['divider', 'hr', 'fenge', '分割线'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setHorizontalRule().run()
  },
  {
    title: '图片', description: '上传并插入图片', icon: '🖼', group: 'media',
    searchTerms: ['image', 'img', 'picture', 'tupian', '图片'],
    command: ({ editor, range }) => { editor.chain().focus().deleteRange(range).run(); pickFile(editor, 'image'); }
  },
  {
    title: '视频', description: '上传并插入视频', icon: '🎬', group: 'media',
    searchTerms: ['video', 'shipin', '视频'],
    command: ({ editor, range }) => { editor.chain().focus().deleteRange(range).run(); pickFile(editor, 'video'); }
  },
  {
    title: '音频', description: '上传并插入音频', icon: '🎵', group: 'media',
    searchTerms: ['audio', 'yinpin', '音频'],
    command: ({ editor, range }) => { editor.chain().focus().deleteRange(range).run(); pickFile(editor, 'audio'); }
  },
  {
    title: 'PDF', description: '上传并插入 PDF', icon: '📄', group: 'media',
    searchTerms: ['pdf', 'wendang', '文档'],
    command: ({ editor, range }) => { editor.chain().focus().deleteRange(range).run(); pickFile(editor, 'pdf'); }
  },
  {
    title: '文件', description: '上传任意文件作为附件', icon: '📎', group: 'media',
    searchTerms: ['file', 'attachment', 'wenjian', '文件', '附件'],
    command: ({ editor, range }) => { editor.chain().focus().deleteRange(range).run(); pickFile(editor, 'file'); }
  },
  {
    title: '嵌入网页', description: '嵌入 YouTube / Figma / 网页', icon: '🔗', group: 'media',
    searchTerms: ['embed', 'iframe', 'qianru', '嵌入', '网页'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range)
      .insertContent({ type: 'embed', attrs: { url: '' } }).run()
  },
  {
    title: '表格', description: '插入 3×3 表格', icon: '▦', group: 'advanced',
    searchTerms: ['table', 'biaoge', '表格'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
  },
  {
    title: '流程图', description: 'Mermaid 图表', icon: '⬡', group: 'advanced',
    searchTerms: ['mermaid', 'diagram', 'flow', 'litu', '图', '流程图'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range)
      .insertContent({ type: 'mermaid', attrs: { code: 'graph TD\n  A[开始] --> B[处理]\n  B --> C[结束]' } }).run()
  },
  {
    title: '标注', description: '高亮提示块（Callout）', icon: '💡', group: 'advanced',
    searchTerms: ['callout', 'biaozhu', 'tip', '提示', '标注'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range)
      .insertContent({ type: 'callout', content: [{ type: 'paragraph' }] }).run()
  },
  {
    title: '折叠', description: '可折叠内容（Toggle）', icon: '▸', group: 'advanced',
    searchTerms: ['toggle', 'zhedie', 'collapse', '折叠'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range)
      .insertContent({ type: 'toggle', attrs: { summary: '点击展开' }, content: [{ type: 'paragraph' }] }).run()
  },
  {
    title: '公式', description: 'KaTeX 数学公式（块级）', icon: '∑', group: 'advanced',
    searchTerms: ['math', 'katex', 'formula', 'gongshi', '公式', 'tex'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range)
      .insertContent({ type: 'mathBlock', attrs: { latex: 'E = mc^2' } }).run()
  },
  {
    title: '流程图（Draw.io）', description: 'Draw.io 流程图（嵌入编辑器）', icon: '🗺', group: 'advanced',
    searchTerms: ['drawio', 'diagram', 'flow', 'litu', '流程图', '图表'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range)
      .insertContent({ type: 'drawio', attrs: { xml: '', preview: '' } }).run()
  },
  {
    title: '白板', description: 'Excalidraw 手绘白板', icon: '✏', group: 'advanced',
    searchTerms: ['excalidraw', 'baiban', 'whiteboard', 'handdraw', '白板', '手绘'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range)
      .insertContent({ type: 'excalidraw', attrs: { elements: [], appState: {}, files: {}, preview: '' } }).run()
  },
  {
    title: 'AI 续写', description: '让 AI 接着当前段落继续写', icon: '✍️', group: 'ai',
    searchTerms: ['ai', 'continue', 'xuxie', '续写', '生成'],
    command: ({ editor, range }) => aiAction(editor, range, 'continue')
  },
  {
    title: 'AI 总结', description: '让 AI 总结本页要点', icon: '📋', group: 'ai',
    searchTerms: ['ai', 'summary', 'zongjie', '总结', '摘要'],
    command: ({ editor, range }) => aiAction(editor, range, 'summarize')
  }
];

/** Fuzzy subsequence match with a light score (contiguous / prefix bonuses). */
function fuzzyScore(query: string, target: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (t.includes(q)) return t.startsWith(q) ? 1000 : 500 - t.indexOf(q);
  let qi = 0;
  let score = 0;
  let streak = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) { qi++; streak++; score += 1 + streak; }
    else streak = 0;
  }
  return qi === q.length ? score : -1;
}

/** Filter + rank items by a query, then keep them ordered by group. */
export function filterSlashItems(query: string): SlashItem[] {
  const q = query.trim();
  if (!q) return [...ITEMS].sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
  const scored = ITEMS
    .map((item) => {
      const best = Math.max(
        fuzzyScore(q, item.title),
        ...item.searchTerms.map((t) => fuzzyScore(q, t))
      );
      return { item, best };
    })
    .filter((s) => s.best >= 0);
  scored.sort((a, b) => {
    const g = GROUP_ORDER.indexOf(a.item.group) - GROUP_ORDER.indexOf(b.item.group);
    if (g !== 0) return g;
    return b.best - a.best;
  });
  return scored.map((s) => s.item);
}

export interface SlashCommandOptions {
  suggestion: Record<string, unknown>;
  onPickFile: (kind: MediaKind) => void;
  onAiAction: (kind: AiActionKind, range: Range) => void;
}

export const SlashCommand = Extension.create<SlashCommandOptions>({
  name: 'slashCommand',

  addOptions() {
    return {
      suggestion: {
        char: '/',
        startOfLine: false,
        command: ({ editor, range, props }: { editor: Editor; range: Range; props: SlashItem }) => {
          props.command({ editor, range });
        }
      },
      onPickFile: () => {},
      onAiAction: () => {}
    };
  },

  addStorage() {
    return {
      onPickFile: (_k: MediaKind) => {},
      onAiAction: (_k: AiActionKind, _r: Range) => {}
    } as { onPickFile: (k: MediaKind) => void; onAiAction: (k: AiActionKind, r: Range) => void };
  },

  onCreate() {
    this.storage.onPickFile = this.options.onPickFile;
    this.storage.onAiAction = this.options.onAiAction;
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        char: (this.options.suggestion as { char?: string }).char ?? '/',
        startOfLine: (this.options.suggestion as { startOfLine?: boolean }).startOfLine ?? false,
        command: this.options.suggestion.command as SuggestionOptions['command'],
        items: ({ query }: { query: string }) => filterSlashItems(query),
        render: () => {
          let component: ReactRenderer<SlashMenuRef> | null = null;
          let popup: HTMLDivElement | null = null;

          const place = (rect: DOMRect | null | undefined) => {
            if (!popup || !rect) return;
            const maxTop = window.innerHeight - popup.offsetHeight - 12;
            popup.style.top = `${Math.min(rect.bottom + 6, Math.max(12, maxTop))}px`;
            popup.style.left = `${Math.min(rect.left, window.innerWidth - popup.offsetWidth - 12)}px`;
          };

          return {
            onStart: (props: SuggestionProps) => {
              component = new ReactRenderer(SlashMenu, {
                props: { items: props.items, command: (item: SlashItem) => props.command(item) },
                editor: props.editor
              });
              popup = document.createElement('div');
              popup.className = 'slash-popup';
              document.body.appendChild(popup);
              popup.appendChild(component.element);
              place(props.clientRect?.());
            },
            onUpdate: (props: SuggestionProps) => {
              component?.updateProps({ items: props.items, command: (item: SlashItem) => props.command(item) });
              place(props.clientRect?.());
            },
            onKeyDown: (props: { event: KeyboardEvent }) => {
              if (props.event.key === 'Escape') {
                popup?.remove();
                popup = null;
                return true;
              }
              return component?.ref?.onKeyDown(props.event) ?? false;
            },
            onExit: () => {
              popup?.remove();
              popup = null;
              component?.destroy();
              component = null;
            }
          };
        }
      })
    ];
  }
});
