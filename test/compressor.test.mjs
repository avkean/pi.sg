import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { Worker as NodeWorker } from 'node:worker_threads';
import { createPiNext } from '../codecs/compact/pi.mjs';
import {
  encodeFast as frozenFast,
  MAX_INPUT_BYTES
} from '../codecs/core/core.mjs';
import { createCompressor } from '../src/compressor.mjs';
import { encodeFast, OUTPUT_LIMIT_MESSAGE } from '../src/fast.mjs';
import { createEncoder } from '../src/client.mjs';
import { isWide, fromWide } from '../src/wide.mjs';
import { renderResult } from '../src/surface.mjs';

const model = await readFile(
  new URL('../models/context-v1.bin', import.meta.url)
);
const compressor = createCompressor(model),
  frozen = createPiNext(model);
const options = { origin: 'http://127.0.0.1:8788' };
const short = 'https://a.co';

function checkEncoded(result, input, origin = options.origin) {
  assert.notEqual(result.codec, 'original');
  assert.ok(
    isWide(result.payload) || /^[A-Za-z0-9_-]{6,8192}$/.test(result.payload)
  );
  assert.equal(result.url, new URL(origin).origin + '/' + result.payload);
  assert.ok(new URL(result.url).href.length <= 8192);
  assert.equal(compressor.decode(result.payload), input);
}

function token(length) {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let state = 0x7316abcd,
    out = '';
  for (let i = 0; i < length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out += alphabet[(state >>> 0) % 64];
  }
  return out;
}
const oversized = 'https://example.com/?token=' + token(9500);
const isOutputLimit = (error) =>
  error instanceof RangeError && error.message === OUTPUT_LIMIT_MESSAGE;

test('short URLs always produce the shortest encoded candidate even when it is longer', () => {
  for (const [input, payload] of [
    ['https://a.co', 'M1Cx6cECek'],
    ['http://a', 'KNET_wAWi4'],
    ['https://x.com/', 'TrEuWD7mO']
  ]) {
    assert.equal(frozen.encode(input, options).payload, null);
    const result = compressor.encode(input, { ...options, format: 'ascii' });
    checkEncoded(result, input);
    assert.ok(result.payload.length <= payload.length);
    assert.equal(compressor.decode(payload), input);
    assert.ok(result.url.length > input.length);
    assert.ok(result.url.length < encodeFast(input, options).url.length);
  }
});

test('existing frozen links stay decodable and new ASCII candidates never grow', async () => {
  const corpus = JSON.parse(
    await readFile(new URL('./fixtures/inputs.json', import.meta.url))
  ).rows;
  const inputs = [
    ...corpus.slice(0, 40).map((row) => row.input),
    'https://www.wikipedia.org/wiki/Arithmetic_coding?sample=exact&case=%2f#section',
    'https://example.com/?q=' + 'repeat-'.repeat(1000),
    'https://example.com/?id=' + '0123456789abcdef'.repeat(200),
    'https://example.com/?token=' + token(1000)
  ];
  let fullWinners = 0,
    fastWinners = 0;
  for (const input of inputs) {
    const prior = frozen.encode(input, options),
      result = compressor.encode(input, options);
    checkEncoded(result, input);
    if (prior.payload) {
      assert.equal(compressor.decode(prior.payload), input);
      assert.ok(result.asciiPayload.length <= prior.payload.length);
      fullWinners++;
    }
    const priorFast = frozenFast(input, options),
      fast = encodeFast(input, options);
    checkEncoded(fast, input);
    if (priorFast.payload) {
      assert.equal(compressor.decode(priorFast.payload), input);
      assert.ok(fast.payload.length <= priorFast.payload.length);
      fastWinners++;
    }
  }
  assert.ok(fullWinners >= 20);
  assert.ok(fastWinners >= 2);
});

test('full and fast encoding preserve exact spelling, Unicode, credentials and fragments', () => {
  for (const input of [
    short,
    'HTTPS://EXAMPLE.COM:443/A?b=%2F&b=%2f#🍕',
    'HtTp://user:pass@xn--bcher-kva.example:80/a/../b?k=1&k=2#f',
    'https://example.com/中文/🙂?a=%e4%b8%ad&b=%E4%B8%AD#é',
    'https://example.com/a%00b?x=%0d%0a&bare=&empty&&y=z',
    'https://example.com/' + 'é'.repeat(2200),
    'https://example.com/' + 'a'.repeat(MAX_INPUT_BYTES - 20)
  ]) {
    checkEncoded(compressor.encode(input, options), input);
    checkEncoded(encodeFast(input, options), input);
  }
  assert.ok(encodeFast(short, options).url.length > short.length);
});

