// Bundles the daemon entrypoint into a single dist/bundle.js with all
// pure-JS deps inlined. Native modules (better-sqlite3) stay external —
// the bundle requires them from a sidecar node_modules/ that the macOS app
// ships alongside bundle.js inside Dispatch.app/Contents/Resources/daemon/.
//
// Output layout the macOS app expects:
//   Resources/daemon/bundle.js
//   Resources/daemon/node_modules/better-sqlite3/...   (arm64 native + JS shim)

import { build } from 'esbuild';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = resolve(here, '..');

await build({
  entryPoints: [resolve(repo, 'src/index.ts')],
  outfile: resolve(repo, 'dist/bundle.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // Native + side-effecting Node addons must stay external. better-sqlite3
  // loads a .node binary; the rest are stdlib aliases that esbuild would
  // otherwise try to bundle.
  external: ['better-sqlite3'],
  minify: false,
  sourcemap: false,
  logLevel: 'info',
  // src/index.ts already declares its own shebang; CJS output preserves it.
});

console.log('bundled → dist/bundle.cjs');
