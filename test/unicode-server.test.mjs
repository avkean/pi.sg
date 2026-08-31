import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { deflateRawSync, brotliCompressSync, constants as z } from 'node:zlib';
import {
  createUnicodeCodec,
  MAX_INPUT_BYTES,
  MAX_BODY_BYTES,
  MAX_SKELETON_BYTES,
  measureBody,
  renderBody
} from '../codecs/unicode/codec.mjs';
import {
  MODES,
  Writer,
  Reader,
  percentToBytes,
  bytesToPercent,
  transform,
  restore,
  recode,
  unrecode,
  splitHigh,
  joinHigh
} from '../codecs/unicode/transform.mjs';
import { random } from './helpers/random.mjs';
import { seal, toBase64 } from '../codecs/core/bytes.mjs';
import { createCodec as createSubword } from '../codecs/compact/subword.mjs';
import subwordModel from '../codecs/core/subword/model.mjs';
const enc = new TextEncoder(),
  dec = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const model = fs.readFileSync(
  new URL('../models/context-v1.bin', import.meta.url)
);
const codec = createUnicodeCodec(model),
  prefix = 'https://x.example/?q=';
function bytes(...values) {
  return Uint8Array.from(
    values.flatMap((x) =>
      typeof x === 'string' ? [...enc.encode(x)] : Array.from(x)
    )
  );
}
function body(
  input,
  b,
  mode = 'bytes',
  method = 0,
  layout = 0,
  sk = null,
  skMethod = 0,
  length = Buffer.byteLength(input)
) {
  const w = new Writer();
  w.put(0x10 | layout);
  w.put(MODES.indexOf(mode) | (method << 4));
  w.uint(length);
  if (layout) {
    w.put(skMethod);
    w.uint(sk.length);
    w.append(sk);
  }
  const packed =
    method === 0
      ? b
      : method === 1
        ? deflateRawSync(b)
        : brotliCompressSync(b, {
            params: { [z.BROTLI_PARAM_QUALITY]: 5, [z.BROTLI_PARAM_LGWIN]: 17 }
          });
  w.append(packed);
  return w.finish();
}
function check(input, options) {
  const e = codec.encode(input, options);
  assert.ok(e, 'candidate missing');
  assert.equal(codec.decodeBody(e.body), input);
  assert.equal(codec.decode(e.payload), input);
  assert.equal(codec.decode(e.asciiPayload), input);
  assert.equal(codec.decode(new URL(e.url).href.slice(14)), input);
  assert.deepEqual(codec.encode(input, options).body, e.body);
  assert.ok(e.body.length <= MAX_BODY_BYTES);
  if (options?.format !== 'ascii')
    assert.deepEqual(measureBody(e.body), e.metrics);
  return e;
}

test('independent percent-byte vectors include intra-triplet mixed case and global switches', () => {
  const input = prefix + '%00%1B%80%Ab%aB%2f%2F/é';
  const expected = bytes(
    prefix,
    [27, 0, 27, 27, 128, 29, 1, 171, 29, 2, 171, 28, 27, 47, 28, 27, 47],
    '/',
    [26, 2, 195, 169]
  );
  assert.deepEqual(percentToBytes(enc.encode(input)), expected);
  assert.equal(dec.decode(bytesToPercent(expected)), input);
  assert.equal(codec.decodeBody(body(input, expected)), input);
});

test('independent Unicode lane vectors, invalid UTF-8 bytes and supplementary points', () => {
  const original = Uint8Array.from([
    65, 0xc3, 0xa9, 0xf0, 0x9f, 0x99, 0x82, 0xff, 0xc0, 0x80
  ]);
  const le = Uint8Array.from([
    65, 0, 233, 0, 0x3d, 0xd8, 0x42, 0xde, 0xff, 0xdc, 0xc0, 0xdc, 0x80, 0xdc
  ]);
  assert.deepEqual(recode(original, 'utf16le'), le);
  assert.deepEqual(unrecode(le, 'utf16le'), original);
  for (const mode of MODES)
    assert.deepEqual(unrecode(recode(original, mode), mode), original);
});

test('all 256 percent bytes and every hex-letter casing survive all recodings and compressors', () => {
  let tail = '';
  for (let v = 0; v < 256; v++)
    for (let mask = 0; mask < 4; mask++) {
      const s = v.toString(16).padStart(2, '0').toUpperCase();
      tail +=
        '%' +
        (mask & 2 ? s[0].toLowerCase() : s[0]) +
        (mask & 1 ? s[1].toLowerCase() : s[1]);
    }
  const input =
    prefix + tail + '&literal=%GG%q1%4%&nested=%252f%252F&raw=中🙂é';
  for (const mode of MODES)
    for (const method of [0, 1, 2]) {
      const b = transform(enc.encode(input), mode);
      assert.deepEqual(restore(b, mode), enc.encode(input));
      const framed = body(input, b, mode, method);
      if (framed.length <= MAX_BODY_BYTES)
        assert.equal(codec.decodeBody(framed), input);
    }
  check(input);
  check(input, { profile: 'thorough', quality: 4 });
  check(input, { quality: 6, format: 'ascii' });
});

