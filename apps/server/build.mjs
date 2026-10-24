import { build } from 'esbuild';
import fs from 'node:fs';

// Bundle the server (workspace packages inlined, npm dependencies kept external).
const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies).filter((d) => !d.startsWith('@framecraft/'));

await build({
  entryPoints: { main: 'src/main.ts', 'worker-main': 'src/worker-main.ts', migrate: 'src/db/migrate-cli.ts', 'create-admin': 'src/cli/create-admin.ts', 'providers-check': 'src/cli/providers-check.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  external,
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
console.log('Server bundle written to apps/server/dist');
