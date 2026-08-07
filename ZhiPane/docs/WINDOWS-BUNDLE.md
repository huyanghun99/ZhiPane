# Windows Bundle Plan

The Windows one-click distribution is a formal product target but not implemented in this starter.

Recommended implementation:

1. Use Tauri or Electron as the launcher.
2. Bundle the server build and web assets.
3. Bundle a standard PostgreSQL runtime with pgvector.
4. Do not require zhparser in MVP. Chinese search uses app-level tokenization and PostgreSQL simple tsvector.
5. On first launch:
   - create `%LOCALAPPDATA%\ZhiPane`
   - initialize PostgreSQL data directory
   - generate random DB password
   - run migrations
   - start PostgreSQL on `127.0.0.1` with a free local port
   - start Hono server
   - open browser or WebView

Ports should bind to `127.0.0.1` only. Logs and backups should be stored under `%LOCALAPPDATA%\ZhiPane\logs` and `%LOCALAPPDATA%\ZhiPane\backups`.