test('destination case, authority, dot segments, combining marks, BOM and partial byte origins stay exact', () => {
  for (const suffix of [
    '%E4%B8%AD/中/%e4%b8%ad',
    '%E4%B8é%AD',
    '%c0%af%ED%A0%80%F4%90%80%80',
    '%EF%BB%BF/\ufeff',
    'é/é/가/가',
    '%252f%252F%25e4%25E4/%GG%2%',
    '%Ab%aB%ff%FF'
  ]) {
    check(
      'HtTp://User:pAss@例え.EXAMPLE:080/a/../b//?q=' + suffix + '&q=&q=+#'
    );
  }
});

test('split side streams roundtrip with S and P skeletons and strict run boundaries', () => {
  const input = prefix + '%E4%B8%AD&literal=%2F&raw=é&bad=%FF%Ab',
    raw = enc.encode(input);
  const { skeleton, parts } = splitHigh(raw),
    S = createSubword(subwordModel, { maxInputBytes: MAX_SKELETON_BYTES });
  for (const mode of MODES) {
    const side = new Writer();
    for (const p of parts) {
      const b = transform(p, mode);
      side.uint(b.length);
      side.append(b);
    }
    const b = side.finish();
    assert.deepEqual(joinHigh(skeleton, b, mode), raw);
    assert.equal(
      codec.decodeBody(body(input, b, mode, 1, 1, S.encodeBytes(skeleton))),
      input
    );
    assert.throws(() => joinHigh(skeleton, bytes(b, [1]), mode));
    assert.throws(() => joinHigh(skeleton, b.subarray(0, b.length - 1), mode));
  }
  // The regular development runner also verifies every chosen P skeleton.
  check(input, { profile: 'thorough' });
});

test('seeded grammar fuzz covers mixed raw/percent Unicode and invalid/incomplete escapes', () => {
  const next = random(0xda7a13ef);
  const atoms = [
    '%',
    '%A',
    '%q1',
    '%GG',
    '%00',
    '%1b',
    '%Ab',
    '%aB',
    '%2F',
    '%2f',
    '%C0',
    '%80',
    '%ED%A0%80',
    '%F4%90%80%80',
    '%252F',
    'é',
    'é',
    '中',
    '🙂',
    '\ufeff',
    '&q=',
    '/?',
    '#',
    '+',
    'abc',
    '%E4%B8%AD'
  ];
  for (let i = 0; i < 1200; i++) {
    let input = prefix;
    for (let j = 0, n = 1 + (next() % 50); j < n; j++)
      input += atoms[next() % atoms.length];
    for (const mode of MODES)
      assert.deepEqual(
        restore(transform(enc.encode(input), mode), mode),
        enc.encode(input)
      );
    if (i % 6 === 0 && /[%\u0080-\uffff]/.test(input)) check(input);
  }
});

test('unsafe destinations, malformed UTF-16 and oversized inputs decline without repair', () => {
  for (const input of [
    null,
    {},
    42,
    '',
    'foo',
    'ftp://x/%FF',
    'javascript:alert(1)',
    'https:///%00',
    prefix + '\ud800',
    prefix + '\udc00',
    prefix + 'a'.repeat(MAX_INPUT_BYTES),
    prefix + '中'.repeat(MAX_INPUT_BYTES / 2)
  ])
    assert.equal(codec.encode(input), null);
  for (const value of [0, 9, 10, 13, 27, 32, 127])
    assert.equal(
      codec.encode(prefix + String.fromCharCode(value) + '%ff'),
      null
    );
  assert.equal(codec.encode('https://example.com/plain'), null);
  assert.throws(() => codec.encode(prefix + '%00', { profile: 'infinite' }));
  assert.throws(() => codec.encode(prefix + '%00', { quality: 11 }));
});

test('inclusive 128 KiB input and transform limits, including ASCII transport fallback', () => {
  const unit = '%E4%B8%AD',
    count = Math.floor((MAX_INPUT_BYTES - prefix.length) / unit.length);
  const input =
    prefix +
    unit.repeat(count) +
    'a'.repeat(MAX_INPUT_BYTES - prefix.length - count * unit.length);
  assert.equal(Buffer.byteLength(input), MAX_INPUT_BYTES);
  check(input, { profile: 'fast' });
  assert.equal(codec.encode(input), null);
  assert.equal(codec.encode(input + 'x'), null);
  const max = new Uint8Array(MAX_INPUT_BYTES).fill(65);
  assert.equal(recode(max, 'bytes').length, MAX_INPUT_BYTES);
  assert.throws(() => recode(max, 'utf16le'), /limit/);
  assert.throws(
    () => unrecode(new Uint8Array(MAX_INPUT_BYTES).fill(255), 'window'),
    /limit|codepoint/
  );
  for (const size of [1, 4, 128, 1200, 1700, MAX_BODY_BYTES]) {
    const b = new Uint8Array(size),
      rendered = renderBody(b, enc.encode(prefix + '%00'));
    assert.deepEqual(measureBody(b), rendered.metrics);
  }
});

