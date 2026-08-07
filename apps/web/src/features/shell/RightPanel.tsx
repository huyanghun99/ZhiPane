import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Brain, Check, Link2, ListTree, Loader2, PanelRightClose, RefreshCw, Send, Tag as TagIcon, X } from 'lucide-react';
import { api, post, streamRag, getAiProfile, getPageSuggestions, undoSuggestion, updatePageTags } from '../../api';
import { setPendingScroll } from '../../editor/scrollTo';
import type { AiProfile } from '@zhipane/shared';
import { type PMNode } from '../../editor/prosemirror';
import { extractOutline, type OutlineItem } from '../notes/outline';
import { EmptyState } from '../../components/EmptyState';
import { SkeletonList } from '../../components/Skeleton';
import { useToast } from '../../components/Toast';
import { SuggestionCard, SuggestionAccepted, suggestionTitle, HighRiskModal } from '../wiki/SuggestionCard';
import type { PageDetail, Space, Workspace, WikiSuggestion } from '../../types';

type Tab = 'summary' | 'tags' | 'related' | 'outline';

function scrollToHeading(outline: OutlineItem[], index: number) {
  const id = outline[index]?.id;
  const el = (id ? document.getElementById(id) : null)
    ?? (document.querySelectorAll('.editor-content h1, .editor-content h2, .editor-content h3, .editor-content h4, .editor-content h5, .editor-content h6')[index] as HTMLElement | undefined);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Phase C2.5 (U12): give each rendered heading a stable id so outline clicks
// jump by id (duplicate titles no longer collide on positional matching).
const HEADING_SEL = '.editor-content h1, .editor-content h2, .editor-content h3, .editor-content h4, .editor-content h5, .editor-content h6';
function syncHeadingIds(outline: OutlineItem[]) {
  const headings = Array.from(document.querySelectorAll(HEADING_SEL)) as HTMLElement[];
  headings.forEach((h, i) => { if (outline[i]) h.id = outline[i].id; });
}

export function RightPanel({ workspace, space, pageId, onOpenPage, onClose }: {
  workspace: Workspace;
  space: Space;
  pageId: string;
  onOpenPage: (id: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>('outline');

  const { data } = useQuery<{ page: PageDetail }>({
    queryKey: ['page-detail', pageId],
    staleTime: 0,
    queryFn: () => api(`/api/pages/${pageId}`)
  });
  const page = data?.page ?? null;

  const outline = useMemo(() => extractOutline(page?.contentJson as PMNode | undefined), [page?.contentJson]);

  // Scroll-spy: highlight the heading currently in view so the outline tracks reading position.
  const [activeIdx, setActiveIdx] = useState(-1);
  const visibleRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (tab !== 'outline' || outline.length === 0) return;
    const root = document.querySelector('.center') as HTMLElement | null;
    const headings = Array.from(
      document.querySelectorAll('.editor-content h1, .editor-content h2, .editor-content h3, .editor-content h4, .editor-content h5, .editor-content h6')
    ) as HTMLElement[];
    if (headings.length === 0) return;
    visibleRef.current.clear();
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const idx = headings.indexOf(e.target as HTMLElement);
          if (idx < 0) continue;
          if (e.isIntersecting) visibleRef.current.add(idx);
          else visibleRef.current.delete(idx);
        }
        if (visibleRef.current.size > 0) setActiveIdx(Math.min(...Array.from(visibleRef.current)));
      },
      { root: root ?? null, rootMargin: '0px 0px -65% 0px', threshold: [0, 1] }
    );
    headings.forEach((h) => obs.observe(h));
    return () => obs.disconnect();
  }, [tab, outline, pageId]);

  // Phase C2.5 (U12): stamp stable ids onto rendered headings whenever the
  // outline (or page) changes, so outline clicks can scroll by id.
  useLayoutEffect(() => {
    if (tab !== 'outline') return;
    syncHeadingIds(outline);
  }, [tab, outline, pageId]);

  const TABS: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: 'summary', label: 'AI 摘要', icon: <Brain size={15} /> },
    { key: 'tags', label: '标签', icon: <TagIcon size={15} /> },
    { key: 'related', label: '相关页面', icon: <Link2 size={15} /> },
    { key: 'outline', label: '大纲', icon: <ListTree size={15} /> }
  ];

  return (
    <aside className="right-panel">
      <div className="rp-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`rp-tab${tab === t.key ? ' active' : ''}`} title={t.label} onClick={() => setTab(t.key)}>
            {t.icon}<span>{t.label}</span>
          </button>
        ))}
        <div className="spacer" />
        <button className="icon-btn" title="收起面板" onClick={onClose}><PanelRightClose size={16} /></button>
      </div>

      <div className="rp-body">
        {tab === 'summary' && (
          <SummaryTab workspace={workspace} space={space} pageId={pageId} onOpenPage={onOpenPage} />
        )}
        {tab === 'tags' && <TagsTab pageId={pageId} />}
        {tab === 'related' && <RelatedTab pageId={pageId} onOpenPage={onOpenPage} />}
        {tab === 'outline' && (
          outline.length === 0
            ? <EmptyState icon={<ListTree size={28} />} title="暂无大纲" hint="在正文中添加标题，这里会自动生成目录。" />
            : (
              <div className="rp-outline">
                {outline.map((h) => (
                  <button
                    key={h.id}
                    className={`rp-outline-item lvl-${h.level}${h.index === activeIdx ? ' active' : ''}`}
                    onClick={() => { setActiveIdx(h.index); scrollToHeading(outline, h.index); }}
                  >
                    {h.text}
                  </button>
                ))}
              </div>
            )
        )}
      </div>
    </aside>
  );
}

