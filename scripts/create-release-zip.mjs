import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
const out = '/mnt/data/zhipane-project.zip';
if (existsSync(out)) rmSync(out);
execFileSync('zip', ['-r', out, '.', '-x', './node_modules/*', './.git/*'], {
  cwd: process.cwd(),
  stdio: 'inherit'
});
console.log(out);
