import { useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { TaskCard } from './TaskCard';
import type { Task, TaskStatus, Project } from '../api';

interface KanbanViewProps {
  tasks: Task[];
  projects: Project[];
  onTaskUpdate: (id: string, updates: Partial<Task>) => void;
  onSelectTask: (task: Task) => void;
  onToggleStatus: (task: Task) => void;
  selectedTaskId?: string | null;
}

// `today` is a ZhiPane addition to ZenithFlow's column set.
const COLUMNS: { id: TaskStatus; label: string }[] = [
  { id: 'inbox', label: '收件箱' },
  { id: 'today', label: '今日' },
  { id: 'next', label: '下一步行动' },
  { id: 'scheduled', label: '日程' },
  { id: 'waiting', label: '等待' },
  { id: 'someday', label: '将来/也许' },
  { id: 'done', label: '已完成' }
];

const STORAGE_KEY = 'zhipane_kanban_collapsed';

export function KanbanView({
  tasks, projects, onTaskUpdate, onSelectTask, onToggleStatus, selectedTaskId
}: KanbanViewProps) {
  // Low-signal columns start collapsed so active work gets the space.
  const [collapsed, setCollapsed] = useState<Set<TaskStatus>>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) return new Set(JSON.parse(saved) as TaskStatus[]);
    } catch {
      /* corrupt value -> fall back to defaults */
    }
    return new Set<TaskStatus>(['waiting', 'someday', 'done']);
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...collapsed]));
  }, [collapsed]);

  const toggleCollapse = (status: TaskStatus) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  const handleDrop = (e: React.DragEvent, status: TaskStatus) => {
    e.preventDefault();
    const taskId = e.dataTransfer.getData('taskId');
    if (!taskId) return;
    // Dropping into "done" also fills the progress meter.
    onTaskUpdate(taskId, status === 'done' ? { status, progress: 100 } : { status });
  };

  const maxInCol = Math.max(...COLUMNS.map((c) => tasks.filter((t) => t.status === c.id).length), 1);

  return (
    <div className="kanban-view">
      <div className="kanban-cols">
        {COLUMNS.map((col) => {
          const columnTasks = tasks.filter((t) => t.status === col.id);
          const isCollapsed = collapsed.has(col.id);
          const load = Math.min(100, (columnTasks.length / maxInCol) * 100);

          if (isCollapsed) {
            return (
              <div
                key={col.id}
                className="kanban-col is-collapsed"
                onDrop={(e) => handleDrop(e, col.id)}
                onDragOver={(e) => e.preventDefault()}
              >
                <div className="kanban-col-rail">
                  <button className="icon-btn" title="展开列" onClick={() => toggleCollapse(col.id)}>
                    <ChevronRight size={16} />
                  </button>
                  <span className="kanban-count is-accent">{columnTasks.length}</span>
                </div>
                <div className="kanban-load">
                  <div className="kanban-load-fill" style={{ height: `${load}%` }} />
                </div>
                <div className="kanban-col-vtitle">{col.label}</div>
              </div>
            );
          }

          return (
            <div
              key={col.id}
              className="kanban-col"
              onDrop={(e) => handleDrop(e, col.id)}
              onDragOver={(e) => e.preventDefault()}
            >
              <div className="kanban-col-head">
                <div className="kanban-col-head-left">
                  <button className="icon-btn" title="收起列" onClick={() => toggleCollapse(col.id)}>
                    <ChevronLeft size={16} />
                  </button>
                  <span className="kanban-col-title">{col.label}</span>
                </div>
                <span className="kanban-count">{columnTasks.length}</span>
              </div>

              <div className="kanban-col-body">
                {columnTasks.map((task) => {
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
                    />
                  );
                })}
                {columnTasks.length === 0 && <div className="kanban-empty">空空如也</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
