// Frozen transport alphabet, in this order (15 bits per BMP character):
// U+3400..4DBF (6,592), U+4E00..9FFF (20,992), U+AC00..C03F (5,184).
// The ASCII payload already carries its version and checksum. This layer only
// preserves its exact six-bit symbols; it does not interpret base64 bytes.
const ASCII =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const MAX_ASCII = 8192;
const MAX_WIDE = Math.ceil((6 * MAX_ASCII + 1) / 15); // 3,277

function asciiValue(code) {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 45) return 62;
  if (code === 95) return 63;
  return -1;
}

export function wideValue(code) {
  if (code >= 0x3400 && code <= 0x4dbf) return code - 0x3400;
  if (code >= 0x4e00 && code <= 0x9fff) return code - 0x4e00 + 6592;
  if (code >= 0xac00 && code <= 0xc03f) return code - 0xac00 + 27584;
  return -1;
}

export function wideCharacter(value) {
  if (value < 6592) return String.fromCharCode(0x3400 + value);
  if (value < 27584) return String.fromCharCode(0x4e00 + value - 6592);
  return String.fromCharCode(0xac00 + value - 27584);
}

/** Literal alphabet/size check, not a frame or checksum validator.
 * NFD/NFKD Hangul is deliberately false; pass it directly to fromWide instead.
 */
export function isWide(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_WIDE
  )
    return false;
  for (let i = 0; i < value.length; i++) {
    if (wideValue(value.charCodeAt(i)) < 0) return false;
  }
  return true;
}

/** Encode 0..8,192 base64url symbols, including otherwise noncanonical base64.
 * Wire bits: a leading 1 followed by six bits per ASCII symbol, MSB first.
 * Left-pad the first 15-bit group with zeros. No trailing padding is used.
 * The leading 1 preserves zero symbols at both ends and the exact bit length.
 */
export function toWide(asciiPayload) {
  if (typeof asciiPayload !== 'string')
    throw new TypeError('ASCII payload must be a string');
  if (asciiPayload.length > MAX_ASCII)
    throw new RangeError('ASCII payload exceeds the 8,192-character limit');

  const totalBits = 6 * asciiPayload.length + 1;
  const output = new Array(Math.ceil(totalBits / 15));
  let buffer = 1,
    bits = 1 + ((15 - (totalBits % 15)) % 15),
    written = 0;
  for (let i = 0; i < asciiPayload.length; i++) {
    const value = asciiValue(asciiPayload.charCodeAt(i));
    if (value < 0) throw new Error('Invalid base64url payload');
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 15) {
      bits -= 15;
      output[written++] = wideCharacter(buffer >>> bits);
      buffer &= (1 << bits) - 1;
    }
  }
  // Only empty input leaves its sentinel buffered; all other lengths align.
  if (bits) output[written] = wideCharacter(buffer);
  return output.join('');
}

export function recoverCanonical(value) {
  if (typeof value !== 'string')
    throw new TypeError('Wide payload must be a string');
  if (value.length === 0) throw new Error('Wide payload is empty');
  // One emitted syllable can decompose into at most three UTF-16 code units.
  // Bound the input before even scanning or asking the runtime to normalize it.
  if (value.length > 3 * MAX_WIDE)
    throw new RangeError('Wide payload exceeds the length limit');
  let hasJamo = false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (wideValue(code) >= 0) continue;
    // Only modern canonical Hangul components may enter normalization. In
    // particular, reject compatibility ideographs, compatibility Jamo, marks,
    // ASCII and percent escapes BEFORE they could normalize into the alphabet.
    if (
      (code >= 0x1100 && code <= 0x1112) ||
      (code >= 0x1161 && code <= 0x1175) ||
      (code >= 0x11a8 && code <= 0x11c2)
    ) {
      hasJamo = true;
    } else {
      throw new Error('Invalid wide payload character');
    }
  }
  const canonical = hasJamo ? value.normalize('NFC') : value;
  if (canonical.length > MAX_WIDE)
    throw new RangeError('Wide payload exceeds the length limit');
  // Reject isolated, reordered, incomplete or out-of-range Jamo compositions.
  if (!isWide(canonical)) throw new Error('Invalid wide payload character');
  return canonical;
}

/** Recover the exact ASCII string, accepting canonical Hangul decompositions.
 * No URL unescaping, trimming, case folding or compatibility repair is done.
 * The caller must still validate the recovered payload's version and checksum.
 */
export function fromWide(widePayload) {
  const canonical = recoverCanonical(widePayload);
  const first = wideValue(canonical.charCodeAt(0));
  if (first === 0) throw new Error('Noncanonical wide payload sentinel');

  // The first set bit is the sentinel. Every following bit belongs to payload;
  // there are no ambiguous padding bits and no alternate leading-zero groups.
  let bits = 31 - Math.clz32(first);
  const payloadBits = bits + 15 * (canonical.length - 1);
  if (payloadBits % 6 !== 0) throw new Error('Invalid wide payload bit length');
  const length = payloadBits / 6;
  if (length > MAX_ASCII)
    throw new RangeError('ASCII payload exceeds the 8,192-character limit');

  const output = new Array(length);
  let buffer = first ^ (1 << bits),
    written = 0;
  for (let i = 0; i < canonical.length; i++) {
    if (i !== 0) {
      buffer = (buffer << 15) | wideValue(canonical.charCodeAt(i));
      bits += 15;
    }
    while (bits >= 6) {
      bits -= 6;
      output[written++] = ASCII[(buffer >>> bits) & 63];
    }
    buffer &= (1 << bits) - 1;
  }
  return output.join('');
}
