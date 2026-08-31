import { after, before, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { once, getEventListeners } from 'node:events';
import { performance } from 'node:perf_hooks';
import { deflateRawSync, gunzipSync, brotliDecompressSync } from 'node:zlib';
import { Worker } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import { createPiNext } from '../codecs/compact/pi.mjs';
import { seal, toBase64 } from '../codecs/core/bytes.mjs';
import { createRedirectPool } from '../src/redirect-pool.mjs';
import { serve } from '../server.mjs';

const model = await readFile(
  new URL('../models/context-v1.bin', import.meta.url)
);
const pi = createPiNext(model);
const golden = JSON.parse(
  await readFile(new URL('./fixtures/legacy-links.json', import.meta.url))
).rows;
let running;
before(async () => {
  running = await serve({ port: 0 });
});
after(async () => {
  await running?.close();
});

function request(
  path,
  { method = 'GET', headers = {}, origin = running.origin } = {}
) {
  return new Promise((resolve, reject) => {
    // http.request preserves raw paths and never follows a Location header.
    const req = http.request(
      origin,
      { path, method, headers, agent: false },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks)
          })
        );
        res.on('error', reject);
      }
    );
    req.setTimeout(5000, () =>
      req.destroy(new Error('Test request timed out'))
    );
    req.on('error', reject);
    req.end();
  });
}

function rawRequest(target) {
  const { hostname, port } = new URL(running.origin);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: hostname, port: Number(port) });
    const chunks = [];
    socket.setTimeout(3000, () =>
      socket.destroy(new Error('Test socket timed out'))
    );
    socket.on('connect', () => socket.write(target));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString()));
    socket.on('error', reject);
  });
}

function legacyDeflate(input) {
  const bytes = Buffer.from(input);
  return 'D' + toBase64(seal(deflateRawSync(bytes), bytes));
}

function checkSecurity(response) {
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  const csp = response.headers['content-security-policy'];
  for (const kind of ['script', 'style', 'worker', 'connect'])
    assert.ok(csp.includes(`${kind}-src 'self'`));
  for (const rule of ['frame-src', 'frame-ancestors', 'object-src', 'base-uri'])
    assert.ok(csp.includes(`${rule} 'none'`));
  assert.ok(!csp.includes('unsafe-inline') && !csp.includes('unsafe-eval'));
  assert.equal(response.headers['set-cookie'], undefined);
}

test('the configured public origin works behind HTTPS without trusting forwarded headers', async () => {
  const proxied = await serve({ port: 0, publicOrigin: 'https://pi.sg/' });
  try {
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        Origin: 'https://pi.sg'
      },
      body: 'https://example.com/a?x=1&x=2#end'
    };
    const response = await fetch(proxied.origin + '/api/compress', options);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(Object.keys(result), ['codec', 'payload']);
    const decoded = await request('/' + result.payload, {
      origin: proxied.origin
    });
    assert.equal(decoded.status, 302);
    assert.equal(decoded.headers.location, options.body);
    for (const origin of ['https://other.example', proxied.origin]) {
      const denied = await fetch(proxied.origin + '/api/compress', {
        ...options,
        headers: {
          ...options.headers,
          Origin: origin,
          'X-Forwarded-Host': origin.slice(origin.indexOf('//') + 2),
          'X-Forwarded-Proto': 'https'
        }
      });
      assert.equal(denied.status, 403);
      await denied.arrayBuffer();
    }
  } finally {
    await proxied.close();
  }
});

test('invalid public origins fail before starting workers', async () => {
  for (const publicOrigin of [
    '',
    'pi.sg',
    'ftp://pi.sg',
    'https://user:pass@pi.sg',
    'https://pi.sg/path',
    'https://pi.sg/?',
    'https://pi.sg/#'
  ])
    await assert.rejects(serve({ port: 0, publicOrigin }));
});

test('compact context and subword links stay on this origin and redirect exactly', async () => {
  const codecs = new Set();
  for (const input of [
    'https://github.com/example/project/issues/12345',
    'https://www.wikipedia.org/wiki/Arithmetic_coding?sample=exact&case=%2f#section'
  ]) {
    const result = pi.encode(input, { origin: running.origin });
    codecs.add(result.codec);
    assert.match(result.payload, /^[A-Za-z0-9_-]{6,8192}$/);
    assert.equal(result.url, `${running.origin}/${result.payload}`);
    const response = await request('/' + result.payload);
    assert.equal(response.status, 302);
    assert.equal(response.headers.location, new URL(input).href);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.body.length, 0);
    checkSecurity(response);
  }
  assert.deepEqual(codecs, new Set(['subword-compact', 'context-compact']));
});

