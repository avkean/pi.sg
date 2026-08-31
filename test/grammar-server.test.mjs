import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { loadGrammar } from '../codecs/grammar/load.mjs';
import { createGrammarCandidate } from '../codecs/grammar/candidate.mjs';
import {
  packDomainPool,
  openDomainPool
} from '../codecs/grammar/domain-format.mjs';
import { seal, toBase64, fromBase64 } from '../codecs/core/bytes.mjs';
const contextBytes = await fs.readFile(
  new URL('../models/context-v1.bin', import.meta.url)
);
const candidate = loadGrammar(contextBytes),
  te = new TextEncoder();

test('opaque spelling, delimiters, casing, leading zeros, and encodings survive', () => {
  const inputs = [
    'https://www.example.com',
    'HTTPS://WWW.EXAMPLE.COM:443/A%2fb?x=0&x=00&&bare&empty=#',
    'hTtPs://wWw.ExAmPlE.CoM.:0443/a/../b//?q=A+B&v=A%20B#e\u0301',
    'https://github.com/team/project/tree/main?foo=000000123456&bar=89abcdef01234567&foo=',
    'http://unknown-experimental-host.invalid/a//b?one&two=&one=3&&#',
    'https://unknown-experimental-host.invalid/12345678901234567890/ABCDEF0123456789/',
    'https://unknown-experimental-host.invalid/7f3ac912-650d-4be3-a012-d03394829a23?b=ABc5Efg8I_jkL-90',
    'https://example.com/日本語/🙂?q=שלום&x=%e4%b8%ad&x=%E4%B8%AD#مرحبا',
    'https://user:pass@example.com/a?next=https%3A%2F%2Fexample.net%2Fa#fragment',
    'https://[2001:db8::1]:0443/a?empty=&x=001234',
    'https://example.com/?=&&&&q=%00%0d%0a#%23%25',
    'https://example.com/\uFEFF/x',
    'https:///example.com/a',
    'http://example.com\\a\\b?c=d'
  ];
  for (const input of inputs) {
    const compact = candidate.encode(input),
      ascii = candidate.encode(input, { format: 'ascii' });
    assert.equal(candidate.decode(compact.payload), input);
    assert.equal(
      candidate.decode(new URL(compact.url).pathname.slice(1)),
      input
    );
    assert.equal(candidate.decode(ascii.payload), input);
    assert.equal(candidate.encode(input).payload, compact.payload);
  }
});
test('4096-byte cap and unsupported inputs never silently normalize', () => {
  const base = 'https://example.com/';
  const input = base + 'a'.repeat(4096 - base.length);
  const encoded = candidate.encode(input);
  assert.equal(candidate.decode(encoded.payload), input);
  assert.equal(candidate.encode(input + 'a'), null);
  assert.equal(candidate.encodeBytes(new Uint8Array(32768)), null);
  for (const bad of [
    'ftp://example.com/a',
    'https://example.com/\uD800',
    'https://example.com/a b'
  ])
    assert.throws(() => candidate.encode(bad));
  let seed = 0xb02198a7;
  const alphabet =
    '!$()*+,-.0123456789:;=@ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz~';
  for (let n = 0; n < 6; n++) {
    let noisy =
      n & 1 ? 'https://unlisted-host.invalid/' : 'https://example.com/';
    while (noisy.length < 4096) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      noisy += alphabet[(seed >>> 0) % alphabet.length];
    }
    const body = candidate.encodeBytes(te.encode(noisy));
    if (body) {
      assert.ok(body.length <= 6145);
      assert.deepEqual(candidate.decodeBytes(body), te.encode(noisy));
    }
    const result = candidate.encode(noisy);
    if (result) assert.equal(candidate.decode(result.payload), noisy);
  }
});
test('CRC and canonical arithmetic reject mutation, truncation, append, and version changes', () => {
  const inputs = [
    'https://www.wikipedia.org/a?x=0123456789',
    'https://unknown-experimental-host.invalid/a?q=ABCdef9012-_&empty=#'
  ];
  for (const input of inputs) {
    const good = candidate.encode(input, { format: 'ascii' }).payload,
      frame = fromBase64(good.slice(1));
    for (let i = 0; i < frame.length; i++)
      for (const bit of [1, 128]) {
        const bad = frame.slice();
        bad[i] ^= bit;
        assert.throws(() => candidate.decode('w' + toBase64(bad)));
      }
    for (let n = 1; n < frame.length; n++)
      assert.throws(() =>
        candidate.decode('w' + toBase64(frame.subarray(0, n)))
      );
    const appended = new Uint8Array(frame.length + 1);
    appended.set(frame);
    assert.throws(() => candidate.decode('w' + toBase64(appended)));
    const original = te.encode(input),
      body = candidate.encodeBytes(original);
    for (const version of [0, 2, 15]) {
      const bad = body.slice();
      bad[0] = version << 4;
      assert.throws(() =>
        candidate.decode('w' + toBase64(seal(bad, original)))
      );
    }
    const reserved = body.slice();
    reserved[0] = 0x12;
    assert.throws(() =>
      candidate.decode('w' + toBase64(seal(reserved, original)))
    );
  }
});
test('bounded malformed-stream probes with reproducible pseudo-random data', () => {
  let state = 0x173ea50d;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  for (let n = 0; n < 300; n++) {
    const body = Uint8Array.from(
      { length: 8 + (random() % 100) },
      () => random() & 255
    );
    body[4] = 0x10 | (n & 1);
    assert.throws(() => candidate.decode('w' + toBase64(body)));
  }
});
test('packed domain lookup equals rank order and refuses malformed dictionaries', () => {
  const names = ['example.org', 'a.example.org', 'example.com', 'z.test'];
  const bytes = packDomainPool(names),
    pool = openDomainPool(bytes);
  names.forEach((name, rank) => {
    assert.equal(pool.find(name), rank);
    assert.equal(pool.get(rank), name);
  });
  for (const absent of [
    '',
    'example',
    'example.com.',
    'Example.com',
    'not-found.invalid'
  ])
    assert.equal(pool.find(absent), undefined);
  assert.throws(() => openDomainPool(bytes.subarray(0, bytes.length - 1)));
  const badRank = bytes.slice(),
    data = new DataView(badRank.buffer);
  data.setUint32(12 + 4 * (names.length + 1), names.length + 3, true);
  assert.throws(() => openDomainPool(badRank));
});
test('known/unknown long authorities and mixed-case host fuzz remain bounded and exact', async () => {
  const domainOnly = createGrammarCandidate({
    contextBytes,
    domainBytes: await fs.readFile(
      new URL(
        '../codecs/grammar/models/majestic-262144-pool.bin',
        import.meta.url
      )
    ),
    domainMeta: JSON.parse(
      await fs.readFile(
        new URL(
          '../codecs/grammar/models/majestic-262144-meta.json',
          import.meta.url
        )
      )
    )
  });
  const oversizedPrefix =
    'https://' + 'a'.repeat(260) + '.wikipedia.org/path?x=12345678';
  assert.equal(domainOnly.encode(oversizedPrefix), null);
  const largePort = 'https://wikipedia.org:' + '0'.repeat(40) + '443/a';
  assert.equal(domainOnly.encode(largePort), null);
  const longInputs = [
    oversizedPrefix,
    largePort,
    'https://' + 'a'.repeat(1000) + '.unknown.invalid/a',
    'https://' + 'a'.repeat(255) + '.wikipedia.org/a'
  ];
  let state = 0x821d7543;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const hosts = [
    'example.com',
    'www.wikipedia.org',
    'docs.google.com',
    'unlisted-host.invalid'
  ];
  for (let i = 0; i < 200; i++) {
    const host = [...hosts[i % hosts.length]]
      .map((c) => (random() & 1 ? c.toUpperCase() : c))
      .join('');
    const scheme = [...(i % 3 ? 'https' : 'http')]
      .map((c) => (random() & 1 ? c.toUpperCase() : c))
      .join('');
    longInputs.push(
      `${scheme}://${host}${i % 7 ? '' : '.:0443'}/a//${random()}?x=0&x=00&&y=%2f#${random()}`
    );
  }
  for (const input of longInputs) {
    const encoded = candidate.encode(input);
    assert.ok(encoded);
    assert.equal(candidate.decode(encoded.payload), input);
  }
});
