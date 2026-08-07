import { useCallback, useRef, useState, useEffect } from 'react';
import { EditorContent, useEditor, type Editor, ReactNodeViewRenderer } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import TextStyle from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import Highlight from '@tiptap/extension-highlight';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import type { PMNode } from './prosemirror';
import { emptyDoc, extractText } from './prosemirror';
import { SlashCommand, type MediaKind } from './slash-command';
import { EditorKeymap } from './editor-keymap';
import { AiPopover, type AiRequest } from './AiPopover';
import { AI_ACTIONS, type AiActionKind } from './ai-actions';
import { Mermaid } from './Mermaid';
import { Video, Audio, Pdf, FileCard } from './Media';
import { Callout } from './Callout';
import { Toggle } from './Toggle';
import { MathBlock, MathInline } from './Math';
import { Embed } from './Embed';
import { Drawio } from './Drawio';
import { Excalidraw } from './Excalidraw';
import { MarkdownShortcuts } from './MarkdownShortcuts';
import { BubbleMenu } from './BubbleMenu';
import { EditorToolbar } from './EditorToolbar';
import { ImageView } from './ImageView';
import { BlockHandle } from './BlockHandle';
import { useUploads, inferKind } from './useUploads';
import { UploadOverlay } from './UploadOverlay';
import { classifyUrl, isSingleUrl } from './url';
import { useToast } from '../components/Toast';

type RichEditorProps = {
  content: PMNode;
  editable?: boolean;
  workspaceId?: string;
  spaceId?: string;
  pageId?: string | null;
  onChange?: (payload: { contentJson: PMNode; textContent: string }) => void;
  onSave?: () => void;
};

/** Split plain AI output into paragraph nodes for insertion. */
function textToParagraphs(text: string) {
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => ({
      type: 'paragraph',
      content: block ? [{ type: 'text', text: block }] : []
    }));
}

