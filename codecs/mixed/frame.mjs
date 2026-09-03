import {
  DENSE_ASCII_RADIX,
  DENSE_WIDE_RADIX,
  MIXED_ASCII_PREFIXES,
  MIXED_WIDE_PREFIX_RADIX,
  denseAsciiCharacter,
  denseAsciiValue,
  denseWideCharacter,
  denseWideValue,
  mixedWidePrefixCharacter,
  mixedWidePrefixValue
} from '../../src/dense.mjs';
import { normalizeMixedUnicodePayload } from '../../src/mixed-surface.mjs';
import { createRadixFrame, verifyArithmeticCandidates } from './radix.mjs';

const BASE64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const WIDE_MAXIMUM_LENGTH = 820;
const ASCII_MAXIMUM_LENGTH = 2048;

function crc8(bytes) {
  let crc = 0xff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = ((crc << 1) ^ (crc & 0x80 ? 0x1d : 0)) & 0xff;
  }
  return crc ^ 0xff;
}

function wideChecksum(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > 256)
    throw new RangeError('Invalid mixed frame checksum input');
  const protectedBytes = new Uint8Array(bytes.length + 3);
  protectedBytes[0] = 2;
  protectedBytes[1] = bytes.length >>> 8;
  protectedBytes[2] = bytes.length & 255;
  protectedBytes.set(bytes, 3);
  return crc8(protectedBytes);
}

function asciiChecksum(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > 256)
    throw new RangeError('Invalid mixed ASCII checksum input');
  let crc = 0;
  const write = (bit) => {
    const feedback = ((crc >>> 12) & 1) ^ bit;
    crc = (crc << 1) & 0x1fff;
    if (feedback) crc ^= 0x157f;
  };
  const writeByte = (byte) => {
    for (let shift = 7; shift >= 0; shift--) write((byte >>> shift) & 1);
  };
  writeByte(3);
  writeByte(bytes.length >>> 8);
  writeByte(bytes.length & 255);
  for (const byte of bytes) writeByte(byte);
  return crc;
}

function widePointText(point, length) {
  const output = new Array(length);
  let value = point;
  for (let index = length - 1; index > 0; index--) {
    output[index] = denseWideCharacter(Number(value % DENSE_WIDE_RADIX));
    value /= DENSE_WIDE_RADIX;
  }
  output[0] = mixedWidePrefixCharacter(Number(value));
  return output.join('');
}

function wideTextPoint(input) {
  const canonical = normalizeMixedUnicodePayload(input);
  let point = BigInt(mixedWidePrefixValue(canonical.charCodeAt(0)));
  if (point < 0n) throw new Error('Invalid mixed wide prefix');
  for (let index = 1; index < canonical.length; index++)
    point =
      point * DENSE_WIDE_RADIX +
      BigInt(denseWideValue(canonical.charCodeAt(index)));
  return {
    canonical,
    point,
    grid:
      MIXED_WIDE_PREFIX_RADIX * DENSE_WIDE_RADIX ** BigInt(canonical.length - 1)
  };
}

function asciiPointText(point, length) {
  if (!Number.isSafeInteger(length) || length < 1)
    throw new Error('Invalid ASCII frame length');
  const output = new Array(length);
  let value = point;
  output[length - 1] = BASE64[Number(value & 63n)];
  value >>= 6n;
  for (let index = length - 2; index > 0; index--) {
    output[index] = denseAsciiCharacter(Number(value % DENSE_ASCII_RADIX));
    value /= DENSE_ASCII_RADIX;
  }
  output[0] = MIXED_ASCII_PREFIXES[Number(value)];
  if (!output[0]) throw new Error('ASCII frame point exceeds grid');
  return output.join('');
}

function asciiTextPoint(input) {
  if (
    typeof input !== 'string' ||
    input.length < 2 ||
    input.length > ASCII_MAXIMUM_LENGTH
  )
    throw new Error('Invalid ASCII frame length');
  const prefix = MIXED_ASCII_PREFIXES.indexOf(input[0]);
  if (prefix < 0) throw new Error('Invalid mixed ASCII prefix');
  let point = BigInt(prefix);
  for (let index = 1; index < input.length - 1; index++) {
    const digit = denseAsciiValue(input.charCodeAt(index));
    if (digit < 0) throw new Error('Invalid ASCII frame character');
    point = point * DENSE_ASCII_RADIX + BigInt(digit);
  }
  const last = BASE64.indexOf(input[input.length - 1]);
  if (last < 0) throw new Error('Invalid ASCII frame ending');
  return {
    canonical: input,
    point: (point << 6n) | BigInt(last),
    grid:
      BigInt(MIXED_ASCII_PREFIXES.length) *
      64n *
      DENSE_ASCII_RADIX ** BigInt(input.length - 2)
  };
}

