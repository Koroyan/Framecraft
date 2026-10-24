#!/usr/bin/env node
// Starts the API (with embedded worker when using the embedded database) and the web app.
import { spawn } from 'node:child_process';

const procs = [
  { name: 'api', color: '\x1b[35m', cmd: 'pnpm', args: ['--filter', '@framecraft/server', 'dev'] },
  { name: 'web', color: '\x1b[36m', cmd: 'pnpm', args: ['--filter', '@framecraft/web', 'dev'] },
];
if (process.env.DATABASE_URL?.startsWith('postgres')) {
  procs.push({ name: 'worker', color: '\x1b[33m', cmd: 'pnpm', args: ['--filter', '@framecraft/server', 'dev:worker'] });
}

const children = procs.map((p) => {
  const child = spawn(p.cmd, p.args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', env: process.env });
  const prefix = `${p.color}[${p.name}]\x1b[0m `;
  const pipe = (stream, out) => stream.on('data', (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => out.write(prefix + l + '\n')));
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    console.log(`${prefix}exited with code ${code}`);
    shutdown(code ?? 0);
  });
  return child;
});

let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill();
  setTimeout(() => process.exit(code), 500);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
console.log('Framecraft dev: web http://localhost:3000 · api http://localhost:4000');
