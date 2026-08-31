import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  toNativeFrame,
  fromNativeFrame,
  isNativeFrame
} from '../src/native-frame.mjs';
import { toWide, fromWide, wideValue, wideCharacter } from '../src/wide.mjs';
import { createCompressor } from '../src/compressor.mjs';

test('native transport agrees with an independent bit-string oracle across alignments and limits', () => {
  let state = 0x340053;
  for (const bits of [
    ...Array.from({ length: 91 }, (_, i) => i + 40),
    4095,
    4096,
    4097,
    49000,
    49153,
    49154
  ]) {
    const bytes = Uint8Array.from({ length: Math.ceil(bits / 8) }, () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return state & 255;
    });
    if (bits % 8) bytes[bytes.length - 1] &= 255 << (8 - (bits % 8));
    const wireBits =
      '1' +
      Array.from(bytes, (byte) => byte.toString(2).padStart(8, '0'))
        .join('')
        .slice(0, bits);
    const padded = wireBits.padEnd(Math.ceil(wireBits.length / 15) * 15, '0');
    const expected = padded
      .match(/.{15}/g)
      .map((digit) => wideCharacter(parseInt(digit, 2)))
      .join('');
    const result = toNativeFrame(bytes, bits);
    assert.equal(result, expected);
    assert.ok(isNativeFrame(result));
    assert.throws(() => fromWide(result));
    const decoded = fromNativeFrame(result);
    assert.equal(decoded.bitLength, padded.length - 1);
    assert.deepEqual(decoded.bytes.subarray(0, bytes.length), bytes);
    assert.ok(decoded.bytes.subarray(bytes.length).every((byte) => byte === 0));
    for (const form of ['NFC', 'NFD', 'NFKC', 'NFKD']) {
      assert.ok(isNativeFrame(result.normalize(form)));
      assert.deepEqual(
        fromNativeFrame(result.normalize(form)).bytes,
        decoded.bytes
      );
    }
  }
});

test('namespace is disjoint from every old transport length and malformed normalization', () => {
  for (let length = 0; length <= 8192; length++)
    assert.equal(isNativeFrame(toWide('_'.repeat(length))), false);
  for (const input of [
    null,
    '',
    'ABCdef',
    '🙂',
    '\u3400',
    '\uac00A',
    '\uac00\u0301',
    '\u3131',
    '\uac00'.repeat(3278)
  ]) {
    assert.equal(isNativeFrame(input), false);
    assert.throws(() => fromNativeFrame(input));
  }
  assert.throws(() => toNativeFrame(new Uint8Array(4), 32));
  assert.throws(() => toNativeFrame(new Uint8Array(6145), 49155));
  assert.throws(() => toNativeFrame(Uint8Array.of(0, 0, 0, 0, 0, 1), 41));
});

test('every single-bit change, truncation or zero suffix in a real packed link is rejected', async () => {
  const pi = createCompressor(
    await readFile(new URL('../models/context-v1.bin', import.meta.url))
  );
  const input =
    'https://drive.google.com/drive/u/1/folders/1ec0HU6_1vqnyvGlO2iFnfZeVNQKh_jpM';
  const { payload } = pi.encode(input);
  assert.ok(isNativeFrame(payload));
  for (let digit = 0; digit < payload.length; digit++) {
    for (let bit = 0; bit < 15; bit++) {
      const changed =
        payload.slice(0, digit) +
        wideCharacter(wideValue(payload.charCodeAt(digit)) ^ (1 << bit)) +
        payload.slice(digit + 1);
      assert.throws(() => pi.decode(changed));
    }
  }
  assert.throws(() => pi.decode(payload.slice(0, -1)));
  assert.throws(() => pi.decode(payload + wideCharacter(0)));
});
