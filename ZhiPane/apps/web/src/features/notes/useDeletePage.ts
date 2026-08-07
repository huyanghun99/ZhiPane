import { useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { del } from '../../api';
import { useToast } from '../../components/Toast';
import type { Space, TreeNode } from '../../types';

/**
 * Delete-with-undo (Phase 3 "Undo" requirement).
 *
 * The page is removed from the tree cache immediately and a toast with an
 * "撤销" action appears. The real DELETE request is deferred by a few seconds;
 * if the user hits undo first, the request never fires and the tree is
 * restored from the server. This gives a fully reversible delete without any
 * new backend endpoint.
 */
export function useDeletePage(space: Space | null, onAfterDelete?: (id: string) => void) {
  const qc = useQueryClient();
  const toast = useToast();
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  return useCallback((page: { id: string; title: string }) => {
    if (!space) return;
    const key = ['page-tree', space.id];
    const snapshot = qc.getQueryData<{ tree: TreeNode[] }>(key);

    // Optimistically drop the node (and its subtree) from the cache.
    qc.setQueryData<{ tree: TreeNode[] }>(key, (old) => {
      if (!old) return old;
      const prune = (nodes: TreeNode[]): TreeNode[] =>
        nodes.filter((n) => n.id !== page.id).map((n) => ({ ...n, children: prune(n.children) }));
      return { tree: prune(old.tree) };
    });
    onAfterDelete?.(page.id);

    const commit = async () => {
      timers.current.delete(page.id);
      try {
        await del(`/api/pages/${page.id}`);
      } catch (err) {
        toast.error(`删除失败：${(err as Error).message}`);
      } finally {
        qc.invalidateQueries({ queryKey: key });
      }
    };

    const timer = setTimeout(commit, 5000);
    timers.current.set(page.id, timer);

    toast.info(`已删除「${page.title || '未命名笔记'}」`, {
      action: {
        label: '撤销',
        onClick: () => {
          const t = timers.current.get(page.id);
          if (t) { clearTimeout(t); timers.current.delete(page.id); }
          if (snapshot) qc.setQueryData(key, snapshot);
          else qc.invalidateQueries({ queryKey: key });
        }
      }
    });
  }, [qc, toast, space?.id, onAfterDelete]);
}
