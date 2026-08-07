import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { GROUP_LABELS, type SlashGroup, type SlashItem } from './slash-command';

export interface SlashMenuRef {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

export const SlashMenu = forwardRef<SlashMenuRef, { items: SlashItem[]; command: (item: SlashItem) => void }>(
  ({ items, command }, ref) => {
    const [selected, setSelected] = useState(0);
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => setSelected(0), [items]);

    // Keep the highlighted row within the scroll viewport.
    useEffect(() => {
      const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${selected}"]`);
      el?.scrollIntoView({ block: 'nearest' });
    }, [selected]);

    useImperativeHandle(ref, () => ({
      onKeyDown: (event: KeyboardEvent) => {
        if (items.length === 0) return false;
        if (event.key === 'ArrowUp') {
          setSelected((s) => (s + items.length - 1) % items.length);
          return true;
        }
        if (event.key === 'ArrowDown') {
          setSelected((s) => (s + 1) % items.length);
          return true;
        }
        if (event.key === 'Enter') {
          if (items[selected]) command(items[selected]);
          return true;
        }
        return false;
      }
    }));

    if (items.length === 0) {
      return <div className="slash-menu"><div className="slash-empty">无匹配命令</div></div>;
    }

    let lastGroup: SlashGroup | null = null;

    return (
      <div className="slash-menu" ref={listRef}>
        {items.map((item, i) => {
          const showHeader = item.group !== lastGroup;
          lastGroup = item.group;
          return (
            <div key={`${item.group}:${item.title}`}>
              {showHeader && <div className="slash-group">{GROUP_LABELS[item.group]}</div>}
              <button
                type="button"
                data-idx={i}
                className={`slash-item${i === selected ? ' active' : ''}`}
                onMouseEnter={() => setSelected(i)}
                onMouseDown={(e) => { e.preventDefault(); command(item); }}
              >
                <span className="slash-icon">{item.icon}</span>
                <span className="slash-text">
                  <b>{item.title}</b>
                  <small>{item.description}</small>
                </span>
              </button>
            </div>
          );
        })}
      </div>
    );
  }
);

SlashMenu.displayName = 'SlashMenu';
