import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAdaptivePolling } from '../../hooks/useAdaptivePolling';
import { Archive, Brain, Check, Layers, Link2, Network, Pause, Pencil, Pin, PinOff, Play, Plus, RefreshCw, RotateCcw, Trash2, X, Zap } from 'lucide-react';
import { api, post, consolidateSpace, getJob, skipPageLlm, updateTopic, archiveTopic, reactivateTopic, deleteTopic } from '../../api';
import { useToast } from '../../components/Toast';
import { useDialog } from '../../components/Dialog';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { SkeletonList } from '../../components/Skeleton';
import { SuggestionCard, SuggestionAccepted, suggestionTitle, HighRiskModal } from './SuggestionCard';
import type { Space, WikiSuggestion } from '../../types';

type WikiTopic = {
  id: string; title: string; status: string; source: string;
  aiSummary: string; textContent?: string; createdAt?: string;
  synthesisStatus?: 'ready' | 'failed'; qualityIssues?: string[]; synthesisDiagnostics?: { evidenceCount?: number; inputCharacterCount?: number; processedCharacterCount?: number; qualityScore?: number };
  // Phase B (B2.1/B2.3): fields needed for manual edit / archive / delete.
  pinned?: boolean; lifecycleStatus?: string; publicationStatus?: string;
  contentJson?: unknown;
};

type InboxItem = { id: string; title: string; llmProcessStatus: string; updatedAt?: string };

type WikiError = { id: string; title: string; wikiErrorMessage: string };

const TOPIC_STATUS_LABEL: Record<string, string> = {
  suggested: '待审阅', accepted: '已采纳', user_edited: '已编辑', stale: '待更新', archived: '已归档', synthesis_failed: '综合失败'
};
const INBOX_STATUS_LABEL: Record<string, string> = {
  pending: '待整理', processing: '整理中', processed: '已整理', failed: '整理失败', ignored: '已忽略'
};

