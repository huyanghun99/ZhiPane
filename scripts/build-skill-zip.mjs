import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const src = join(root, 'skills/zhipane');
const outDir = join(root, 'dist');
const md = readFileSync(join(src, 'SKILL.md'), 'utf8');
const version = md.match(/^version:\s*(.+)$/m)?.[1]?.trim() ?? '0.0.0';
const out = join(outDir, `zhipane-skill-${version}.zip`);

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
if (existsSync(out)) rmSync(out);

execFileSync('zip', ['-r', out, 'zhipane'], {
  cwd: join(root, 'skills'),
  stdio: 'inherit'
});
console.log(out);
