import { toWide } from './wide.mjs';

const BASE64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const ASCII_EXTRA = ".!$&'()*+,;=:@";
const ASCII_ALPHABET = BASE64 + ASCII_EXTRA;
export const MIXED_ASCII_PREFIXES = "!$&'()*+,;=:@";
const ROOTS =
  'noxPSDLzyuw' +
  [...BASE64]
    .filter((character) => !'noxPSDLzyuw-_'.includes(character))
    .join('');
export const DENSE_ASCII_RADIX = BigInt(ASCII_ALPHABET.length);
export const DENSE_WIDE_RADIX = 39921n;
export const MIXED_WIDE_PREFIX_RADIX = 15345n;
const MAX_FRAME = 2048;
const MAX_DENSE_WIDE = 820;

const base64Ranks = new Int16Array(128).fill(-1);
const asciiRanks = new Int16Array(128).fill(-1);
for (let i = 0; i < BASE64.length; i++) base64Ranks[BASE64.charCodeAt(i)] = i;
for (let i = 0; i < ASCII_ALPHABET.length; i++)
  asciiRanks[ASCII_ALPHABET.charCodeAt(i)] = i;

function checkFrame(input) {
  if (typeof input !== 'string') throw new TypeError('Frame must be a string');
  if (input.length < 6 || input.length > 8192)
    throw Error('Invalid frame length');
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code >= 128 || base64Ranks[code] < 0)
      throw Error('Invalid frame alphabet');
  }
}

function frameValue(input) {
  const root = ROOTS.indexOf(input[0]);
  let value = BigInt(root < 0 ? 1 : root + 2);
  for (let i = root < 0 ? 0 : 1; i < input.length; i++)
    value = (value << 6n) | BigInt(base64Ranks[input.charCodeAt(i)]);
  return value;
}

function restoreFrame(value) {
  const output = [];
  while (value >= 64n) {
    output.push(BASE64[Number(value & 63n)]);
    value >>= 6n;
    if (output.length > MAX_FRAME) throw Error('Dense frame is too long');
  }
  const tail = output.reverse().join('');
  let frame;
  if (value === 1n) {
    frame = tail;
    if (frame[0] !== '-' && frame[0] !== '_')
      throw Error('Invalid dense frame root');
  } else if (value >= 2n && value <= 63n) {
    frame = ROOTS[Number(value) - 2] + tail;
  } else {
    throw Error('Invalid dense frame root');
  }
  checkFrame(frame);
  if (frame.length > MAX_FRAME) throw Error('Dense frame is too long');
  return frame;
}

function encodeInteger(value, radix, character) {
  const output = [];
  while (value) {
    output.push(character(Number(value % radix)));
    value /= radix;
  }
  return output.reverse().join('');
}

function hasAsciiExtra(input) {
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code >= 128 || asciiRanks[code] < 0) return false;
    if (asciiRanks[code] >= 64) return true;
  }
  return false;
}

export function mixedWidePrefixValue(code) {
  const value = denseWideValue(code);
  if (value >= 8192 && value < 16384) return value - 8192;
  if (value >= 32768) return value - 32768 + 8192;
  return -1;
}

export function mixedWidePrefixCharacter(value) {
  if (!Number.isInteger(value) || value < 0 || value >= 15345)
    throw new RangeError('Invalid mixed wide prefix');
  return denseWideCharacter(value < 8192 ? value + 8192 : value - 8192 + 32768);
}

export function denseAsciiValue(code) {
  return code < asciiRanks.length ? asciiRanks[code] : -1;
}

export function denseAsciiCharacter(value) {
  if (!Number.isInteger(value) || value < 0 || value >= ASCII_ALPHABET.length)
    throw new RangeError('Invalid dense ASCII value');
  return ASCII_ALPHABET[value];
}

export function isDense(input) {
  return (
    typeof input === 'string' &&
    input.length > 0 &&
    input.length <= MAX_FRAME &&
    input.charCodeAt(input.length - 1) < 128 &&
    base64Ranks[input.charCodeAt(input.length - 1)] >= 0 &&
    hasAsciiExtra(input)
  );
}

