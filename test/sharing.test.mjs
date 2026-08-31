import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { createCompressor } from '../src/compressor.mjs';
import { toWide, fromWide, isWide } from '../src/wide.mjs';
import { renderResult, withConfirmation } from '../src/surface.mjs';
import { serve } from '../server.mjs';
import { PREFIXES } from '../codecs/compact/frame.mjs';
import { seal, toBase64 } from '../codecs/core/bytes.mjs';
import { encodeStructured } from '../src/structured.mjs';
import { isNativeFrame } from '../src/native-frame.mjs';

const model = await readFile(
  new URL('../models/context-v1.bin', import.meta.url)
);
const pi = createCompressor(model);
let running;
before(async () => {
  running = await serve({ port: 0 });
});
after(async () => {
  await running.close();
});

function request(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(running.origin, { path, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          location: res.headers.location,
          body: Buffer.concat(chunks).toString()
        })
      );
    });
    req.setTimeout(3000, () => req.destroy(Error('Request timed out')));
    req.on('error', reject);
    req.end();
  });
}

const examples = [
  'https://drive.google.com/drive/u/1/folders/1ec0HU6_1vqnyvGlO2iFnfZeVNQKh_jpM',
  'https://docs.google.com/document/d/AbCdEf0123456789_-ZX/edit?usp=sharing#heading=h.Exact',
  'https://youtu.be/dQw4w9WgXcQ?t=42',
  'https://en.wikipedia.org/wiki/Arithmetic_coding',
  'HTTPS://EXAMPLE.COM:443/中文?a=%2f&a=%2F#🙂',
  'https://example.com/' +
    encodeURIComponent('这是一个保留完整拼写的网页地址测试'.repeat(10))
];

test('new frames use unused markers, retain old structured links and keep all checksum bits', () => {
  for (const marker of 'xyz') assert.ok(!(PREFIXES + 'PSDL').includes(marker));
  const result = pi.encode(examples[0]);
  assert.equal(result.codec, 'packed-v1');
  assert.ok(isNativeFrame(result.payload));
  assert.ok(
    result.payload.length < 24,
    'Beat the reproduced Mia CJK result on this known development example'
  );
  assert.ok(
    result.asciiPayload.length < 55,
    'The underlying ASCII result must improve too'
  );
  const legacy =
    'z' +
    toBase64(
      seal(encodeStructured(examples[0]), new TextEncoder().encode(examples[0]))
    );
  assert.equal(pi.decode(legacy), examples[0]);
  assert.equal(pi.decode(toWide(legacy)), examples[0]);
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  for (const original of [legacy, result.asciiPayload]) {
    for (let i = 1; i <= 5; i++) {
      for (const digit of alphabet) {
        if (digit === original[i]) continue;
        const changed = original.slice(0, i) + digit + original.slice(i + 1);
        assert.throws(() => pi.decode(changed));
        assert.throws(() => pi.decode(toWide(changed)));
      }
    }
  }
});

test('compact and plain links carry identical data and redirect through the real HTTP server', async () => {
  for (const input of examples) {
    const compact = pi.encode(input, { origin: running.origin });
    const plain = pi.encode(input, { origin: running.origin, format: 'ascii' });
    assert.ok(isWide(compact.payload));
    assert.equal(compact.transport, 'compact');
    assert.equal(plain.transport, 'ascii');
    assert.equal(pi.decode(compact.asciiPayload), input);
    assert.ok(compact.payload.length < plain.payload.length);
    assert.equal(pi.decode(compact.payload), input);
    assert.equal(pi.decode(plain.payload), input);
    for (const form of [compact, plain]) {
      const response = await request(new URL(form.url).pathname);
      assert.equal(response.status, 302);
      assert.equal(response.location, new URL(input).href);
    }
  }
});

test('Unicode normalization still restores the exact versioned payload and destination', async () => {
  // Exercise a real payload containing Hangul, not just transport-only symbols.
  let result;
  for (let i = 0; i < 100; i++) {
    result = pi.encode(examples[0] + '?sample=' + i, {
      origin: running.origin
    });
    if (/[\uAC00-\uC03F]/.test(result.payload)) break;
  }
  assert.match(result.payload, /[\uAC00-\uC03F]/);
  const expected = pi.decode(result.payload);
  for (const form of ['NFC', 'NFD', 'NFKC', 'NFKD']) {
    const normalized = result.payload.normalize(form);
    assert.equal(pi.decode(normalized), expected);
    const response = await request('/' + encodeURIComponent(normalized));
    assert.equal(response.status, 302);
    assert.equal(response.location, new URL(expected).href);
    const confirmation = await request(
      '/' + encodeURIComponent(normalized) + '~'
    );
    assert.equal(confirmation.status, 200);
    assert.equal(confirmation.location, undefined);
  }
});

test('confirmation works with ASCII, native Unicode and generic Unicode without changing their payloads', async () => {
  for (const input of examples) {
    for (const format of ['ascii', 'compact']) {
      const result = pi.encode(input, { origin: running.origin, format });
      const marked = withConfirmation(result.url, true);
      assert.equal(marked, result.url + '~');
      const response = await request(new URL(marked).pathname);
      assert.equal(response.status, 200);
      assert.equal(response.location, undefined);
      assert.ok(response.body.includes(new URL(input).host));
      assert.ok(response.body.includes('Continue →'));
      assert.equal(pi.decode(result.payload), input);
    }
  }
});

test('the optional confirmation character respects the serialized sharing limit', () => {
  const base = 'https://pi.sg/';
  const exact = base + 'A'.repeat(8192 - base.length);
  assert.equal(withConfirmation(exact), exact);
  assert.equal(withConfirmation(exact.slice(0, -1), true).length, 8192);
  assert.throws(() => withConfirmation(exact, true), /size limit/);
  const wide = base + '中'.repeat(908);
  const escapedLimit = wide + 'A'.repeat(8192 - new URL(wide).href.length);
  assert.ok(escapedLimit.length < 1000);
  assert.throws(() => withConfirmation(escapedLimit, true), /size limit/);
});

test('damaged, mixed and invalid escaped payloads cannot enter another route', async () => {
  const result = pi.encode(examples[0]);
  const damaged = toWide(
    result.asciiPayload.slice(0, 4) +
      (result.asciiPayload[4] === 'A' ? 'B' : 'A') +
      result.asciiPayload.slice(5)
  );
  const paths = [
    '/' + encodeURIComponent(damaged),
    '/' + encodeURIComponent(result.payload + '/health'),
    '/' + encodeURIComponent(result.payload + 'A'),
    '/' + encodeURIComponent(result.payload) + '?x=1',
    '/%41%41%41%41%41%41',
    '/%2Fhealth',
    '/%252Fhealth',
    '/%E0%A4%A',
    '/%ED%A0%80',
    '/' + encodeURIComponent('🙂🙂🙂'),
    '/' + encodeURIComponent('\u3400').repeat(911)
  ];
  for (const path of paths) {
    const response = await request(path);
    assert.equal(response.status, 400, path.slice(0, 50));
    assert.equal(response.location, undefined);
  }
});

test('compact rendering falls back to ASCII before percent-escaped URLs exceed the wire limit', () => {
  const result = { codec: 'transport-fixture', payload: 'A'.repeat(2500) };
  const rendered = renderResult(result);
  assert.equal(rendered.transport, 'ascii');
  assert.equal(rendered.payload, result.payload);
  assert.ok(new URL(rendered.url).href.length <= 8192);
  assert.throws(() => renderResult(result, { format: 'unknown' }), /Unknown/);
});
