import { deflateSync, inflateSync } from 'fflate/browser';
import { inspectDeflate } from '../codecs/core/deflate-check.mjs';

// Independent packed structural body, v2. The parent owns version, CRC and transport.
// Bits are MSB first, with NO alignment between fields. The first byte keeps the
// template in bits 0..5, residual in bit 6, and HTTP in bit 7. IDs are append-only.
// Unsigned LEB128 octets are also unaligned and must be minimal. Short lengths
// use six bits for 1..63, or zero + LEB128 for 0 or >=64. Base64 IDs cannot be empty.
// Text: LEB128(size*4+mode), then UTF-8(0), seven-bit ASCII(1), or DEFLATE(2).
// Residual-only mode 3: size is query entry count; see putQuery/readQuery below.
export const MAX_INPUT_BYTES = 128 * 1024,
  MAX_BODY_BYTES = 6 * 1024;
const utf8 = new TextEncoder(),
  text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const HEX = '0123456789abcdef',
  DEC = '0123456789';
const specs = {
  b: { pattern: '[A-Za-z0-9_-]{1,1024}', max: 1024 },
  // Accounts are opaque path segments, not integers. Only exact 0/1/2 get shortcuts.
  c: { pattern: '[^/?#]{1,64}', max: 64 },
  y: { pattern: '[A-Za-z0-9_-]{10}[AEIMQUYcgkosw048]' },
  s: { pattern: '[A-Za-z0-9]{22}', fixed: 22 },
  a: { pattern: '[A-Za-z0-9]{10}', fixed: 10 },
  h: {
    pattern:
      '(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})'
  },
  t: { pattern: '(?:[^/?#]*-)?', max: 1024 },
  p: { pattern: '[^/?#]{1,1024}', max: 1024 },
  n: { pattern: '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', max: 63 },
  u: { pattern: '[A-Za-z0-9_]{1,15}', max: 15 },
  d: { pattern: '[0-9]{1,64}', max: 64 }
};
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function template(parts, query = false) {
  const pattern = parts
    .map((part, i) => (i % 2 ? '(' + specs[part].pattern + ')' : escape(part)))
    .join('');
  return {
    parts,
    regex: new RegExp(
      '^' + pattern + '(' + (query ? '[&#]' : '[/?#]') + '[\\s\\S]*)?$'
    )
  };
}
const templates = [
  template(['https://drive.google.com/drive/u/', 'c', '/folders/', 'b', '']), // 0
  template(['https://drive.google.com/drive/folders/', 'b', '']), // 1
  template(['https://drive.google.com/file/d/', 'b', '']), // 2
  template(['https://docs.google.com/document/d/', 'b', '']), // 3
  template(['https://docs.google.com/spreadsheets/d/', 'b', '']), // 4
  template(['https://docs.google.com/presentation/d/', 'b', '']), // 5
  template(['https://www.youtube.com/watch?v=', 'y', ''], true), // 6
  template(['https://youtube.com/watch?v=', 'y', ''], true), // 7
  template(['https://m.youtube.com/watch?v=', 'y', ''], true), // 8
  template(['https://youtu.be/', 'y', '']), // 9
  template(['https://www.youtube.com/shorts/', 'y', '']), // 10
  template(['https://youtube.com/shorts/', 'y', '']), // 11
  template(['https://www.youtube.com/live/', 'y', '']), // 12
  template(['https://www.youtube.com/embed/', 'y', '']), // 13
  ...['track', 'album', 'playlist', 'episode', 'show', 'artist'].map((kind) =>
    template(['https://open.spotify.com/' + kind + '/', 's', ''])
  ), // 14..19
  template(['https://www.notion.so/', 't', '', 'h', '']), // 20
  template(['https://notion.so/', 't', '', 'h', '']), // 21
  template(['https://', 'n', '.notion.site/', 't', '', 'h', '']), // 22
  ...[
    'www.amazon.com',
    'amazon.com',
    'www.amazon.co.uk',
    'www.amazon.de',
    'www.amazon.ca'
  ].map((host) => template(['https://' + host + '/dp/', 'a', ''])), // 23..27
  template(['https://www.amazon.com/gp/product/', 'a', '']), // 28
  template(['https://www.amazon.com/', 'p', '/dp/', 'a', '']), // 29
  ...['www.instagram.com', 'instagram.com'].flatMap((host) =>
    ['p', 'reel'].map((kind) =>
      template(['https://' + host + '/' + kind + '/', 'b', ''])
    )
  ), // 30..33
  ...[
    'x.com',
    'twitter.com',
    'www.x.com',
    'www.twitter.com',
    'mobile.twitter.com'
  ].map((host) =>
    template(['https://' + host + '/', 'u', '/status/', 'd', ''])
  ), // 34..38
  template(['https://drive.google.com/drive/u/', 'c', '/file/d/', 'b', '']), // 39
  ...['document', 'spreadsheets', 'presentation'].map((kind) =>
    template(['https://docs.google.com/' + kind + '/u/', 'c', '/d/', 'b', ''])
  ) // 40..42
];

