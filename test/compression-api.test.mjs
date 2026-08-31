import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createCompressionAPI } from '../src/compression-api.mjs';
import { createCompressor } from '../src/compressor.mjs';
const codec = createCompressor(
  await readFile(new URL('../models/context-v1.bin', import.meta.url))
);

async function fixture() {
  let api,
    clock = 0,
    calls = 0;
  const send = (req, res, status, body = '', headers = {}) => {
    if (res.destroyed) return;
    res.writeHead(status, { 'Content-Type': 'text/plain', ...headers });
    res.end(body);
  };
  const server = http.createServer((req, res) => api(req, res, send));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  api = createCompressionAPI({
    origin,
    now: () => clock,
    pool: {
      encode: async (input) => {
        calls++;
        try {
          return [codec.encode(input, { origin, format: 'ascii' })];
        } catch {
          throw Object.assign(Error(), { code: 'INVALID' });
        }
      }
    }
  });
  return {
    origin,
    calls: () => calls,
    advance: (ms) => {
      clock += ms;
    },
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      })
  };
}
const headers = {
  'Content-Type': 'text/plain; charset=utf-8',
  'X-Pi-Format': 'compact'
};

test('HTTP extra compression preserves exact input and returns only a same-origin representation', async () => {
  const f = await fixture();
  try {
    const input = 'HTTPS://EXAMPLE.COM:443/中文?a=%2f&a=%2F#🙂';
    const response = await fetch(f.origin + '/api/compress', {
      method: 'POST',
      headers: { ...headers, Origin: f.origin },
      body: input
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(Object.keys(result), ['codec', 'payload']);
    assert.equal(codec.decode(result.payload), input);
    assert.equal(f.calls(), 1);
  } finally {
    await f.close();
  }
});

test('HTTP extra compression rejects cross-site use, wrong formats, invalid inputs and oversized bodies', async () => {
  const f = await fixture();
  try {
    const input = 'https://example.com/';
    for (const [opts, status] of [
      [{ method: 'GET' }, 405],
      [
        {
          method: 'POST',
          headers: { ...headers, Origin: 'https://other.example/' },
          body: input
        },
        403
      ],
      [
        {
          method: 'POST',
          headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' },
          body: input
        },
        403
      ],
      [
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input)
        },
        415
      ],
      [
        {
          method: 'POST',
          headers: { ...headers, 'X-Pi-Format': 'unknown' },
          body: input
        },
        400
      ],
      [{ method: 'POST', headers, body: 'javascript:alert(1)' }, 400],
      [{ method: 'POST', headers, body: Uint8Array.of(0xff) }, 400],
      [{ method: 'POST', headers, body: input + 'x'.repeat(32768) }, 413]
    ]) {
      const r = await fetch(f.origin + '/api/compress', opts);
      await r.text();
      assert.equal(r.status, status);
    }
    assert.equal(
      f.calls(),
      1,
      'Only the well-formed UTF-8 but invalid URL reaches pool validation'
    );
  } finally {
    await f.close();
  }
});

test('HTTP extra compression has a global bounded admission rate and recovers without keeping caller data', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 10; i++) {
      const r = await fetch(f.origin + '/api/compress', {
        method: 'POST',
        headers,
        body: 'https://example.com/'
      });
      await r.text();
      assert.equal(r.status, 200);
    }
    const limited = await fetch(f.origin + '/api/compress', {
      method: 'POST',
      headers,
      body: 'https://example.com/'
    });
    await limited.text();
    assert.equal(limited.status, 429);
    assert.equal(f.calls(), 10);
    f.advance(100);
    const recovered = await fetch(f.origin + '/api/compress', {
      method: 'POST',
      headers,
      body: 'https://example.com/'
    });
    await recovered.text();
    assert.equal(recovered.status, 200);
  } finally {
    await f.close();
  }
});
