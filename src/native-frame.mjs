import { wideValue, wideCharacter, recoverCanonical } from './wide.mjs';

// The old six-bit transport's first digit has 1, 4, 7, 10 or 13 bits.
// A full 15-bit first digit is a disjoint namespace. Its leading 1 identifies
// this packed structural frame; the remaining bits carry CRC32 then the body.
export function isNativeFrame(value) {
  if (typeof value !== 'string' || !value || !/[^\x00-\x7f]/.test(value))
    return false;
  try {
    return wideValue(recoverCanonical(value).charCodeAt(0)) >= 16384;
  } catch {
    return false;
  }
}

export function toNativeFrame(bytes, bitLength) {
  if (
    !(bytes instanceof Uint8Array) ||
    !Number.isInteger(bitLength) ||
    bitLength < 40 ||
    bitLength > 49154 ||
    bytes.length !== Math.ceil(bitLength / 8)
  )
    throw Error('Invalid native frame');
  if (bitLength % 8 && bytes.at(-1) & ((1 << (8 - (bitLength % 8))) - 1))
    throw Error('Invalid native frame padding');
  const count = Math.ceil((bitLength + 1) / 15),
    out = new Array(count);
  for (let i = 0; i < count; i++) {
    let digit = 0;
    for (let j = 0; j < 15; j++) {
      const p = i * 15 + j - 1;
      const bit =
        p === -1
          ? 1
          : p < bitLength
            ? (bytes[p >>> 3] >>> (7 - (p & 7))) & 1
            : 0;
      digit = digit * 2 + bit;
    }
    out[i] = wideCharacter(digit);
  }
  return out.join('');
}

export function fromNativeFrame(value) {
  const canonical = recoverCanonical(value);
  if (wideValue(canonical.charCodeAt(0)) < 16384)
    throw Error('Not a native frame');
  const bitLength = canonical.length * 15 - 1;
  if (bitLength < 40 || bitLength > 49154)
    throw Error('Invalid native frame size');
  const bytes = new Uint8Array(Math.ceil(bitLength / 8));
  for (let i = 0; i < canonical.length; i++) {
    const digit = wideValue(canonical.charCodeAt(i));
    for (let j = i === 0 ? 1 : 0; j < 15; j++) {
      const p = i * 15 + j - 1;
      if ((digit >>> (14 - j)) & 1) bytes[p >>> 3] |= 1 << (7 - (p & 7));
    }
  }
  return { bytes, bitLength, canonical };
}
