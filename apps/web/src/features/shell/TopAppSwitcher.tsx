import { Moon, Monitor, Sun, Settings, LogOut, BookOpen, CheckSquare, Compass } from 'lucide-react';
import type { ThemeMode } from '../../theme';
import type { User } from '../../types';

export type ModuleKey = 'kb' | 'tasks' | 'nav';

const MODULES: { key: ModuleKey; label: string; icon: typeof BookOpen }[] = [
  { key: 'kb', label: '知识库', icon: BookOpen },
  { key: 'tasks', label: '任务', icon: CheckSquare },
  { key: 'nav', label: '导航', icon: Compass }
];

/**
 * Level-0 product switcher — always-on top bar that switches between the three
 * core modules. Replaces the old "独立模块" group that used to live inside the
 * (now-decomposed) LeftSidebar. The right side hosts the universal user
 * controls (theme / settings / logout) so they stay reachable from every module.
 */
export function TopAppSwitcher({
  module, onSwitch, me, onOpenSettings, onLogout, theme, onToggleTheme
}: {
  module: ModuleKey;
  onSwitch: (m: ModuleKey) => void;
  me: User;
  onOpenSettings: () => void;
  onLogout: () => void;
  theme: ThemeMode;
  onToggleTheme: () => void;
}) {
  return (
    <header className="top-appswitcher">
      <div className="appswitcher-modules">
        {MODULES.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            className={`appswitcher-btn${module === key ? ' active' : ''}`}
            onClick={() => onSwitch(key)}
            title={label}
          >
            <Icon size={17} />
            <span>{label}</span>
          </button>
        ))}
      </div>

      <div className="appswitcher-user">
        <button
          className="icon-btn"
          title={theme === 'dark' ? '深色模式' : theme === 'light' ? '浅色模式' : '跟随系统'}
          onClick={onToggleTheme}
        >
          {theme === 'dark' ? <Moon size={16} /> : theme === 'light' ? <Sun size={16} /> : <Monitor size={16} />}
        </button>
        <button className="icon-btn" title="设置" onClick={onOpenSettings}><Settings size={16} /></button>
        <button className="icon-btn" title="退出登录" onClick={onLogout}><LogOut size={16} /></button>
        <span className="appswitcher-name">
          {me.name}{me.isInstanceOwner && <span className="tag">Owner</span>}
        </span>
      </div>
    </header>
  );
}
