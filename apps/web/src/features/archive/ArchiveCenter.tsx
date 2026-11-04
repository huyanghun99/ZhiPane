import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Archive, Trash2, History } from 'lucide-react';
import { listArchive, restoreArchiveItem, deleteArchiveItem, type ArchiveItem } from '../archive/api';
import { EmptyState } from '../../components/EmptyState';

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button className={`archive-tab${active ? ' active' : ''}`} onClick={onClick}>{children}</button>
  );
}

type Tab = 'deleted' | 'history' | 'versions';

export function ArchiveCenter({ workspace }: { workspace: { id: string } }) {
  const [tab, setTab] = useState<Tab>('deleted');
  const { data, isLoading } = useQuery({
    queryKey: ['archive', workspace.id],
    queryFn: () => listArchive(workspace.id),
  });

  const deleted = useMemo(() => (data ?? []).filter((i) => i.kind === 'deleted'), [data]);
  const history = useMemo(() => (data ?? []).filter((i) => i.kind === 'history'), [data]);
  const versions = useMemo(() => (data ?? []).filter((i) => i.kind === 'versions'), [data]);

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: 'deleted', label: '已删除', count: deleted.length },
    { key: 'history', label: '历史记录', count: history.length },
    { key: 'versions', label: '历史版本', count: versions.length },
  ];

  const items = tab === 'deleted' ? deleted : tab === 'history' ? history : versions;

  return (
    <div className="archive-page">
      <h2><Archive size={18} /> 归档中心</h2>
      <p className="muted small">误删或想找回历史内容时，可在此恢复或彻底删除。</p>

      <div className="archive-tabs">
        {tabs.map((t) => (
          <TabButton key={t.key} active={tab === t.key} onClick={() => setTab(t.key)}>
            {t.label}（{t.count}）
          </TabButton>
        ))}
      </div>

      {isLoading ? (
        <p className="muted small">加载中…</p>
      ) : items.length === 0 ? (
        <EmptyState icon={<Archive size={32} />} title="暂无内容" hint="该分类下没有记录" />
      ) : (
        <div>
          {tab === 'deleted' && (
            <div className="archive-group">
              <h4>建议</h4>
              <div className="archive-row">
                <span>定期清理已删除条目，避免占用回收站空间</span>
                <span className="tag">提示</span>
              </div>
              <div className="archive-row">
                <span>恢复的内容会回到原位置，删除的名称以「(恢复)」结尾</span>
                <span className="tag">提示</span>
              </div>
              <div className="archive-row">
                <span>彻底删除后无法找回，请谨慎操作</span>
                <span className="tag">提示</span>
              </div>
            </div>
          )}
          {items.map((it: ArchiveItem) => (
            <div className="archive-row" key={it.id}>
              <div className="archive-item-main">
                <div className="archive-item-title">{it.title}</div>
                <div className="muted small">{new Date(it.deletedAt).toLocaleString('zh-CN')}</div>
              </div>
              <div className="archive-item-actions">
                <button className="ghost sm" onClick={() => restoreArchiveItem(workspace.id, it.id)}><History size={14} /> 恢复</button>
                <button className="ghost sm danger" onClick={() => deleteArchiveItem(workspace.id, it.id)}><Trash2 size={14} /> 彻底删除</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
