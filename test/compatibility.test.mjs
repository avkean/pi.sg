import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createCompressor } from '../src/server-compressor.mjs';

test('saved links still decode and compression produces the same bytes', async () => {
  const read = (name) => readFile(new URL(name, import.meta.url));
  const compressor = createCompressor(await read('../models/context-v1.bin'));
  const fixtures = JSON.parse(await read('./fixtures/links.json'));
  for (const { input, ascii, compact } of fixtures) {
    for (const [format, payload] of Object.entries({ ascii, compact })) {
      assert.equal(compressor.decode(payload), input);
      assert.equal(compressor.encode(input, { format }).payload, payload);
      const path = new URL('https://pi.sg/' + payload).pathname.slice(1);
      assert.equal(compressor.decode(path), input);
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
