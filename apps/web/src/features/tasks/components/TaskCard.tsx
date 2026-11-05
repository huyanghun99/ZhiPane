import { CheckCircle, Circle, Clock, Tag, Layers } from 'lucide-react';
import type { Task } from '../api';
import { RECURRENCE_LABELS } from '../api';

interface TaskCardProps {
  task: Task;
  projectColor?: string;
  projectName?: string;
  onSelect: (task: Task) => void;
  onToggleStatus: (task: Task) => void;
  compact?: boolean;
  selected?: boolean;
}

export function TaskCard({
  task, projectColor, projectName, onSelect, onToggleStatus, compact = false, selected = false
}: TaskCardProps) {
  const isDone = task.status === 'done';

  return (
    <div
      draggable
      onDragStart={(e) => {
        // 'taskId' is the contract used by the calendar and kanban drop zones;
        // text/plain is a fallback for browsers that drop custom MIME types.
        e.dataTransfer.setData('taskId', task.id);
        e.dataTransfer.setData('text/plain', task.id);
        e.dataTransfer.effectAllowed = 'copyMove';
      }}
      onClick={() => onSelect(task)}
      className={[
        'task-card',
        isDone ? 'is-done' : '',
        compact ? 'is-compact' : '',
        selected ? 'is-selected' : ''
      ].filter(Boolean).join(' ')}
      style={projectColor ? { borderLeftWidth: 4, borderLeftColor: projectColor } : undefined}
    >
      {(task.parentTaskId || task.recurrenceUnit) && !compact && (
        <span className="task-card-badge" title="多段执行 / 重复任务">
          <Layers size={14} />
        </span>
      )}

      <div className="task-card-main">
        <button
          className={`task-card-check${isDone ? ' is-done' : ''}`}
          onClick={(e) => { e.stopPropagation(); onToggleStatus(task); }}
          aria-label={isDone ? '标记为未完成' : '标记为完成'}
        >
          {isDone ? <CheckCircle size={18} /> : <Circle size={18} />}
        </button>

        <div className="task-card-body">
          <h4 className="task-card-title">{task.title}</h4>
          {!compact && projectName && (
            <div className="task-card-project">
              <span className="task-card-dot" style={{ background: projectColor }} />
              <span>{projectName}</span>
            </div>
          )}
        </div>
      </div>

      {!compact && (
        <div className="task-card-meta">
          {task.progress > 0 && !isDone && (
            <div className="task-card-progress">
              <div
                className="task-card-progress-fill"
                style={{ width: `${task.progress}%`, background: projectColor || 'var(--primary)' }}
              />
            </div>
          )}

          <div className="task-card-tags">
            {task.estimatedDuration > 0 && (
              <span className="task-chip">
                <Clock size={10} /> {task.estimatedDuration}m
              </span>
            )}
            {task.context && (
              <span className="task-chip is-accent">
                <Tag size={10} /> {task.context}
              </span>
            )}
            {task.recurrenceUnit && (
              <span className="task-chip is-accent">
                重复：{RECURRENCE_LABELS[task.recurrenceUnit] ?? task.recurrenceUnit}
              </span>
            )}
            {task.tags?.map((t) => (
              <span key={t} className="task-chip">#{t}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