test('decompression bombs are bounded before native inflation can exceed 128 KiB', () => {
  for (const method of [1, 2])
    assert.throws(() =>
      codec.decodeBody(
        body(
          prefix + '%00',
          new Uint8Array(MAX_INPUT_BYTES + 1).fill(65),
          'bytes',
          method
        )
      )
    );
  const highExpansion = new Uint8Array(MAX_INPUT_BYTES).fill(128);
  for (const method of [1, 2])
    assert.throws(() =>
      codec.decodeBody(body(prefix + '%00', highExpansion, 'bytes', method))
    );
  const decodedLength = bytes(prefix, [0x80]);
  assert.throws(() =>
    codec.decodeBody(
      body(
        prefix + '%80',
        decodedLength,
        'bytes',
        1,
        0,
        null,
        0,
        MAX_INPUT_BYTES + 1
      )
    )
  );
});

test('rejects oversized Brotli windows, reserved flags, overlong varints and trailing streams', () => {
  const input = prefix + '%e4%b8%ad',
    transformed = transform(enc.encode(input), 'bytes');
  const br = brotliCompressSync(transformed, {
    params: { [z.BROTLI_PARAM_QUALITY]: 5, [z.BROTLI_PARAM_LGWIN]: 24 }
  });
  const w = new Writer();
  w.put(0x10);
  w.put(0x20);
  w.uint(Buffer.byteLength(input));
  w.append(br);
  assert.throws(() => codec.decodeBody(w.finish()), /window/);
  for (const version of [0, 0x12, 0x20, 255]) {
    const b = body(input, transformed);
    b[0] = version;
    assert.throws(() => codec.decodeBody(b));
  }
  for (const flag of [7, 15, 48, 128, 255]) {
    const b = body(input, transformed);
    b[1] = flag;
    assert.throws(() => codec.decodeBody(b));
  }
  const b = body(input, transformed);
  assert.throws(() =>
    codec.decodeBody(bytes(b.subarray(0, 2), [b[2] | 128, 0], b.subarray(3)))
  );
  for (const method of [1, 2]) {
    const valid = body(input, transformed, 'bytes', method);
    for (let n = 0; n < valid.length; n++)
      assert.throws(() => codec.decodeBody(valid.subarray(0, n)));
    assert.throws(() => codec.decodeBody(bytes(valid, [0])));
    assert.throws(() => codec.decodeBody(bytes(valid, valid)));
  }
});

test('rejects noncanonical percent metadata, malformed Unicode recodings and skeleton abuse', () => {
  for (const b of [
    [26, 0],
    [26, 1, 65],
    [27],
    [27, 255],
    [28],
    [29, 0, 255],
    [29, 1, 15],
    [0],
    [127],
    [29, 2]
  ])
    assert.throws(() => bytesToPercent(bytes(prefix, b)));
  for (const [mode, b] of [
    ['utf16le', [0]],
    ['utf16le', [0, 216]],
    ['utf16le', [0, 220]],
    ['codepoint', [128, 0]],
    ['delta', [129]],
    ['window', [127, 2]],
    ['window', [128]],
    ['delta', [128, 1]]
  ])
    assert.throws(() => unrecode(Uint8Array.from(b), mode));
  assert.throws(() => codec.decodeBody(new Uint8Array(MAX_BODY_BYTES + 1)));
  for (const value of [null, {}, [], 'body'])
    assert.throws(() => codec.decodeBody(value));
  const S = createSubword(subwordModel, { maxInputBytes: 65536 }),
    sk = S.encodeBytes(new Uint8Array(MAX_SKELETON_BYTES + 1).fill(97));
  assert.throws(() =>
    codec.decodeBody(body(prefix, new Uint8Array([1]), 'bytes', 0, 1, sk))
  );
});

test('CRC32, base64 canonicality, marker and serialized transport reject corruption', () => {
  const input = prefix + '%E4%B8%AD%aB%FF',
    e = check(input),
    frame = seal(e.body, enc.encode(input));
  for (let i = 0; i < 4; i++)
    for (let bit = 0; bit < 8; bit++) {
      const bad = frame.slice();
      bad[i] ^= 1 << bit;
      assert.throws(() => codec.decode('u' + toBase64(bad)));
    }
  assert.throws(() => codec.decode('y' + e.asciiPayload.slice(1)));
  assert.throws(() => codec.decode(e.asciiPayload + '='));
  assert.throws(() => codec.decode('%75' + e.asciiPayload.slice(1)));
  assert.throws(() => codec.decode('%' + 'AA'.repeat(10000)));
  assert.equal(codec.decode(e.payload.normalize('NFD')), input);
});

test('random framed corruption either rejects or returns exactly the CRC-protected original', () => {
  const next = random(0x7fa511),
    input = prefix + '%E4%B8%AD'.repeat(60) + '%aB%FF',
    e = check(input),
    frame = seal(e.body, enc.encode(input));
  for (let i = 0; i < 1500; i++) {
    const bad = frame.slice();
    bad[next() % bad.length] ^= 1 << next() % 8;
    let result;
    try {
      result = codec.decode('u' + toBase64(bad));
    } catch {
      continue;
    }
    assert.equal(result, input);
  }
});
