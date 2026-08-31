import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toWide, fromWide, isWide } from '../src/wide.mjs';

const ASCII =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const FORMS = ['NFC', 'NFD', 'NFKC', 'NFKD'];
const ALPHABET = [
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xac00, 0xc03f]
].flatMap(([first, last]) =>
  Array.from({ length: last - first + 1 }, (_, i) =>
    String.fromCharCode(first + i)
  )
);
const MAX_ASCII = 8192;
const MAX_WIDE = 3277;

// An intentionally different, small-input oracle: construct a binary string,
// split it from the right, and index an explicit alphabet. No streaming state.
function referenceEncode(input) {
  const binary =
    '1' +
    [...input]
      .map((c) => ASCII.indexOf(c).toString(2).padStart(6, '0'))
      .join('');
  return binary
    .padStart(Math.ceil(binary.length / 15) * 15, '0')
    .match(/.{15}/g)
    .map((group) => ALPHABET[parseInt(group, 2)])
    .join('');
}

function asciiFromBits(bits) {
  assert.equal(bits.length % 6, 0);
  return (bits.match(/.{6}/g) || [])
    .map((group) => ASCII[parseInt(group, 2)])
    .join('');
}

function randomPayload(length, seed = 0x724fed91) {
  let state = seed;
  return Array.from({ length }, () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ASCII[(state >>> 0) & 63];
  }).join('');
}

test('frozen vectors specify alphabet order, bit order, empty input and zero preservation', () => {
  for (const [ascii, wide] of [
    ['', '\u3401'],
    ['A', '\u3440'],
    ['_', '\u347f'],
    ['AA', '\u4400'],
    ['__', '\u543f'],
    ['AAA', '\u3408\u3400'],
    ['AAAA', '\u3600\u3400'],
    ['AAAAA', '\u3401\u3400\u3400'],
    ['_____', '\u3401\uc03f\uc03f'],
    ['ABC', '\u3408\u3442']
  ]) {
    assert.equal(toWide(ascii), wide);
    assert.equal(fromWide(wide), ascii);
    assert.equal(isWide(wide), true);
    assert.equal(referenceEncode(ascii), wide);
  }
});

test('every allowed payload length round-trips with exact visible length', () => {
  const random = randomPayload(MAX_ASCII);
  for (let length = 0; length <= MAX_ASCII; length++) {
    const ascii = random.slice(0, length),
      wide = toWide(ascii);
    assert.equal(
      wide.length,
      Math.ceil((6 * length + 1) / 15),
      `length ${length}`
    );
    assert.equal(fromWide(wide), ascii, `length ${length}`);
    assert.equal(isWide(wide), true);
  }
});

test('all one- and two-symbol ASCII inputs agree with the independent oracle', () => {
  for (const a of ASCII) {
    for (const b of ['', ...ASCII]) {
      const ascii = a + b;
      assert.equal(toWide(ascii), referenceEncode(ascii));
      assert.equal(fromWide(toWide(ascii)), ascii);
    }
  }
});

test('random alignments, arbitrary base64url symbols and zero runs are exact', () => {
  for (let seed = 1; seed <= 160; seed++) {
    const ascii = randomPayload((seed * 1543) % (MAX_ASCII + 1), seed);
    assert.equal(toWide(ascii), referenceEncode(ascii));
    assert.equal(fromWide(toWide(ascii)), ascii);
  }
  for (const length of [
    0, 1, 2, 3, 4, 5, 6, 14, 15, 16, 127, 128, 129, 8190, 8191, 8192
  ]) {
    for (const ascii of [
      'A'.repeat(length),
      '_'.repeat(length),
      ('A'.repeat(length) + 'B').slice(-MAX_ASCII),
      ('B' + 'A'.repeat(length)).slice(0, MAX_ASCII)
    ]) {
      assert.equal(fromWide(toWide(ascii)), ascii);
    }
  }
  // These need not represent canonical whole bytes: do not base64-decode them.
  for (const ascii of ['B', 'AB', 'ABC', 'aA-_09Zz', ASCII]) {
    assert.equal(fromWide(toWide(ascii)), ascii);
  }
  assert.notEqual(toWide('A'), toWide('a'));
});

