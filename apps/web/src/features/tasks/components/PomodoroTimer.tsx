import { useState, useEffect, useRef } from 'react';
import { Timer, Play, Pause, RotateCcw, ChevronDown } from 'lucide-react';
import type { FocusKind } from '../api';

interface PomodoroTimerProps {
  /** Task the focus time is credited to, if any. */
  activeTaskId?: string | null;
  onSessionComplete: (input: { kind: FocusKind; durationSeconds: number; startedAt: string }) => void;
}

const PRESETS: { mins: number; label: string; kind: FocusKind }[] = [
  { mins: 25, label: '专注 25m', kind: 'focus' },
  { mins: 5, label: '短息 5m', kind: 'short_break' },
  { mins: 15, label: '长息 15m', kind: 'long_break' }
];

const RADIUS = 54;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

/** Short chime via WebAudio, so no audio asset is needed. */
function playChime() {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
  } catch {
    /* audio unavailable -> silent */
  }
}

export function PomodoroTimer({ activeTaskId, onSessionComplete }: PomodoroTimerProps) {
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState(PRESETS[0]);
  const [duration, setDuration] = useState(25 * 60);
  const [timeLeft, setTimeLeft] = useState(25 * 60);
  const [running, setRunning] = useState(false);
  // When the current run began, so a completed session can be persisted.
  const startedAtRef = useRef<string | null>(null);

  useEffect(() => {
    if (!running) return;

    if (timeLeft <= 0) {
      setRunning(false);
      playChime();
      if ('Notification' in window) {
        if (Notification.permission === 'granted') {
          new Notification('⏱️ 番茄钟时间到！', { body: '放松一下，准备下一次专注吧！' });
        } else if (Notification.permission !== 'denied') {
          void Notification.requestPermission();
        }
      }
      // Persist the finished session (focus time rolls onto the task).
      onSessionComplete({
        kind: preset.kind,
        durationSeconds: duration,
        startedAt: startedAtRef.current ?? new Date(Date.now() - duration * 1000).toISOString()
      });
      startedAtRef.current = null;
      return;
    }

    const id = setInterval(() => setTimeLeft((t) => t - 1), 1000);
    return () => clearInterval(id);
  }, [running, timeLeft, duration, preset.kind, onSessionComplete]);

  const toggle = () => {
    setRunning((prev) => {
      if (!prev && !startedAtRef.current) startedAtRef.current = new Date().toISOString();
      return !prev;
    });
  };

  const reset = () => {
    setRunning(false);
    setTimeLeft(duration);
    startedAtRef.current = null;
  };

  const selectPreset = (p: typeof PRESETS[number]) => {
    setRunning(false);
    setPreset(p);
    setDuration(p.mins * 60);
    setTimeLeft(p.mins * 60);
    startedAtRef.current = null;
  };

  const adjust = (mins: number) => {
    setTimeLeft((prev) => Math.max(5, prev + mins * 60));
    setDuration((prev) => Math.max(5, prev + mins * 60));
  };

  return (
    <div className="pomo">
      <button
        className={`pomo-trigger${running ? ' is-running' : ''}${open ? ' is-open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="番茄钟"
      >
        <Timer size={14} />
        <span className="pomo-trigger-time">{formatTime(timeLeft)}</span>
      </button>

      {open && (
        <>
          <div className="pomo-backdrop" onClick={() => setOpen(false)} />
          <div className="pomo-pop">
            <div className="pomo-pop-head">
              <Timer size={12} /> 专注番茄钟
              <button className="pomo-collapse" title="收起" onClick={() => setOpen(false)}><ChevronDown size={14} /></button>
            </div>

            <div className="pomo-dial">
              <svg viewBox="0 0 120 120">
                <circle className="pomo-dial-track" cx="60" cy="60" r={RADIUS} strokeWidth="5.5" fill="none" />
                <circle
                  className="pomo-dial-fill"
                  cx="60" cy="60" r={RADIUS} strokeWidth="5.5" fill="none" strokeLinecap="round"
                  strokeDasharray={CIRCUMFERENCE}
                  strokeDashoffset={CIRCUMFERENCE - (CIRCUMFERENCE * timeLeft) / duration}
                />
              </svg>
              <span className="pomo-dial-time">{formatTime(timeLeft)}</span>
            </div>

            <div className="pomo-controls">
              <button className={`pomo-play${running ? ' is-pause' : ''}`} onClick={toggle}>
                {running ? <Pause size={18} /> : <Play size={18} />}
              </button>
              <button className="pomo-reset" onClick={reset}>
                <RotateCcw size={16} />
              </button>
            </div>

            <div className="pomo-presets">
              {PRESETS.map((p) => (
                <button
                  key={p.mins}
                  className={`pomo-preset${preset.mins === p.mins ? ' is-active' : ''}`}
                  onClick={() => selectPreset(p)}
                >
                  {p.label}
                </button>
              ))}
            </div>

            <div className="pomo-adjust">
              <button onClick={() => adjust(-1)}>-1 分钟</button>
              <button onClick={() => adjust(1)}>+1 分钟</button>
              <button onClick={() => adjust(5)}>+5 分钟</button>
            </div>

            {activeTaskId && <div className="pomo-note">完成后将计入当前选中任务</div>}
          </div>
        </>
      )}
    </div>
  );
}
