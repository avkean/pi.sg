import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, inflateSync } from 'fflate/browser';
import { seal, toBase64, verify } from '../codecs/core/bytes.mjs';
import {
  encodePercent,
  decodePercent,
  MAX_INPUT_BYTES,
  MAX_TRANSFORM_BYTES,
  MAX_BODY_BYTES
} from '../src/percent.mjs';

const utf8 = new TextEncoder(),
  ESC = 27,
  PREFIX = 'https://search.example/?q=';
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}
function sequence(next, count, base = 0x4e00, span = 2048) {
  return Array.from({ length: count }, () =>
    String.fromCodePoint(base + (next() % span))
  ).join('');
}
function escaped(value, lower = false) {
  const result = encodeURIComponent(value);
  return lower
    ? result.replace(/%[0-9A-F]{2}/g, (triplet) => triplet.toLowerCase())
    : result;
}
function uint(value) {
  const bytes = [];
  do {
    const byte = value & 127;
    value = Math.floor(value / 128);
    bytes.push(byte | (value ? 128 : 0));
  } while (value);
  return bytes;
}
function frame(transformed, originalLength, header = 0x10, level = 6) {
  const prefix = [header, ...uint(originalLength)],
    compressed = deflateSync(Uint8Array.from(transformed), { level });
  const body = new Uint8Array(prefix.length + compressed.length);
  body.set(prefix);
  body.set(compressed, prefix.length);
  return body;
}
function unpack(body) {
  let position = 1,
    originalLength = 0,
    scale = 1;
  do {
    const byte = body[position++];
    originalLength += (byte & 127) * scale;
    scale *= 128;
    if (!(byte & 128)) break;
  } while (position < body.length);
  return {
    headerLength: position,
    originalLength,
    transformed: inflateSync(body.subarray(position))
  };
}
function roundtrip(input) {
  const body = encodePercent(input);
  assert.ok(body instanceof Uint8Array, input.slice(0, 100));
  assert.ok(body.length <= MAX_BODY_BYTES);
  assert.equal(decodePercent(body), input);
  assert.deepEqual(encodePercent(input), body);
  assert.ok(
    body.length + 4 <= deflateSync(utf8.encode(input), { level: 6 }).length
  );
  return body;
}

test('independent wire vectors distinguish encoded high bytes, encoded ASCII, and raw UTF-8', () => {
  for (const lower of [false, true]) {
    const input =
      PREFIX +
      escaped('中', lower) +
      '&slash=' +
      (lower ? '%2f' : '%2F') +
      '&zero=%00&esc=' +
      (lower ? '%1b' : '%1B') +
      '&raw=中';
    const transformed = [
      ...utf8.encode(PREFIX),
      0xe4,
      0xb8,
      0xad,
      ...utf8.encode('&slash='),
      ESC,
      0x2f,
      ...utf8.encode('&zero='),
      ESC,
      0,
      ...utf8.encode('&esc='),
      ESC,
      ESC,
      ...utf8.encode('&raw='),
      ESC,
      0xe4,
      ESC,
      0xb8,
      ESC,
      0xad
    ];
    const body = frame(
      transformed,
      utf8.encode(input).length,
      0x10 | Number(lower)
    );
    assert.equal(decodePercent(body), input);
    const candidate = encodePercent(input);
    if (candidate) assert.deepEqual(candidate, body);
  }
});

test('seeded Chinese, Arabic, and emoji URLs preserve both hex cases across unrelated hosts', () => {
  const next = random(0x50455243);
  for (const [base, span] of [
    [0x4e00, 2048],
    [0x621, 40],
    [0x1f600, 80]
  ]) {
    for (let i = 0; i < 24; i++) {
      const value = sequence(next, 80 + (next() % 100), base, span);
      for (const lower of [false, true]) {
        const input =
          `${i % 2 ? 'http' : 'https'}://h${next().toString(36)}.example:8080/a//../search?q=` +
          escaped(value, lower) +
          '&slash=' +
          (lower ? '%2f' : '%2F') +
          '&q=again#exact';
        const body = roundtrip(input);
        assert.equal(body[0], lower ? 0x11 : 0x10);
      }
    }
  }
});

test('all percent byte values, including controls and invalid percent UTF-8, are lossless', () => {
  const next = random(0x00ff001b),
    tail = sequence(next, 500);
  for (const lower of [false, true]) {
    const bytes = Array.from(
      { length: 256 },
      (_, byte) => '%' + byte.toString(16).padStart(2, '0')
    ).join('');
    const input =
      PREFIX +
      (lower ? bytes : bytes.toUpperCase()) +
      '&q=' +
      escaped(tail, lower);
    roundtrip(input);
  }
});