/* ----------------------------------------------------------- summary tab --- */
type Citation = { title?: string; pageId?: string; chunkId?: string; excerpt?: string; score?: number };

function renderAnswer(text: string, sources: Citation[], onClick: (c: Citation) => void) {
  const parts = text.split(/(\[\d+\])/g);
  return parts.map((part, i) => {
    const m = part.match(/^\[(\d+)\]$/);
    if (m) {
      const c = sources[Number(m[1]) - 1];
      return (
        <button key={i} className="cite-badge" title={c?.title ?? `引用 ${m[1]}`} onClick={() => c && onClick(c)}>
          {m[1]}
        </button>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

function SummaryTab({ workspace, space, pageId, onOpenPage }: {
  workspace: Workspace; space: Space; pageId: string; onOpenPage: (id: string) => void;
}) {
  const toast = useToast();

  const { data: profData, isLoading: profLoading, refetch: refetchProf } = useQuery<{ profile: AiProfile | null }>({
    queryKey: ['ai-profile', pageId], queryFn: () => getAiProfile(pageId)
  });
  const profile = profData?.profile ?? null;

  const regen = useMutation({
    mutationFn: () => post(`/api/llm-wiki/pages/${pageId}/process-now`, {}),
    onSuccess: () => { toast.success('已重新生成摘要'); refetchProf(); },
    onError: (e) => toast.error(`生成失败：${(e as Error).message}`)
  });

  // 本页建议（风险分级交互）
  const { data: suggData, refetch: refetchSugg } = useQuery<{ suggestions: WikiSuggestion[] }>({
    queryKey: ['page-suggestions', pageId], queryFn: () => getPageSuggestions(pageId)
  });
  const suggestions = suggData?.suggestions ?? [];
  const [recentlyAccepted, setRecentlyAccepted] = useState<{ id: string; label: string }[]>([]);
  const [highSugg, setHighSugg] = useState<WikiSuggestion | null>(null);

  // Phase C1 (U7): make the auto-apply of low-risk (tag) suggestions a
  // user-controllable, persisted preference instead of an always-on side effect
  // (previously a bare useEffect with no opt-out). Default on to preserve prior
  // behaviour; the explicit "批量接受低风险" button remains for manual control.
  const [autoApplyLow, setAutoApplyLow] = useState<boolean>(() => {
    try { return localStorage.getItem('ml.autoApplyLowRiskTags') !== '0'; } catch { return true; }
  });
  const toggleAutoApply = () => {
    const next = !autoApplyLow;
    setAutoApplyLow(next);
    try { localStorage.setItem('ml.autoApplyLowRiskTags', next ? '1' : '0'); } catch { /* ignore */ }
  };

  const accept = useMutation({
    mutationFn: (id: string) => post(`/api/llm-wiki/suggestions/${id}/accept`, {}),
    onSuccess: (_r, id) => {
      refetchSugg();
      const s = suggestions.find((x) => x.id === id);
      if (s) setRecentlyAccepted((p) => [...p, { id, label: suggestionTitle(s).title }]);
    }
  });
  const ignore = useMutation({
    mutationFn: (id: string) => post(`/api/llm-wiki/suggestions/${id}/ignore`, {}),
    onSuccess: () => refetchSugg()
  });
  const undo = useMutation({
    mutationFn: (id: string) => undoSuggestion(id),
    onSuccess: (_r, id) => {
      setRecentlyAccepted((p) => p.filter((x) => x.id !== id));
      refetchSugg();
    }
  });

  // Low-risk (tag) suggestions are applied automatically when the user's
  // preference is on, but transparently: each one fires a toast so the user
  // always knows what changed. Gated by the persisted `autoApplyLow` toggle.
  const autoHandled = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!autoApplyLow) return;
    for (const s of suggestions) {
      if (s.risk === 'low' && !autoHandled.current.has(s.id)) {
        autoHandled.current.add(s.id);
        const label = (s.payload as { topicTitle?: string; targetPageTitle?: string })?.topicTitle
          ?? (s.payload as { targetPageTitle?: string })?.targetPageTitle
          ?? (s.type === 'topic_proposal' ? '新主题' : '关联');
        accept.mutate(s.id);
        toast.info(`已自动添加标签：${label}`);
      }
    }
  }, [suggestions, accept, toast, autoApplyLow]);

  // 问当前页面（流式 SSE）
  const [q, setQ] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [sources, setSources] = useState<Citation[]>([]);
  const [answer, setAnswer] = useState('');
  const [streamErr, setStreamErr] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const openChunk = (c: Citation) => {
    if (!c.pageId) return;
    if (c.excerpt) setPendingScroll(c.excerpt);
    onOpenPage(c.pageId);
  };

  const ask = () => {
    if (!q.trim() || streaming) return;
    setStreaming(true); setSources([]); setAnswer(''); setStreamErr(null);
    const ac = new AbortController();
    abortRef.current = ac;
    streamRag(
      { workspaceId: workspace.id, spaceId: space.id, query: q, pageId },
      (ev) => {
        if (ev.type === 'sources') setSources(ev.citations as Citation[]);
        else if (ev.type === 'token') setAnswer((a) => a + ev.text);
        else if (ev.type === 'error') { setStreamErr(ev.message); setStreaming(false); }
        else if (ev.type === 'done') setStreaming(false);
      },
      ac.signal
    ).catch(() => setStreaming(false));
  };

  return (
    <div className="rp-summary">
      <section className="rp-section">
        <div className="rp-section-head-row">
          <h4 className="rp-section-title">AI 摘要</h4>
          <button className="ghost sm" disabled={regen.isPending} onClick={() => regen.mutate()} title="根据当前正文重新生成摘要与标签">
            <RefreshCw size={13} className={regen.isPending ? 'spin' : ''} /> 重新生成
          </button>
        </div>
        {profLoading && <div className="muted small">生成中…</div>}
        {!profLoading && !profile?.summary && <p className="muted small">保存或整理后，AI 会在此生成本页摘要。</p>}
        {profile?.summary && <p className="rp-ai-summary">{profile.summary}</p>}
      </section>

      <section className="rp-section">
        <div className="rp-section-head-row">
          <h4 className="rp-section-title">本页 AI 建议</h4>
          <label className="auto-toggle" title="自动采纳低风险标签建议">
            <input type="checkbox" checked={autoApplyLow} onChange={toggleAutoApply} />
            自动采纳低风险
          </label>
        </div>
        {suggestions.length === 0 && recentlyAccepted.length === 0 && (
          <p className="muted small">AI 整理本页后，会在此给出可审阅的主题与关联建议。</p>
        )}
        {suggestions.map((s) => (
          <SuggestionCard
            key={s.id}
            s={s}
            onAccept={(x) => accept.mutate(x.id)}
            onIgnore={(x) => ignore.mutate(x.id)}
            onAcceptHigh={(x) => setHighSugg(x)}
          />
        ))}
        {recentlyAccepted.map((a) => (
          <SuggestionAccepted key={a.id} label={a.label} onUndo={() => undo.mutate(a.id)} />
        ))}
      </section>

      <section className="rp-section">
        <h4 className="rp-section-title">问当前页面</h4>
        <p className="muted small">仅基于本篇笔记回答，并标注引用来源。</p>
        <div className="rp-ai-box">
          <input value={q} placeholder="问这篇笔记…" onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && q.trim()) ask(); }} />
          <button className="icon-btn" disabled={!q.trim() || streaming} onClick={ask}>
            {streaming ? <Loader2 className="spin" size={15} /> : <Send size={15} />}
          </button>
        </div>
        {streamErr && <p className="error">{streamErr}</p>}
        {(sources.length > 0 || answer) && (
          <div className="rp-ai-answer">
            {sources.length > 0 && (
              <div className="rp-ai-cites">
                <span className="muted small">来源（先出现，可点击跳转）</span>
                <div className="cite-list">
                  {sources.map((c, i) => (
                    <button key={c.chunkId ?? i} className="src-chip" title={c.excerpt} onClick={() => openChunk(c)}>
                      <Link2 size={12} /> <span className="cite-idx">[{i + 1}]</span> {c.title || '来源'}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {answer && <p className="answer-text">{renderAnswer(answer, sources, openChunk)}</p>}
            {streaming && <span className="stream-cursor" />}
          </div>
        )}
      </section>

      {highSugg && (
        <HighRiskModal
          suggestion={highSugg}
          onClose={() => setHighSugg(null)}
          onConfirm={() => { accept.mutate(highSugg.id); setHighSugg(null); }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------- tags tab ---- */
function TagsTab({ pageId }: { pageId: string }) {
  const toast = useToast();
  const { data, isLoading, refetch } = useQuery<{ profile: AiProfile | null }>({
    queryKey: ['ai-profile', pageId], queryFn: () => getAiProfile(pageId)
  });
  const profile = data?.profile ?? null;
  const [tags, setTags] = useState<string[]>([]);
  const [userAdded, setUserAdded] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState('');

  // Seed local editable copy from the AI profile whenever it (re)loads.
  useEffect(() => {
    if (profile) { setTags(profile.tags ?? []); setUserAdded(new Set()); }
  }, [profile]);

  const save = useMutation({
    mutationFn: (next: string[]) => updatePageTags(pageId, next),
    onSuccess: () => { toast.success('标签已保存'); refetch(); },
    onError: (e) => toast.error(`保存失败：${(e as Error).message}`)
  });

  const removeTag = (t: string) => {
    const next = tags.filter((x) => x !== t);
    setTags(next);
    setUserAdded((prev) => { const n = new Set(prev); n.delete(t); return n; });
    save.mutate(next);
  };
  const addTag = () => {
    const t = draft.trim();
    if (!t || tags.includes(t)) { setDraft(''); return; }
    const next = [...tags, t];
    setTags(next);
    setUserAdded((prev) => new Set(prev).add(t));
    setDraft('');
    save.mutate(next);
  };

  if (isLoading) return <SkeletonList rows={3} />;
  return (
    <div className="rp-tags-tab">
      <section className="rp-section">
        <h4 className="rp-section-title">标签</h4>
        <p className="muted small">AI 会自动为笔记打标签；你也可以增删，所有改动都会保存。</p>
        {tags.length === 0 && <p className="muted small">还没有标签。</p>}
        <div className="rp-tags">
          {tags.map((t) => (
            <span key={t} className={`tag-chip${userAdded.has(t) ? ' user' : ''}`}>
              {!userAdded.has(t) && <Brain size={11} className="tag-src" />}
              {userAdded.has(t) && <span className="tag-src you">你</span>}
              {t}
              <button className="tag-x" onClick={() => removeTag(t)} aria-label={`删除 ${t}`}><X size={11} /></button>
            </span>
          ))}
        </div>
        <div className="rp-tag-add">
          <input value={draft} placeholder="添加标签后回车…" onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addTag(); }} />
          <button className="ghost sm" onClick={addTag}><Check size={13} /> 添加</button>
        </div>
      </section>
    </div>
  );
}

/* ---------------------------------------------------------- related tab ---- */
type GNode = { id: string; type: 'page' | 'topic'; label: string };
type GEdge = { id: string; source: string; target: string; confidence?: number };

function RelatedTab({ pageId, onOpenPage }: { pageId: string; onOpenPage: (id: string) => void }) {
  const { data, isLoading, isError } = useQuery<{ nodes: GNode[]; edges: GEdge[] }>({
    queryKey: ['related', pageId],
    queryFn: () => api(`/api/graph/around-page/${pageId}`)
  });

  const related = useMemo(() => {
    if (!data) return [] as (GNode & { score: number })[];
    const connected = new Set<string>();
    for (const e of data.edges) {
      if (e.source === pageId) connected.add(e.target);
      if (e.target === pageId) connected.add(e.source);
    }
    return data.nodes
      .filter((n) => n.id !== pageId && connected.has(n.id))
      .map((n) => {
        const confs = data.edges
          .filter((e) => (e.source === pageId && e.target === n.id) || (e.target === pageId && e.source === n.id))
          .map((e) => e.confidence ?? 0);
        return { ...n, score: confs.length ? Math.max(...confs) : 0 };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }, [data, pageId]);

  if (isLoading) return <SkeletonList rows={4} />;
  if (isError || related.length === 0) {
    return <EmptyState icon={<Link2 size={28} />} title="暂无关联" hint="当这篇笔记与其他内容产生联系时，会显示在这里。" />;
  }
  return (
    <div className="rp-related">
      {related.map((n) => (
        <button key={n.id} className="rp-related-item" onClick={() => n.type === 'page' && onOpenPage(n.id)}>
          <span className={`rp-related-kind ${n.type}`}>{n.type === 'page' ? '笔记' : '主题'}</span>
          <span className="rp-related-title">{n.label}</span>
          <span className="rel-bar" title={`相关度 ${Math.round(n.score)}%`}>
            <span className="rel-fill" style={{ width: `${Math.min(100, Math.max(4, n.score))}%` }} />
          </span>
        </button>
      ))}
    </div>
  );
}
