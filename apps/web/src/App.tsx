import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { BrowserRouter, useMatch } from 'react-router-dom';
import { api } from './api';
import { AuthPanel } from './features/auth/AuthPanel';
import { ShareView } from './ShareView';
import { ShellLayout } from './features/shell/ShellLayout';
import type { User } from './types';

function AuthedApp() {
  const { data: me, isLoading } = useQuery<{ user: User }>({
    queryKey: ['me'],
    queryFn: () => api('/api/auth/me'),
    retry: false
  });

  const shareMatch = useMatch('/share/:token');

  if (isLoading) {
    return (
      <div className="loading-screen">
        <Loader2 className="spin" size={28} />
      </div>
    );
  }
  if (!me?.user) return <AuthPanel />;

  // Public share pages are reachable without the authenticated shell.
  if (shareMatch?.params.token) return <ShareView token={shareMatch.params.token} />;

  return <ShellLayout me={me.user} />;
}

export function App() {
  return (
    <BrowserRouter>
      <AuthedApp />
    </BrowserRouter>
  );
}