// Exact, case-sensitive keys; zero is the literal-key escape. Never URL-decode.
const keys = [
  '',
  't',
  'si',
  'start',
  'list',
  'index',
  'feature',
  'ab_channel',
  'usp',
  'resourcekey',
  'igsh',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_source_platform',
  'utm_creative_format',
  'utm_marketing_tactic',
  'v',
  'pvs',
  'share',
  'ref',
  'ref_',
  'tag',
  'th',
  'psc',
  's',
  'lang',
  'hl',
  'q',
  'id',
  'tab',
  'authuser',
  'export',
  'format',
  'gid',
  'range',
  'view',
  'usp_param',
  'fbclid',
  'gclid',
  'dclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'pp',
  'context',
  'is_from_webapp',
  'sender_device',
  'web_id',
  'url',
  'redirect',
  'source',
  'time_continue'
];
const keyIds = new Map(keys.slice(1).map((key, i) => [key, i + 1]));
const fail = () => {
  throw Error('Invalid packed structured URL body');
};
function validInput(input) {
  if (
    typeof input !== 'string' ||
    input.length > MAX_INPUT_BYTES ||
    /[\u0000-\u0020\u007f]/.test(input)
  )
    return false;
  const raw = utf8.encode(input);
  return raw.length <= MAX_INPUT_BYTES && text.decode(raw) === input;
}
class Writer {
  bytes = [];
  bitLength = 0;
  put(value, width) {
    while (width) {
      const offset = this.bitLength % 8,
        n = Math.min(8 - offset, width);
      const index = Math.floor(this.bitLength / 8);
      this.bytes[index] =
        (this.bytes[index] || 0) |
        (((value >>> (width - n)) & ((1 << n) - 1)) << (8 - offset - n));
      this.bitLength += n;
      width -= n;
    }
  }
  uint(value) {
    do {
      const low = value % 128;
      value = Math.floor(value / 128);
      this.put(low | (value ? 128 : 0), 8);
    } while (value);
  }
  length(value) {
    this.put(value > 0 && value < 64 ? value : 0, 6);
    if (!value || value >= 64) this.uint(value);
  }
  symbols(value, alphabet, width) {
    for (const char of value) this.put(alphabet.indexOf(char), width);
  }
  append(other) {
    for (let i = 0; i < other.bytes.length; i++) {
      const n = Math.min(8, other.bitLength - i * 8);
      this.put(other.bytes[i] >>> (8 - n), n);
    }
  }
  result() {
    return { bytes: Uint8Array.from(this.bytes), bitLength: this.bitLength };
  }
}
class Reader {
  position = 0;
  constructor(bytes, bitLength) {
    this.bytes = bytes;
    this.bitLength = bitLength;
  }
  read(width) {
    if (this.position + width > this.bitLength) fail();
    let value = 0;
    while (width) {
      const offset = this.position % 8,
        n = Math.min(8 - offset, width);
      value =
        value * 2 ** n +
        ((this.bytes[Math.floor(this.position / 8)] >>> (8 - offset - n)) &
          ((1 << n) - 1));
      this.position += n;
      width -= n;
    }
    return value;
  }
  uint(maximum) {
    let value = 0,
      scale = 1;
    for (let i = 0; i < 3; i++, scale *= 128) {
      const byte = this.read(8);
      value += (byte & 127) * scale;
      if (value > maximum) fail();
      if (!(byte & 128)) {
        if (i && byte === 0) fail();
        return value;
      }
    }
    fail();
  }
  length(maximum) {
    let size = this.read(6);
    if (!size) {
      size = this.uint(maximum);
      if (size > 0 && size < 64) fail();
    }
    if (size > maximum) fail();
    return size;
  }
  symbols(size, alphabet, width) {
    if (size * width > this.bitLength - this.position) fail();
    const result = [];
    for (let i = 0; i < size; i++) {
      const code = this.read(width);
      if (code >= alphabet.length) fail();
      result.push(alphabet[code]);
    }
    return result.join('');
  }
  data(size) {
    if (size * 8 > this.bitLength - this.position) fail();
    return Uint8Array.from({ length: size }, () => this.read(8));
  }
}
const shortest = (candidates) =>
  candidates.reduce((best, next) =>
    next.bitLength < best.bitLength ? next : best
  );