export function toDense(input) {
  checkFrame(input);
  if (input.length > MAX_FRAME) return input;
  let value = frameValue(input);
  const last = BASE64[Number(value & 63n)];
  value >>= 6n;
  const output =
    encodeInteger(value, DENSE_ASCII_RADIX, (value) => ASCII_ALPHABET[value]) +
    last;
  return output.length < input.length &&
    hasAsciiExtra(output) &&
    !MIXED_ASCII_PREFIXES.includes(output[0])
    ? output
    : input;
}

export function fromDense(input) {
  if (!isDense(input)) throw Error('Invalid dense frame');
  let value = 0n;
  for (let i = 0; i < input.length - 1; i++)
    value = value * DENSE_ASCII_RADIX + BigInt(asciiRanks[input.charCodeAt(i)]);
  value =
    (value << 6n) | BigInt(base64Ranks[input.charCodeAt(input.length - 1)]);
  const frame = restoreFrame(value);
  if (toDense(frame) !== input) throw Error('Noncanonical dense frame');
  return frame;
}

export function denseWideValue(code) {
  if (code >= 0x3400 && code <= 0x4dbf) return code - 0x3400;
  if (code >= 0x4e00 && code <= 0x9fff) return code - 0x4e00 + 6592;
  if (code >= 0xac00 && code <= 0xc03f) return code - 0xac00 + 27584;
  if (code >= 0xa000 && code <= 0xa48c) return code - 0xa000 + 32768;
  if (code >= 0xc040 && code <= 0xd7a3) return code - 0xc040 + 33933;
  return -1;
}

export function denseWideCharacter(value) {
  if (value < 6592) return String.fromCharCode(0x3400 + value);
  if (value < 27584) return String.fromCharCode(0x4e00 + value - 6592);
  if (value < 32768) return String.fromCharCode(0xac00 + value - 27584);
  if (value < 33933) return String.fromCharCode(0xa000 + value - 32768);
  return String.fromCharCode(0xc040 + value - 33933);
}

function isNewWide(code) {
  return (
    (code >= 0xa000 && code <= 0xa48c) || (code >= 0xc040 && code <= 0xd7a3)
  );
}

export function recoverDenseWide(input) {
  if (typeof input !== 'string')
    throw new TypeError('Wide frame must be a string');
  if (!input || input.length > 3 * MAX_DENSE_WIDE)
    throw Error('Invalid wide frame length');
  let hasJamo = false;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (denseWideValue(code) >= 0) continue;
    if (
      (code >= 0x1100 && code <= 0x1112) ||
      (code >= 0x1161 && code <= 0x1175) ||
      (code >= 0x11a8 && code <= 0x11c2)
    ) {
      hasJamo = true;
    } else {
      throw Error('Invalid wide frame character');
    }
  }
  const canonical = hasJamo ? input.normalize('NFC') : input;
  if (!canonical || canonical.length > MAX_DENSE_WIDE)
    throw Error('Invalid wide frame length');
  for (let i = 0; i < canonical.length; i++)
    if (denseWideValue(canonical.charCodeAt(i)) < 0)
      throw Error('Invalid wide frame character');
  return canonical;
}

function hasNewWide(input) {
  for (let i = 0; i < input.length; i++)
    if (isNewWide(input.charCodeAt(i))) return true;
  return false;
}

export function isDenseWide(input) {
  try {
    return hasNewWide(recoverDenseWide(input));
  } catch {
    return false;
  }
}

export function toDenseWide(input) {
  checkFrame(input);
  const old = toWide(input);
  if (input.length > MAX_FRAME) return old;
  const output = encodeInteger(
    frameValue(input),
    DENSE_WIDE_RADIX,
    denseWideCharacter
  );
  return output.length < old.length &&
    hasNewWide(output) &&
    mixedWidePrefixValue(output.charCodeAt(0)) < 0
    ? output
    : old;
}

export function fromDenseWide(input) {
  const canonical = recoverDenseWide(input);
  if (!hasNewWide(canonical)) throw Error('Not a dense wide frame');
  let value = 0n;
  for (let i = 0; i < canonical.length; i++)
    value =
      value * DENSE_WIDE_RADIX +
      BigInt(denseWideValue(canonical.charCodeAt(i)));
  const frame = restoreFrame(value);
  if (toDenseWide(frame) !== canonical)
    throw Error('Noncanonical dense wide frame');
  return frame;
}
