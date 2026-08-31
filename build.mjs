import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const root = new URL('./', import.meta.url);
await fs.mkdir(new URL('dist/', root), { recursive: true });
for (const name of ['app', 'worker']) {
  await build({
    entryPoints: [fileURLToPath(new URL(`src/${name}.mjs`, root))],
    outfile: fileURLToPath(new URL(`dist/${name}.js`, root)),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'eof'
  });
}
console.log('Built Pi.');