/** Phase B (B2.2): render a TopicSynthesis structurally instead of a raw <pre>. */
function TopicContentView({ topic }: { topic: WikiTopic }) {
  const synth = (topic.contentJson ?? null) as
    | { definition?: string; overview?: string; keyPoints?: { title: string; content: string; citations?: { chunkId: string; pageId?: string }[] }[]; conflicts?: string[]; openQuestions?: string[]; relatedTopics?: string[] }
    | null;
  if (topic.synthesisStatus === 'failed' || (synth as { schemaVersion?: string } | null)?.schemaVersion === 'topic-synthesis-failed-v1') {
    const failed = synth as { error?: string; evidencePreview?: { excerpt: string }[] };
    return <div className="topic-synthesis-failed"><h4>综合失败</h4><p>{failed?.error || topic.aiSummary || '尚未生成可靠 Topic 正文。'}</p>{topic.qualityIssues && topic.qualityIssues.length > 0 && <p className="muted small">质量问题：{topic.qualityIssues.join('、')}</p>}{failed?.evidencePreview && <details><summary>查看保留的原始证据</summary><ul>{failed.evidencePreview.map((e, i) => <li key={i}>{e.excerpt}</li>)}</ul></details>}</div>;
  }
  if (!synth || typeof synth !== 'object') {
    return topic.textContent ? (
      <div className="topic-text-content">
        <h4>主题内容</h4>
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.6 }}>{topic.textContent}</pre>
      </div>
    ) : null;
  }
  return (
    <div className="topic-synthesis">
      {synth.definition && (<div className="synth-block"><h4>定义</h4><p>{synth.definition}</p></div>)}
      {synth.overview && (<div className="synth-block"><h4>概述</h4><p>{synth.overview}</p></div>)}
      {Array.isArray(synth.keyPoints) && synth.keyPoints.length > 0 && (
        <div className="synth-block">
          <h4>要点</h4>
          <ul className="synth-kp">
            {synth.keyPoints.map((kp, i) => (
              <li key={i}>
                <b>{kp.title}</b>
                <p>{kp.content}</p>
                {Array.isArray(kp.citations) && kp.citations.length > 0 && (
                  <span className="muted small">引用 {kp.citations.length} 条</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {Array.isArray(synth.conflicts) && synth.conflicts.length > 0 && (
        <div className="synth-block"><h4>争议 / 冲突</h4><ul>{synth.conflicts.map((c, i) => <li key={i}>{c}</li>)}</ul></div>
      )}
      {Array.isArray(synth.openQuestions) && synth.openQuestions.length > 0 && (
        <div className="synth-block"><h4>开放问题</h4><ul>{synth.openQuestions.map((q, i) => <li key={i}>{q}</li>)}</ul></div>
      )}
      {Array.isArray(synth.relatedTopics) && synth.relatedTopics.length > 0 && (
        <div className="synth-block"><h4>相关主题</h4><p className="muted small">{synth.relatedTopics.join('、')}</p></div>
      )}
    </div>
  );
}

export function WikiView({ space, onOpenPage }: { space: Space; onOpenPage: (id: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const dialog = useDialog();
  const [tab, setTab] = useState<'inbox' | 'suggestions' | 'topics'>('inbox');
  // Phase B3.2: Topic list dimension filters (lifecycle + source).
  const [topicLifecycle, setTopicLifecycle] = useState<'active' | 'archived'>('active');
  const [topicSource, setTopicSource] = useState<'all' | 'ai' | 'user'>('all');

  const [hasActivity, setHasActivity] = useState(false);
  const poll = useAdaptivePolling({ enabled: !!space, hasActivity });

  // Phase C1 (U5): surface load failures instead of silently showing an empty
  // state, and expose refetch so the user can retry.
  const { data: inboxData, isLoading: inboxLoading, isError: inboxError, error: inboxErr, refetch: refetchInbox } = useQuery<{ inbox: InboxItem[] }>({
    queryKey: ['inbox', space.id], queryFn: () => api(`/api/llm-wiki/inbox?spaceId=${space.id}`), refetchInterval: poll
  });
  const inbox = inboxData?.inbox ?? [];

  const { data: spaceData } = useQuery<{ space: Space & { autoLlmProcessing: boolean } }>({
    queryKey: ['wiki-space', space.id], queryFn: () => api(`/api/spaces/${space.id}`)
  });
  const autoOn = spaceData?.space?.autoLlmProcessing ?? true;

  const { data: suggData, isLoading: suggLoading, isError: suggError, error: suggErr, refetch: refetchSugg } = useQuery<{ suggestions: WikiSuggestion[] }>({
    queryKey: ['suggestions', space.id], queryFn: () => api(`/api/llm-wiki/suggestions?spaceId=${space.id}`), refetchInterval: poll
  });
  const suggestions = suggData?.suggestions ?? [];

  const { data: topicData, isLoading: topicLoading, isError: topicError, error: topicErr, refetch: refetchTopics } = useQuery<{ topics: WikiTopic[] }>({
    queryKey: ['topics', space.id, topicLifecycle],
    queryFn: () => api(`/api/llm-wiki/topics?spaceId=${space.id}${topicLifecycle === 'archived' ? '&lifecycle=archived' : ''}`),
    refetchInterval: poll
  });
  const topics = topicData?.topics ?? [];
  // Phase B3.2: client-side source filter (ai-generated vs user-created).
  const visibleTopics = useMemo(() => {
    if (topicSource === 'all') return topics;
    if (topicSource === 'ai') return topics.filter((t) => t.source === 'ai_generated');
    return topics.filter((t) => t.source !== 'ai_generated');
  }, [topics, topicSource]);

  // Phase 0 task 6: surface pages whose Wiki artifact generation failed.
  const { data: wikiErrData } = useQuery<{ errors: WikiError[] }>({
    queryKey: ['wiki-errors', space.id], queryFn: () => api(`/api/llm-wiki/spaces/${space.id}/wiki-errors`), refetchInterval: poll
  });
  const wikiErrors = wikiErrData?.errors ?? [];

  useEffect(() => {
    setHasActivity(inbox.some((item) => item.llmProcessStatus === 'processing') || suggestions.some((item) => item.status === 'pending'));
  }, [inbox, suggestions, topics]);

  const retrySynthesis = useMutation({
    mutationFn: (topicId: string) => post(`/api/llm-wiki/topics/${topicId}/retry-synthesis`, {}),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['topics', space.id] }); toast.success('已重新生成主题综合'); },
    onError: (e) => toast.error(`综合仍未通过：${(e as Error).message}`)
  });

  const reprocess = useMutation({
    mutationFn: () => post(`/api/llm-wiki/spaces/${space.id}/reprocess`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inbox', space.id] });
      qc.invalidateQueries({ queryKey: ['suggestions', space.id] });
      qc.invalidateQueries({ queryKey: ['topics', space.id] });
      toast.success('已重新生成全部 Wiki 产物');
    },
    onError: (e) => toast.error(`操作失败：${(e as Error).message}`)
  });
  const toggleAuto = useMutation({
    mutationFn: () => post(`/api/llm-wiki/spaces/${space.id}/${autoOn ? 'pause' : 'resume'}`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['wiki-space', space.id] })
  });

  /* ------------------------------------------------ LLM Inbox ------------ */
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  const markDone = (ids: string[]) => setDoneIds((p) => { const n = new Set(p); ids.forEach((i) => n.add(i)); return n; });

  const bulkProcess = useMutation({
    mutationFn: (ids: string[]) => Promise.all(ids.map((id) => post(`/api/llm-wiki/pages/${id}/process-now`, {}))),
    onSuccess: () => { markDone(inbox.map((p) => p.id)); qc.invalidateQueries({ queryKey: ['inbox', space.id] }); toast.success('已加入处理队列'); },
    onError: (e) => toast.error(`操作失败：${(e as Error).message}`)
  });
  const bulkIgnore = useMutation({
    mutationFn: (ids: string[]) => Promise.all(ids.map((id) => skipPageLlm(id))),
    onSuccess: () => { markDone(inbox.map((p) => p.id)); qc.invalidateQueries({ queryKey: ['inbox', space.id] }); toast.success('已忽略收件箱中的页面'); },
    onError: (e) => toast.error(`操作失败：${(e as Error).message}`)
  });

  const processNow = useMutation({
    mutationFn: (pageId: string) => post(`/api/llm-wiki/pages/${pageId}/process-now`, {}),
    onSuccess: (_r, id) => { markDone([id]); qc.invalidateQueries({ queryKey: ['inbox', space.id] }); },
    onError: (e) => toast.error(`操作失败：${(e as Error).message}`)
  });
  const skipOne = useMutation({
    mutationFn: (pageId: string) => skipPageLlm(pageId),
    onSuccess: (_r, id) => { markDone([id]); qc.invalidateQueries({ queryKey: ['inbox', space.id] }); },
    onError: (e) => toast.error(`操作失败：${(e as Error).message}`)
  });

  /* --------------------------------------------- Suggestions (review) ---- */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const bulkAccept = useMutation({
    mutationFn: (ids: string[]) => post(`/api/llm-wiki/suggestions/bulk-accept`, { spaceId: space.id, ids }),
    onSuccess: () => { setSelected(new Set()); qc.invalidateQueries({ queryKey: ['suggestions', space.id] }); }
  });
  const [recentlyAccepted, setRecentlyAccepted] = useState<{ id: string; label: string }[]>([]);
  const [highSugg, setHighSugg] = useState<WikiSuggestion | null>(null);
  const [snoozed, setSnoozed] = useState<Set<string>>(new Set());

  const accept = useMutation({
    mutationFn: (id: string) => post(`/api/llm-wiki/suggestions/${id}/accept`, {}),
    // Phase C1 (U6): optimistic removal so the card vanishes instantly instead
    // of waiting for the refetch (still invalidated to reconcile with the server).
    onSuccess: (_r, id) => {
      qc.setQueryData<{ suggestions: WikiSuggestion[] }>(['suggestions', space.id], (old) =>
        old ? { ...old, suggestions: old.suggestions.filter((s) => s.id !== id) } : old);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['suggestions', space.id] });
      const s = suggestions.find((x) => x.id === id);
      if (s) setRecentlyAccepted((p) => [...p, { id, label: suggestionTitle(s).title }]);
    }
  });
  const ignore = useMutation({
    mutationFn: (id: string) => post(`/api/llm-wiki/suggestions/${id}/ignore`, {}),
    onSuccess: (_r, id) => {
      qc.setQueryData<{ suggestions: WikiSuggestion[] }>(['suggestions', space.id], (old) =>
        old ? { ...old, suggestions: old.suggestions.filter((s) => s.id !== id) } : old);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['suggestions', space.id] });
    }
  });
  const undo = useMutation({
    mutationFn: (id: string) => post(`/api/llm-wiki/suggestions/${id}/undo`, {}),
    onSuccess: (_r, id) => {
      setRecentlyAccepted((p) => p.filter((x) => x.id !== id));
      qc.invalidateQueries({ queryKey: ['suggestions', space.id] });
    }
  });

  // Low-risk (tag) suggestions are applied automatically — but transparently,
  // via a toast — so the user always knows what changed (never "secret" edits).
  const autoHandled = useRef<Set<string>>(new Set());
  useEffect(() => {
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
  }, [suggestions, accept, toast]);

  const lowRiskIds = suggestions.filter((s) => s.risk === 'low').map((s) => s.id);
  const visibleSuggestions = suggestions.filter((s) => !snoozed.has(s.id));

  /* ----------------------------------------------------- Topics ---------- */
  const [activeTopic, setActiveTopic] = useState<WikiTopic | null>(null);
  const { data: topicSources } = useQuery<{ sources: { id: string; title: string }[] }>({
    queryKey: ['topic-sources', activeTopic?.id], enabled: !!activeTopic,
    queryFn: () => api(`/api/llm-wiki/topics/${activeTopic!.id}/sources`)
  });
  const acceptTopic = useMutation({
    mutationFn: (id: string) => post(`/api/llm-wiki/topics/${id}/accept`, {}),
    onSuccess: () => {
      // Phase C1 (U6): flip the topic to accepted immediately in the cache.
      if (activeTopic) {
        qc.setQueryData<{ topics: WikiTopic[] }>(['topics', space.id, topicLifecycle], (old) =>
          old ? { ...old, topics: old.topics.map((t) => t.id === activeTopic.id ? { ...t, status: 'accepted' } : t) } : old);
      }
      qc.invalidateQueries({ queryKey: ['topics', space.id] });
      if (activeTopic) setActiveTopic({ ...activeTopic, status: 'accepted' });
    }
  });
  const refreshTopic = useMutation({
    mutationFn: (id: string) => post(`/api/llm-wiki/topics/${id}/refresh-suggestions`, {}),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['suggestions', space.id] }); qc.invalidateQueries({ queryKey: ['topics', space.id] }); toast.success('已提交重新生成，稍后查看结果'); },
    onError: (e) => toast.error(`操作失败：${(e as Error).message}`)
  });

  /* ------------------- Phase B (B1.3): async consolidate + progress poll --- */
  // Clustering is enqueued as a job; we poll its progress and refresh the
  // topic list once it succeeds (instead of blocking on a sync response).
  const [consolidateJob, setConsolidateJob] = useState<{ id: string; status: string; progress: { done?: number; total?: number; stage?: string } } | null>(null);
  const consolidatePoll = useRef<ReturnType<typeof setInterval> | null>(null);
  const consolidateM = useMutation({
    mutationFn: () => consolidateSpace(space.id),
    onSuccess: async ({ jobId }) => {
      if (consolidatePoll.current) clearInterval(consolidatePoll.current);
      consolidatePoll.current = setInterval(async () => {
        try {
          const job = await getJob(jobId);
          setConsolidateJob({ id: job.id, status: job.status, progress: job.progress });
          if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') {
            if (consolidatePoll.current) clearInterval(consolidatePoll.current);
            consolidatePoll.current = null;
            setConsolidateJob(null);
            if (job.status === 'succeeded') {
              await qc.invalidateQueries({ queryKey: ['topics', space.id] });
              await qc.invalidateQueries({ queryKey: ['suggestions', space.id] });
              toast.success('主题整合完成');
            } else if (job.status === 'failed') {
              toast.error(`整合失败：${job.errorMessage ?? '未知错误'}`);
            }
          }
        } catch (e) {
          if (consolidatePoll.current) clearInterval(consolidatePoll.current);
          consolidatePoll.current = null;
          setConsolidateJob(null);
          toast.error(`查询整合任务失败：${(e as Error).message}`);
        }
      }, 1500);
    },
    onError: (e) => toast.error(`操作失败：${(e as Error).message}`)
  });
  useEffect(() => () => { if (consolidatePoll.current) clearInterval(consolidatePoll.current); }, []);
  const undoTopicM = useMutation({
    mutationFn: (id: string) => post(`/api/llm-wiki/topics/${id}/undo`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['topics', space.id] });
      if (activeTopic) setActiveTopic({ ...activeTopic, status: 'suggested' });
    }
  });
  const [newTitle, setNewTitle] = useState('');
  const createTopic = useMutation({
    mutationFn: () => post<{ topic: WikiTopic }>(`/api/llm-wiki/topics`, {
      workspaceId: space.workspaceId, spaceId: space.id, title: newTitle || '新主题',
      contentJson: { type: 'doc', content: [] }, aiSummary: ''
    }),
    onSuccess: async (r) => { setNewTitle(''); await qc.invalidateQueries({ queryKey: ['topics', space.id] }); setActiveTopic(r.topic); }
  });

  /* ----------------------------- Phase B (B2.1/B2.3): manual edit ---------- */
  // Rename / pin via PATCH. Renaming/user-editing never gets overwritten by AI
  // refresh (enforced server-side via publicationStatus='user_edited').
  const updateTopicM = useMutation({
    mutationFn: (body: { title?: string; pinned?: boolean }) => updateTopic(activeTopic!.id, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['topics', space.id] }); },
    onError: (e) => toast.error(`操作失败：${(e as Error).message}`)
  });
  const archiveM = useMutation({
    mutationFn: () => archiveTopic(activeTopic!.id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['topics', space.id] }); if (activeTopic) setActiveTopic({ ...activeTopic, lifecycleStatus: 'archived', status: 'archived' }); },
    onError: (e) => toast.error(`归档失败：${(e as Error).message}`)
  });
  const reactivateM = useMutation({
    mutationFn: () => reactivateTopic(activeTopic!.id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['topics', space.id] }); if (activeTopic) setActiveTopic({ ...activeTopic, lifecycleStatus: 'active', status: 'accepted' }); },
    onError: (e) => toast.error(`恢复失败：${(e as Error).message}`)
  });
  const deleteM = useMutation({
    mutationFn: () => deleteTopic(activeTopic!.id),
    onSuccess: async () => { setActiveTopic(null); await qc.invalidateQueries({ queryKey: ['topics', space.id] }); toast.success('主题已删除（可在归档中心恢复）'); },
    onError: (e) => toast.error(`删除失败：${(e as Error).message}`)
  });
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');

  const TABS: { key: typeof tab; label: string; icon: React.ReactNode; count: number }[] = [
    { key: 'inbox', label: 'Inbox', icon: <Layers size={16} />, count: inbox.length },
    { key: 'suggestions', label: '建议', icon: <Brain size={16} />, count: visibleSuggestions.length },
    { key: 'topics', label: 'Topic Center', icon: <Network size={16} />, count: topics.length }
  ];

  return (
    <div className="wiki-view">
      {wikiErrors.length > 0 && (
        <div className="wiki-errors-banner">
          <b>⚠ {wikiErrors.length} 篇笔记的 Wiki 产物生成失败</b>
          <ul>
            {wikiErrors.map((e) => (
              <li key={e.id}>
                <span className="muted small">{e.title}</span>
                <span className="wiki-err-msg">{e.wikiErrorMessage}</span>
                <button className="ghost sm" disabled={processNow.isPending} onClick={() => processNow.mutate(e.id)}>重试</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="wiki-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`wiki-tab${tab === t.key ? ' active' : ''}`} onClick={() => setTab(t.key)}>
            {t.icon}<span>{t.label}</span>{t.count > 0 && <span className="tab-count">{t.count}</span>}
          </button>
        ))}
        <div className="wiki-tabs-right">
          {consolidateJob ? (
            <span className="chip" title={`整合进度 ${consolidateJob.progress.done ?? 0}/${consolidateJob.progress.total ?? '?'}`}>
              <Brain size={13} /> 整合中 {consolidateJob.progress.done ?? 0}/{consolidateJob.progress.total ?? '?'}
            </span>
          ) : (
            <button className="chip" onClick={() => consolidateM.mutate()} title="整合本 Space 的候选主题为正式主题" disabled={consolidateM.isPending}>
              <Brain size={13} /> 整合主题
            </button>
          )}
          <button className="chip" onClick={() => reprocess.mutate()} title="重新处理本 Space 全部笔记并生成 Wiki 产物" disabled={reprocess.isPending}>
            <RefreshCw size={13} /> 重新生成
          </button>
          <button className={`chip${autoOn ? ' on' : ''}`} onClick={() => toggleAuto.mutate()} title="切换自动处理">
            {autoOn ? <><Play size={13} /> 自动处理中</> : <><Pause size={13} /> 已暂停</>}
          </button>
        </div>
      </div>

      {tab === 'inbox' && (
        <div className="wiki-pane">
          {inbox.length > 0 && (
            <div className="batch-bar">
              <span className="muted small">待处理 {inbox.length} 篇</span>
              <div className="spacer" />
              <button className="ghost sm" disabled={bulkProcess.isPending} onClick={() => bulkProcess.mutate(inbox.map((p) => p.id))}>
                <Check size={14} /> 全部标记已处理
              </button>
              <button className="ghost sm" disabled={bulkIgnore.isPending} onClick={() => bulkIgnore.mutate(inbox.map((p) => p.id))}>
                <X size={14} /> 全部忽略
              </button>
            </div>
          )}
          {inboxError && <ErrorState title="收件箱加载失败" message={(inboxErr as Error)?.message} onRetry={() => refetchInbox()} />}
          {!inboxError && inboxLoading && <SkeletonList rows={5} />}
          {!inboxError && !inboxLoading && inbox.length === 0 && (
            <EmptyState icon={<Layers size={36} />} title="收件箱为空" hint="新建或编辑笔记后会自动进入 LLM 处理队列，处理完成后将生成主题与建议。" />
          )}
          {inbox.map((p) => {
            const done = doneIds.has(p.id);
            return (
              <div className={`wiki-row inbox-row${done ? ' done' : ''}`} key={p.id}>
                <div className="wiki-row-main">
                  <b>{p.title || '未命名笔记'}</b>
                  <span className="muted small inbox-meta">
                    {p.updatedAt ? `修改于 ${new Date(p.updatedAt).toLocaleString()}` : '修改时间未知'}
                    <span className={`inbox-status status-${p.llmProcessStatus}`}>{INBOX_STATUS_LABEL[p.llmProcessStatus] ?? p.llmProcessStatus}</span>
                  </span>
                </div>
                <div className="wiki-row-actions">
                  {done
                    ? <span className="accept-check static"><Check size={14} /> {p.llmProcessStatus === 'ignored' ? '已忽略' : '已处理'}</span>
                    : (
                      <>
                        <button className="ghost" onClick={() => onOpenPage(p.id)}>打开</button>
                        <button className="ghost" disabled={skipOne.isPending} onClick={() => skipOne.mutate(p.id)}><X size={14} /> 忽略</button>
                        <button className="ghost ok" disabled={processNow.isPending} onClick={() => processNow.mutate(p.id)}><Zap size={14} /> 立即处理</button>
                      </>
                    )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {tab === 'suggestions' && (
        <div className="wiki-pane">
          {suggError ? (
            <ErrorState title="建议加载失败" message={(suggErr as Error)?.message} onRetry={() => refetchSugg()} />
          ) : (
            <>
              <div className="batch-bar">
                <label className="check-all">
                  <input type="checkbox" checked={selected.size === visibleSuggestions.length && visibleSuggestions.length > 0}
                    onChange={(e) => setSelected(e.target.checked ? new Set(visibleSuggestions.map((s) => s.id)) : new Set())} />
                  全选
                </label>
                <span className="muted small">已选 {selected.size} / {visibleSuggestions.length}</span>
                <div className="spacer" />
                <button className="ghost sm" disabled={lowRiskIds.length === 0 || bulkAccept.isPending} onClick={() => bulkAccept.mutate(lowRiskIds)} title="一次性接受所有低风险建议">
                  <Check size={14} /> 批量接受低风险（{lowRiskIds.length}）
                </button>
                <button className="primary sm" disabled={selected.size === 0 || bulkAccept.isPending} onClick={() => bulkAccept.mutate([...selected])}>
                  <Check size={14} /> 批量接受
                </button>
              </div>
              {suggLoading && <SkeletonList rows={5} />}
              {!suggLoading && visibleSuggestions.length === 0 && recentlyAccepted.length === 0 && (
                <EmptyState icon={<Brain size={36} />} title="暂无待审阅建议" hint="处理笔记后会由 AI 生成主题提案与关联建议。" />
              )}
              {!suggLoading && visibleSuggestions.map((s) => (
                <SuggestionCard
                  key={s.id}
                  s={s}
                  onAccept={(x) => accept.mutate(x.id)}
                  onIgnore={(x) => ignore.mutate(x.id)}
                  onSnooze={(x) => setSnoozed((p) => new Set(p).add(x.id))}
                  onAcceptHigh={(x) => setHighSugg(x)}
                />
              ))}
              {recentlyAccepted.map((a) => (
                <SuggestionAccepted key={a.id} label={a.label} onUndo={() => undo.mutate(a.id)} />
              ))}
            </>
          )}
        </div>
      )}

      {tab === 'topics' && (
        <div className="topic-layout">
          <div className="topic-list">
            <div className="topic-new">
              <input value={newTitle} placeholder="新建主题…" onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createTopic.mutate()} />
              <button className="icon-btn" disabled={createTopic.isPending} onClick={() => createTopic.mutate()}><Plus size={15} /></button>
            </div>
            {/* Phase B3.2: lifecycle + source dimension filters. */}
            <div className="topic-filters">
              <div className="seg">
                <button className={topicLifecycle === 'active' ? 'on' : ''} onClick={() => setTopicLifecycle('active')}>活跃</button>
                <button className={topicLifecycle === 'archived' ? 'on' : ''} onClick={() => setTopicLifecycle('archived')}>已归档</button>
              </div>
              <select value={topicSource} onChange={(e) => setTopicSource(e.target.value as 'all' | 'ai' | 'user')} title="来源">
                <option value="all">全部来源</option>
                <option value="ai">AI 生成</option>
                <option value="user">人工创建</option>
              </select>
            </div>
            {topicError ? (
              <ErrorState title="主题加载失败" message={(topicErr as Error)?.message} onRetry={() => refetchTopics()} />
            ) : (
              <>
                {topicLoading && <SkeletonList rows={5} />}
                {!topicLoading && visibleTopics.length === 0 && <EmptyState icon={<Network size={36} />} title={topicLifecycle === 'archived' ? '归档中暂无主题' : '暂无 Topic'} hint="处理笔记后，AI 会提炼候选主题；也可手动创建。" />}
                {!topicLoading && visibleTopics.map((t) => (
              <button key={t.id} className={`topic-item${activeTopic?.id === t.id ? ' active' : ''}`} onClick={() => setActiveTopic(t)}>
                <div><b>{t.title}</b><span className={`tag status-${t.status}`}>{TOPIC_STATUS_LABEL[t.status] ?? t.status}</span></div>
                {t.status === 'stale' && (
                  <button
                    className="stale-updated"
                    title="来源页面已更新，点击重新生成"
                    onClick={(e) => { e.stopPropagation(); refreshTopic.mutate(t.id); }}
                  >
                    <RefreshCw size={11} /> 来源已更新
                  </button>
                )}
                {t.aiSummary && <p className="muted small topic-sum">{t.aiSummary}</p>}
              </button>
            ))}
              </>
            )}
          </div>
          <div className="topic-detail">
            {!activeTopic && <EmptyState icon={<Network size={36} />} title="选择左侧主题查看详情" />}
            {activeTopic && (
              <>
                <div className="topic-detail-head">
                  {editingTitle ? (
                    <input
                      className="topic-title-input"
                      autoFocus
                      value={titleDraft}
                      onChange={(e) => setTitleDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && titleDraft.trim()) { updateTopicM.mutate({ title: titleDraft.trim() }); setActiveTopic({ ...activeTopic, title: titleDraft.trim(), status: 'user_edited', publicationStatus: 'user_edited' }); setEditingTitle(false); }
                        if (e.key === 'Escape') setEditingTitle(false);
                      }}
                      onBlur={() => setEditingTitle(false)}
                    />
                  ) : (
                    <h3>
                      {activeTopic.title}
                      <button className="icon-btn" title="重命名" onClick={() => { setTitleDraft(activeTopic.title); setEditingTitle(true); }}><Pencil size={13} /></button>
                    </h3>
                  )}
                  <span className={`tag status-${activeTopic.status}`}>{TOPIC_STATUS_LABEL[activeTopic.status] ?? activeTopic.status}</span>
                  {activeTopic.lifecycleStatus === 'archived' && <span className="tag status-archived">已归档</span>}
                  {activeTopic.pinned && <span className="tag">📌 置顶</span>}
                </div>
                <p className="topic-ai-sum">{activeTopic.aiSummary || '（暂无 AI 摘要）'}</p>
                <TopicContentView topic={activeTopic} />
                <div className="topic-detail-actions">
                  {activeTopic.status !== 'accepted' && activeTopic.synthesisStatus !== 'failed' && (
                    <button className="primary sm" disabled={acceptTopic.isPending} onClick={() => acceptTopic.mutate(activeTopic.id)}><Check size={14} /> 采纳主题</button>
                  )}
                  {activeTopic.status === 'accepted' && (
                    <button className="ghost" disabled={undoTopicM.isPending} onClick={() => undoTopicM.mutate(activeTopic.id)}><RotateCcw size={14} /> 撤销采纳</button>
                  )}
                  {activeTopic.status === 'stale' && (
                    <button className="ghost stale-updated-btn" disabled={refreshTopic.isPending} onClick={() => refreshTopic.mutate(activeTopic.id)}>
                      <RefreshCw size={14} /> 来源已更新 · 重新生成
                    </button>
                  )}
                  {activeTopic.synthesisStatus === 'failed' && (
                    <button className="ghost stale-updated-btn" disabled={retrySynthesis.isPending} onClick={() => retrySynthesis.mutate(activeTopic.id)}><RefreshCw size={14} /> 重试综合</button>
                  )}
                  {activeTopic.synthesisStatus !== 'failed' && <button className="ghost" disabled={refreshTopic.isPending} onClick={() => refreshTopic.mutate(activeTopic.id)}><RefreshCw size={14} /> 刷新建议</button>}
                  {/* Phase B (B2.1): manual lifecycle / edit actions */}
                  <button className="ghost" disabled={updateTopicM.isPending} onClick={() => updateTopicM.mutate({ pinned: !activeTopic.pinned })}>
                    {activeTopic.pinned ? <><PinOff size={14} /> 取消置顶</> : <><Pin size={14} /> 置顶</>}
                  </button>
                  {activeTopic.lifecycleStatus !== 'archived' ? (
                    <button className="ghost" disabled={archiveM.isPending} onClick={async () => { const ok = await dialog.confirm({ title: '归档主题', message: '归档后该主题将降权但仍可搜索，可在归档中心恢复。', confirmText: '归档', danger: true }); if (ok) archiveM.mutate(); }}><Archive size={14} /> 归档</button>
                  ) : (
                    <button className="ghost" disabled={reactivateM.isPending} onClick={() => reactivateM.mutate()}><RotateCcw size={14} /> 恢复</button>
                  )}
                  <button className="ghost danger" disabled={deleteM.isPending} onClick={async () => { const ok = await dialog.confirm({ title: '删除主题', message: '删除后主题不会立即消失，而是进入归档中心（可恢复）。', confirmText: '删除', danger: true }); if (ok) deleteM.mutate(); }}><Trash2 size={14} /> 删除</button>
                </div>
                <h4>来源页面（{topicSources?.sources?.length ?? 0}）</h4>
                <div className="topic-sources">
                  {(topicSources?.sources ?? []).map((src) => (
                    <button key={src.id} className="src-chip" onClick={() => onOpenPage(src.id)}><Link2 size={13} /> {src.title}</button>
                  ))}
                  {(topicSources?.sources?.length ?? 0) === 0 && <p className="muted small">暂无关联页面</p>}
                </div>
              </>
            )}
          </div>
        </div>
      )}

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
