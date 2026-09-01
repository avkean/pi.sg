import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCompressor } from '../src/server-compressor.mjs';
import { createCompressor as createPrevious } from '../src/compressor.mjs';
import { renderResult } from '../src/surface.mjs';
import { serve } from '../server.mjs';

const model = await readFile(
  new URL('../models/context-v1.bin', import.meta.url)
);
const current = createCompressor(model),
  previous = createPrevious(model);
const inputs = [
  'https://drive.google.com/drive/u/1/folders/1ec0HU6_1vqnyvGlO2iFnfZeVNQKh_jpM',
  'https://www.allrecipes.com/recipe/240438/easy-slow-cooker-chicken-fajitas/',
  'HTTPS://WWW.EXAMPLE.COM:443/A%2fb?x=0&x=00&&bare&empty=#',
  'https://example.com/日本語/🙂?q=שלום&x=%e4%b8%ad&x=%E4%B8%AD#مرحبا',
  'https://example.com/?q=' + encodeURIComponent('中文測試🙂'.repeat(30)),
  'https://user:pass@[2001:db8::1]:0443/a?one=1&two=&one=2#',
  'https://example.com/#' + 'pi'.repeat(16000)
];

test('disabling prediction keeps new links readable without issuing more of them', async () => {
  const fallback = createCompressor(model, { prediction: false });
  const fixtures = JSON.parse(
    await readFile(new URL('fixtures/predict-links.json', import.meta.url))
  );
  for (const frame of fixtures[0].frames)
    assert.equal(fallback.decode(frame), fixtures[0].input);
  assert.ok(
    fallback
      .encodeAdditional(inputs[1])
      .every((candidate) => !['n', 'o'].includes(candidate.payload[0]))
  );
});

test('server candidates preserve old links and never increase the chosen link length', () => {
  for (const input of inputs)
    for (const format of ['compact', 'ascii']) {
      const old = previous.encode(input, { format }),
        result = current.encode(input, { format });
      assert.equal(current.decode(old.payload), input);
      assert.equal(current.decode(result.payload), input);
      assert.equal(
        current.decode(new URL(result.url).pathname.slice(1)),
        input
      );
      assert.ok(result.url.length <= old.url.length);
    }
  assert.equal(current.encode(inputs[0]).payload.length, 17);
});

test('every additional codec and both transports redirect through the actual HTTP worker', async () => {
  const app = await serve({ port: 0 });
  try {
    const seen = new Set();
    for (const input of inputs.slice(1, 5))
      for (const candidate of current.encodeAdditional(input)) {
        seen.add(candidate.codec);
        for (const format of ['compact', 'ascii']) {
          const result = renderResult(candidate, {
            origin: app.origin,
            format
          });
          const response = await fetch(result.url, { redirect: 'manual' });
          assert.equal(response.status, 302);
          assert.equal(response.headers.get('location'), new URL(input).href);
          assert.equal(response.headers.get('cache-control'), 'no-store');
          await response.arrayBuffer();
        }
      }
    assert.ok(seen.has('unicode-v1'));
    assert.ok(seen.has('url-grammar-v1'));
    assert.ok(seen.has('statistical-v1') || seen.has('neural-v1'));
    for (const path of [
      '/codecs/grammar/models/majestic-262144-pool.bin',
      '/src/compression-worker.mjs',
      '/models/predict-v1/context.bin',
      '/dist/neural.node',
      '/archive/before-cleanup/transcript.md'
    ]) {
      const response = await fetch(app.origin + path, { redirect: 'manual' });
      assert.equal(response.status, 400);
      await response.arrayBuffer();
    }
  } finally {
    await app.close();
  }
});
