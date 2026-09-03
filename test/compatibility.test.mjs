import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createCompressor } from '../src/server-compressor.mjs';
import { isMixedInput } from '../codecs/mixed/frame.mjs';

test('every saved link still decodes', async () => {
  const read = (name) => readFile(new URL(name, import.meta.url));
  const compressor = createCompressor(await read('../models/context-v1.bin'));
  const fixtures = JSON.parse(await read('./fixtures/links.json'));
  for (const { input, ascii, compact } of fixtures) {
    for (const [format, payload] of Object.entries({ ascii, compact })) {
      assert.equal(compressor.decode(payload), input);
      const path = new URL('https://pi.sg/' + payload).pathname.slice(1);
      assert.equal(compressor.decode(path), input);
    }
  }
});

test('new results do not grow across a representative saved sample', async () => {
  const read = (name) => readFile(new URL(name, import.meta.url));
  const compressor = createCompressor(await read('../models/context-v1.bin'));
  const fixtures = JSON.parse(await read('./fixtures/links.json'));
  compressor.warmup();
  const sample = fixtures.filter(
    (_, index) => index % 8 === 0 || index === fixtures.length - 1
  );
  for (const { input, ascii, compact } of sample) {
    for (const [format, payload] of Object.entries({ ascii, compact })) {
      const result = compressor.encode(input, { format });
      assert.ok(result.payload.length <= payload.length);
      assert.equal(compressor.decode(result.payload), input);
    }
  }
});

test('shared model files keep their published hashes', async () => {
  const hashes = JSON.parse(
    await readFile(new URL('../models/checksums.json', import.meta.url))
  );
  for (const [path, expected] of Object.entries(hashes)) {
    const bytes = await readFile(new URL('../' + path, import.meta.url));
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      expected,
      path
    );
  }
});

test('saved older links stay outside the mixed namespace', async () => {
  const read = (name) => readFile(new URL(name, import.meta.url));
  const links = JSON.parse(await read('./fixtures/links.json'));
  const legacy = JSON.parse(await read('./fixtures/legacy-links.json'));
  const prediction = JSON.parse(await read('./fixtures/predict-links.json'));
  const payloads = [
    ...links.flatMap((fixture) => [fixture.ascii, fixture.compact]),
    ...legacy.rows.map((fixture) => fixture.payload),
    ...prediction.flatMap((fixture) => fixture.frames)
  ];
  assert.ok(payloads.every((payload) => !isMixedInput(payload)));
});