test('forced frames retain corruption and truncation checks', () => {
  for (const encode of [compressor.encode, encodeFast]) {
    const { payload } = encode(short, { ...options, format: 'ascii' });
    for (const changed of [
      payload.slice(0, -2),
      payload + 'A',
      payload.slice(0, 2) + (payload[2] === 'A' ? 'B' : 'A') + payload.slice(3)
    ]) {
      assert.throws(() => compressor.decode(changed));
    }
  }
});

test('the 8,192-character cap includes the origin and accepts its exact boundary', () => {
  const input = 'https://example.com/?token=' + token(7950);
  const candidate = encodeFast(input, { origin: 'https://x.co' });
  const originLength = 8192 - candidate.payload.length - 1;
  assert.ok(originLength > 15 && originLength < 250);
  const hostname = Array.from({ length: originLength - 8 }, (_, i) =>
    i > 0 && i % 50 === 0 ? '.' : 'a'
  ).join('');
  const origin = 'https://' + hostname;
  for (const encode of [compressor.encode, encodeFast]) {
    const result = encode(input, { origin });
    assert.equal(result.url.length, 8192);
    checkEncoded(result, input, origin);
    assert.throws(() => encode(input, { origin: origin + 'a' }), isOutputLimit);
    assert.throws(() => encode(oversized, options), isOutputLimit);
  }
});

test('input limits and non-HTTP or credential-bearing origins remain explicit errors', () => {
  for (const encode of [compressor.encode, encodeFast]) {
    for (const input of [
      'javascript:alert(1)',
      'example.com',
      'https://example.com/\n',
      'https://example.com/\ud800'
    ]) {
      assert.throws(() => encode(input, options));
    }
    assert.throws(
      () =>
        encode('https://example.com/' + 'a'.repeat(MAX_INPUT_BYTES), options),
      /limit/
    );
    for (const origin of [
      'ftp://example.com',
      'https://user:pass@example.com',
      'relative'
    ]) {
      assert.throws(() => encode(short, { origin }));
    }
    const result = encode(short, {
      origin: options.origin + '/ignored?x=1#fragment'
    });
    checkEncoded(result, short);
  }
});

function installWorker({
  ready = true,
  hang = false,
  fail = false,
  original = false,
  postThrows = false,
  constructorThrows = false
} = {}) {
  const previous = globalThis.Worker,
    instances = [];
  globalThis.Worker = class {
    constructor(url) {
      if (constructorThrows) throw Error('Worker unavailable');
      this.url = url;
      this.posts = [];
      this.terminated = false;
      instances.push(this);
      if (ready) queueMicrotask(() => this.emit({ ready: true }));
    }
    emit(data) {
      this.onmessage?.({ data });
    }
    postMessage(data) {
      if (postThrows) throw Error('Submission failed');
      this.posts.push(data);
      if (hang) return;
      queueMicrotask(() => {
        if (fail) return this.emit({ id: data.id, error: 'Worker error' });
        try {
          this.emit({
            id: data.id,
            result: (original ? frozen : compressor).encode(
              data.input,
              data.options
            )
          });
        } catch (error) {
          this.emit({ id: data.id, error: String(error) });
        }
      });
    }
    terminate() {
      this.terminated = true;
    }
  };
  return {
    instances,
    restore() {
      globalThis.Worker = previous;
    }
  };
}

test('client exposes the same API and returns the full worker winner for short links', async () => {
  const fake = installWorker(),
    encoder = createEncoder({ timeoutMs: 1000 });
  try {
    assert.equal(encoder.preload(), true);
    const result = await encoder.encode(short, {
      ...options,
      uncloneable() {}
    });
    assert.equal(result.limited, false);
    assert.deepEqual(result, {
      ...compressor.encode(short, options),
      limited: false
    });
    assert.equal(
      new URL(fake.instances[0].url).pathname.endsWith('/worker.js'),
      true
    );
    encoder.close();
    assert.equal(encoder.preload(), false);
    await assert.rejects(encoder.encode(short, options), /closed/);
  } finally {
    encoder.close();
    fake.restore();
  }
});

test('client format switching uses the best plain candidate retained by the compact worker', async () => {
  const fake = installWorker(),
    encoder = createEncoder({ timeoutMs: 1000 });
  const input = 'https://drive.google.com/drive/folders/Aa_9';
  try {
    const result = await encoder.encode(input, { ...options, format: 'ascii' });
    assert.equal(
      result.payload,
      compressor.encode(input, { ...options, format: 'ascii' }).payload
    );
    checkEncoded(result, input);
  } finally {
    encoder.close();
    fake.restore();
  }
});