test('isWide checks every BMP code point and never accepts a partial alphabet match', () => {
  const allowed = new Set(ALPHABET);
  assert.equal(allowed.size, 32768);
  for (let code = 0; code <= 0xffff; code++) {
    const character = String.fromCharCode(code);
    assert.equal(
      isWide(character),
      allowed.has(character),
      `U+${code.toString(16)}`
    );
    if (!allowed.has(character)) {
      assert.equal(isWide(ALPHABET[1] + character + ALPHABET[0]), false);
      // Even the allowed recovery Jamo cannot form a syllable in isolation.
      assert.throws(
        () => fromWide(ALPHABET[1] + character + ALPHABET[0]),
        Error
      );
    }
  }
  assert.equal(isWide(ALPHABET[0]), true); // Alphabet membership is not framing.
  assert.throws(() => fromWide(ALPHABET[0]), /sentinel/);
  assert.equal(isWide(ALPHABET[1].repeat(MAX_WIDE)), true);
  assert.equal(isWide(ALPHABET[1].repeat(MAX_WIDE + 1)), false);
});

test('all 32,768 digits encode, normalize and survive URI path/fragment transport', () => {
  // An even number of 15-bit digits is an integral number of six-bit symbols.
  // Batch below the API limit while exercising every alphabet character.
  for (let offset = 0; offset < ALPHABET.length; offset += 3276) {
    const digits = ALPHABET.slice(offset, offset + 3276);
    const wide = ALPHABET[1] + digits.join('');
    const ascii = asciiFromBits(
      digits.map((_, i) => (offset + i).toString(2).padStart(15, '0')).join('')
    );
    assert.equal(toWide(ascii), wide);
    assert.equal(fromWide(wide), ascii);
    assert.equal(isWide(wide), true);
    assert.equal([...wide].length, wide.length);
    assert.equal(Buffer.byteLength(wide, 'utf8'), 3 * wide.length);
    assert.equal(encodeURIComponent(wide).length, 9 * wide.length);
    assert.equal(fromWide(decodeURIComponent(encodeURIComponent(wide))), ascii);
    for (const form of FORMS) {
      const normalized = wide.normalize(form);
      assert.equal(fromWide(normalized), ascii, form);
      const path = new URL(
        'https://pi.example/' + normalized + '?keep=1#section'
      );
      assert.equal(path.search, '?keep=1');
      assert.equal(path.hash, '#section');
      assert.equal(path.pathname.split('/').length, 2);
      assert.equal(fromWide(decodeURIComponent(path.pathname.slice(1))), ascii);
      const fragment = new URL('https://pi.example/#' + normalized);
      assert.equal(fromWide(decodeURIComponent(fragment.hash.slice(1))), ascii);
      for (const nextForm of FORMS) {
        assert.equal(
          fromWide(normalized.normalize(nextForm)),
          ascii,
          `${form} -> ${nextForm}`
        );
      }
    }
  }
});

test('normalization audit proves the alphabet is recoverable, not NFD-invariant', () => {
  const changed = Object.fromEntries(FORMS.map((form) => [form, 0]));
  const normalizedKeys = Object.fromEntries(
    FORMS.map((form) => [form, new Set()])
  );
  for (const character of ALPHABET) {
    assert.doesNotMatch(
      character,
      /[\p{Mark}\p{Separator}\p{Other}\p{Punctuation}\p{Default_Ignorable_Code_Point}]/u
    );
    assert.equal(character.toUpperCase(), character);
    assert.equal(character.toLowerCase(), character);
    for (const form of FORMS) {
      const normalized = character.normalize(form);
      if (normalized !== character) changed[form]++;
      assert.equal(normalized.normalize('NFC'), character);
      normalizedKeys[form].add(normalized);
    }
  }
  assert.deepEqual(changed, { NFC: 0, NFD: 5184, NFKC: 0, NFKD: 5184 });
  for (const form of FORMS) assert.equal(normalizedKeys[form].size, 32768);
  // Exercise boundaries too: individual-character checks alone are insufficient.
  const sequence = ALPHABET.join('') + [...ALPHABET].reverse().join('');
  for (const form of FORMS)
    assert.equal(sequence.normalize(form).normalize('NFC'), sequence);
});

