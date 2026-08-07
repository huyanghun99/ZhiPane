import { useState, useEffect, useMemo } from 'react';
import {
  Sparkles, Clock, Bot, Calendar, PlusCircle, Repeat, History,
  Briefcase, ExternalLink, Trash2, ArrowRight, Flag
} from 'lucide-react';
import type { Task, Project, TaskStatus, TaskPriority, RecurrenceUnit } from '../api';
import { PRIORITY_META, aiBreakdown, aiPrioritize } from '../api';
import { addDays, format } from '../dateUtils';

interface RightPanelProps {
  task: Task | null;
  tasks: Task[];
  projects: Project[];
  onUpdateTask: (id: string, updates: Partial<Task>) => void;
  onAddTask: (title: string, overrides: Partial<Task>) => void;
  onDeleteTask: (id: string) => void;
  onAddSubtasks: (tasks: Partial<Task>[]) => void;
  onSelectTask: (task: Task | null) => void;
}

const URL_RE = /(https?:\/\/[^\s]+)/g;

/** Read-only notes view that linkifies URLs; click to switch to editing. */
function NotesView({ text, onClick }: { text: string; onClick: () => void }) {
  const parts = text.split(URL_RE);
  return (
    <div className="rp-notes-view" onClick={onClick}>
      {text
        ? parts.map((part, i) =>
            part.match(URL_RE) ? (
              <a
                key={i}
                href={part}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                {part} <ExternalLink size={10} />
              </a>
            ) : (
              <span key={i}>{part}</span>
            )
          )
        : <span className="rp-notes-empty">添加笔记、链接或说明…</span>}
    </div>
  );
}

