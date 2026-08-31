import { deflateSync, inflateSync } from 'fflate/browser';
import { inspectDeflate } from '../codecs/core/deflate-check.mjs';

// Independent, byte-exact percent preconditioning. The caller owns the marker,
// CRC32 of the original UTF-8, and final transport/link length selection.
// v1 wire: header, minimal unsigned LEB128 original byte count, raw DEFLATE.
// Header: high nibble = version 1, bits 1..3 = method 0 (DEFLATE level 6),
// bit 0 = lowercase percent hex. Other versions/methods are reserved.
// Percent letters must have one global case; digit-only escapes use uppercase.
// No URL normalization, percent decoding to text, model, or host dictionary.
export const MAX_INPUT_BYTES = 128 * 1024;
export const MAX_TRANSFORM_BYTES = 128 * 1024;
export const MAX_BODY_BYTES = 6 * 1024;
const VERSION = 0x10,
  ESC = 0x1b,
  MIN_SAVINGS_BYTES = 4;
const utf8 = new TextEncoder();
const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function fail() {
  throw Error('Invalid percent URL body');
}
function validUrl(input) {
  return (
    typeof input === 'string' &&
    input.length <= MAX_INPUT_BYTES &&
    /^https?:\/\//i.test(input) &&
    !/[\u0000-\u0020\u007f]/.test(input) &&
    URL.canParse(input)
  );
}
function hex(byte) {
  if (byte >= 48 && byte <= 57) return byte - 48;
  const lower = byte | 32;
  return lower >= 97 && lower <= 102 ? lower - 87 : -1;
}
function hexCase(byte) {
  return byte >= 65 && byte <= 70 ? 1 : byte >= 97 && byte <= 102 ? 2 : 0;
}

// A measuring pass precedes allocation. The same walk writes the encoder's
// bytes and checks the decoder's canonical transform without another buffer.
function precondition(raw, write) {
  let length = 0,
    letters = 0,
    percents = 0;
  const put = (byte) => {
    write?.(byte);
    length++;
  };
  for (let i = 0; i < raw.length; i++) {
    const byte = raw[i];
    const hi = byte === 37 && i + 2 < raw.length ? hex(raw[i + 1]) : -1;
    const lo = hi >= 0 ? hex(raw[i + 2]) : -1;
    if (hi >= 0 && lo >= 0) {
      letters |= hexCase(raw[i + 1]) | hexCase(raw[i + 2]);
      if (letters === 3) return null;
      const decoded = hi * 16 + lo;
      if (decoded < 128) put(ESC);
      put(decoded);
      percents++;
      i += 2;
    } else {
      if (byte >= 128) put(ESC);
      put(byte);
    }
    if (length > MAX_TRANSFORM_BYTES) return null;
  }
  return { length, lowercase: letters === 2 ? 1 : 0, percents };
}
function integer(out, value) {
  do {
    const byte = value & 127;
    value = Math.floor(value / 128);
    out.push(byte | (value ? 128 : 0));
  } while (value);
}

/** Return a complete candidate body, or null for unsafe/unsupported/no-gain input. */
export function encodePercent(input) {
  if (!validUrl(input) || !input.includes('%')) return null;
  const raw = utf8.encode(input);
  if (raw.length > MAX_INPUT_BYTES || text.decode(raw) !== input) return null;
  const info = precondition(raw);
  if (!info || !info.percents) return null;
  const transformed = new Uint8Array(info.length);
  let position = 0;
  precondition(raw, (byte) => {
    transformed[position++] = byte;
  });
  const compressed = deflateSync(transformed, { level: 6 });
  const header = [VERSION | info.lowercase];
  integer(header, raw.length);
  const size = header.length + compressed.length;
  // Count the complete body against ordinary DEFLATE: both candidates receive
  // the same outer marker and CRC. Four saved bytes avoid trivial candidates.
  if (
    size > MAX_BODY_BYTES ||
    size + MIN_SAVINGS_BYTES > deflateSync(raw, { level: 6 }).length
  )
    return null;
  const body = new Uint8Array(size);
  body.set(header);
  body.set(compressed, header.length);
  return body;
}

/** Decode strictly; malformed/unsafe bodies throw. Integrity is the caller's CRC. */
export function decodePercent(body) {
  if (
    !(body instanceof Uint8Array) ||
    body.length < 4 ||
    body.length > MAX_BODY_BYTES
  )
    fail();
  const header = body[0];
  if ((header & 0xfe) !== VERSION) fail();
  let position = 1,
    originalLength = 0,
    scale = 1;
  for (let i = 0; ; i++, scale *= 128) {
    if (i === 3 || position >= body.length) fail();
    const byte = body[position++];
    originalLength += (byte & 127) * scale;
    if (originalLength > MAX_INPUT_BYTES) fail();
    if (!(byte & 128)) {
      if (!originalLength || (i && byte === 0)) fail();
      break;
    }
  }
  const compressed = body.subarray(position);
  // This pass checks all back references and the expansion cap before inflate
  // can allocate its output. The reconstructed URL has its own separate cap.
  const length = inspectDeflate(
    compressed,
    Math.min(MAX_TRANSFORM_BYTES, originalLength * 2)
  );
  if (originalLength > length * 3) fail();
  const transformed = inflateSync(compressed, { out: new Uint8Array(length) });
  if (transformed.length !== length) fail();
  let restoredLength = 0;
  for (let i = 0; i < length; i++) {
    const byte = transformed[i];
    if (byte === ESC) {
      if (++i === length) fail();
      restoredLength += transformed[i] >= 128 ? 1 : 3;
    } else if (byte >= 128) restoredLength += 3;
    else {
      if (byte <= 32 || byte === 127) fail();
      restoredLength++;
    }
    if (restoredLength > originalLength) fail();
  }
  if (restoredLength !== originalLength) fail();
  const raw = new Uint8Array(originalLength);
  const alphabet = header & 1 ? '0123456789abcdef' : '0123456789ABCDEF';
  position = 0;
  function percent(byte) {
    raw[position++] = 37;
    raw[position++] = alphabet.charCodeAt(byte >>> 4);
    raw[position++] = alphabet.charCodeAt(byte & 15);
  }
  for (let i = 0; i < length; i++) {
    const byte = transformed[i];
    if (byte === ESC) {
      const next = transformed[++i];
      if (next >= 128) raw[position++] = next;
      else percent(next);
    } else if (byte >= 128) percent(byte);
    else raw[position++] = byte;
  }
  const input = text.decode(raw);
  if (!validUrl(input)) fail();
  position = 0;
  const info = precondition(raw, (byte) => {
    if (byte !== transformed[position++]) fail();
  });
  // Reject literal spellings of valid %XX triplets, ambiguous case flags, and
  // no-percent streams. Malformed literal percent sequences remain unchanged.
  if (
    !info ||
    !info.percents ||
    info.length !== length ||
    info.lowercase !== (header & 1)
  )
    fail();
  // Also rejects alternate DEFLATE encodings and ignored stored-block padding.
  const canonical = deflateSync(transformed, { level: 6 });
  if (
    canonical.length !== compressed.length ||
    canonical.some((byte, i) => byte !== compressed[i])
  )
    fail();
  return input;
}
