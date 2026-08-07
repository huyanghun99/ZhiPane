import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { ToastProvider } from './components/Toast';
import { DialogProvider } from './components/Dialog';
import { EditorStatusProvider } from './features/shell/editorStatus';
import { initTheme } from './theme';
import 'katex/dist/katex.min.css';
import './styles.css';

initTheme();

const client = new QueryClient();
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <ToastProvider>
        <DialogProvider>
          <EditorStatusProvider>
            <App />
          </EditorStatusProvider>
        </DialogProvider>
      </ToastProvider>
    </QueryClientProvider>
  </React.StrictMode>
);
