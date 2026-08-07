import { ReactNodeViewRenderer } from '@tiptap/react';
import { createZhipaneBlock } from './blockContract';
import { VideoView, AudioView, PdfView, FileCardView } from './MediaViews';

function mediaNode(name: string, kind: 'video' | 'audio' | 'pdf' | 'file', View: typeof VideoView) {
  return createZhipaneBlock({
    name,
    dataType: kind,
    addAttributes: () => ({
      src: { default: '' },
      attachmentId: { default: null },
      fileName: { default: '' },
      mimeType: { default: '' },
      size: { default: null }
    }),
    addNodeView: () => ReactNodeViewRenderer(View)
  });
}

export const Video = mediaNode('video', 'video', VideoView);
export const Audio = mediaNode('audio', 'audio', AudioView);
export const Pdf = mediaNode('pdf', 'pdf', PdfView);
export const FileCard = mediaNode('file', 'file', FileCardView);