export function RichEditor({ content, editable = true, workspaceId, spaceId, pageId, onChange, onSave }: RichEditorProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const [pendingKind, setPendingKind] = useState<MediaKind>('image');
  const [aiReq, setAiReq] = useState<AiRequest | null>(null);
  const toast = useToast();

  // Distinguishes edits we emitted (local) from external `content` changes so
  // the sync effect never clobbers in-progress typing (replaces the old
  // full-document JSON.stringify comparison).
  const lastJsonRef = useRef<string>('');
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  // Open the streaming AI popover for a selection or block.
  const openAi = useCallback((kind: AiActionKind, sourceText: string, anchor: { top: number; left: number }, range: { from: number; to: number } | null) => {
    const ed = editorRef.current;
    if (!ed) return;
    const insertAt = range ? range.to : ed.state.selection.to;
    setAiReq({
      kind,
      sourceText,
      anchor,
      onReplace: range && AI_ACTIONS[kind].canReplace
        ? (t) => ed.chain().focus().insertContentAt({ from: range.from, to: range.to }, t).run()
        : undefined,
      onInsert: (t) => {
        const nodes = textToParagraphs(t);
        ed.chain().focus().insertContentAt(insertAt, nodes.length ? nodes : t).run();
      }
    });
  }, []);

  const uploads = useUploads({
    getEditor: () => editorRef.current,
    workspaceId,
    spaceId,
    pageId: pageId ?? undefined,
    onError: (m) => toast.error(m)
  });
  const uploadsRef = useRef(uploads);
  uploadsRef.current = uploads;

  const openFilePicker = (kind: MediaKind) => {
    setPendingKind(kind);
    if (fileRef.current) {
      fileRef.current.accept =
        kind === 'image' ? 'image/*'
          : kind === 'video' ? 'video/*'
          : kind === 'audio' ? 'audio/*'
          : kind === 'pdf' ? 'application/pdf'
          : '*';
      fileRef.current.value = '';
      fileRef.current.click();
    }
  };

  const insertByUrl = (kind: ReturnType<typeof classifyUrl>, url: string) => {
    const ed = editorRef.current;
    if (!ed) return;
    if (kind === 'image') {
      ed.chain().focus().setImage({ src: url, alt: '' }).run();
    } else if (kind === 'video') {
      ed.chain().focus().insertContent({ type: 'video', attrs: { src: url, fileName: url, mimeType: '', size: null } }).run();
    } else if (kind === 'audio') {
      ed.chain().focus().insertContent({ type: 'audio', attrs: { src: url, fileName: url, mimeType: '', size: null } }).run();
    } else if (kind === 'embed') {
      ed.chain().focus().insertContent({ type: 'embed', attrs: { url } }).run();
    } else {
      ed.chain().focus().insertContent([
        { type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] }
      ]).run();
    }
  };

  const editor = useEditor({
    editable,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Placeholder.configure({
        placeholder: '输入 “/” 唤起命令菜单，可插入标题、表格、流程图、图片等；支持 Markdown 快捷输入（#、>、-、1.、```）'
      }),
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      Underline,
      Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' } }),
      Image.extend({
      addAttributes() {
        return {
          ...this.parent?.(),
          width: { default: null, parseHTML: (el) => { const w = el.getAttribute('width') || el.style.width; return w ? parseInt(String(w).replace('px', '')) || null : null; }, renderHTML: (attrs) => attrs.width ? { width: attrs.width, style: `width: ${attrs.width}px` } : {} },
          align: { default: 'left', parseHTML: (el) => { const p = el.parentElement?.style.textAlign; return p === 'center' ? 'center' : p === 'right' ? 'right' : 'left'; }, renderHTML: () => ({}) }
        };
      },
      addNodeView() {
        return ReactNodeViewRenderer(ImageView);
      }
    }).configure({ inline: false, allowBase64: false }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      Mermaid,
      Video,
      Audio,
      Pdf,
      FileCard,
      Callout,
      Toggle,
      MathBlock,
      MathInline,
      Embed,
      Drawio,
      Excalidraw,
      SlashCommand.configure({
        onPickFile: (kind) => openFilePicker(kind),
        onAiAction: (kind, range) => {
          const ed = editorRef.current;
          if (!ed) return;
          const fullText = extractText(ed.getJSON() as PMNode).trim();
          let rect: { top: number; left: number } = { top: window.innerHeight / 2, left: window.innerWidth / 2 };
          try { const c = ed.view.coordsAtPos(range.from); rect = { top: c.bottom, left: c.left }; } catch { /* fall back to center */ }
          ed.chain().focus().deleteRange(range).run();
          const insertAt = ed.state.selection.to;
          setAiReq({
            kind,
            sourceText: fullText,
            anchor: rect,
            onInsert: (t) => {
              const nodes = textToParagraphs(t);
              ed.chain().focus().insertContentAt(insertAt, nodes.length ? nodes : t).run();
            }
          });
        }
      }),
      MarkdownShortcuts,
      EditorKeymap.configure({
        onSave: () => onSaveRef.current?.(),
        onLink: () => (editorRef.current?.view.dom as HTMLElement | undefined)?.dispatchEvent(new CustomEvent('zhipane:edit-link'))
      })
    ],
    content: content ?? emptyDoc,
    editorProps: {
      attributes: { class: 'prosemirror-host' },
      handlePaste: (_view, event) => {
        const cdata = (event as ClipboardEvent).clipboardData;
        const files = Array.from(cdata?.files ?? []);
        if (files.length) {
          files.forEach((f) => uploadsRef.current.start(f));
          return true;
        }
        const text = (cdata?.getData('text/plain') ?? '').trim();
        if (isSingleUrl(text)) {
          insertByUrl(classifyUrl(text), text);
          return true;
        }
        return false;
      },
      handleDrop: (_view, event) => {
        const files = Array.from(((event as DragEvent).dataTransfer?.files ?? []));
        if (files.length === 0) return false;
        event.preventDefault();
        files.forEach((f) => uploadsRef.current.start(f, inferKind(f)));
        return true;
      }
    },
    onCreate: ({ editor: ed }) => {
      lastJsonRef.current = JSON.stringify(ed.getJSON());
    },
    onUpdate: ({ editor: ed }) => {
      const json = ed.getJSON() as PMNode;
      lastJsonRef.current = JSON.stringify(json);
      onChange?.({ contentJson: json, textContent: extractText(json) });
    }
  });

  editorRef.current = editor;

  // Sync when the external `content` prop changes (page switch, fresh server
  // data, draft/conflict resolution). We compare against the JSON we last
  // emitted (lastJsonRef): if the incoming content equals our own edit echoed
  // back, we skip; otherwise it is a genuine external update and we apply it
  // while restoring the cursor position where possible.
  useEffect(() => {
    if (!editor) return;
    const target = (content ?? emptyDoc) as PMNode;
    const targetStr = JSON.stringify(target);
    if (targetStr === lastJsonRef.current) return;
    const { from, to } = editor.state.selection;
    editor.commands.setContent(target, false);
    lastJsonRef.current = targetStr;
    const size = editor.state.doc.content.size;
    try {
      editor.commands.setTextSelection({ from: Math.min(from, size), to: Math.min(to, size) });
    } catch {
      /* selection out of range after external replace — leave default */
    }
  }, [content, editor]);

  if (!editor) return <div className="editor-loading">编辑器加载中…</div>;

  return (
    <div className="rich-editor">
      <EditorToolbar editor={editor} />
      <EditorContent editor={editor} className="editor-content" />

      <BubbleMenu
        editor={editor}
        onAi={workspaceId && spaceId ? (kind, text, anchor) => {
          const { from, to } = editor.state.selection;
          openAi(kind, text, anchor, { from, to });
        } : undefined}
      />
      <BlockHandle editor={editor} />

      {aiReq && workspaceId && spaceId && (
        <AiPopover
          request={aiReq}
          workspaceId={workspaceId}
          spaceId={spaceId}
          pageId={pageId ?? undefined}
          onClose={() => setAiReq(null)}
        />
      )}

      <UploadOverlay
        items={uploads.items}
        onCancel={uploads.cancel}
        onRetry={uploads.retry}
        onDismiss={uploads.cancel}
      />

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files && e.target.files[0];
          if (f) uploadsRef.current.start(f, pendingKind);
          e.target.value = '';
        }}
      />
    </div>
  );
}
