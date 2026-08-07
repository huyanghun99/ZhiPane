import { useCallback, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import type { MediaKind } from './slash-command';

export type UploadStatus = 'uploading' | 'error' | 'done';
export type UploadItem = {
  id: string;
  fileName: string;
  kind: MediaKind;
  progress: number;
  status: UploadStatus;
  error?: string;
  file: File;
};

interface UseUploadsOpts {
  getEditor: () => Editor | null;
  workspaceId?: string;
  spaceId?: string;
  pageId?: string;
  onInserted?: () => void;
  onError?: (msg: string) => void;
}

function uid(): string {
  return 'up-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Upload manager (Phase4 — task 7).
 *
 * - Uses XHR (not fetch) so we get real `upload.onprogress` for a live
 *   progress bar.
 * - Exposes `cancel(id)` (xhr.abort) and `retry(id)` so a failed
 *   upload is recoverable instead of silently lost.
 * - On success the node is inserted into the editor; the in-flight entry is
 *   removed shortly after, so a failed upload never touches the document.
 */
export function useUploads(opts: UseUploadsOpts) {
  const { getEditor, workspaceId, spaceId, pageId, onInserted, onError } = opts;
  const [items, setItems] = useState<UploadItem[]>([]);
  const xhrMap = useRef<Map<string, XMLHttpRequest>>(new Map());

  const patch = useCallback((id: string, p: Partial<UploadItem>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...p } : it)));
  }, []);

  const remove = useCallback((id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
    xhrMap.current.delete(id);
  }, []);

  const insert = useCallback(
    (kind: MediaKind, attachment: { id: string; fileName: string; mimeType: string; sizeBytes: number }) => {
      const ed = getEditor();
      if (!ed) return;
      const src = `/api/attachments/${attachment.id}/download`;
      if (kind === 'image') {
        ed.chain().focus().setImage({ src, alt: attachment.fileName }).run();
      } else {
        ed.chain().focus().insertContent({
          type: kind,
          attrs: {
            src,
            attachmentId: attachment.id,
            fileName: attachment.fileName,
            mimeType: attachment.mimeType,
            size: attachment.sizeBytes
          }
        }).run();
      }
      onInserted?.();
    },
    [getEditor, onInserted]
  );

  const run = useCallback(
    (item: UploadItem) => {
      if (!workspaceId || !spaceId || !pageId) {
        const msg = '请先保存页面，再插入附件。';
        patch(item.id, { status: 'error', error: msg });
        onError?.(msg);
        return;
      }
      const { file, kind, id } = item;
      patch(id, { status: 'uploading', progress: 0, error: undefined });

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/attachments/upload');
      xhr.withCredentials = true;
      xhr.upload.onprogress = (e: ProgressEvent) => {
        if (e.lengthComputable) {
          patch(id, { progress: Math.round((e.loaded / e.total) * 100) });
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          let attachment: { id: string; fileName: string; mimeType: string; sizeBytes: number } | undefined;
          try {
            attachment = JSON.parse(xhr.responseText)?.attachment;
          } catch {
            attachment = undefined;
          }
          if (attachment) {
            insert(kind, attachment);
            patch(id, { status: 'done', progress: 100 });
            window.setTimeout(() => remove(id), 1400);
          } else {
            patch(id, { status: 'error', error: '上传失败：服务器无返回' });
          }
        } else {
          let msg = '上传失败';
          try {
            msg = JSON.parse(xhr.responseText)?.error ?? msg;
          } catch {
            /* keep default */
          }
          patch(id, { status: 'error', error: msg });
        }
      };
      xhr.onerror = () => patch(id, { status: 'error', error: '网络错误，请重试' });
      xhr.onabort = () => remove(id);

      const form = new FormData();
      form.append('file', file);
      form.append('pageId', pageId);
      xhr.send(form);
      xhrMap.current.set(id, xhr);
    },
    [workspaceId, spaceId, pageId, patch, insert, remove, onError]
  );

  const start = useCallback(
    (file: File, kind?: MediaKind) => {
      const resolved: MediaKind = kind ?? inferKind(file);
      const id = uid();
      const item: UploadItem = {
        id,
        fileName: file.name || '未命名文件',
        kind: resolved,
        progress: 0,
        status: 'uploading',
        file
      };
      setItems((prev) => [...prev, item]);
      run(item);
    },
    [run]
  );

  const cancel = useCallback(
    (id: string) => {
      xhrMap.current.get(id)?.abort();
    },
    []
  );

  const retry = useCallback(
    (id: string) => {
      const it = items.find((x) => x.id === id);
      if (it) run(it);
    },
    [items, run]
  );

  return { items, start, cancel, retry };
}

export function inferKind(file: File): MediaKind {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  if (file.type === 'application/pdf') return 'pdf';
  return 'file';
}