test('worker failures, active deadlines and stale original results always use encoded fast fallback', async () => {
  for (const [mode, reason] of [
    [{ constructorThrows: true }, 'worker-failure'],
    [{ postThrows: true }, 'worker-failure'],
    [{ fail: true }, 'worker-error'],
    [{ hang: true }, 'deadline'],
    [{ original: true }, 'worker-original']
  ]) {
    const fake = installWorker(mode),
      encoder = createEncoder({ timeoutMs: 20 });
    try {
      const result = await encoder.encode(short, options);
      checkEncoded(result, short);
      assert.equal(result.limited, true);
      assert.equal(result.reason, reason);
      assert.equal(
        result.url,
        renderResult(encodeFast(short, options), options).url
      );
      if (mode.hang) assert.equal(fake.instances[0].terminated, true);
    } finally {
      encoder.close();
      fake.restore();
    }
  }
});

test('startup expiry, queue saturation and shutdown also return encoded fast fallbacks', async () => {
  const fake = installWorker({ ready: false });
  const encoder = createEncoder({
    timeoutMs: 1000,
    startupMs: 10,
    maxPending: 1
  });
  try {
    const first = encoder.encode(short, options);
    const busy = await encoder.encode(short, options);
    assert.equal(busy.reason, 'busy');
    checkEncoded(busy, short);
    const expired = await first;
    assert.equal(expired.reason, 'model-timeout');
    checkEncoded(expired, short);
    assert.equal(fake.instances[0].terminated, true);
    const pending = encoder.encode(short, options);
    encoder.close();
    const closed = await pending;
    assert.equal(closed.reason, 'closed');
    checkEncoded(closed, short);
  } finally {
    encoder.close();
    fake.restore();
  }
});

test('an early deadline keeps model loading, and expired work is never submitted later', async () => {
  const fake = installWorker({ ready: false }),
    encoder = createEncoder({ timeoutMs: 20, startupMs: 1000 });
  try {
    const early = await encoder.encode(short, options);
    assert.equal(early.reason, 'deadline');
    checkEncoded(early, short);
    assert.equal(fake.instances[0].posts.length, 0);
    assert.equal(fake.instances[0].terminated, false);
    fake.instances[0].emit({ ready: true });
    const full = await encoder.encode(short, options);
    assert.equal(full.limited, false);
    checkEncoded(full, short);
    assert.equal(fake.instances[0].posts.length, 1);
  } finally {
    encoder.close();
    fake.restore();
  }
});

test('client propagates the explicit output-limit error with and without a working worker', async () => {
  for (const mode of [{}, { constructorThrows: true }]) {
    const fake = installWorker(mode),
      encoder = createEncoder({ timeoutMs: 1000 });
    try {
      await assert.rejects(encoder.encode(oversized, options), isOutputLimit);
      await assert.rejects(
        encoder.encode(short, { origin: 'ftp://example.com' }),
        /HTTP\(S\)/
      );
      await assert.rejects(encoder.encode('javascript:alert(1)', options));
    } finally {
      encoder.close();
      fake.restore();
    }
  }
  for (const limits of [
    { timeoutMs: 0 },
    { startupMs: Infinity },
    { maxPending: 0 }
  ]) {
    assert.throws(() => createEncoder(limits), /Invalid worker limits/);
  }
});

test('the actual app browser worker uses forced compression and reports output-limit errors', async () => {
  const source = `
    import { parentPort, workerData } from 'node:worker_threads';
    import { readFile } from 'node:fs/promises';
    globalThis.self = globalThis;
    globalThis.postMessage = message => parentPort.postMessage(message);
    globalThis.fetch = async url => {
      if (!url.pathname.endsWith('/models/context-v1.bin')) throw Error('Unexpected model request');
      return new Response(await readFile(new URL(workerData.model)));
    };
    parentPort.on('message', data => globalThis.onmessage({ data }));
    await import(workerData.entry);
  `;
  const worker = new NodeWorker(
    new URL('data:text/javascript,' + encodeURIComponent(source)),
    {
      workerData: {
        model: new URL('../models/context-v1.bin', import.meta.url).href,
        entry: new URL('../src/worker.mjs', import.meta.url).href
      }
    }
  );
  const next = () =>
    once(worker, 'message', { signal: AbortSignal.timeout(3000) }).then(
      ([message]) => message
    );
  try {
    assert.deepEqual(await next(), { ready: true });
    let response = next();
    worker.postMessage({ id: 1, input: short, options });
    const encoded = await response;
    assert.equal(encoded.id, 1);
    assert.deepEqual(encoded.result, compressor.encode(short, options));
    checkEncoded(encoded.result, short);
    response = next();
    worker.postMessage({ id: 2, input: oversized, options });
    assert.deepEqual(await response, {
      id: 2,
      error: 'RangeError: ' + OUTPUT_LIMIT_MESSAGE
    });
  } finally {
    await worker.terminate();
  }
});
