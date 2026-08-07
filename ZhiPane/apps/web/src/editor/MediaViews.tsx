import { type NodeViewProps } from '@tiptap/react';
import { Download } from 'lucide-react';
import { BlockFrame } from './BlockFrame';

const KIND_LABEL: Record<string, string> = {
  video: '视频', audio: '音频', pdf: 'PDF', file: '文件'
};

function MediaFrame({ kind, title: _title, src, onRemove, children }: {
  kind: string; title: string; src: string; onRemove: () => void; children: React.ReactNode;
}) {
  const actions = (
    <a
      className="ml-block-action"
      href={src}
      target="_blank"
      rel="noopener noreferrer"
      download
      onMouseDown={(e) => e.stopPropagation()}
    >
      <Download size={13} /> 下载
    </a>
  );
  return (
    <BlockFrame label={KIND_LABEL[kind] ?? '文件'} kind={kind} onDelete={onRemove} actions={actions}>
      {children}
    </BlockFrame>
  );
}

export function VideoView({ node, deleteNode }: NodeViewProps) {
  const src = node.attrs.src as string;
  const fileName = (node.attrs.fileName as string) || '视频';
  return (
    <MediaFrame kind="video" title={fileName} src={src} onRemove={() => deleteNode()}>
      <video className="media-video" src={src} controls preload="metadata" />
    </MediaFrame>
  );
}

export function AudioView({ node, deleteNode }: NodeViewProps) {
  const src = node.attrs.src as string;
  const fileName = (node.attrs.fileName as string) || '音频';
  return (
    <MediaFrame kind="audio" title={fileName} src={src} onRemove={() => deleteNode()}>
      <audio className="media-audio" src={src} controls preload="metadata" />
    </MediaFrame>
  );
}

export function PdfView({ node, deleteNode }: NodeViewProps) {
  const src = node.attrs.src as string;
  const fileName = (node.attrs.fileName as string) || 'PDF';
  const size = node.attrs.size as number | undefined;
  return (
    <MediaFrame kind="pdf" title={fileName} src={src} onRemove={() => deleteNode()}>
      <div className="pdf-preview">
        <iframe className="pdf-frame" src={src} title={fileName} />
        <span className="muted small">{size != null ? `${(size / 1024 / 1024).toFixed(1)} MB` : ''}</span>
      </div>
    </MediaFrame>
  );
}

export function FileCardView({ node, deleteNode }: NodeViewProps) {
  const src = node.attrs.src as string;
  const fileName = (node.attrs.fileName as string) || '文件';
  const size = node.attrs.size as number | undefined;
  const mime = (node.attrs.mimeType as string) || '';
  return (
    <MediaFrame kind="file" title={fileName} src={src} onRemove={() => deleteNode()}>
      <div className="file-card">
        <div className="file-meta">
          <span className="file-mime">{mime || '未知类型'}</span>
          {size != null && <span className="muted small">{size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`}</span>}
        </div>
      </div>
    </MediaFrame>
  );
}
