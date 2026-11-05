// Deprecated: the navigation module no longer renders a shell-level sidebar.
// Its controls now live in NavView's own .nav-controlbar and call handlers
// directly. This file is kept for reference (and is no longer imported), so the
// CustomEvent dispatch below is intentionally unused.
import { useQuery } from '@tanstack/react-query';
import { Compass, Plus, Pencil, Search } from 'lucide-react';
import type { Workspace } from '../../types';
import { listNav, type NavGroup } from '../nav/api';
import { getSearchEngines } from '../nav/api';

function dispatch(name: string, detail?: unknown) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

export function NavSidebar({ workspace }: { workspace: Workspace | null }) {
  const wsId = workspace?.id;
  const groupsQ = useQuery({
    queryKey: ['nav-groups', wsId],
    enabled: !!wsId,
    queryFn: () => listNav(),
  });
  const enginesQ = useQuery({
    queryKey: ['nav-engines', wsId],
    enabled: !!wsId,
    queryFn: () => getSearchEngines(),
  });

  const groups: NavGroup[] = groupsQ.data?.groups ?? [];
  const engines = enginesQ.data?.engines ?? [];
  const engine = engines.find((e) => e.isDefault) ?? engines[0];

  return (
    <aside className="sidebar nav-sidebar">
      <div className="sb-head">
        <span className="sb-title">
          <Compass size={15} /> 常用导航
        </span>
      </div>

      <button className="sb-engine" onClick={() => dispatch('nav:engine')}>
        <Search size={14} />
        <span>{engine ? `搜索：${engine.name}` : '设置搜索引擎'}</span>
      </button>

      <div className="sb-scroll">
        {groups.map((g) => (
          <div className="sb-nav-group" key={g.id}>
            <button className="sb-group-btn" title={g.title} onClick={() => dispatch('nav:scroll-to-group', { groupId: g.id })}>
              <span className="sb-group-name">{g.title}</span>
              <span className="sb-count">{g.links.length}</span>
            </button>
          </div>
        ))}
      </div>

      <div className="sb-foot">
        <button className="sb-foot-btn" onClick={() => dispatch('nav:add-group')}>
          <Plus size={15} /> 新增分组
        </button>
        <button className="sb-foot-btn" onClick={() => dispatch('nav:add-link')}>
          <Plus size={15} /> 新增网址
        </button>
        <button className="sb-foot-btn" onClick={() => dispatch('nav:toggle-edit')}>
          <Pencil size={15} /> 编辑模式
        </button>
      </div>
    </aside>
  );
}
