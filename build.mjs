import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
const root = new URL('./', import.meta.url);
await fs.mkdir(new URL('dist/', root), { recursive: true });
const headers =
  process.env.PI_NODE_HEADERS ??
  resolve(dirname(process.execPath), '../include/node');
await fs.access(resolve(headers, 'node_api.h')).catch(() => {
  throw Error(
    'Node headers not found. Set PI_NODE_HEADERS to the directory containing node_api.h.'
  );
});
for (const name of ['context', 'neural']) {
  execFileSync(
    process.env.CXX || 'c++',
    [
      '-O3',
      '-std=c++17',
      '-fno-fast-math',
      '-ffp-contract=off',
      ...(process.platform === 'darwin'
        ? ['-bundle', '-undefined', 'dynamic_lookup']
        : ['-shared', '-fPIC']),
      '-I',
      headers,
      fileURLToPath(new URL(`codecs/predict/native/${name}.cc`, root)),
      '-o',
      fileURLToPath(new URL(`dist/${name}.node`, root))
    ],
    { stdio: 'inherit' }
  );
}
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
