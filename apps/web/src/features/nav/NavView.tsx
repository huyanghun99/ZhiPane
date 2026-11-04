import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Search, Download, Upload, Pencil, Trash2, Check, X, Settings as SettingsIcon, Clock
} from 'lucide-react';
import { useToast } from '../../components/Toast';
import {
  listNav, createGroup, updateGroup, deleteGroup, createLink, updateLink, deleteLink,
  recordOpen, reorderNav, getSearchEngines, setSearchEngine, exportNav, importNav,
  type NavGroup, type SearchEngine, buildSearchUrl, firstChar
} from './api';

const DEFAULT_ENGINE: SearchEngine = { id: '', workspaceId: '', name: 'Bing', urlTemplate: 'https://cn.bing.com/search?q=%s', isDefault: true };

/** Isolated clock — owns its own 1s tick so the whole nav tree doesn't
 *  re-render every second just to refresh the time display. */
function NavClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const clock = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const dateStr = now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  return (
    <header className="nav-header">
      <div className="nav-clock">{clock}</div>
      <div className="nav-date">{dateStr}</div>
    </header>
  );
}

export function NavView({ workspace }: { workspace: { id: string } }) {
  const qc = useQueryClient();
  const toast = useToast();
  const workspaceId = workspace.id;

  const { data, isLoading } = useQuery({
    queryKey: ['nav', workspaceId],
    queryFn: () => listNav()
  });
  const { data: engineData } = useQuery({
    queryKey: ['nav-engine', workspaceId],
    queryFn: () => getSearchEngines()
  });

  const groups: NavGroup[] = useMemo(() => data?.groups ?? [], [data]);
  const engines: SearchEngine[] = useMemo(() => engineData?.engines ?? [DEFAULT_ENGINE], [engineData]);
  const activeEngine = useMemo(() => engines.find((e) => e.isDefault) ?? engines[0] ?? DEFAULT_ENGINE, [engines]);

  const [editMode, setEditMode] = useState(false);
  const [search, setSearch] = useState('');
  const [engineModal, setEngineModal] = useState(false);
  const [engineDraft, setEngineDraft] = useState({ name: '', urlTemplate: '' });

  // mutations
  const invalidate = useCallback(() => qc.invalidateQueries({ queryKey: ['nav', workspaceId] }), [qc, workspaceId]);

  const createGroupMut = useMutation({ mutationFn: (title: string) => createGroup(title, groups.length), onSuccess: invalidate });
  const updateGroupMut = useMutation({ mutationFn: ({ id, title }: { id: string; title: string }) => updateGroup(id, { title }), onSuccess: invalidate });
  const deleteGroupMut = useMutation({ mutationFn: (id: string) => deleteGroup(id), onSuccess: invalidate });

  const createLinkMut = useMutation({
    mutationFn: ({ groupId, name, url }: { groupId: string; name: string; url: string }) => {
      const g = groups.find((x) => x.id === groupId);
      return createLink(groupId, { name, url, iconChar: firstChar(name), position: g ? g.links.length : 0 });
    },
    onSuccess: invalidate
  });
  const updateLinkMut = useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; url?: string; iconChar?: string | null }) => updateLink(id, body),
    onSuccess: invalidate
  });
  const deleteLinkMut = useMutation({ mutationFn: (id: string) => deleteLink(id), onSuccess: invalidate });
  const reorderMut = useMutation({ mutationFn: reorderNav, onSuccess: invalidate });
  const engineMut = useMutation({
    mutationFn: setSearchEngine,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['nav-engine', workspaceId] }); setEngineModal(false); toast.success('搜索引擎已保存'); }
  });

  // search submit
  const onSearch = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    const q = search.trim();
    if (!q) return;
    window.open(buildSearchUrl(activeEngine.urlTemplate, q), '_blank');
    setSearch('');
  };

  // open link (record + navigate)
  const onOpenLink = (id: string, url: string) => {
    if (editMode) return;
    recordOpen(id);
    window.open(url, '_blank');
  };

  // ----- modals (add site / add group) -----
  const [siteModal, setSiteModal] = useState<{ groupId: string; linkId: string | null } | null>(null);
  const [siteName, setSiteName] = useState('');
  const [siteUrl, setSiteUrl] = useState('');
  const [groupModal, setGroupModal] = useState<string | null>(null); // null=new, id=rename
  const [groupName, setGroupName] = useState('');

  const openSiteModal = (groupId: string, linkId: string | null) => {
    const link = linkId ? groups.flatMap((g) => g.links).find((l) => l.id === linkId) : null;
    setSiteName(link?.name ?? '');
    setSiteUrl(link?.url ?? '');
    setSiteModal({ groupId, linkId });
  };
  const saveSite = () => {
    if (!siteModal || !siteName.trim() || !siteUrl.trim()) return;
    let url = siteUrl.trim();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    if (siteModal.linkId) {
      updateLinkMut.mutate({ id: siteModal.linkId, name: siteName.trim(), url });
    } else {
      createLinkMut.mutate({ groupId: siteModal.groupId, name: siteName.trim(), url });
    }
    setSiteModal(null);
  };
  const openGroupModal = (id: string | null) => {
    setGroupName(id ? (groups.find((g) => g.id === id)?.title ?? '') : '');
    setGroupModal(id);
  };
  const saveGroup = () => {
    if (!groupName.trim()) return;
    if (groupModal) updateGroupMut.mutate({ id: groupModal, title: groupName.trim() });
    else createGroupMut.mutate(groupName.trim());
    setGroupModal(null);
  };

  // ----- drag & drop -----
  const dragRef = useRef<{ type: 'card' | 'group'; groupId?: string; linkId?: string; index?: number } | null>(null);
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);

  const moveCard = (sGroupId: string, sIdx: number, tGroupId: string, tIdx: number) => {
    const sGroup = groups.find((g) => g.id === sGroupId);
    const tGroup = groups.find((g) => g.id === tGroupId);
    if (!sGroup || !tGroup) return;
    const moved = sGroup.links[sIdx];
    const nextGroups = groups.map((g) => ({ ...g, links: [...g.links] }));
    const sg = nextGroups.find((g) => g.id === sGroupId)!;
    const tg = nextGroups.find((g) => g.id === tGroupId)!;
    sg.links.splice(sIdx, 1);
    tg.links.splice(tIdx, 0, moved);
    // optimistic order + persist
    const linkOrders = nextGroups.flatMap((g) =>
      g.links.map((l, i) => ({ id: l.id, groupId: g.id, position: i }))
    );
    const groupOrders = nextGroups.map((g, i) => ({ id: g.id, position: i }));
    qc.setQueryData(['nav', workspaceId], { groups: nextGroups });
    reorderMut.mutate({ groups: groupOrders, links: linkOrders });
  };
  const moveGroup = (sIdx: number, tIdx: number) => {
    if (sIdx === tIdx) return;
    const next = [...groups];
    const [m] = next.splice(sIdx, 1);
    next.splice(tIdx, 0, m);
    qc.setQueryData(['nav', workspaceId], { groups: next });
    reorderMut.mutate({ groups: next.map((g, i) => ({ id: g.id, position: i })) });
  };

  // export / import
  const onExport = async () => {
    try {
      const data = await exportNav();
      const blob = new Blob([JSON.stringify(data.groups, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `zhipane_nav_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
    } catch { toast.error('导出失败'); }
  };
  const fileRef = useRef<HTMLInputElement>(null);
  const onImportFile = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error('格式错误');
      await importNav(parsed.map((g: { title: string; links?: { name: string; url: string; iconChar?: string }[] }) => ({
        title: g.title, links: (g.links ?? []).map((l) => ({ name: l.name, url: l.url, iconChar: l.iconChar }))
      })));
      invalidate();
      toast.success('导航数据已导入');
    } catch { toast.error('导入失败：文件格式错误'); }
  };

  return (
    <div className="nav-view">
      <NavClock />

      <div className="nav-searchwrap">
        <Search size={20} className="nav-search-icon" />
        <input
          className="nav-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={onSearch}
          placeholder={`使用 ${activeEngine.name} 搜索…`}
        />
        <button className="nav-engine-btn" title="搜索引擎设置" onClick={() => { setEngineDraft({ name: activeEngine.name, urlTemplate: activeEngine.urlTemplate }); setEngineModal(true); }}>
          <SettingsIcon size={16} />
        </button>
      </div>

      {isLoading ? (
        <div className="nav-loading">加载中…</div>
      ) : (
        <div className="nav-container">
          {groups.length === 0 && !editMode && (
            <div className="nav-empty">
              <p>还没有导航分组。</p>
              <button className="btn-primary" onClick={() => openGroupModal(null)}><Plus size={14} /> 新建分组</button>
            </div>
          )}
          {groups.map((group, gIndex) => (
            <section
              key={group.id}
              className={`nav-group ${dragOverGroup === group.id ? 'drag-over' : ''}`}
              onDragOver={editMode ? (e) => { e.preventDefault(); setDragOverGroup(group.id); } : undefined}
              onDragLeave={editMode ? () => setDragOverGroup(null) : undefined}
              onDrop={editMode ? (e) => {
                e.preventDefault(); setDragOverGroup(null);
                const d = dragRef.current;
                if (d?.type === 'group') moveGroup(d.index!, gIndex);
                else if (d?.type === 'card') moveCard(d.groupId!, d.index!, group.id, group.links.length);
              } : undefined}
            >
              <div
                className="nav-group-head"
                draggable={editMode}
                onDragStart={editMode ? (e) => { dragRef.current = { type: 'group', index: gIndex }; (e.target as HTMLElement).classList.add('dragging'); } : undefined}
              >
                <span className="nav-group-title">{group.title}</span>
                {editMode && (
                  <span className="nav-group-actions">
                    <button className="nav-mini" onClick={() => openGroupModal(group.id)}><Pencil size={12} /></button>
                    <button className="nav-mini danger" onClick={() => { if (confirm('删除分组及全部链接？')) deleteGroupMut.mutate(group.id); }}><Trash2 size={12} /></button>
                  </span>
                )}
              </div>
              <div className="nav-grid">
                {group.links.map((link, lIndex) => (
                  <div
                    key={link.id}
                    className="nav-card"
                    draggable={editMode}
                    onDragStart={editMode ? (e) => { dragRef.current = { type: 'card', groupId: group.id, linkId: link.id, index: lIndex }; (e.target as HTMLElement).classList.add('dragging'); } : undefined}
                    onDragOver={editMode ? (e) => e.preventDefault() : undefined}
                    onDrop={editMode ? (e) => {
                      e.preventDefault(); e.stopPropagation();
                      const d = dragRef.current;
                      if (d?.type === 'card') moveCard(d.groupId!, d.index!, group.id, lIndex);
                    } : undefined}
                    onClick={() => onOpenLink(link.id, link.url)}
                  >
                    {editMode && (
                      <>
                        <button className="nav-card-del" onClick={(e) => { e.stopPropagation(); if (confirm('删除该链接？')) deleteLinkMut.mutate(link.id); }}>×</button>
                        <div className="nav-card-edit" onClick={(e) => { e.stopPropagation(); openSiteModal(group.id, link.id); }} />
                      </>
                    )}
                    <div className="nav-text-icon">{link.iconChar || firstChar(link.name)}</div>
                    <span>{link.name}</span>
                  </div>
                ))}
                {editMode && (
                  <div className="nav-card nav-add" onClick={() => openSiteModal(group.id, null)}>
                    <Plus size={24} />
                  </div>
                )}
              </div>
            </section>
          ))}
        </div>
      )}

      <div className="nav-controlbar">
        <button className="nav-ctrl" onClick={onExport}><Download size={16} /> 备份</button>
        <button className="nav-ctrl" onClick={() => fileRef.current?.click()}><Upload size={16} /> 恢复</button>
        <input ref={fileRef} type="file" accept=".json" style={{ display: 'none' }} onChange={(e) => { if (e.target.files?.[0]) onImportFile(e.target.files[0]); e.target.value = ''; }} />
        {editMode && <button className="nav-ctrl" onClick={() => openGroupModal(null)}><Plus size={16} /> 分组</button>}
        <div className="nav-ctrl-sep" />
        <button className={`nav-ctrl ${editMode ? 'primary' : ''}`} onClick={() => setEditMode((v) => !v)}>{editMode ? <><Check size={16} /> 完成</> : <><Pencil size={16} /> 整理桌面</>}</button>
      </div>

      {/* site modal */}
      {siteModal && (
        <div className="nav-modal-overlay" onClick={() => setSiteModal(null)}>
          <div className="nav-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{siteModal.linkId ? '编辑网站' : '添加网站'}</h3>
            <div className="nav-form-group"><label>名称</label><input value={siteName} onChange={(e) => setSiteName(e.target.value)} placeholder="网站名称" autoFocus /></div>
            <div className="nav-form-group"><label>网址</label><input value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} placeholder="https://example.com" /></div>
            <div className="nav-modal-btns">
              <button className="nav-btn-cancel" onClick={() => setSiteModal(null)}>取消</button>
              <button className="nav-btn-confirm" onClick={saveSite}>确认</button>
            </div>
          </div>
        </div>
      )}
      {/* group modal */}
      {groupModal !== null && (
        <div className="nav-modal-overlay" onClick={() => setGroupModal(null)}>
          <div className="nav-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{groupModal ? '重命名分组' : '新建分组'}</h3>
            <div className="nav-form-group"><label>分组名称</label><input value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="分组名称" autoFocus /></div>
            <div className="nav-modal-btns">
              <button className="nav-btn-cancel" onClick={() => setGroupModal(null)}>取消</button>
              <button className="nav-btn-confirm" onClick={saveGroup}>确认</button>
            </div>
          </div>
        </div>
      )}
      {/* engine modal */}
      {engineModal && (
        <div className="nav-modal-overlay" onClick={() => setEngineModal(false)}>
          <div className="nav-modal" onClick={(e) => e.stopPropagation()}>
            <h3>搜索引擎设置</h3>
            <div className="nav-form-group"><label>名称</label><input value={engineDraft.name} onChange={(e) => setEngineDraft({ ...engineDraft, name: e.target.value })} placeholder="如 Bing / Google" /></div>
            <div className="nav-form-group"><label>搜索地址（用 %s 代替关键词）</label><input value={engineDraft.urlTemplate} onChange={(e) => setEngineDraft({ ...engineDraft, urlTemplate: e.target.value })} placeholder="https://cn.bing.com/search?q=%s" /></div>
            <p className="muted small">当前可用：{engines.map((e) => e.name).join('、') || 'Bing'}</p>
            <div className="nav-modal-btns">
              <button className="nav-btn-cancel" onClick={() => setEngineModal(false)}>取消</button>
              <button className="nav-btn-confirm" onClick={() => engineMut.mutate({ ...engineDraft, isDefault: true })}>保存为默认</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