test('raw Unicode, malformed literal percent sequences, and nested query spelling stay exact', () => {
  const next = random(0x5eed1122);
  for (const lower of [false, true]) {
    const value = escaped(sequence(next, 250), lower);
    roundtrip(
      'HTTP://User:pAss@EXAMPLE.com:080/café/中/مرحبا/🙂/\ufeff?q=' +
        value +
        '&raw=é中🙂&malformed=%GG%q1%4%&incomplete=%A#%%'
    );
    const nested =
      'https://nested.example/a?query=' + value + '&sort=recent&limit=30';
    roundtrip(
      'https://forward.example/redirect?url=' +
        escaped(nested, lower) +
        '&extra=' +
        value
    );
    // Inner triplet letters are literal after the outer %25 and may differ in case.
    roundtrip(PREFIX + value + '&inner=%252f%252F%25e4%25E4');
  }
});

test('mixed hex case declines instead of normalizing, including case within one triplet', () => {
  const rich = PREFIX + escaped(sequence(random(42), 100));
  for (const suffix of ['%2f%2F', '%aB', '%Ab', '%aa', '%ff', '%Ff']) {
    assert.equal(encodePercent(rich + suffix), null);
  }
  roundtrip(rich + '&literal=abcdefABCDEF&nested=%252f');
});

test('unsafe, malformed Unicode, oversized, no-percent, and trivial inputs decline safely', () => {
  for (const input of [
    null,
    undefined,
    1,
    {},
    [],
    new Uint8Array(),
    '',
    'not a URL',
    'ftp://example.com/%E4%B8%AD',
    'javascript:alert(1)',
    'https:///%00',
    PREFIX + 'abc',
    PREFIX + '%',
    PREFIX + '%GG',
    PREFIX + '%4',
    PREFIX + '%20',
    PREFIX + '%2F',
    PREFIX + '\ud800%E4%B8%AD',
    PREFIX + '\udc00%E4%B8%AD',
    PREFIX + '\ud800x\udc00%00',
    PREFIX + 'a'.repeat(MAX_INPUT_BYTES) + '%00',
    PREFIX + '中'.repeat(MAX_INPUT_BYTES / 2) + '%00'
  ]) {
    assert.equal(encodePercent(input), null);
  }
  for (const byte of [0, 9, 10, 13, 27, 32, 127]) {
    assert.equal(
      encodePercent(PREFIX + '%00' + String.fromCharCode(byte)),
      null
    );
  }
});

test('input byte limit is inclusive and rejects an extra byte without normalizing', () => {
  const count = Math.floor((MAX_INPUT_BYTES - PREFIX.length) / 9);
  const input =
    PREFIX +
    '%E4%B8%AD'.repeat(count) +
    'a'.repeat(MAX_INPUT_BYTES - PREFIX.length - count * 9);
  assert.equal(utf8.encode(input).length, MAX_INPUT_BYTES);
  roundtrip(input);
  assert.equal(encodePercent(input + 'a'), null);
});

test('transformed and restored lengths have independent 128 KiB limits', () => {
  const prefix = utf8.encode(PREFIX),
    count = Math.floor((MAX_TRANSFORM_BYTES - prefix.length - 3) / 4);
  const padding = MAX_TRANSFORM_BYTES - prefix.length - count * 4 - 3;
  const transformed = new Uint8Array(MAX_TRANSFORM_BYTES);
  transformed.set(prefix);
  for (let i = 0; i < count; i++)
    transformed.set([ESC, 0xc3, ESC, 0xa9], prefix.length + 4 * i);
  transformed.set([0xe4, 0xb8, 0xad], prefix.length + 4 * count);
  transformed.fill(97, transformed.length - padding);
  const input = PREFIX + 'é'.repeat(count) + '%E4%B8%AD' + 'a'.repeat(padding);
  assert.equal(
    decodePercent(frame(transformed, utf8.encode(input).length)),
    input
  );
  assert.equal(encodePercent(input + 'é'), null); // Input fits; transformed UTF-8 does not.
  const oversized = new Uint8Array(MAX_TRANSFORM_BYTES + 1);
  oversized.fill(97);
  assert.throws(() => decodePercent(frame(oversized, MAX_INPUT_BYTES)));
  const expansionBomb = new Uint8Array(
    Math.ceil(MAX_INPUT_BYTES / 3) + prefix.length
  );
  expansionBomb.set(prefix);
  expansionBomb.fill(0x80, prefix.length);
  assert.throws(() => decodePercent(frame(expansionBomb, MAX_INPUT_BYTES)));
  assert.throws(() => decodePercent(frame(prefix, MAX_INPUT_BYTES + 1)));
});

