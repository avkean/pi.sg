import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fromDense,
  fromDenseWide,
  isDense,
  isDenseWide,
  toDense,
  toDenseWide
} from '../src/dense.mjs';
import { toWide } from '../src/wide.mjs';

const BASE64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function randomFrame(length, seed) {
  let state = seed,
    output = '';
  for (let i = 0; i < length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    output += BASE64[(state >>> 0) & 63];
  }
  return output;
}

test('frozen vectors keep the dense alphabets and root order stable', () => {
  for (const [frame, ascii, wide] of [
    ['o_____AAAAA', '0uQJl.f08A', '㑨쀿쀿㐀㐀'],
    ['PAAAAAAAAAAAAAAAA', 'UE5DhgRfFAlS&6IA', '䟀㐀㐀㐀㐀㐀㐀'],
    ['S0123456789abcdef', 'beE8;*b-ytaV+cef', '䢴鿶빹똟莚欣诟'],
    ['nhBFPRQayl0L3Ku1xIIRZ', 'Es&e0PC9,i8AAc-@luBZ', '蔗뒩嫴臂멦稃츝즓'],
    ['xaDn3pFUtF7zMV0UUUTNtmA', 'Fe&KJMDcISHVRls!L2X3oA', '䊇鳄졧ꅏ첁쭼䃁픉逤']
  ]) {
    assert.equal(toDense(frame), ascii);
    assert.equal(fromDense(ascii), frame);
    assert.equal(toDenseWide(frame), wide);
    if (isDenseWide(wide)) assert.equal(fromDenseWide(wide), frame);
    else assert.equal(wide, toWide(frame));
  }
});

test('dense transports never grow a frame and preserve every first symbol', () => {
  const lengths = [6, 7, 8, 15, 16, 31, 32, 63, 64, 127, 256, 511, 1024, 2048];
  for (let first = 0; first < BASE64.length; first++) {
    for (const length of lengths) {
      const frame =
        BASE64[first] + randomFrame(length - 1, first * 65537 + length);
      const ascii = toDense(frame),
        wide = toDenseWide(frame),
        oldWide = toWide(frame);
      assert.ok(ascii.length <= frame.length);
      assert.ok(wide.length <= oldWide.length);
      if (ascii !== frame) {
        assert.equal(isDense(ascii), true);
        assert.match(ascii.at(-1), /^[A-Za-z0-9_-]$/);
        assert.equal(ascii.includes('~'), false);
        assert.equal(fromDense(ascii), frame);
      }
      if (wide !== oldWide) {
        assert.equal(isDenseWide(wide), true);
        assert.equal(fromDenseWide(wide), frame);
      }
    }
  }
});

test('ASCII output is one safe path segment and stays separate from old links', () => {
  const extras = new Set();
  for (let seed = 1; seed <= 2000; seed++) {
    const frame = randomFrame(80, seed),
      dense = toDense(frame);
    if (dense === frame) continue;
    assert.equal(new URL('https://pi.sg/' + dense).pathname, '/' + dense);
    for (const character of dense)
      if (!BASE64.includes(character)) extras.add(character);
  }
  assert.equal(
    [...extras].sort().join(''),
    [...".!$&'()*+,;=:@"].sort().join('')
  );
  assert.equal(extras.has('~'), false);
  assert.equal(isDense('A'.repeat(80)), false);
  assert.equal(isDense(toDense('n' + 'A'.repeat(79)) + '~'), false);
});

test('dense Unicode survives normalization and URL escaping', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const frame = randomFrame(40 + (seed % 120), seed),
      wide = toDenseWide(frame);
    if (!isDenseWide(wide)) continue;
    for (const form of ['NFC', 'NFD', 'NFKC', 'NFKD']) {
      const normalized = wide.normalize(form);
      assert.equal(fromDenseWide(normalized), frame);
      const url = new URL('https://pi.sg/' + normalized);
      assert.equal(
        fromDenseWide(decodeURIComponent(url.pathname.slice(1))),
        frame
      );
    }
  }
});

test('the added Unicode ranges are stable and recoverable', () => {
  for (const [first, last] of [
    [0xa000, 0xa48c],
    [0xc040, 0xd7a3]
  ]) {
    for (let code = first; code <= last; code++) {
      const character = String.fromCharCode(code);
      for (const form of ['NFC', 'NFD', 'NFKC', 'NFKD'])
        assert.equal(character.normalize(form).normalize('NFC'), character);
    }
  }
});

test('alternate spellings, invalid roots and oversized work are rejected', () => {
  const frame = 'o' + randomFrame(120, 7),
    ascii = toDense(frame),
    wide = toDenseWide(frame);
  assert.equal(isDense(ascii), true);
  assert.throws(() => fromDense('A' + ascii), /canonical|root/i);
  assert.throws(() => fromDense(ascii.slice(0, -1) + '!'), /dense/i);
  assert.throws(() => fromDense(ascii + '~'));
  assert.throws(() => fromDense(toWide(frame)));
  assert.throws(() => fromDenseWide(toWide(frame)));
  if (isDenseWide(wide)) {
    assert.notEqual(fromDenseWide(wide + '\u3400'), frame);
    assert.throws(() => fromDenseWide(wide + 'A'));
  }
  for (const value of [null, undefined, 1, {}, [], new String(ascii)]) {
    assert.throws(() => toDense(value), TypeError);
    assert.throws(() => fromDense(value));
    assert.equal(isDense(value), false);
  }
  const long = 'n' + 'A'.repeat(8191);
  assert.equal(toDense(long), long);
  assert.equal(toDenseWide(long), toWide(long));
  assert.throws(() => toDense(long + 'A'), /length/);
  assert.throws(() => fromDense('!'.repeat(2047) + 'A'));
});
