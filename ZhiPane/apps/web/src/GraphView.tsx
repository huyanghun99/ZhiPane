import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, post, patch } from './api';
import { Check, Network, X, Layers, Link2, ZoomIn, ZoomOut, Maximize2, RefreshCw } from 'lucide-react';

type GNode = { id: string; type: 'page' | 'topic'; label: string };
type GEdge = {
  id: string; source: string; target: string; relationType: string;
  confidence: number; status: string; evidence: Record<string, unknown>;
};
type GraphData = { nodes: GNode[]; edges: GEdge[] };
type SpaceLike = { id: string; name: string; workspaceId: string };

const RELATION_LABEL: Record<string, string> = {
  related: '相关', covers: '涵盖', references: '引用', derives: '派生', linked: '链接'
};
const STATUS_LABEL: Record<string, string> = {
  suggested: '待确认', confirmed: '已确认', deleted: '已删除', user_edited: '已编辑'
};

/* ----------------------------------------------- force-directed layout ---- */
interface P { x: number; y: number; vx: number; vy: number; fixed?: boolean }
function useForceLayout(nodes: GNode[], edges: GEdge[], w: number, h: number) {
  const [, setTick] = useState(0);
  const pos = useRef<Map<string, P>>(new Map());
  const raf = useRef<number | null>(null);
  const alpha = useRef(1);
  const reheat = () => { alpha.current = Math.max(alpha.current, 0.6); };

  useEffect(() => {
    const cx = w / 2, cy = h / 2;
    const ids = new Set(nodes.map((n) => n.id));
    for (const n of nodes) {
      if (!pos.current.has(n.id)) {
        const a = Math.random() * Math.PI * 2;
        const r = 70 + Math.random() * 140;
        pos.current.set(n.id, { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, vx: 0, vy: 0 });
      }
    }
    for (const k of [...pos.current.keys()]) if (!ids.has(k)) pos.current.delete(k);
    alpha.current = 0.9;
  }, [nodes, w, h]);

  useEffect(() => {
    const step = () => {
      const map = pos.current;
      const arr = nodes.map((n) => map.get(n.id)).filter(Boolean) as P[];
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const a = arr[i], b = arr[j];
          let dx = a.x - b.x, dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) { dx = Math.random(); dy = Math.random(); d2 = dx * dx + dy * dy; }
          const d = Math.sqrt(d2);
          const rep = 2600 / d2;
          const fx = (dx / d) * rep, fy = (dy / d) * rep;
          a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
        }
      }
      for (const e of edges) {
        const a = map.get(e.source), b = map.get(e.target);
        if (!a || !b) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const k = 0.025 * (d - 150);
        const fx = (dx / d) * k, fy = (dy / d) * k;
        a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
      }
      for (const n of nodes) {
        const p = map.get(n.id);
        if (!p) continue;
        p.vx += (w / 2 - p.x) * 0.0025;
        p.vy += (h / 2 - p.y) * 0.0025;
        if (p.fixed) { p.vx = 0; p.vy = 0; continue; }
        p.vx *= 0.84; p.vy *= 0.84;
        p.x += p.vx * alpha.current;
        p.y += p.vy * alpha.current;
      }
      alpha.current *= 0.985;
      if (alpha.current < 0.02) { setTick((t) => t + 1); return; }
      setTick((t) => t + 1);
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, [nodes, edges, w, h]);

  return { pos: pos.current, reheat };
}

