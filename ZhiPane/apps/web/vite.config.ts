import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

// Excalidraw 0.18.x ships its stylesheet through a *conditional* export
// (`development` / `production`) with no `default` fallback. Vite's CSS
// subpath resolver does not match those conditions, so the bare import
// `@excalidraw/excalidraw/index.css` fails to resolve ("Does the file
// exist?"). We map that subpath to the concrete dist file so the editor
// styles load reliably in both dev and build.
function resolveExcalidrawCss(): string | undefined {
  try {
    const entry = require.resolve('@excalidraw/excalidraw');
    const distDir = entry.replace(/dist\/(?:prod|dev)\/index\.js$/, 'dist');
    // Prefer dev, fall back to prod — works regardless of build vs serve.
    for (const variant of ['dev', 'prod']) {
      const cssPath = path.join(distDir, variant, 'index.css');
      if (fs.existsSync(cssPath)) return cssPath;
    }
  } catch {
    /* package not installed — nothing to alias */
  }
  return undefined;
}

export default defineConfig(() => {
  const excalidrawCss = resolveExcalidrawCss();
  const alias: Record<string, string> = excalidrawCss
    ? { '@excalidraw/excalidraw/index.css': excalidrawCss }
    : {};
  return {
    plugins: [react()],
    resolve: {
      alias
    },
    server: {
      port: 5173,
      host: '0.0.0.0',
      proxy: {
        '/api': { target: 'http://127.0.0.1:39280', changeOrigin: true },
        '/health': { target: 'http://127.0.0.1:39280', changeOrigin: true }
      }
    },
    build: {
      // Phase J (S8): split stable vendor libs into separate chunks so app
      // code changes don't invalidate the cached vendor bundle, and the main
      // entry stays under the 500KB minified warning threshold.
      rollupOptions: {
        output: {
          manualChunks: {
            'react-vendor': ['react', 'react-dom', 'react-router-dom'],
            'tiptap-vendor': ['@tiptap/react', '@tiptap/starter-kit'],
            'tanstack-vendor': ['@tanstack/react-query']
          }
        }
      }
    }
  };
});
