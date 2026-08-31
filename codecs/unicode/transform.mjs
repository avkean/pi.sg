// Independent URL byte transform. Never use a URL serializer on destination text.
export const MAX_BYTES = 128 * 1024;
export const MODES = Object.freeze([
  'bytes',
  'utf16le',
  'split16',
  'delta',
  'window',
  'codepoint',
  'raw'
]);
export function fail(message = 'Malformed Unicode transform') {
  throw new Error(message);
}
export class Writer {
  constructor(limit = MAX_BYTES) {
    this.limit = limit;
    this.bytes = new Uint8Array(Math.min(256, limit));
    this.length = 0;
  }
  ensure(n) {
    if (n > this.limit - this.length) fail('Transform output limit');
    if (this.length + n > this.bytes.length) {
      const next = new Uint8Array(
        Math.min(this.limit, Math.max(this.length + n, this.bytes.length * 2))
      );
      next.set(this.bytes);
      this.bytes = next;
    }
  }
  put(value) {
    this.ensure(1);
    this.bytes[this.length++] = value;
  }
  append(bytes) {
    this.ensure(bytes.length);
    this.bytes.set(bytes, this.length);
    this.length += bytes.length;
  }
  uint(value) {
    do {
      this.put((value & 127) | (value > 127 ? 128 : 0));
      value = Math.floor(value / 128);
    } while (value);
  }
  finish() {
    return this.bytes.slice(0, this.length);
  }
}
export class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.position = 0;
  }
  get remaining() {
    return this.bytes.length - this.position;
  }
  byte() {
    if (!this.remaining) fail('Truncated transform');
    return this.bytes[this.position++];
  }
  uint(limit = MAX_BYTES) {
    let value = 0,
      scale = 1;
    for (let i = 0; i < 4; i++, scale *= 128) {
      const b = this.byte();
      value += (b & 127) * scale;
      if (value > limit) fail('Integer limit');
      if (!(b & 128)) {
        if (i && b === 0) fail('Nonminimal integer');
        return value;
      }
    }
    fail('Integer limit');
  }
  take(n) {
    if (n > this.remaining) fail('Truncated transform');
    const b = this.bytes.subarray(this.position, this.position + n);
    this.position += n;
    return b;
  }
}
export function equal(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
export function hex(b) {
  return b >= 48 && b <= 57
    ? b - 48
    : (b | 32) >= 97 && (b | 32) <= 102
      ? (b | 32) - 87
      : -1;
}
export function percentWidth(raw, i, highOnly = false) {
  if (raw[i] !== 37 || i + 2 >= raw.length) return 0;
  const hi = hex(raw[i + 1]),
    lo = hex(raw[i + 2]);
  return hi >= 0 && lo >= 0 && (!highOnly || hi >= 8) ? 3 : 0;
}

// Raw high-byte runs: 26, byte-count, raw UTF-8. Encoded ASCII: 27, byte.
// Encoded high bytes are literal. 28 toggles hex case. 29, mask, byte handles
// opposing case within a triplet; bits 1/0 mean lowercase high/low hex digit.
export function percentToBytes(raw) {
  const out = new Writer();
  let lower = 0;
  for (let i = 0; i < raw.length; ) {
    if (percentWidth(raw, i)) {
      const hi = hex(raw[i + 1]),
        lo = hex(raw[i + 2]),
        value = hi * 16 + lo;
      const a = hi >= 10 ? +(raw[i + 1] >= 97) : null,
        b = lo >= 10 ? +(raw[i + 2] >= 97) : null;
      if (a !== null && b !== null && a !== b) {
        out.put(29);
        out.put(a * 2 + b);
        out.put(value);
      } else {
        const desired = a ?? b ?? lower;
        if (desired !== lower) {
          out.put(28);
          lower = desired;
        }
        if (value < 128) out.put(27);
        out.put(value);
      }
      i += 3;
    } else if (raw[i] >= 128) {
      const start = i;
      while (i < raw.length && raw[i] >= 128) i++;
      out.put(26);
      out.uint(i - start);
      out.append(raw.subarray(start, i));
    } else {
      if (raw[i] <= 32 || raw[i] === 127) fail('Literal URL control');
      out.put(raw[i++]);
    }
  }
  return out.finish();
}
export function bytesToPercent(bytes, limit = MAX_BYTES) {
  const r = new Reader(bytes),
    out = new Writer(limit),
    alphabet = '0123456789ABCDEF';
  let lower = 0;
  const percent = (b, mask) => {
    out.put(37);
    out.put(
      alphabet.charCodeAt(b >>> 4) + (b >>> 4 >= 10 && mask & 2 ? 32 : 0)
    );
    out.put(
      alphabet.charCodeAt(b & 15) + ((b & 15) >= 10 && mask & 1 ? 32 : 0)
    );
  };
  while (r.remaining) {
    const b = r.byte();
    if (b === 26) {
      const n = r.uint(limit);
      if (!n) fail('Empty raw Unicode run');
      const run = r.take(n);
      if (run.some((x) => x < 128)) fail('Raw Unicode run contains ASCII');
      out.append(run);
    } else if (b === 27) {
      const value = r.byte();
      if (value >= 128) fail('Invalid ASCII quote');
      percent(value, lower * 3);
    } else if (b === 28) lower ^= 1;
    else if (b === 29) {
      const mask = r.byte(),
        value = r.byte();
      if ((mask !== 1 && mask !== 2) || value >>> 4 < 10 || (value & 15) < 10)
        fail('Invalid mixed hex case');
      percent(value, mask);
    } else if (b >= 128) percent(b, lower * 3);
    else {
      if (b <= 32 || b === 127) fail('Literal URL control');
      out.put(b);
    }
  }
  const raw = out.finish();
  if (!equal(percentToBytes(raw), bytes))
    fail('Noncanonical percent spelling metadata');
  return raw;
}

// Strict UTF-8 with a lossless integer escape for invalid byte values. These
// integers are internal symbols, never Unicode destination characters.
export function codepoints(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    let n =
      b < 128
        ? 1
        : b >= 194 && b <= 223
          ? 2
          : b >= 224 && b <= 239
            ? 3
            : b >= 240 && b <= 244
              ? 4
              : 0;
    let cp = n ? b & [0, 127, 31, 15, 7][n] : 0;
    if (i + n > bytes.length) n = 0;
    for (let j = 1; j < n; j++) {
      if ((bytes[i + j] & 192) !== 128) {
        n = 0;
        break;
      }
      cp = cp * 64 + (bytes[i + j] & 63);
    }
    if (
      n &&
      ((n === 2 && cp < 128) ||
        (n === 3 && cp < 2048) ||
        (n === 4 && cp < 65536) ||
        cp > 0x10ffff ||
        (cp >= 0xd800 && cp <= 0xdfff))
    )
      n = 0;
    if (n) {
      out.push(cp);
      i += n;
    } else {
      out.push(0x110000 + b);
      i++;
    }
  }
  return out;
}
function putCodepoint(out, cp) {
  if (
    !Number.isInteger(cp) ||
    cp < 0 ||
    cp > 0x1100ff ||
    (cp >= 0xd800 && cp <= 0xdfff) ||
    (cp > 0x10ffff && cp < 0x110080)
  )
    fail('Invalid codepoint');
  if (cp >= 0x110080) out.put(cp - 0x110000);
  else if (cp < 128) out.put(cp);
  else if (cp < 2048) {
    out.put(192 | (cp >>> 6));
    out.put(128 | (cp & 63));
  } else if (cp < 65536) {
    out.put(224 | (cp >>> 12));
    out.put(128 | ((cp >>> 6) & 63));
    out.put(128 | (cp & 63));
  } else {
    out.put(240 | (cp >>> 18));
    out.put(128 | ((cp >>> 12) & 63));
    out.put(128 | ((cp >>> 6) & 63));
    out.put(128 | (cp & 63));
  }
}
export function recode(bytes, mode) {
  if (mode === 'bytes' || mode === 'raw') return bytes;
  if (!MODES.includes(mode)) fail('Unknown Unicode recoding');
  const cps = codepoints(bytes),
    out = new Writer();
  let previous = 0,
    base = 0;
  if (mode === 'utf16le' || mode === 'split16') {
    const units = [];
    for (const cp of cps) {
      if (cp >= 0x110080) units.push(0xdc00 + cp - 0x110000);
      else if (cp < 65536) units.push(cp);
      else {
        const n = cp - 65536;
        units.push(0xd800 + (n >>> 10), 0xdc00 + (n & 1023));
      }
    }
    if (mode === 'utf16le')
      for (const u of units) {
        out.put(u & 255);
        out.put(u >>> 8);
      }
    else {
      for (const u of units) out.put(u & 255);
      for (const u of units) out.put(u >>> 8);
    }
  } else
    for (const cp of cps) {
      if (mode === 'codepoint') out.uint(cp);
      else if (mode === 'delta') {
        if (cp < 128) out.put(cp);
        else {
          const d = cp - previous;
          out.put(128);
          out.uint(d < 0 ? -d * 2 - 1 : d * 2);
          previous = cp;
        }
      } else {
        if (cp < 128) {
          if (cp === 127) {
            out.put(127);
            out.put(0);
          } else out.put(cp);
        } else {
          if (cp < base || cp >= base + 128) {
            base = cp - (cp % 128);
            out.put(127);
            out.put(1);
            out.uint(base / 128);
          }
          out.put(128 + cp - base);
        }
      }
    }
  return out.finish();
}
export function unrecode(bytes, mode, limit = MAX_BYTES) {
  if (mode === 'bytes' || mode === 'raw') {
    if (bytes.length > limit) fail('Decoded transform limit');
    return bytes;
  }
  const out = new Writer(limit),
    r = new Reader(bytes);
  if (mode === 'utf16le' || mode === 'split16') {
    if (bytes.length % 2) fail('Odd UTF16 byte count');
    const count = bytes.length / 2;
    const unit = (i) =>
      mode === 'utf16le'
        ? bytes[i * 2] + bytes[i * 2 + 1] * 256
        : bytes[i] + bytes[i + count] * 256;
    for (let i = 0; i < count; i++) {
      const u = unit(i);
      let cp = u;
      if (u >= 0xd800 && u <= 0xdbff) {
        if (++i === count) fail('Truncated surrogate');
        const v = unit(i);
        if (v < 0xdc00 || v > 0xdfff) fail('Invalid surrogate');
        cp = 65536 + (u - 0xd800) * 1024 + v - 0xdc00;
      } else if (u >= 0xdc80 && u <= 0xdcff) cp = 0x110000 + u - 0xdc00;
      putCodepoint(out, cp);
    }
  } else {
    let previous = 0,
      base = 0;
    while (r.remaining) {
      if (mode === 'codepoint') putCodepoint(out, r.uint(0x1100ff));
      else if (mode === 'delta') {
        const b = r.byte();
        if (b < 128) out.put(b);
        else {
          if (b !== 128) fail('Invalid delta');
          const d = r.uint(0x2201fe);
          previous += d % 2 ? -(d + 1) / 2 : d / 2;
          putCodepoint(out, previous);
        }
      } else if (mode === 'window') {
        const b = r.byte();
        if (b === 127) {
          const tag = r.byte();
          if (tag === 0) out.put(127);
          else if (tag === 1) base = r.uint(0x2201) * 128;
          else fail('Invalid window tag');
        } else putCodepoint(out, b < 128 ? b : base + b - 128);
      } else fail('Unknown Unicode recoding');
    }
  }
  const result = out.finish();
  if (!equal(recode(result, mode), bytes))
    fail('Noncanonical Unicode recoding');
  return result;
}
export function transform(raw, mode) {
  return mode === 'raw' ? raw : recode(percentToBytes(raw), mode);
}
export function restore(bytes, mode, limit = MAX_BYTES) {
  const b = unrecode(bytes, mode);
  return mode === 'raw'
    ? b.length <= limit
      ? b
      : fail('Raw output limit')
    : bytesToPercent(b, limit);
}

export function splitHigh(raw) {
  const out = new Writer(),
    parts = [];
  const step = (i) => (raw[i] >= 128 ? 1 : percentWidth(raw, i, true));
  for (let i = 0; i < raw.length; ) {
    if (step(i)) {
      const start = i;
      while (i < raw.length && step(i)) i += step(i);
      parts.push(raw.subarray(start, i));
      out.put(0);
    } else out.put(raw[i++]);
  }
  return { skeleton: out.finish(), parts };
}
export function joinHigh(skeleton, side, mode, limit = MAX_BYTES) {
  const out = new Writer(limit),
    r = new Reader(side);
  for (const b of skeleton) {
    if (b) {
      if (b < 33 || b >= 127) fail('Invalid skeleton');
      out.put(b);
    } else {
      const n = r.uint();
      if (!n) fail('Empty side run');
      out.append(restore(r.take(n), mode, limit - out.length));
    }
  }
  if (r.remaining) fail('Trailing side data');
  return out.finish();
}
