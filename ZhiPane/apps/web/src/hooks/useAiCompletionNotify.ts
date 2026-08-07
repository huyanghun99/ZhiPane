import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useToast } from '../components/Toast';
import type { TreeNode } from '../types';

/**
 * "AI 处理完成"通知 (Phase 6 — task 5).
 *
 * Polls the page tree (which already carries each page's `llmProcessStatus`)
 * every 15s and, purely client-side, detects when a page transitions out of a
 * pending/processing state into `done`/`processed`. A success toast is shown
 * exactly once per transition. No new backend endpoint is required — it reuses
 * the existing tree API and a *separate* query key so the visible tree cache is
 * never disturbed by the polling.
 */
export function useAiCompletionNotify(spaceId: string | undefined) {
  const toast = useToast();
  const seen = useRef<Map<string, string>>(new Map());

  const { data } = useQuery<{ tree: TreeNode[] }>({
    queryKey: ['llm-status', spaceId],
    enabled: !!spaceId,
    queryFn: () => api(`/api/pages/tree?spaceId=${spaceId}`),
    refetchInterval: 15000
  });

  useEffect(() => {
    if (!data) return;
    const flat: TreeNode[] = [];
    const walk = (ns: TreeNode[]) => ns.forEach((n) => { flat.push(n); walk(n.children); });
    walk(data.tree);

    const prev = seen.current;
    for (const n of flat) {
      const prevStatus = prev.get(n.id);
      if (
        prevStatus &&
        prevStatus !== 'done' &&
        prevStatus !== 'processed' &&
        (n.llmProcessStatus === 'done' || n.llmProcessStatus === 'processed')
      ) {
        toast.success(`AI 已完成整理：${n.title || '未命名笔记'}`);
      }
      prev.set(n.id, n.llmProcessStatus);
    }
    // Forget pages that no longer exist.
    const ids = new Set(flat.map((n) => n.id));
    for (const id of [...prev.keys()]) if (!ids.has(id)) prev.delete(id);
  }, [data, toast]);
}