test('version/method flags, minimal lengths, compressed canonicality, and truncation are strict', () => {
  const input = PREFIX + escaped(sequence(random(1337), 100));
  const body = roundtrip(input),
    { transformed, originalLength, headerLength } = unpack(body);
  for (const value of [
    null,
    {},
    [],
    'body',
    new Uint8Array(),
    new Uint8Array(MAX_BODY_BYTES + 1)
  ]) {
    assert.throws(() => decodePercent(value));
  }
  for (let end = 0; end < body.length; end++)
    assert.throws(() => decodePercent(body.subarray(0, end)));
  for (const header of [0, 1, 0x12, 0x13, 0x18, 0x20, 0x80, 0xff]) {
    const changed = body.slice();
    changed[0] = header;
    assert.throws(() => decodePercent(changed));
  }
  for (const size of [
    0,
    originalLength - 1,
    originalLength + 1,
    MAX_INPUT_BYTES + 1
  ]) {
    assert.throws(() => decodePercent(frame(transformed, size)));
  }
  for (const length of [
    [0x80, 0],
    [0x81, 0],
    [0x80, 0x80, 0x80, 1],
    [0xff, 0xff, 0x7f]
  ]) {
    assert.throws(() =>
      decodePercent(
        Uint8Array.from([0x10, ...length, ...body.subarray(headerLength)])
      )
    );
  }
  const nonminimal = uint(originalLength);
  nonminimal[nonminimal.length - 1] |= 128;
  nonminimal.push(0);
  assert.throws(() =>
    decodePercent(
      Uint8Array.from([0x10, ...nonminimal, ...body.subarray(headerLength)])
    )
  );
  assert.throws(() => decodePercent(Uint8Array.from([...body, 0])));
  assert.throws(() =>
    decodePercent(Uint8Array.from([...body, ...body.subarray(headerLength)]))
  );
  assert.throws(() =>
    decodePercent(frame(transformed, originalLength, 0x10, 0))
  );
  const stored = frame(transformed, originalLength, 0x10, 0);
  stored[headerLength] |= 0xf8;
  assert.throws(() => decodePercent(stored)); // Ignored alignment bits are not canonical.
  const reserved = body.slice();
  reserved[headerLength] = 7;
  assert.throws(() => decodePercent(reserved));
});

test('inverse transform rejects dangling escapes, ambiguous spelling, raw controls, and invalid UTF-8', () => {
  const prefix = [...utf8.encode(PREFIX)];
  assert.throws(() =>
    decodePercent(frame([...prefix, ESC], prefix.length + 3))
  );
  assert.throws(() =>
    decodePercent(frame([...prefix, ...utf8.encode('%41')], prefix.length + 3))
  );
  assert.throws(() =>
    decodePercent(
      frame([...prefix, ...utf8.encode('%aB'), 0x80], prefix.length + 6)
    )
  );
  assert.throws(() => decodePercent(frame(prefix, prefix.length))); // No percent data.
  assert.equal(
    decodePercent(frame([...prefix, ESC, 0], prefix.length + 3)),
    PREFIX + '%00'
  );
  assert.throws(() =>
    decodePercent(frame([...prefix, ESC, 0], prefix.length + 3, 0x11))
  ); // No letters to lowercase.
  for (const byte of [0, 9, 10, 13, 32, 127]) {
    assert.throws(() =>
      decodePercent(frame([...prefix, byte, 0x80], prefix.length + 4))
    );
  }
  for (const invalid of [
    [0xff],
    [0x80],
    [0xc0, 0xaf],
    [0xed, 0xa0, 0x80],
    [0xe2, 0x82],
    [0xf4, 0x90, 0x80, 0x80]
  ]) {
    assert.throws(() =>
      decodePercent(
        frame(
          [...prefix, ...invalid.flatMap((byte) => [ESC, byte]), 0x80],
          prefix.length + invalid.length + 3
        )
      )
    );
  }
  const notHttp = [...utf8.encode('javascript:alert(1)'), 0x80];
  assert.throws(() => decodePercent(frame(notHttp, notHttp.length + 2)));
});

test('parent CRC detects a valid case-bit mutation of an otherwise canonical body', () => {
  const input = PREFIX + escaped(sequence(random(0xc0decafe), 150));
  const body = roundtrip(input),
    sealed = seal(body, utf8.encode(input));
  const changed = body.slice();
  changed[0] ^= 1;
  const other = decodePercent(changed);
  assert.equal(
    other,
    input.replace(/%[0-9A-F]{2}/g, (triplet) => triplet.toLowerCase())
  );
  assert.notEqual(other, input);
  assert.throws(() => verify(sealed, utf8.encode(other)));
});

test('seeded malformed bodies and mutations stay bounded without treating CRC as syntax', () => {
  const next = random(0xbadc0de),
    body = roundtrip(PREFIX + escaped(sequence(next, 180)));
  for (let i = 0; i < 700; i++) {
    const changed =
      i % 3
        ? body.slice()
        : Uint8Array.from({ length: 4 + (next() % 80) }, () => next() & 255);
    if (i % 3) changed[next() % changed.length] ^= 1 << next() % 8;
    else changed[0] = 0x10 | (i & 1);
    try {
      const input = decodePercent(changed);
      assert.ok(utf8.encode(input).length <= MAX_INPUT_BYTES);
      const encoded = encodePercent(input);
      if (encoded) assert.deepEqual(encoded, changed);
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof assert.AssertionError), error.message);
    }
  }
});
