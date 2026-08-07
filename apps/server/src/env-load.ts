import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

/**
 * Minimal .env loader (no external dependency). Searches upward from the
 * current working directory for a `.env` file (so it works whether the server
 * is started from the repo root or from `apps/server`), then populates
 * `process.env` for any key not already set. The FIRST occurrence of a key in
 * the file wins, and existing environment variables (incl. CI secrets) take
 * precedence.
 *
 * Imported as the very first module in `src/index.ts` so it runs before
 * `env.ts` parses `process.env`.
 */
function findEnvFile(): string | null {
  let dir = process.cwd();
  while (true) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const envPath = findEnvFile();
if (envPath) {
  const text = readFileSync(envPath, 'utf-8');
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