test('every frozen legacy P/S/D/L vector redirects through the new decoder', async () => {
  assert.deepEqual(
    new Set(golden.map((row) => row.payload[0])),
    new Set('PSDL')
  );
  for (const { input, payload } of golden) {
    const response = await request('/' + payload);
    assert.equal(response.status, 302);
    assert.equal(response.headers.location, new URL(input).href);
  }
});

test('Location uses URL serialization while preserving escapes, repeated keys and fragments', async () => {
  for (const input of [
    'HTTPS://EXAMPLE.COM:443/A?b=%2F&b=%2f#🍕',
    'HtTp://user:pass@xn--bcher-kva.example:80/a/../b?k=1&k=2#f',
    'https://example.com/中文/🙂?a=%e4%b8%ad&b=%E4%B8%AD#é',
    'https://example.com/a%00b?x=%0d%0a&bare=&empty&&y=z'
  ]) {
    const response = await request('/' + legacyDeflate(input));
    assert.equal(response.status, 302);
    assert.equal(response.headers.location, new URL(input).href);
  }
});

test('redirects and confirmation never fetch the destination before the visitor follows the link', async () => {
  let hits = 0;
  const destination = http.createServer((_req, res) => {
    hits++;
    res.end('Local destination reached.');
  });
  destination.listen(0, '127.0.0.1');
  await once(destination, 'listening');
  try {
    const input = `http://127.0.0.1:${destination.address().port}/private?secret=unlogged#fragment`;
    const response = await request('/' + legacyDeflate(input));
    assert.equal(response.status, 302);
    assert.equal(response.headers.location, input);
    const confirmation = await request('/' + legacyDeflate(input) + '~');
    assert.equal(confirmation.status, 200);
    assert.equal(confirmation.headers.location, undefined);
    assert.equal(hits, 0);
    const continueUrl = confirmation.body
      .toString()
      .match(/class="copy-button" href="([^"]+)"/)[1];
    assert.equal(continueUrl, input);
    const target = new URL(continueUrl);
    const visit = await request(target.pathname + target.search, {
      origin: target.origin
    });
    assert.equal(visit.status, 200);
    assert.equal(visit.body.toString(), 'Local destination reached.');
    assert.equal(hits, 1);
  } finally {
    destination.closeAllConnections();
    await new Promise((resolve) => destination.close(resolve));
  }
});

