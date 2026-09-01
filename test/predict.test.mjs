import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createPredictor } from '../codecs/predict/codec.mjs';
import { readModel, shareContext } from '../codecs/predict/models.mjs';
import { fromBase64, toBase64 } from '../codecs/core/bytes.mjs';

const fixtures = JSON.parse(
  readFileSync(new URL('fixtures/predict-links.json', import.meta.url))
);
const codec = createPredictor(shareContext());

test('prediction formats match saved independent frames', (t) => {
  t.mock.method(performance, 'now', () => 0);
  for (const { input, frames } of fixtures) {
    for (const frame of frames) assert.equal(codec.decode(frame), input);
    const result = codec.encode(input);
    assert.ok(frames.includes(result.payload));
    assert.equal(codec.decode(result.payload), input);
  }
});

test('prediction formats preserve spelling, Unicode, boundaries and random IDs', (t) => {
  t.mock.method(performance, 'now', () => 0);
  const inputs = [
    'HTTPS://WwW.ExAmPlE.CoM.:0443/A%2fb?x=0&x=00&&bare&empty=#',
    'https://user:pass@[2001:db8::1]:0443/a?one=1&two=&one=2#',
    'https://example.com/日本語/🙂?q=שלום&x=%e4%b8%ad&x=%E4%B8%AD#مرحبا',
    'https://drive.google.com/drive/u/1/folders/1ec0HU6_1vqnyvGlO2iFnfZeVNQKh_jpM',
    'https://example.com/\ufeff?=~#%00'
  ];
  for (const size of [255, 256, 257, 1023, 1024])
    inputs.push('https://example.com/' + 'a'.repeat(size - 20));
  for (const input of inputs) {
    const result = codec.encode(input);
    assert.equal(codec.decode(result.payload), input);
    if (Buffer.byteLength(input) > 256) assert.equal(result.payload[0], 'n');
  }
  assert.equal(codec.encode('https://example.com/' + 'a'.repeat(1005)), null);
});

test('an expired encoding budget falls back without changing decoding', (t) => {
  let elapsed = 0;
  t.mock.method(performance, 'now', () => (elapsed += 21));
  assert.equal(codec.encode(fixtures[0].input), null);
  for (const frame of fixtures[0].frames)
    assert.equal(codec.decode(frame), fixtures[0].input);
});

test('verification can stop early without affecting later decodes', () => {
  for (const frame of fixtures[0].frames) {
    assert.throws(
      () => codec.decode(frame, { deadline: 0 }),
      /Prediction time budget/
    );
    assert.equal(codec.decode(frame), fixtures[0].input);
  }
  assert.equal(codec.encode(fixtures[0].input, { deadline: 0 }), null);
});

test('a completed stream remains usable when its alternate runs out of time', (t) => {
  let checks = 0;
  t.mock.method(performance, 'now', () => (++checks > 20 ? 100 : 0));
  const input =
    'https://www.theregister.com/2025/03/31/llm_providers_extinction/';
  const result = codec.encode(input, { deadline: 50 });
  assert.ok(result);
  assert.equal(codec.decode(result.payload), input);
});

test('prediction frames reject corruption, trailing data and other markers', () => {
  for (const { frames } of fixtures.slice(0, 5))
    for (const frame of frames) {
      const bytes = fromBase64(frame.slice(1));
      for (const offset of [0, 3, bytes.length - 1]) {
        const changed = bytes.slice();
        changed[offset] ^= 1;
        assert.throws(() => codec.decode(frame[0] + toBase64(changed)));
      }
      assert.throws(() => codec.decode(frame + 'AAAA'));
      assert.throws(() => codec.decode(frame.slice(0, -2)));
    }
  for (const value of [
    '',
    'n',
    'oAAAAAA',
    'NAAAAAAA',
    'n' + 'A'.repeat(2048),
    null,
    123
  ])
    assert.throws(() => codec.decode(value));
});

test('native predictors reject invalid arguments and damaged models without losing their model', () => {
  const require = createRequire(import.meta.url);
  for (const name of ['context', 'neural']) {
    const native = require(`../dist/${name}.node`);
    const bytes = readModel(`models/predict-v1/${name}.bin`);
    native.load(bytes);
    const history = Buffer.from('https://example.com/');
    const expected = Array.from(native.predict(history, new Float64Array(257)));
    for (const value of [
      undefined,
      null,
      1,
      {},
      Buffer.alloc(0),
      bytes.subarray(0, bytes.length - 1)
    ])
      assert.throws(() => native.load(value));
    assert.throws(() => native.predict());
    assert.throws(() => native.predict('url', new Float64Array(257)));
    assert.throws(() => native.predict(history, new Float32Array(257)));
    assert.throws(() => native.predict(history, new Float64Array(256)));
    assert.deepEqual(
      Array.from(native.predict(history, new Float64Array(257))),
      expected
    );
  }
});