test('guarded NFC recovery accepts complete or partial canonical Hangul decompositions', () => {
  const ascii = '_____',
    wide = toWide(ascii);
  const nfd = wide.normalize('NFD');
  assert.notEqual(nfd, wide);
  assert.equal(isWide(nfd), false); // Caller must not gate recovery on this check.
  assert.equal(fromWide(nfd), ascii);
  const partial = nfd[0] + nfd.slice(1, 3).normalize('NFC') + nfd.slice(3);
  assert.notEqual(partial, wide);
  assert.equal(fromWide(partial), ascii);

  for (const bad of [
    '\u1100',
    '\u1161',
    '\u11a8',
    '\u1100\u1100',
    '\u1161\u1100',
    '\u1100\u11a8',
    '\u1100\u1161\u11a8\u11a8',
    '\u115f\u1160',
    '\u3131\u314f',
    '\uffa1\uffc2',
    '\uc040',
    '\ud7a3',
    '\uc040'.normalize('NFD'),
    '\ud7a3'.normalize('NFD')
  ]) {
    assert.throws(() => fromWide(ALPHABET[1] + bad + ALPHABET[0]), Error);
  }
  // NFC would silently turn this out-of-alphabet compatibility ideograph into
  // an accepted CJK digit. The raw whitelist must reject it before normalization.
  const compatibility = '\uf900';
  assert.equal(isWide(compatibility.normalize('NFC')), true);
  assert.equal(isWide(compatibility), false);
  assert.throws(
    () => fromWide(ALPHABET[1] + compatibility + ALPHABET[0]),
    /character/
  );
});

test('reject types, mixed ASCII, percent escapes, syntax, marks and malformed Unicode', () => {
  const hostileObject = {
    toString() {
      throw new Error('must not coerce');
    }
  };
  for (const value of [
    null,
    undefined,
    1,
    0n,
    false,
    [],
    {},
    new String('A'),
    Symbol('x'),
    hostileObject
  ]) {
    assert.throws(() => toWide(value), TypeError);
    assert.throws(() => fromWide(value), TypeError);
    assert.equal(isWide(value), false);
  }
  assert.equal(isWide(''), false);
  assert.throws(() => fromWide(''), /empty/);
  for (const character of [
    ' ',
    '\n',
    '\r',
    '\t',
    '\u0000',
    '\u00a0',
    '\u200b',
    '\ufeff',
    '\u202e',
    '\u2066',
    '\u0301',
    '\ufe0f',
    '\ud800',
    '\udfff',
    '😀',
    '/',
    '?',
    '#',
    '%',
    '+',
    '=',
    '.',
    ',',
    ':',
    ';',
    '\\',
    'Ａ',
    'é',
    '中'
  ]) {
    for (const input of [character, 'AA' + character, character + 'AA']) {
      assert.throws(() => toWide(input), /base64url/);
    }
  }
  const wide = toWide('AA');
  for (const input of [
    wide + 'A',
    'A' + wide,
    wide + '\n',
    '\n' + wide,
    wide + '%20',
    encodeURIComponent(wide),
    '/' + wide,
    'https://pi.example/' + wide,
    wide + '😀',
    wide + '\u0301',
    wide + '\u200d',
    wide + '\ufe0f'
  ]) {
    assert.equal(isWide(input), false);
    assert.throws(() => fromWide(input), Error);
  }
  for (let code = 0; code < 128; code++) {
    const character = String.fromCharCode(code);
    if (!ASCII.includes(character))
      assert.throws(() => toWide('A' + character), /base64url/);
  }
});