const wide = createRadixFrame({
  headerStates: 256,
  minimumLength: 2,
  maximumLength: WIDE_MAXIMUM_LENGTH,
  initialGrid: MIXED_WIDE_PREFIX_RADIX * DENSE_WIDE_RADIX,
  nextGrid: (grid) => grid * DENSE_WIDE_RADIX,
  pointText: widePointText,
  textPoint: wideTextPoint
});

const ascii = createRadixFrame({
  headerStates: 8192,
  minimumLength: 5,
  maximumLength: ASCII_MAXIMUM_LENGTH,
  initialGrid:
    BigInt(MIXED_ASCII_PREFIXES.length) *
    64n *
    DENSE_ASCII_RADIX ** BigInt(5 - 2),
  nextGrid: (grid) => grid * DENSE_ASCII_RADIX,
  pointText: asciiPointText,
  textPoint: asciiTextPoint
});

export function encodeMixedFrames(bytes, candidates, acceptsLegacy, options) {
  return {
    unicode: encodeUnicodeMixed(bytes, candidates, acceptsLegacy, options),
    ascii: encodeAsciiMixed(bytes, candidates, acceptsLegacy, options)
  };
}

export function encodeUnicodeMixed(bytes, candidates, acceptsLegacy, options) {
  return wide.encodeShortest(
    bytes,
    candidates,
    wideChecksum,
    acceptsLegacy,
    options
  );
}

export function encodeAsciiMixed(bytes, candidates, acceptsLegacy, options) {
  return ascii.encodeShortest(
    bytes,
    candidates,
    asciiChecksum,
    acceptsLegacy,
    options
  );
}

export function decodeUnicodeMixed(payload, predictor, acceptsLegacy, options) {
  return wide.decode(payload, predictor, wideChecksum, acceptsLegacy, options);
}

export function decodeAsciiMixed(payload, predictor, acceptsLegacy, options) {
  return ascii.decode(
    payload,
    predictor,
    asciiChecksum,
    acceptsLegacy,
    options
  );
}

export function verifyUnicodeMixed(
  payload,
  predictor,
  acceptsLegacy,
  expectedBytes,
  options
) {
  return wide.verify(
    payload,
    predictor,
    wideChecksum,
    acceptsLegacy,
    expectedBytes,
    options
  );
}

export function verifyAsciiMixed(
  payload,
  predictor,
  acceptsLegacy,
  expectedBytes,
  options
) {
  return ascii.verify(
    payload,
    predictor,
    asciiChecksum,
    acceptsLegacy,
    expectedBytes,
    options
  );
}

export function verifyEncodedMixedFrames(
  frames,
  candidates,
  acceptsLegacy,
  expectedBytes,
  options = {}
) {
  if (!frames?.unicode || !frames?.ascii)
    throw new TypeError('Generated mixed frames required');
  verifyArithmeticCandidates(candidates, expectedBytes, options);
  wide.verifyEncoded(
    frames.unicode,
    candidates,
    wideChecksum,
    acceptsLegacy,
    expectedBytes,
    options
  );
  ascii.verifyEncoded(
    frames.ascii,
    candidates,
    asciiChecksum,
    acceptsLegacy,
    expectedBytes,
    options
  );
}

export function isUnicodeMixedPayload(input) {
  try {
    return input.length >= 2 && wideTextPoint(input).canonical === input;
  } catch {
    return false;
  }
}

export function isUnicodeMixedInput(input) {
  try {
    return input.length >= 2 && wideTextPoint(input).canonical.length >= 2;
  } catch {
    return false;
  }
}

export function isAsciiMixedPayload(input) {
  try {
    return input.length >= 5 && asciiTextPoint(input).canonical === input;
  } catch {
    return false;
  }
}

export function isMixedInput(input) {
  return /[^\x00-\x7f]/.test(input)
    ? isUnicodeMixedInput(input)
    : isAsciiMixedPayload(input);
}
