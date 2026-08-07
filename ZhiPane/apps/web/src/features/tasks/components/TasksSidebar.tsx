import { useState } from 'react';
import {
  Inbox, Layers, Archive, Calendar as CalendarIcon, Zap, Flame,
  FolderPlus, Trash2, Edit2, Plus
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { TaskCard } from './TaskCard';
import { ProjectModal } from './ProjectModal';
import type { Task, TaskStatus, Project } from '../api';

/** Either a GTD status bucket or a `p_<projectId>` selection. */
export type TaskFilter = TaskStatus | 'all' | `p_${string}`;

interface TasksSidebarProps {
  tasks: Task[];
  projects: Project[];
  filter: TaskFilter;
  onFilterChange: (f: TaskFilter) => void;
  onAddTask: (title: string) => void;
  onSelectTask: (task: Task) => void;
  onToggleStatus: (task: Task) => void;
  onAddProject: (name: string, color: string) => void;
  onUpdateProject: (id: string, updates: Partial<Project>) => void;
  onDeleteProject: (project: Project) => void;
  selectedTaskId?: string | null;
}

const NAV: { icon: LucideIcon; label: string; value: TaskStatus }[] = [
  { icon: Inbox, label: '收件箱', value: 'inbox' },
  { icon: Flame, label: '今日', value: 'today' },
  { icon: Zap, label: '下一步行动', value: 'next' },
  { icon: CalendarIcon, label: '日程', value: 'scheduled' },
  { icon: Layers, label: '等待', value: 'waiting' },
  { icon: Archive, label: '将来/也许', value: 'someday' }
];

export function TasksSidebar({
  tasks, projects, filter, onFilterChange, onAddTask, onSelectTask, onToggleStatus,
  onAddProject, onUpdateProject, onDeleteProject, selectedTaskId
}: TasksSidebarProps) {
  const [quickTitle, setQuickTitle] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);

  const activeProjects = projects.filter((p) => !p.archived);
  const archivedProjects = projects.filter((p) => p.archived);

  const filtered = tasks.filter((t) => {
    if (typeof filter === 'string' && filter.startsWith('p_')) {
      return t.projectId === filter.slice(2) && t.status !== 'done';
    }
    if (filter === 'all') return t.status !== 'done';
    return t.status === filter;
  });

  const listTitle =
    typeof filter === 'string' && filter.startsWith('p_')
      ? projects.find((p) => `p_${p.id}` === filter)?.name ?? '项目任务'
      : NAV.find((n) => n.value === filter)?.label ?? '所有活动任务';

  return (
    <aside className="tasks-sidebar">
      <ProjectModal
        isOpen={modalOpen}
        project={editing}
        onClose={() => setModalOpen(false)}
        onSave={(name, color) => {
          if (editing) onUpdateProject(editing.id, { name, color });
          else onAddProject(name, color);
        }}
      />

      <div className="ts-quickadd">
        <Plus size={14} />
        <input
          value={quickTitle}
          onChange={(e) => setQuickTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && quickTitle.trim()) {
              onAddTask(quickTitle.trim());
              setQuickTitle('');
            }
          }}
          placeholder="快速收集任务…"
        />
      </div>

      <div className="ts-scroll">
        <nav className="ts-nav">
          {NAV.map(({ icon: Icon, label, value }) => {
            const count = tasks.filter((t) => t.status === value).length;
            return (
              <button
                key={value}
                className={`ts-nav-item${filter === value ? ' is-active' : ''}`}
                onClick={() => onFilterChange(value)}
              >
                <span className="ts-nav-label"><Icon size={16} /> {label}</span>
                {count > 0 && <span className="ts-nav-count">{count}</span>}
              </button>
            );
          })}
        </nav>

        <div className="ts-projects">
          <div className="ts-projects-head">
            <span>项目</span>
            <button
              className="icon-btn"
              title="新建项目"
              onClick={() => { setEditing(null); setModalOpen(true); }}
            >
              <FolderPlus size={14} />
            </button>
          </div>

          {activeProjects.map((p) => (
            <div
              key={p.id}
              className={`ts-project${filter === `p_${p.id}` ? ' is-active' : ''}`}
              onClick={() => onFilterChange(`p_${p.id}`)}
            >
              <span className="ts-project-name">
                <span className="ts-project-dot" style={{ background: p.color }} />
                {p.name}
              </span>
              <span className="ts-project-actions">
                <button
                  className="icon-btn"
                  title="编辑"
                  onClick={(e) => { e.stopPropagation(); setEditing(p); setModalOpen(true); }}
                >
                  <Edit2 size={12} />
                </button>
                <button
                  className="icon-btn"
                  title="归档"
                  onClick={(e) => { e.stopPropagation(); onUpdateProject(p.id, { archived: true }); }}
                >
                  <Archive size={12} />
                </button>
                <button
                  className="icon-btn danger"
                  title="删除"
                  onClick={(e) => { e.stopPropagation(); onDeleteProject(p); }}
                >
                  <Trash2 size={12} />
                </button>
              </span>
            </div>
          ))}

          {archivedProjects.length > 0 && (
            <button className="ts-archive-toggle" onClick={() => setShowArchived((v) => !v)}>
              {showArchived ? '隐藏已归档' : `显示已归档 (${archivedProjects.length})`}
            </button>
          )}

          {showArchived && archivedProjects.map((p) => (
            <div key={p.id} className="ts-project is-archived">
              <span className="ts-project-name">{p.name}</span>
              <button
                className="icon-btn"
                title="取消归档"
                onClick={() => onUpdateProject(p.id, { archived: false })}
              >
                <Archive size={12} />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="ts-list">
        <h3 className="ts-list-head">{listTitle}</h3>
        <div className="ts-list-body">
          {filtered.length === 0 && <div className="ts-list-empty">空空如也</div>}
          {filtered.map((task) => {
            const project = projects.find((p) => p.id === task.projectId);
            return (
              <TaskCard
                key={task.id}
                task={task}
                projectColor={project?.color}
                projectName={project?.name}
                onSelect={onSelectTask}
                onToggleStatus={onToggleStatus}
                selected={selectedTaskId === task.id}
                compact
              />
            );
          })}
        </div>
      </div>
    </aside>
  );
}