export function RightPanel({
  task, tasks, projects, onUpdateTask, onAddTask, onDeleteTask, onAddSubtasks, onSelectTask
}: RightPanelProps) {
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [advice, setAdvice] = useState<{ id: string; reason: string }[] | null>(null);
  const [editingNotes, setEditingNotes] = useState(false);

  useEffect(() => {
    setEditingNotes(false);
    setAiError(null);
  }, [task?.id]);

  // All execution sessions belonging to this task's family, in time order.
  const sessions = useMemo(() => {
    if (!task) return [];
    const rootId = task.parentTaskId || task.id;
    return tasks
      .filter((t) => t.id === rootId || t.parentTaskId === rootId)
      .sort((a, b) => {
        const at = a.startDate ? new Date(a.startDate).getTime() : 0;
        const bt = b.startDate ? new Date(b.startDate).getTime() : 0;
        return at !== bt
          ? at - bt
          : new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      });
  }, [task, tasks]);

  const addSession = () => {
    if (!task) return;
    const rootId = task.parentTaskId || task.id;
    const start = task.startDate ? addDays(task.startDate, 1) : new Date();
    onAddTask(task.title, {
      projectId: task.projectId,
      context: task.context,
      parentTaskId: rootId,
      status: 'scheduled',
      startDate: start.toISOString(),
      endDate: task.endDate ? addDays(task.endDate, 1).toISOString() : null,
      estimatedDuration: task.estimatedDuration,
      tags: task.tags
    });
  };

  const runBreakdown = async () => {
    if (!task) return;
    setAiLoading(true);
    setAiError(null);
    try {
      const { subtasks } = await aiBreakdown({ title: task.title, notes: task.notes ?? undefined });
      if (subtasks.length) {
        onAddSubtasks(subtasks.map((s) => ({
          title: s.title,
          estimatedDuration: s.estimatedDuration,
          status: 'next' as TaskStatus,
          projectId: task.projectId,
          context: task.context,
          parentTaskId: task.id
        })));
      }
    } catch (e) {
      setAiError((e as Error).message);
    } finally {
      setAiLoading(false);
    }
  };

  const runPrioritize = async () => {
    setAiLoading(true);
    setAiError(null);
    try {
      const { ranking } = await aiPrioritize();
      setAdvice(ranking);
    } catch (e) {
      setAiError((e as Error).message);
    } finally {
      setAiLoading(false);
    }
  };

  /** Apply an HH:mm value onto the existing date part of startDate/endDate. */
  const setTime = (field: 'startDate' | 'endDate', value: string) => {
    if (!task || !value) return;
    const [h, m] = value.split(':').map(Number);
    const base = task[field] ? new Date(task[field]!) : new Date();
    base.setHours(h, m, 0, 0);
    onUpdateTask(task.id, { [field]: base.toISOString() });
  };

  return (
    <aside className="right-panel">
      <div className="rp-head">
        <Clock size={14} />
        <span>{task ? '任务详情' : '专注实验室'}</span>
      </div>

      <div className="rp-body">
        {!task ? (
          <div className="rp-empty">
            <div className="rp-empty-icon"><Bot size={32} /></div>
            <h3>专注实验室</h3>
            <p>让 AI 帮你理清今天的重心</p>

            <button className="btn-secondary rp-ai-btn" onClick={runPrioritize} disabled={aiLoading}>
              {aiLoading ? '分析中…' : <><Sparkles size={16} /> 分析当日重心</>}
            </button>

            {aiError && <div className="rp-ai-error">{aiError}</div>}

            {advice && advice.length > 0 && (
              <div className="rp-advice">
                <h4><Sparkles size={14} /> AI 智能教练建议</h4>
                <ol>
                  {advice.map((r) => {
                    const t = tasks.find((x) => x.id === r.id);
                    if (!t) return null;
                    return (
                      <li key={r.id}>
                        <button className="rp-advice-item" onClick={() => onSelectTask(t)}>
                          <strong>{t.title}</strong>
                          {r.reason && <span>{r.reason}</span>}
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </div>
            )}
          </div>
        ) : (
          <div className="rp-form">
            <div className="rp-field">
              <label>核心任务标题</label>
              <input
                className="rp-title-input"
                value={task.title}
                onChange={(e) => onUpdateTask(task.id, { title: e.target.value })}
                placeholder="任务名称…"
              />
            </div>

            <div className="rp-grid-2">
              <div className="rp-field">
                <label><Clock size={10} /> 状态</label>
                <select
                  value={task.status}
                  onChange={(e) => onUpdateTask(task.id, { status: e.target.value as TaskStatus })}
                >
                  <option value="inbox">📥 收件箱</option>
                  <option value="today">🔥 今日</option>
                  <option value="next">⚡ 下一步行动</option>
                  <option value="scheduled">📅 日程安排</option>
                  <option value="waiting">⏳ 等待中</option>
                  <option value="someday">💡 将来/也许</option>
                  <option value="done">✅ 已完成</option>
                </select>
              </div>
              <div className="rp-field">
                <label><Flag size={10} /> 优先级</label>
                <select
                  value={task.priority}
                  onChange={(e) => onUpdateTask(task.id, { priority: e.target.value as TaskPriority })}
                >
                  {(Object.keys(PRIORITY_META) as TaskPriority[]).map((p) => (
                    <option key={p} value={p}>{PRIORITY_META[p].label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="rp-grid-2">
              <div className="rp-field">
                <label><Repeat size={10} /> 循环周期</label>
                <select
                  value={task.recurrenceUnit ?? ''}
                  onChange={(e) =>
                    onUpdateTask(task.id, {
                      recurrenceUnit: (e.target.value || null) as RecurrenceUnit | null,
                      recurrenceInterval: e.target.value ? task.recurrenceInterval || 1 : null
                    })
                  }
                >
                  <option value="">不重复</option>
                  <option value="day">每日循环</option>
                  <option value="week">每周循环</option>
                  <option value="month">每月循环</option>
                  <option value="year">每年循环</option>
                </select>
              </div>
              <div className="rp-field">
                <label>预计时长 (分钟)</label>
                <input
                  type="number"
                  min={0}
                  step={5}
                  value={task.estimatedDuration}
                  onChange={(e) =>
                    onUpdateTask(task.id, { estimatedDuration: Math.max(0, Number(e.target.value) || 0) })
                  }
                />
              </div>
            </div>

            {task.recurrenceUnit && (
              <div className="rp-callout">
                <div className="rp-callout-head"><Repeat size={12} /> 循环截止日期</div>
                <input
                  type="date"
                  value={task.recurrenceEndDate ? format(task.recurrenceEndDate, 'yyyy-MM-dd') : ''}
                  onChange={(e) => {
                    if (!e.target.value) {
                      onUpdateTask(task.id, { recurrenceEndDate: null });
                      return;
                    }
                    const d = new Date(e.target.value);
                    d.setHours(23, 59, 59, 999);
                    onUpdateTask(task.id, { recurrenceEndDate: d.toISOString() });
                  }}
                />
                <p className="rp-hint">完成当前任务后，会按周期自动生成下一个实例。</p>
              </div>
            )}

            <div className="rp-field">
              <label><Briefcase size={10} /> 所属项目</label>
              <select
                value={task.projectId ?? ''}
                onChange={(e) => onUpdateTask(task.id, { projectId: e.target.value || null })}
              >
                <option value="">(无项目)</option>
                {projects.filter((p) => !p.archived).map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>

            <div className="rp-field">
              <label>进度 {task.progress}%</label>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={task.progress}
                onChange={(e) => onUpdateTask(task.id, { progress: Number(e.target.value) })}
              />
            </div>

            <div className="rp-section">
              <div className="rp-section-head">
                <label><History size={14} /> 分段执行计划</label>
                <button className="icon-btn" onClick={addSession} title="增加一个执行块">
                  <PlusCircle size={16} />
                </button>
              </div>
              <div className="rp-sessions">
                {sessions.map((s, i) => (
                  <button
                    key={s.id}
                    className={`rp-session${s.id === task.id ? ' is-active' : ''}`}
                    onClick={() => onSelectTask(s)}
                  >
                    <span className="rp-session-label">
                      <span className={`rp-session-dot${s.status === 'done' ? ' is-done' : ''}`} />
                      {!s.parentTaskId ? '原始主任务' : `行动分段 ${i + 1}`}
                      {s.status === 'done' && '（已完成）'}
                    </span>
                    <span className="rp-session-time">
                      {s.startDate ? format(s.startDate, 'MM/dd HH:mm') : '--/--'}
                    </span>
                  </button>
                ))}
                {sessions.length <= 1 && <div className="rp-sessions-empty">单次任务</div>}
              </div>
            </div>

            <div className="rp-field">
              <label><Calendar size={10} /> 执行时段</label>
              <div className="rp-timebox">
                <input
                  type="time"
                  value={task.startDate ? format(task.startDate, 'HH:mm') : ''}
                  onChange={(e) => setTime('startDate', e.target.value)}
                />
                <ArrowRight size={14} />
                <input
                  type="time"
                  value={task.endDate ? format(task.endDate, 'HH:mm') : ''}
                  onChange={(e) => setTime('endDate', e.target.value)}
                />
              </div>
              {task.startDate && (
                <div className="rp-date-chip">
                  选定日期：<strong>{format(task.startDate, 'yyyy-MM-dd')}</strong>
                </div>
              )}
            </div>

            <div className="rp-field">
              <label>上下文 / 标签</label>
              <input
                value={task.context ?? ''}
                placeholder="@电脑 / @外出"
                onChange={(e) => onUpdateTask(task.id, { context: e.target.value || null })}
              />
            </div>

            <div className="rp-field">
              <label>备注与细节</label>
              {editingNotes ? (
                <textarea
                  autoFocus
                  rows={8}
                  value={task.notes ?? ''}
                  placeholder="详情…"
                  onBlur={() => setEditingNotes(false)}
                  onChange={(e) => onUpdateTask(task.id, { notes: e.target.value })}
                />
              ) : (
                <NotesView text={task.notes ?? ''} onClick={() => setEditingNotes(true)} />
              )}
            </div>

            <div className="rp-section">
              <h4 className="rp-ai-title"><Sparkles size={14} /> AI 任务拆解</h4>
              <button className="btn-secondary rp-ai-btn" onClick={runBreakdown} disabled={aiLoading}>
                {aiLoading ? '正在生成…' : <><Bot size={16} /> 智能分解为子任务</>}
              </button>
              {aiError && <div className="rp-ai-error">{aiError}</div>}
            </div>

            <button className="rp-delete" onClick={() => onDeleteTask(task.id)}>
              <Trash2 size={16} /> 永久删除此任务
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