test('all one-digit frames have a unique sentinel and a whole number of ASCII symbols', () => {
  let accepted = 0;
  for (let digit = 0; digit < ALPHABET.length; digit++) {
    const payloadBits = digit.toString(2).slice(1);
    if (digit !== 0 && payloadBits.length % 6 === 0) {
      const ascii = asciiFromBits(payloadBits);
      assert.equal(fromWide(ALPHABET[digit]), ascii);
      assert.equal(toWide(ascii), ALPHABET[digit]);
      accepted++;
    } else {
      assert.throws(() => fromWide(ALPHABET[digit]), /sentinel|bit length/);
    }
  }
  assert.equal(accepted, 1 + 64 + 4096);
});

test('reject missing sentinels and invalid lengths without inventing padding', () => {
  for (const ascii of [
    '',
    'A',
    'AA',
    'ABC',
    'AAAA',
    '_____',
    randomPayload(100)
  ]) {
    const wide = toWide(ascii);
    assert.throws(() => fromWide(ALPHABET[0] + wide), /sentinel/);
    assert.throws(() => fromWide(ALPHABET[0] + wide.slice(1)), /sentinel/);
    assert.throws(() => fromWide(wide + ALPHABET[0]), /bit length/);
    if (wide.length > 1)
      assert.throws(() => fromWide(wide.slice(0, -1)), /bit length/);
  }
});

test('valid symbol mutations and whole 30-bit truncations require the external checksum', () => {
  const ascii = 'ABCDE12345',
    wide = toWide(ascii);
  const mutation =
    wide.slice(0, 1) +
    (wide[1] === ALPHABET[0] ? ALPHABET[1] : ALPHABET[0]) +
    wide.slice(2);
  for (const altered of [
    mutation,
    wide.slice(0, -2),
    wide + ALPHABET[0] + ALPHABET[0]
  ]) {
    assert.equal(isWide(altered), true);
    const recovered = fromWide(altered);
    assert.notEqual(recovered, ascii);
    assert.equal(toWide(recovered), altered);
  }
  assert.equal(fromWide(wide.slice(0, -2)), ascii.slice(0, -5));
  assert.equal(fromWide(wide + ALPHABET[0] + ALPHABET[0]), ascii + 'AAAAA');
});

test('caps both raw normalization input and decoded allocation at exact boundaries', () => {
  const ascii = '_'.repeat(MAX_ASCII),
    wide = toWide(ascii),
    nfd = wide.normalize('NFD');
  assert.equal(wide.length, MAX_WIDE);
  assert.equal(nfd.length, 9829);
  assert.equal(fromWide(wide), ascii);
  assert.equal(fromWide(nfd), ascii);
  assert.throws(() => toWide('A'.repeat(MAX_ASCII + 1)), RangeError);
  assert.throws(() => fromWide(ALPHABET[1].repeat(MAX_WIDE + 1)), RangeError);
  assert.throws(
    () => fromWide(ALPHABET[1].repeat(MAX_WIDE) + '\u1100\u1161'),
    RangeError
  );
  assert.throws(() => fromWide('\u1100'.repeat(3 * MAX_WIDE + 1)), RangeError);
  assert.throws(() => fromWide('A'.repeat(3 * MAX_WIDE + 1)), RangeError);
});

test('visible length is honestly distinguished from UTF-8 and URL serialization', () => {
  const ascii = 'gRrXP3TY1QMpgS_VQWWJrah_uiZPLZKhuxp2xok5cR37fAHK68WlvVr3xnf';
  const wide = toWide(ascii);
  assert.equal(ascii.length, 59);
  assert.equal(wide.length, 24); // Ties, rather than beats, the documented Mia example.
  assert.equal(Buffer.byteLength(wide), 72);
  assert.equal(encodeURIComponent(wide).length, 216);
  assert.equal(fromWide(wide), ascii);
  assert.equal(toWide(ascii.slice(0, 57)).length, 23);
});
