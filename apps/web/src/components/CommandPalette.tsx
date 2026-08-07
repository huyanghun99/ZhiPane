import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Brain, CornerDownLeft, FileText, Home, LayoutGrid, PenLine, Search, Wand2
} from 'lucide-react';
import { pinyin } from 'pinyin-pro';
import { api } from '../api';
import type { MainRoute, TreeNode } from '../types';

function flatten(tree: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (nodes: TreeNode[]) => { for (const n of nodes) { out.push(n); walk(n.children); } };
  walk(tree);
  return out;
}

type ContentHit = { id: string; pageId?: string; title: string; excerpt?: string; snippet?: string };

type Item =
  | { kind: 'page'; id: string; title: string; subtitle?: string }
  | { kind: 'command'; id: string; title: string; icon: React.ReactNode; run: () => void }
  | { kind: 'search'; id: string; title: string };

/**
 * Command Palette (Phase 3) — the unified "search or run a command" surface,
 * opened with ⌘/Ctrl+K. Ties notes, organize, search and ask together so they
 * feel like one product rather than separate screens.
 *
 * Phase C2.3 (U9): matching is no longer limited to exact title `includes`.
 * Titles are also indexed by pinyin (full + initials) so e.g. "wd" / "wendang"
 * matches "文档"; and when a workspace is present we also run a workspace-wide
 * keyword content search (`/api/search?mode=keyword`) so users can jump straight
 * to a page from its body text.
 */
export function CommandPalette({
  open, onClose, tree, onSelectPage, onNavigate, onNewNote, onRunSearch, workspaceId, spaceId
}: {
  open: boolean;
  onClose: () => void;
  tree: TreeNode[];
  onSelectPage: (id: string) => void;
  onNavigate: (r: MainRoute) => void;
  onNewNote: () => void;
  onRunSearch: (q: string) => void;
  workspaceId: string;
  spaceId?: string | null;
}) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [contentHits, setContentHits] = useState<ContentHit[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) { setQ(''); setActive(0); setContentHits([]); setTimeout(() => inputRef.current?.focus(), 20); }
  }, [open]);

  const flat = useMemo(() => flatten(tree), [tree]);

  // Phase C2.3 (U9): precompute pinyin (full + initials) for every page title so
  // we can fuzzy-match romanized / initial queries against Chinese titles.
  const pinyinIndex = useMemo(() => {
    const map = new Map<string, { full: string; initials: string }>();
    for (const n of flat) {
      const t = n.title || '';
      if (!t) continue;
      try {
        const arr = pinyin(t, { toneType: 'none', type: 'array' }) as string[];
        map.set(n.id, { full: arr.join(''), initials: arr.map((s) => s[0] ?? '').join('') });
      } catch {
        /* ignore — fall back to plain title match */
      }
    }
    return map;
  }, [flat]);

  // Phase C2.3 (U9): workspace-wide keyword content search, debounced + aborted
  // on each keystroke so only the latest query resolves.
  useEffect(() => {
    const query = q.trim();
    if (!query || !workspaceId) { setContentHits([]); return; }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      api<{ results: ContentHit[] }>('/api/search', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId,
          ...(spaceId ? { spaceId } : {}),
          query,
          limit: 6,
          mode: 'keyword'
        }),
        signal: ctrl.signal
      })
        .then((res) => { if (!ctrl.signal.aborted) setContentHits(res.results ?? []); })
        .catch((e: Error) => { if (e.name !== 'AbortError') setContentHits([]); });
    }, 300);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [q, workspaceId, spaceId]);

  const commands = useMemo<Item[]>(() => [
    { kind: 'command', id: 'new', title: '新建笔记', icon: <PenLine size={15} />, run: onNewNote },
    { kind: 'command', id: 'home', title: '前往首页', icon: <Home size={15} />, run: () => onNavigate('home') },
    { kind: 'command', id: 'organize', title: '前往智能整理', icon: <Wand2 size={15} />, run: () => onNavigate('organize') },
    { kind: 'command', id: 'ask', title: '前往知识问答', icon: <Brain size={15} />, run: () => onNavigate('ask') },
    { kind: 'command', id: 'map', title: '前往关系图', icon: <LayoutGrid size={15} />, run: () => onNavigate('map') }
  ], [onNavigate, onNewNote]);

  const sections = useMemo<{ label?: string; items: Item[] }[]>(() => {
    const query = q.trim().toLowerCase();
    if (!query) return [{ items: commands }];

    const pageHits: Item[] = flat
      .filter((n) => {
        const title = (n.title || '').toLowerCase();
        if (title.includes(query)) return true;
        const py = pinyinIndex.get(n.id);
        return !!py && (py.full.includes(query) || py.initials.includes(query));
      })
      .slice(0, 8)
      .map((n) => ({ kind: 'page', id: n.id, title: n.title || '未命名笔记' }));

    const contentHitsItems: Item[] = contentHits.map((h) => ({
      kind: 'page',
      id: h.pageId ?? h.id,
      title: h.title || '未命名笔记',
      subtitle: (h.excerpt || h.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 90)
    }));

    const cmdHits = commands.filter((c) => c.title.toLowerCase().includes(query));

    const out: { label?: string; items: Item[] }[] = [];
    if (pageHits.length) out.push({ label: '标题匹配', items: pageHits });
    if (contentHitsItems.length) out.push({ label: '内容匹配', items: contentHitsItems });
    if (cmdHits.length) out.push({ label: '命令', items: cmdHits });
    out.push({ items: [{ kind: 'search', id: 'search', title: `在全部笔记中搜索「${q.trim()}」` }] });
    return out;
  }, [q, flat, pinyinIndex, contentHits, commands]);

  const flatItems = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  useEffect(() => { setActive(0); }, [q]);

  if (!open) return null;

  const choose = (item: Item) => {
    if (item.kind === 'page') onSelectPage(item.id);
    else if (item.kind === 'command') item.run();
    else onRunSearch(q.trim());
    onClose();
  };

  return (
    <div className="cmdk-backdrop" onClick={onClose}>
      <div className="cmdk" onClick={(e) => e.stopPropagation()}>
        <div className="cmdk-input">
          <Search size={17} />
          <input
            ref={inputRef}
            value={q}
            placeholder="搜索笔记（支持拼音/内容），或输入命令…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, flatItems.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
              else if (e.key === 'Enter') { e.preventDefault(); if (flatItems[active]) choose(flatItems[active]); }
              else if (e.key === 'Escape') onClose();
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="cmdk-list">
          {flatItems.length === 0 && <div className="cmdk-empty">没有匹配项</div>}
          {sections.map((sec, si) => (
            <div key={si} className="cmdk-section">
              {sec.label && <div className="cmdk-section-label">{sec.label}</div>}
              {sec.items.map((item) => {
                const i = flatItems.indexOf(item);
                return (
                  <button
                    key={`${item.kind}-${item.id}`}
                    className={`cmdk-item${i === active ? ' active' : ''}`}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => choose(item)}
                  >
                    <span className="cmdk-item-icon">
                      {item.kind === 'page' ? <FileText size={15} />
                        : item.kind === 'search' ? <Search size={15} />
                        : (item as { icon: React.ReactNode }).icon}
                    </span>
                    <span className="cmdk-item-body">
                      <span className="cmdk-item-title">{item.title}</span>
                      {item.kind === 'page' && item.subtitle && (
                        <span className="cmdk-item-sub">{item.subtitle}</span>
                      )}
                    </span>
                    {i === active && <CornerDownLeft size={13} className="cmdk-enter" />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