function textWriter(value) {
  const raw = utf8.encode(value),
    candidates = [];
  const frame = (mode, data, width) => {
    const out = new Writer();
    out.uint(data.length * 4 + mode);
    for (const byte of data) out.put(byte, width);
    candidates.push(out);
  };
  frame(0, raw, 8);
  if (raw.every((byte) => byte < 128)) frame(1, raw, 7);
  if (raw.length >= 32) frame(2, deflateSync(raw, { level: 6 }), 8);
  return shortest(candidates);
}
function readText(reader, maximum, tag = reader.uint(MAX_INPUT_BYTES * 4 + 3)) {
  const mode = tag & 3,
    size = Math.floor(tag / 4);
  if (mode === 3 || (mode !== 2 && size > maximum)) fail();
  let raw;
  if (mode === 0) raw = reader.data(size);
  else if (mode === 1) {
    if (size * 7 > reader.bitLength - reader.position) fail();
    raw = Uint8Array.from({ length: size }, () => reader.read(7));
  } else {
    const compressed = reader.data(size),
      length = inspectDeflate(compressed, maximum);
    raw = inflateSync(compressed, { out: new Uint8Array(length) });
    if (raw.length !== length) fail();
    // Pin canonical compressor output, including stored-block alignment bits.
    const canonical = deflateSync(raw, { level: 6 });
    if (
      canonical.length !== size ||
      canonical.some((byte, i) => byte !== compressed[i])
    )
      fail();
  }
  return text.decode(raw);
}
// Typed strings: two-bit type 0=text, 1=base64url, 2=decimal, 3=hex.
// Hex has one uppercase bit. Numeric values are symbol strings: zeros survive.
function valueWriter(value) {
  const raw = new Writer();
  raw.put(0, 2);
  raw.append(textWriter(value));
  const candidates = [raw];
  for (const [mode, pattern, alphabet, width] of [
    [1, /^[A-Za-z0-9_-]+$/, B64, 6],
    [2, /^[0-9]+$/, DEC, 4],
    [3, /^(?:[0-9a-f]+|[0-9A-F]+)$/, HEX, 4]
  ]) {
    if (!pattern.test(value)) continue;
    const out = new Writer();
    out.put(mode, 2);
    if (mode === 3) out.put(/[A-F]/.test(value) ? 1 : 0, 1);
    out.length(value.length);
    out.symbols(mode === 3 ? value.toLowerCase() : value, alphabet, width);
    candidates.push(out);
  }
  return shortest(candidates);
}
function readValue(reader, maximum) {
  const mode = reader.read(2);
  if (!mode) return readText(reader, maximum);
  const upper = mode === 3 ? reader.read(1) : 0,
    size = reader.length(maximum);
  if (!size) fail();
  const value = reader.symbols(
    size,
    mode === 1 ? B64 : mode === 2 ? DEC : HEX,
    mode === 1 ? 6 : 4
  );
  if (upper && !/[a-f]/.test(value)) fail();
  return upper ? value.toUpperCase() : value;
}
// Ordered query: tag=count*4+3; two start bits (?=0,&=1,path?=2,3 reserved),
// one fragment bit, optional path text for start=2;
// each entry is keyID:6 (0 => text key), equals:1, optional typed value.
// Split only on '&' and the FIRST '='. Empty entries, keys, values and fragments
// remain distinct. A fragment is a final text string, without its initial '#'.
function putQuery(tail) {
  const hash = tail.indexOf('#');
  let start,
    offset = 1;
  if (tail[0] === '?') start = 0;
  else if (tail[0] === '&') start = 1;
  else {
    const question = tail.indexOf('?');
    if (tail[0] !== '/' || question < 0 || (hash >= 0 && question > hash))
      return null;
    start = 2;
    offset = question + 1;
  }
  const query = tail.slice(offset, hash < 0 ? undefined : hash);
  const entries = query ? query.split('&') : [],
    out = new Writer();
  out.uint(entries.length * 4 + 3);
  out.put(start, 2);
  out.put(hash >= 0 ? 1 : 0, 1);
  if (start === 2) out.append(textWriter(tail.slice(0, offset - 1)));
  for (const entry of entries) {
    const equal = entry.indexOf('='),
      key = equal < 0 ? entry : entry.slice(0, equal);
    const id = keyIds.get(key) || 0;
    out.put(id, 6);
    if (!id) out.append(textWriter(key));
    out.put(equal >= 0 ? 1 : 0, 1);
    if (equal >= 0) out.append(valueWriter(entry.slice(equal + 1)));
  }
  if (hash >= 0) out.append(textWriter(tail.slice(hash + 1)));
  return out;
}
function readQuery(reader, count, maximum) {
  if (count > maximum || count * 7 + 3 > reader.bitLength - reader.position)
    fail();
  const start = reader.read(2),
    fragment = reader.read(1),
    chunks = [];
  if (start === 3) fail();
  let budget = maximum;
  const append = (value) => {
    budget -= utf8.encode(value).length;
    if (budget < 0) fail();
    chunks.push(value);
  };
  if (start === 2) {
    const path = readText(reader, budget);
    if (!path.startsWith('/') || /[?#]/.test(path)) fail();
    append(path);
  }
  append(start === 1 ? '&' : '?');
  for (let i = 0; i < count; i++) {
    if (i) append('&');
    const id = reader.read(6);
    if (id >= keys.length) fail();
    const key = id ? keys[id] : readText(reader, budget);
    if ((!id && keyIds.has(key)) || /[&=#]/.test(key)) fail();
    append(key);
    const equal = reader.read(1);
    if (count === 1 && !key && !equal) fail(); // Empty query has zero entries.
    if (equal) {
      append('=');
      const value = readValue(reader, budget);
      if (/[&#]/.test(value)) fail();
      append(value);
    }
  }
  if (fragment) {
    append('#');
    append(readText(reader, budget));
  }
  if (budget < 0) fail();
  return chunks.join('');
}
function putField(out, kind, value) {
  const spec = specs[kind];
  if (spec.max && utf8.encode(value).length > spec.max) return false;
  if (kind === 'c') {
    const code = /^[012]$/.test(value) ? Number(value) : 3;
    out.put(code, 2);
    if (code === 3) out.append(valueWriter(value));
  } else if (kind === 'y') {
    out.symbols(value.slice(0, 10), B64, 6);
    out.put(B64.indexOf(value[10]) >>> 2, 4);
  } else if (kind === 'h') {
    const hex = value.replaceAll('-', ''),
      lower = hex.toLowerCase();
    const mode = hex === lower ? 0 : hex === hex.toUpperCase() ? 1 : 2;
    out.put(mode, 2);
    out.put(value.includes('-') ? 1 : 0, 1);
    out.symbols(lower, HEX, 4);
    if (mode === 2)
      for (const char of hex) out.put(/[A-F]/.test(char) ? 1 : 0, 1);
  } else if (kind === 't' || kind === 'n' || kind === 'p')
    out.append(textWriter(value));
  else {
    if (!spec.fixed) out.length(value.length);
    out.symbols(value, kind === 'd' ? DEC : B64, kind === 'd' ? 4 : 6);
  }
  return true;
}
function readField(reader, kind, budget) {
  const spec = specs[kind],
    maximum = Math.min(budget, spec.max ?? MAX_INPUT_BYTES);
  if (kind === 'c') {
    const code = reader.read(2);
    if (code < 3) return String(code);
    const value = readValue(reader, maximum);
    if (/^[012]$/.test(value)) fail();
    return value;
  }
  if (kind === 'y') return reader.symbols(10, B64, 6) + B64[reader.read(4) * 4];
  if (kind === 'h') {
    const mode = reader.read(2),
      hyphens = reader.read(1);
    if (mode === 3) fail();
    let hex = reader.symbols(32, HEX, 4);
    if (mode === 1) {
      if (!/[a-f]/.test(hex)) fail();
      hex = hex.toUpperCase();
    }
    if (mode === 2) {
      hex = Array.from(hex, (char) => {
        const upper = reader.read(1);
        if (upper && !/[a-f]/.test(char)) fail();
        return upper ? char.toUpperCase() : char;
      }).join('');
      if (hex === hex.toLowerCase() || hex === hex.toUpperCase()) fail();
    }
    return hyphens
      ? hex.slice(0, 8) +
          '-' +
          hex.slice(8, 12) +
          '-' +
          hex.slice(12, 16) +
          '-' +
          hex.slice(16, 20) +
          '-' +
          hex.slice(20)
      : hex;
  }
  if (kind === 't' || kind === 'n' || kind === 'p')
    return readText(reader, maximum);
  const size = spec.fixed || reader.length(maximum);
  if (!size || size > budget) fail();
  return reader.symbols(
    size,
    kind === 'd' ? DEC : kind === 's' || kind === 'a' ? B64.slice(0, 62) : B64,
    kind === 'd' ? 4 : 6
  );
}

export function encodePacked(input) {
  if (!validInput(input)) return null;
  const http = input.startsWith('http://'),
    source = http ? 'https://' + input.slice(7) : input;
  for (let id = 0; id < templates.length; id++) {
    const { parts, regex } = templates[id];
    if (!source.startsWith(parts[0])) continue;
    const match = regex.exec(source);
    if (!match) continue;
    const tail = match.at(-1) || '',
      out = new Writer();
    out.put(id | (http ? 128 : 0) | (tail ? 64 : 0), 8);
    let group = 1;
    for (let i = 1; i < parts.length; i += 2)
      if (!putField(out, parts[i], match[group++])) return null;
    if (tail) {
      const plain = textWriter(tail),
        query = putQuery(tail);
      out.append(query && query.bitLength < plain.bitLength ? query : plain);
    }
    return out.bitLength <= MAX_BODY_BYTES * 8 ? out.result() : null;
  }
  return null;
}

export function decodePacked(bytes, { bitLength = bytes?.length * 8 } = {}) {
  // bitLength describes the transport's logical bits. Unused bits in its final
  // storage byte must also be zero; whole unused storage bytes are forbidden.
  if (
    !(bytes instanceof Uint8Array) ||
    !bytes.length ||
    bytes.length > MAX_BODY_BYTES + 2 ||
    !Number.isSafeInteger(bitLength) ||
    bitLength < 8 ||
    bitLength > bytes.length * 8 ||
    Math.ceil(bitLength / 8) !== bytes.length
  )
    fail();
  if (bitLength % 8 && bytes.at(-1) & ((1 << (8 - (bitLength % 8))) - 1))
    fail();
  const reader = new Reader(bytes, bitLength),
    header = reader.read(8),
    entry = templates[header & 63];
  if (!entry) fail();
  const chunks = [];
  let budget = MAX_INPUT_BYTES;
  const append = (value) => {
    budget -= utf8.encode(value).length;
    if (budget < 0) fail();
    chunks.push(value);
  };
  for (let i = 0; i < entry.parts.length; i++) {
    let value =
      i % 2 ? readField(reader, entry.parts[i], budget) : entry.parts[i];
    if (!i && header & 128) value = 'http://' + value.slice(8);
    if (
      i % 2 &&
      !new RegExp('^(?:' + specs[entry.parts[i]].pattern + ')$').test(value)
    )
      fail();
    append(value);
  }
  if (header & 64) {
    const tag = reader.uint(MAX_INPUT_BYTES * 4 + 3);
    const tail =
      (tag & 3) === 3
        ? readQuery(reader, Math.floor(tag / 4), budget)
        : readText(reader, budget, tag);
    if (!tail) fail();
    append(tail);
  }
  const consumed = reader.position;
  if (consumed > MAX_BODY_BYTES * 8 || bitLength - consumed > 14) fail();
  while (reader.position < bitLength) if (reader.read(1)) fail();
  const input = chunks.join(''),
    source = header & 128 ? 'https://' + input.slice(7) : input;
  if (!validInput(input) || !entry.regex.test(source)) fail();
  return { input, bitLength: consumed };
}