test('legacy confirmation pages show the real host, escape URL text, and work without scripts', async () => {
  for (const { payload } of golden) {
    const response = await request('/' + payload + '~');
    assert.equal(response.status, 200);
    assert.equal(response.headers.location, undefined);
    checkSecurity(response);
  }
  const input =
    'https://trusted.example@evil.example:8443/{{host}}/{{url}}?template={{url}}&next=&quot;&x=1#<svg/onload=alert(1)>';
  const path = '/' + legacyDeflate(input) + '~';
  const response = await request(path);
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^text\/html/);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-robots-tag'], 'noindex, nofollow');
  const page = response.body.toString();
  assert.match(page, /<strong dir="ltr">evil.example:8443<\/strong\s*>/);
  assert.ok(
    page.includes(
      'href="https://trusted.example@evil.example:8443/%7B%7Bhost%7D%7D/%7B%7Burl%7D%7D?template={{url}}&amp;next=&amp;quot;&amp;x=1#%3Csvg/onload=alert(1)%3E"'
    )
  );
  assert.doesNotMatch(page, /<script|<svg|http-equiv=["']refresh/i);
  assert.match(page, /rel="noreferrer noopener"/);
  checkSecurity(response);
  for (const address of [
    'https://example.com',
    'http://[::1]:8080/?#',
    'https://evil.example:pass@evil.example:8443/a?x=1&x=2#end',
    'https://例え.テスト/路径?x=%2f&x=+#片段',
    input
  ]) {
    const preview = await request('/' + legacyDeflate(address) + '~');
    assert.equal(preview.status, 200);
    const markup = preview.body.toString();
    const shown = markup.match(
      /<p\s+class="destination-url"[^>]*>([\s\S]*?)<\/p>/
    )[1];
    const entities = {
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&#39;': "'"
    };
    const unescape = (text) =>
      text.replace(
        /&amp;|&lt;|&gt;|&quot;|&#39;/g,
        (entity) => entities[entity]
      );
    assert.equal(
      unescape(shown.replace(/<[^>]*>/g, '').trim()),
      new URL(address).href
    );
    assert.equal(
      unescape(shown.match(/<strong dir="ltr">([^<]*)<\/strong\s*>/)[1]),
      new URL(address).host
    );
  }
  const head = await request(path, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(Number(head.headers['content-length']), response.body.length);
});

test('malformed raw paths, queries, corruption and unsupported schemes return the fixed invalid page', async () => {
  const invalidPage = await readFile(
    new URL('../public/invalid.html', import.meta.url)
  );
  const payload = pi.encode('https://github.com/example/project/issues/12345', {
    origin: running.origin
  }).payload;
  const paths = [
    '/abcde',
    '/AAAAAA',
    '/' + 'A'.repeat(8193),
    '/Pbad-link',
    '/' + payload + '?',
    '/' + payload + '?x=1',
    '/' + payload + '#fragment',
    '/' + payload + '/',
    '/' + payload + '=',
    '/' + payload + '%41',
    '/' + payload + 'A',
    '/' + payload.slice(0, -2),
    '/' +
      payload.slice(0, 4) +
      (payload[4] === 'A' ? 'B' : 'A') +
      payload.slice(5),
    '/' + legacyDeflate('javascript:alert(1)'),
    '/' + legacyDeflate('file:///etc/passwd'),
    '/' + legacyDeflate('https://example.com/\r\nX-Injected:value'),
    '/~',
    '/~~',
    '/' + payload + '~~',
    '/' + payload + '~A',
    '/' + payload + '%7E',
    '/' + payload + '~?x=1',
    '/' + payload + '~/',
    '/' + legacyDeflate('javascript:alert(1)') + '~',
    '/' + legacyDeflate('file:///etc/passwd') + '~',
    '/AAAAAA~'
  ];
  for (const path of paths) {
    const response = await request(path);
    assert.equal(response.status, 400);
    assert.equal(response.headers.location, undefined);
    assert.deepEqual(response.body, invalidPage);
    assert.equal(response.headers['cache-control'], 'no-store');
    checkSecurity(response);
  }
  const unacceptable = await request('/AAAAAA', {
    headers: { 'Accept-Encoding': 'identity;q=0, *;q=0' }
  });
  assert.equal(unacceptable.status, 400);
});

test('only exact static routes are exposed; private files and raw traversal are rejected', async () => {
  const invalidPage = await readFile(
    new URL('../public/invalid.html', import.meta.url)
  );
  for (const path of [
    '/server.mjs',
    '/package.json',
    '/src/redirect-worker.mjs',
    '/src/redirect-pool.mjs',
    '/tests/server.test.mjs',
    '/public/index.html',
    '/public/invalid.html',
    '/public/confirm.html',
    '/dist/app.js',
    '/.env',
    '/.git/config',
    '/pi-core/src/core.mjs',
    '/pi-next/src/pi.mjs',
    '/../pi-core/models/context-v1.bin',
    '/assets/../../pi-core/src/pi.mjs',
    '/assets/../assets/app.js',
    '/%2e%2e/pi-core/src/pi.mjs',
    '/assets%2fapp.js',
    '//assets/app.js',
    '/assets\\app.js',
    '/assets/app.js.map',
    '/favicon.svg?secret=1',
    '/health?secret=1',
    '/assets/app.js?x=1',
    'http://example.com/' + golden[0].payload
  ]) {
    const response = await request(path);
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, invalidPage);
  }
});

test('GET and HEAD are the only supported methods, including CONNECT', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE']) {
    for (const path of ['/health', '/', '/' + golden[0].payload]) {
      const response = await request(path, { method });
      assert.equal(response.status, 405);
      assert.equal(response.headers.allow, 'GET, HEAD');
      assert.equal(response.headers.location, undefined);
      checkSecurity(response);
    }
  }
  const response = await rawRequest(
    'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n'
  );
  assert.match(response, /^HTTP\/1\.1 405 /);
  assert.match(response, /Allow: GET, HEAD\r\n/);
});

