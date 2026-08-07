/**
 * URL classification for paste handling (Phase 4 — task 6).
 *
 * When a user pastes a single URL we decide, without a server round-trip,
 * whether it should become an inline link, an embedded iframe, or a media
 * block (image / video / audio). This keeps paste fast and predictable.
 */
export type UrlKind = 'image' | 'video' | 'audio' | 'embed' | 'link';

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'];
const VIDEO_EXT = ['mp4', 'webm', 'ogg', 'mov', 'm4v'];
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'oga', 'weba'];
const EMBED_HOSTS = [
  'youtube.com', 'youtu.be', 'figma.com', 'bilibili.com', 'b23.tv',
  'vimeo.com', 'notion.so', 'codepen.io', 'slides.com'
];

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function extOf(url: string): string {
  const clean = url.split('?')[0].split('#')[0].toLowerCase();
  const m = clean.match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

export function classifyUrl(raw: string): UrlKind {
  const url = (raw ?? '').trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return 'link';
  const ext = extOf(url);
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (VIDEO_EXT.includes(ext)) return 'video';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  const host = hostOf(url);
  if (EMBED_HOSTS.some((h) => host.includes(h))) return 'embed';
  return 'link';
}

export function isSingleUrl(text: string): boolean {
  if (!text) return false;
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.length === 1 && /^https?:\/\/\S+$/i.test(lines[0].trim());
}