/* ----------------------------------------------------------- Evidence card ---- */
function EvidenceCard({ edge, spaceId, sourceLabel, targetLabel, onClose }: {
  edge: GEdge; spaceId: string; sourceLabel: string; targetLabel: string; onClose: () => void;
}) {
  const qc = useQueryClient();
  const [relation, setRelation] = useState(edge.relationType);
  const [confidence, setConfidence] = useState(edge.confidence);

  const accept = useMutation({
    mutationFn: () => post(`/api/graph/edges/${edge.id}/accept`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['graph', spaceId] })
  });
  const reject = useMutation({
    mutationFn: () => post(`/api/graph/edges/${edge.id}/reject`, {}),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['graph', spaceId] }); onClose(); }
  });
  const save = useMutation({
    mutationFn: () => patch(`/api/graph/edges/${edge.id}`, { relationType: relation, confidence }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['graph', spaceId] })
  });

  const evidenceEntries = Object.entries(edge.evidence ?? {});

  return (
    <aside className="evidence-card">
      <header className="evidence-head">
        <b>关系证据</b>
        <button className="icon-btn" onClick={onClose}><X size={15} /></button>
      </header>
      <div className="evidence-body">
        <div className="evidence-rel">
          <span className="ev-node">{sourceLabel}</span>
          <span className={`ev-arrow status-${edge.status}`}>
            <Link2 size={13} /> {RELATION_LABEL[edge.relationType] ?? edge.relationType}
          </span>
          <span className="ev-node">{targetLabel}</span>
        </div>

        <div className="ev-field">
          <label>关系类型</label>
          <select value={relation} onChange={(e) => setRelation(e.target.value)}>
            {Object.entries(RELATION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>

        <div className="ev-field">
          <label>置信度：<b>{confidence}%</b></label>
          <input type="range" min={0} max={100} value={confidence} onChange={(e) => setConfidence(Number(e.target.value))} />
        </div>

        <div className="ev-field">
          <label>状态</label>
          <span className={`tag status-${edge.status}`}>{STATUS_LABEL[edge.status] ?? edge.status}</span>
        </div>

        <div className="ev-field">
          <label>证据</label>
          {evidenceEntries.length === 0 && <p className="muted small">（无结构化证据）</p>}
          {evidenceEntries.map(([k, v]) => (
            <div className="ev-row" key={k}>
              <span className="ev-key">{k}</span>
              <span className="ev-val">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
            </div>
          ))}
        </div>
      </div>

      <footer className="evidence-actions">
        <button className="ghost ok sm" disabled={save.isPending} onClick={() => save.mutate()}><Check size={14} /> 保存</button>
        <div className="spacer" />
        <button className="ghost danger sm" disabled={reject.isPending} onClick={() => reject.mutate()}><X size={14} /> 拒绝</button>
        <button className="primary sm" disabled={accept.isPending || edge.status === 'confirmed'} onClick={() => accept.mutate()}><Check size={14} /> 确认</button>
      </footer>
    </aside>
  );
}

/* --------------------------------------------------------------- Graph view ---- */
export function GraphView({ space, onOpenPage }: { space: SpaceLike; onOpenPage: (id: string) => void }) {
  const qc = useQueryClient();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [tf, setTf] = useState({ x: 0, y: 0, k: 1 });
  const [selEdge, setSelEdge] = useState<GEdge | null>(null);
  const [selTopic, setSelTopic] = useState<string | null>(null);

  const { data, isLoading } = useQuery<GraphData>({
    queryKey: ['graph', space.id], queryFn: () => api(`/api/graph/space/${space.id}`), refetchInterval: 6000
  });
  const nodes = data?.nodes ?? [];
  const edges = data?.edges ?? [];
  const { pos, reheat } = useForceLayout(nodes, edges, size.w, size.h);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const labelOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of nodes) m.set(n.id, n.label);
    return m;
  }, [nodes]);

  const drag = useRef<{ id: string; mode: 'node' | 'pan' } | null>(null);
  const last = useRef({ x: 0, y: 0 });

  const toGraph = (sx: number, sy: number) => ({ x: (sx - tf.x) / tf.k, y: (sy - tf.y) / tf.k });

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const rect = wrapRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const k2 = Math.min(3, Math.max(0.3, tf.k * factor));
    setTf({ k: k2, x: mx - (mx - tf.x) * (k2 / tf.k), y: my - (my - tf.y) * (k2 / tf.k) });
  };

  const onDown = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    drag.current = { id, mode: 'node' };
    last.current = { x: e.clientX, y: e.clientY };
    const p = pos.get(id);
    if (p) p.fixed = true;
    reheat();
  };
  const onMoveBg = (e: React.MouseEvent) => {
    if (!drag.current) return;
    if (drag.current.mode === 'pan') {
      const dx = e.clientX - last.current.x, dy = e.clientY - last.current.y;
      last.current = { x: e.clientX, y: e.clientY };
      setTf((t) => ({ ...t, x: t.x + dx, y: t.y + dy }));
    } else {
      const p = pos.get(drag.current.id);
      if (p) {
        const g = toGraph(e.clientX, e.clientY);
        p.x = g.x; p.y = g.y; p.vx = 0; p.vy = 0;
      }
      reheat();
    }
  };
  const onUp = () => {
    if (drag.current?.mode === 'node') {
      const p = pos.get(drag.current.id);
      if (p) p.fixed = false;
    }
    drag.current = null;
  };

  const nodeClick = (n: GNode) => {
    if (n.type === 'page') onOpenPage(n.id);
    else setSelTopic((cur) => (cur === n.id ? null : n.id));
  };

  const reset = () => setTf({ x: 0, y: 0, k: 1 });

  const selectedTopic = nodes.find((n) => n.id === selTopic && n.type === 'topic');

  return (
    <div className="graph-view">
      <div className="graph-toolbar">
        <span className="graph-title"><Network2 /> 知识图谱</span>
        <span className="muted small">{nodes.length} 节点 · {edges.length} 关系</span>
        <div className="spacer" />
        <button className="icon-btn" title="适应视图" onClick={reset}><Maximize2 size={15} /></button>
        <button className="icon-btn" title="放大" onClick={() => setTf((t) => ({ ...t, k: Math.min(3, t.k * 1.15) }))}><ZoomIn size={15} /></button>
        <button className="icon-btn" title="缩小" onClick={() => setTf((t) => ({ ...t, k: Math.max(0.3, t.k * 0.87) }))}><ZoomOut size={15} /></button>
        <button className="icon-btn" title="刷新" onClick={() => qc.invalidateQueries({ queryKey: ['graph', space.id] })}><RefreshCw size={15} /></button>
      </div>

      <div className="graph-stage" ref={wrapRef}
        onWheel={onWheel}
        onMouseDown={(e) => { drag.current = { id: '', mode: 'pan' }; last.current = { x: e.clientX, y: e.clientY }; }}
        onMouseMove={onMoveBg}
        onMouseUp={onUp}
        onMouseLeave={onUp}
      >
        {isLoading && <div className="graph-loading"><RefreshCw className="spin" size={22} /></div>}
        {!isLoading && nodes.length === 0 && (
          <div className="graph-empty">
            <Network size={40} />
            <p>图谱暂无数据</p>
            <span className="muted small">前往「LLM Wiki」点击「重新生成」，即可从笔记中提炼主题与关联并构建图谱。</span>
          </div>
        )}

        <svg width={size.w} height={size.h} style={{ display: nodes.length ? 'block' : 'none' }}>
          <g transform={`translate(${tf.x},${tf.y}) scale(${tf.k})`}>
            {edges.map((e) => {
              const a = pos.get(e.source), b = pos.get(e.target);
              if (!a || !b) return null;
              const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
              const active = selEdge?.id === e.id;
              return (
                <g key={e.id} className={`gedge ${active ? 'active' : ''} status-${e.status}`}
                  onClick={(ev) => { ev.stopPropagation(); setSelEdge(e); setSelTopic(null); }}>
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
                  <circle cx={mx} cy={my} r={9} className="gedge-hit" />
                  <text x={mx} y={my + 3} className="gedge-label" textAnchor="middle">
                    {RELATION_LABEL[e.relationType] ?? e.relationType}
                  </text>
                </g>
              );
            })}
            {nodes.map((n) => {
              const p = pos.get(n.id);
              if (!p) return null;
              const isSel = (selTopic === n.id) || (selEdge && (selEdge.source === n.id || selEdge.target === n.id));
              return (
                <g key={n.id} className={`gnode ${n.type} ${isSel ? 'selected' : ''}`}
                  transform={`translate(${p.x},${p.y})`}
                  onMouseDown={(e) => onDown(e, n.id)}
                  onClick={(e) => { e.stopPropagation(); nodeClick(n); }}>
                  {n.type === 'topic'
                    ? <rect x={-46} y={-18} width={92} height={36} rx={9} className="gnode-shape" />
                    : <circle r={20} className="gnode-shape" />}
                  <text className="gnode-label" textAnchor="middle" y={n.type === 'topic' ? 5 : 4}>
                    {n.label.length > 8 ? n.label.slice(0, 7) + '…' : n.label}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>

        {selectedTopic && (
          <div className="topic-pop">
            <b><Layers size={13} /> {selectedTopic.label}</b>
            <span className="muted small">主题节点 · 相关关系 {edges.filter((e) => e.source === selectedTopic.id || e.target === selectedTopic.id).length}</span>
          </div>
        )}
      </div>

      {selEdge && (
        <EvidenceCard edge={selEdge} spaceId={space.id}
          sourceLabel={labelOf.get(selEdge.source) ?? selEdge.source}
          targetLabel={labelOf.get(selEdge.target) ?? selEdge.target}
          onClose={() => setSelEdge(null)} />
      )}
    </div>
  );
}

/* small inline icon to avoid extra import churn */
function Network2() {
  return <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx={12} cy={5} r={2} /><circle cx={5} cy={19} r={2} /><circle cx={19} cy={19} r={2} /><path d="M12 7v4M12 11l-5 6M12 11l5 6" /></svg>;
}
