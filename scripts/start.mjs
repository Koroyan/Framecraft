#!/usr/bin/env node
// Production-style local start of built artifacts (API + web). In real deployments run
// the API, worker(s) and web as separate services (see docker-compose.yml / docs/DEPLOYMENT.md).
import { spawn } from 'node:child_process';

const procs = [
  { name: 'api', cmd: 'pnpm', args: ['--filter', '@framecraft/server', 'start'] },
  { name: 'web', cmd: 'pnpm', args: ['--filter', '@framecraft/web', 'start'] },
];
if (process.env.DATABASE_URL?.startsWith('postgres')) procs.push({ name: 'worker', cmd: 'pnpm', args: ['--filter', '@framecraft/server', 'start:worker'] });
const children = procs.map((p) => spawn(p.cmd, p.args, { stdio: 'inherit', shell: process.platform === 'win32', env: process.env }));
const stop = () => children.forEach((c) => c.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