test('request headers are capped at 16 KiB and protocol upgrades are rejected', async () => {
  assert.equal(running.server.maxHeaderSize, 16384);
  const overflow = await rawRequest(
    'GET /health HTTP/1.1\r\nHost: localhost\r\nX-Padding: ' +
      'x'.repeat(17 * 1024) +
      '\r\n\r\n'
  );
  assert.match(overflow, /^HTTP\/1\.1 431 /);
  assert.match(overflow, /Referrer-Policy: no-referrer\r\n/);
  const upgrade = await rawRequest(
    'GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: upgrade\r\nUpgrade: websocket\r\n\r\n'
  );
  assert.match(upgrade, /^HTTP\/1\.1 400 /);
});

test('all allowlisted assets serve exact bytes, gzip and Brotli with appropriate caching', async () => {
  for (const [path, relative, type] of [
    ['/', '../public/index.html', 'text/html'],
    ['/assets/style.css', '../public/style.css', 'text/css'],
    ['/assets/app.js', '../dist/app.js', 'text/javascript'],
    ['/assets/worker.js', '../dist/worker.js', 'text/javascript'],
    ['/favicon.svg', '../public/favicon.svg', 'image/svg+xml'],
    [
      '/models/context-v1.bin',
      '../models/context-v1.bin',
      'application/octet-stream'
    ]
  ]) {
    const expected = await readFile(new URL(relative, import.meta.url));
    for (const encoding of ['identity', 'gzip', 'br']) {
      const options = { headers: { 'Accept-Encoding': encoding } };
      const response = await request(path, options);
      assert.equal(response.status, 200);
      assert.ok(response.headers['content-type'].startsWith(type));
      assert.equal(response.headers.vary, 'Accept-Encoding');
      assert.match(response.headers.etag, /^W\/"[A-Za-z0-9_-]+"$/);
      const cached = await request(path, {
        headers: { ...options.headers, 'If-None-Match': response.headers.etag }
      });
      assert.equal(cached.status, 304);
      assert.equal(cached.body.length, 0);
      assert.equal(cached.headers['content-length'], undefined);
      assert.equal(cached.headers.etag, response.headers.etag);
      assert.equal(cached.headers.vary, 'Accept-Encoding');
      assert.equal(
        cached.headers['cache-control'],
        response.headers['cache-control']
      );
      assert.equal(
        Number(response.headers['content-length']),
        response.body.length
      );
      assert.equal(
        response.headers['content-encoding'],
        encoding === 'identity' ? undefined : encoding
      );
      const bytes =
        encoding === 'br'
          ? brotliDecompressSync(response.body)
          : encoding === 'gzip'
            ? gunzipSync(response.body)
            : response.body;
      assert.deepEqual(bytes, expected);
      assert.equal(
        response.headers['cache-control'],
        path.startsWith('/models/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache'
      );
      checkSecurity(response);
      const head = await request(path, { ...options, method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(head.body.length, 0);
      for (const field of [
        'content-type',
        'content-length',
        'content-encoding',
        'cache-control',
        'vary'
      ]) {
        assert.equal(head.headers[field], response.headers[field]);
      }
    }
  }
});

test('conditional requests never cache previews, redirects or errors', async () => {
  const asset = await request('/assets/style.css');
  for (const tag of [
    '*',
    asset.headers.etag,
    '"stale", ' + asset.headers.etag.slice(2)
  ]) {
    const hit = await request('/assets/style.css', {
      headers: { 'If-None-Match': tag }
    });
    assert.equal(hit.status, 304);
  }
  const stale = await request('/assets/style.css', {
    headers: { 'If-None-Match': '"stale"' }
  });
  assert.equal(stale.status, 200);
  for (const [path, status] of [
    ['/' + golden[0].payload, 302],
    ['/' + golden[0].payload + '~', 200],
    ['/AAAAAA', 400]
  ]) {
    const response = await request(path, { headers: { 'If-None-Match': '*' } });
    assert.equal(response.status, status);
    assert.equal(response.headers.etag, undefined);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
});

test('compression negotiation respects exclusions and explicit quality values', async () => {
  for (const [accept, expected] of [
    ['gzip, br', 'br'],
    ['br;q=0, gzip', 'gzip'],
    ['br;q=0.8, gzip;q=0.5, identity;q=0.1', 'br'],
    ['br;q=0, gzip;q=0', undefined],
    ['x-gzip-not-real', undefined],
    ['br;q=0, *;q=1', 'gzip']
  ]) {
    const response = await request('/assets/style.css', {
      headers: { 'Accept-Encoding': accept }
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-encoding'], expected);
  }
  const response = await request('/', {
    headers: { 'Accept-Encoding': '*;q=0' }
  });
  assert.equal(response.status, 406);
});

test('health, errors and redirects support HEAD without a body', async () => {
  for (const path of ['/health', '/AAAAAA', '/' + golden[0].payload]) {
    const get = await request(path);
    const head = await request(path, { method: 'HEAD' });
    assert.equal(head.status, get.status);
    assert.equal(head.headers['content-length'], get.headers['content-length']);
    assert.equal(head.headers.location, get.headers.location);
    assert.equal(head.body.length, 0);
    checkSecurity(head);
  }
  assert.equal((await request('/health')).body.toString(), 'ok');
});

test('test landing is opt-in, harmless and never reflects its query', async () => {
  const disabled = await request('/test/landing?secret=do-not-reflect');
  assert.equal(disabled.status, 400);
  const local = await serve({ port: 0, testMode: true });
  try {
    for (const path of [
      '/test/landing',
      '/test/landing/one?secret=do-not-reflect'
    ]) {
      const response = await request(path, { origin: local.origin });
      assert.equal(response.status, 200);
      assert.equal(response.body.toString(), 'Local test destination reached.');
    }
    const input = local.origin + '/test/landing?secret=do-not-reflect#fragment';
    const response = await request('/' + legacyDeflate(input), {
      origin: local.origin
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.location, input);
  } finally {
    await local.close();
    await local.close();
  }
});

test('HTTP worker saturation/deadlines return 503, then the server recovers', async () => {
  // Fault injection drops jobs without changing the production worker or API.
  const dropped = mock.method(Worker.prototype, 'postMessage', () => {});
  const started = performance.now();
  try {
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => request('/' + golden[0].payload))
    );
    assert.ok(performance.now() - started < 2500);
    for (const response of responses) {
      assert.equal(response.status, 503);
      assert.equal(response.headers['retry-after'], '1');
      assert.equal(response.headers.location, undefined);
      assert.equal(
        response.body.toString(),
        'The decoder is busy. Please try again.'
      );
      checkSecurity(response);
    }
    assert.equal((await request('/health')).status, 200);
  } finally {
    dropped.mock.restore();
  }
  // Reloading the models can take longer than one request's deadline.
  const recoveryDeadline = performance.now() + 5000;
  let recovered;
  do {
    recovered = await request('/' + golden[0].payload);
    if (recovered.status !== 503) break;
    assert.equal(recovered.headers['retry-after'], '1');
    await delay(1000);
  } while (performance.now() < recoveryDeadline);
  assert.equal(recovered.status, 302);
});

function workerURL(source) {
  return new URL('data:text/javascript,' + encodeURIComponent(source));
}

const fixtureWorker = workerURL(`
  import { parentPort, threadId, resourceLimits } from 'node:worker_threads';
  parentPort.on('message', ({ id, payload }) => {
    if (payload === 'hang__') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    if (payload === 'crash_') process.exit(1);
    if (payload === 'invalid') return parentPort.postMessage({ id, type: 'invalid' });
    const respond = () => parentPort.postMessage({ id, type: 'decoded', decoded: JSON.stringify({ threadId, resourceLimits }) });
    if (payload === 'slow__') setTimeout(respond, 100);
    else respond();
  });
  parentPort.postMessage({ type: 'ready' });
`);

const code = (expected) => (error) => error?.code === expected;

test('decoder stays persistent, isolates invalid input and applies the 128 MiB V8 heap budget', async () => {
  const pool = await createRedirectPool({ workerURL: fixtureWorker });
  try {
    const first = JSON.parse(await pool.decode('quick_'));
    const limits = first.resourceLimits;
    assert.equal(
      limits.maxOldGenerationSizeMb + limits.maxYoungGenerationSizeMb,
      128
    );
    await assert.rejects(pool.decode('invalid'), code('INVALID'));
    await assert.rejects(pool.decode('short'), code('INVALID'));
    const second = JSON.parse(await pool.decode('quick_'));
    assert.equal(second.threadId, first.threadId);
  } finally {
    await pool.close();
  }
});

test('one running job plus 16 queued jobs is bounded; expired jobs are removed and worker replaced', async () => {
  const pool = await createRedirectPool({ workerURL: fixtureWorker });
  try {
    const before = JSON.parse(await pool.decode('quick_')).threadId;
    const started = performance.now();
    const jobs = [
      pool.decode('hang__'),
      ...Array.from({ length: 16 }, () => pool.decode('quick_'))
    ];
    const settled = Promise.allSettled(jobs);
    await assert.rejects(pool.decode('quick_'), code('BUSY'));
    const results = await settled;
    assert.ok(performance.now() - started < 2000);
    assert.ok(
      results.every(
        (result) =>
          result.status === 'rejected' && result.reason.code === 'DEADLINE'
      )
    );
    const after = JSON.parse(await pool.decode('quick_')).threadId;
    assert.notEqual(after, before);
  } finally {
    await pool.close();
  }
});

test('aborting a queued job frees its queue slot and removes its abort listener', async () => {
  const pool = await createRedirectPool({
    workerURL: fixtureWorker,
    maxQueue: 1,
    deadlineMs: 1000
  });
  try {
    const active = pool.decode('slow__');
    const controller = new AbortController();
    const queued = pool.decode('quick_', { signal: controller.signal });
    const rejected = assert.rejects(queued, code('ABORTED'));
    await assert.rejects(pool.decode('quick_'), code('BUSY'));
    controller.abort();
    await rejected;
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    const replacement = pool.decode('quick_');
    const [a, b] = await Promise.all([active, replacement]);
    assert.equal(JSON.parse(a).threadId, JSON.parse(b).threadId);
  } finally {
    await pool.close();
  }
});

test('aborting active work replaces the worker and cleans up the deadline/listener', async () => {
  const pool = await createRedirectPool({ workerURL: fixtureWorker });
  try {
    const before = JSON.parse(await pool.decode('quick_')).threadId;
    const controller = new AbortController();
    const pending = pool.decode('hang__', { signal: controller.signal });
    const rejected = assert.rejects(pending, code('ABORTED'));
    controller.abort();
    await rejected;
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.notEqual(JSON.parse(await pool.decode('quick_')).threadId, before);
    assert.equal(JSON.parse(await pool.decode('quick_')).threadId > 0, true);
  } finally {
    await pool.close();
  }
});

test('worker exit rejects its current job but replacement handles queued work', async () => {
  const pool = await createRedirectPool({
    workerURL: fixtureWorker,
    deadlineMs: 1000
  });
  try {
    const failed = assert.rejects(pool.decode('crash_'), code('UNAVAILABLE'));
    const next = pool.decode('quick_');
    await failed;
    assert.ok(JSON.parse(await next).threadId > 0);
  } finally {
    await pool.close();
  }
});

test('close cancels active and queued jobs, is idempotent and disallows new jobs', async () => {
  const pool = await createRedirectPool({ workerURL: fixtureWorker });
  const controller = new AbortController();
  const jobs = Promise.allSettled([
    pool.decode('hang__'),
    pool.decode('quick_', { signal: controller.signal })
  ]);
  const firstClose = pool.close();
  assert.equal(firstClose, pool.close());
  await firstClose;
  assert.ok(
    (await jobs).every(
      (result) =>
        result.status === 'rejected' && result.reason.code === 'CLOSED'
    )
  );
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await assert.rejects(pool.decode('quick_'), code('CLOSED'));
});

test('startup hangs, throws and premature exits fail within their startup deadline', async () => {
  for (const source of [
    'setInterval(() => {}, 1000);',
    'throw new Error("startup failure");',
    'process.exit(0);'
  ]) {
    const started = performance.now();
    await assert.rejects(
      createRedirectPool({
        workerURL: workerURL(source),
        startupTimeoutMs: 150
      }),
      code('UNAVAILABLE')
    );
    assert.ok(performance.now() - started < 2000);
  }
});
