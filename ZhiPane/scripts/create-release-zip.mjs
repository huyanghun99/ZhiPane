import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
const out = '/mnt/data/zhipane-project.zip';
if (existsSync(out)) rmSync(out);
execFileSync('zip', ['-r', out, 'zhipane', '-x', 'zhipane/node_modules/*', 'zhipane/.git/*'], {
  cwd: '/mnt/data',
  stdio: 'inherit'
});
console.log(out);
