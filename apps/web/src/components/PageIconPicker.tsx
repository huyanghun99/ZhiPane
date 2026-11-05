import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** Emoji set shared by the editor title icon and the sidebar tree icon. */
export const PAGE_EMOJIS = [
  '📄', '📝', '📋', '📌', '📎', '📁', '📂', '📕', '📗', '📘', '📙', '📓', '📔', '📒',
  '🎯', '💡', '🔥', '⭐', '✅', '❌', '⚠️', '📊', '📈', '📉', '🔢', '🔧', '⚙️', '🔨',
  '🤖', '🧠', '💭', '💬', '🗓️', '⏰', '🕐', '✨', '🎨', '🎵', '🌱', '🌍', '🚀', '🧩'
];

const POP_W = 272;
const POP_H = 236;

/**
 * Page icon picker anchored to the pointer. Rendered with `position: fixed`
 * (not `top: 100%` inside a static parent) so it always opens next to the
 * click instead of falling to the bottom of the page. Used by both
 * PageEditor (title icon) and PageTree (directory icon).
 */
export function PageIconPicker({ anchor, current, onPick, onClose }: {
  anchor: { x: number; y: number };
  current?: string;
  onPick: (icon: string | null) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: anchor.x, top: anchor.y });

  useLayoutEffect(() => {
    const left = Math.min(anchor.x, window.innerWidth - POP_W - 8);
    const top = Math.min(anchor.y, window.innerHeight - POP_H - 8);
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [anchor.x, anchor.y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="page-icon-pop"
      style={{ position: 'fixed', left: pos.left, top: pos.top }}
      contentEditable={false}
    >
      {PAGE_EMOJIS.map((e) => (
        <button
          key={e}
          className={`emoji-item${current === e ? ' active' : ''}`}
          title={e}
          onClick={() => onPick(e)}
        >
          {e}
        </button>
      ))}
      <button className="emoji-item emoji-clear" title="清除图标" onClick={() => onPick(null)}>✕</button>
    </div>
  );
}
