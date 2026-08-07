import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Sparkles } from 'lucide-react';
import { post } from '../../api';
import type { User } from '../../types';

export function AuthPanel() {
  const qc = useQueryClient();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const mutation = useMutation({
    mutationFn: () => post<{ user: User }>('/api/auth/' + mode, mode === 'register' ? { name, email, password } : { email, password }),
    onSuccess: () => qc.invalidateQueries()
  });
  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="brand">
          <div className="brand-mark"><Sparkles size={22} /></div>
          <div>
            <h1>ZhiPane 知行台</h1>
            <p>个人与小团队的 LLM-first 知识创作系统</p>
          </div>
        </div>
        <div className="auth-tabs">
          <button className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>登录</button>
          <button className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>注册</button>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); mutation.mutate(); }} className="auth-form">
          {mode === 'register' && (
            <label>姓名<input value={name} onChange={(e) => setName(e.target.value)} placeholder="你的名字" required /></label>
          )}
          <label>邮箱<input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" type="email" required /></label>
          <label>密码<input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="至少 8 位" type="password" required /></label>
          <button className="primary block" type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? <Loader2 className="spin" size={16} /> : null}
            {mode === 'register' ? '创建账号' : '登录'}
          </button>
        </form>
        {mutation.error && <p className="error">{String((mutation.error as Error).message)}</p>}
        <p className="auth-hint">首个注册用户将成为实例 Owner。</p>
      </div>
    </div>
  );
}
