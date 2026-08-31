import { deflateSync, inflateSync } from 'fflate/browser';
import { inspectDeflate } from '../codecs/core/deflate-check.mjs';

// Independent URL grammar codec, v1. The caller owns the marker, CRC and transport.
// Wire: template byte (bit 7 = http, bit 6 = residual present), fields, optional residual.
// Lengths are minimal unsigned LEB128; packed symbols are MSB-first, zero padded.
// Decimal accounts 0..63 without leading zeros use a single 0x80|value byte;
// otherwise use length (1..64) + packed decimal nibbles. 0xc0..0xff are reserved.
// Fixed-size IDs omit lengths. UUIDs use a case/hyphen flag + 16 hex bytes and,
// only for mixed case, a 32-bit uppercase mask. Text uses a LEB128 (size*4+mode):
// 0=UTF-8 bytes, 1=7-bit ASCII symbols, 2=raw DEFLATE bytes, 3=reserved.
// An absent residual costs no bytes; a present residual must be nonempty.
export const MAX_INPUT_BYTES = 128 * 1024,
  MAX_BODY_BYTES = 6 * 1024;
const utf8 = new TextEncoder(),
  text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const HEX = '0123456789abcdef';
const smallDecimal = /^(?:[0-9]|[1-5][0-9]|6[0-3])$/;
const fields = {
  b: { pattern: '[A-Za-z0-9_-]{1,1024}', alphabet: B64, bits: 6, max: 1024 },
  d: { pattern: '[0-9]{1,64}', alphabet: '0123456789', bits: 4, max: 64 },
  y: { pattern: '[A-Za-z0-9_-]{11}', alphabet: B64, bits: 6, fixed: 11 },
  s: {
    pattern: '[A-Za-z0-9]{22}',
    alphabet: B64.slice(0, 62),
    bits: 6,
    fixed: 22
  },
  a: {
    pattern: '[A-Za-z0-9]{10}',
    alphabet: B64.slice(0, 62),
    bits: 6,
    fixed: 10
  },
  h: {
    pattern:
      '(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})'
  },
  t: { pattern: '(?:[^/?#]*-)?', max: 1024 },
  p: { pattern: '[^/?#]{1,1024}', max: 1024 },
  n: { pattern: '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', max: 63 }
};
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function template(parts, query = false) {
  const pattern = parts
    .map((part, i) => (i % 2 ? '(' + fields[part].pattern + ')' : escape(part)))
    .join('');
  return {
    parts,
    regex: new RegExp(
      '^' + pattern + '(' + (query ? '[&#]' : '[/?#]') + '[\\s\\S]*)?$'
    )
  };
}
// Stable IDs: append only. Literal prefixes are case sensitive; nothing is URL-normalized.
const templates = [
  template(['https://drive.google.com/drive/u/', 'd', '/folders/', 'b', '']), // 0
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
  template(['https://www.amazon.com/', 'p', '/dp/', 'a', '']) // 29
];

function fail() {
  throw Error('Invalid structured URL body');
}
function validInput(input) {
  if (
    typeof input !== 'string' ||
    input.length > MAX_INPUT_BYTES ||
    /[\u0000-\u0020\u007f]/.test(input)
  )
    return false;
  const bytes = utf8.encode(input);
  return bytes.length <= MAX_INPUT_BYTES && text.decode(bytes) === input;
}
function integer(out, value) {
  do {
    const byte = value & 127;
    value = Math.floor(value / 128);
    out.push(byte | (value ? 128 : 0));
  } while (value);
}
function packed(out, values, bits) {
  let buffer = 0,
    count = 0;
  for (const value of values) {
    buffer = (buffer << bits) | value;
    count += bits;
    if (count >= 8) {
      count -= 8;
      out.push((buffer >>> count) & 255);
    }
  }
  if (count) out.push((buffer << (8 - count)) & 255);
}
function putText(out, value) {
  const raw = utf8.encode(value);
  const frame = (mode, size, bytes) => {
    const result = [];
    integer(result, size * 4 + mode);
    return result.concat(Array.from(bytes));
  };
  let best = frame(0, raw.length, raw);
  if (raw.every((byte) => byte < 128)) {
    const bytes = [];
    packed(bytes, raw, 7);
    const candidate = frame(1, raw.length, bytes);
    if (candidate.length < best.length) best = candidate;
  }
  if (raw.length >= 32) {
    const bytes = deflateSync(raw, { level: 6 }),
      candidate = frame(2, bytes.length, bytes);
    if (candidate.length < best.length) best = candidate;
  }
  for (const byte of best) out.push(byte);
}
function putField(out, kind, value) {
  const spec = fields[kind];
  if (kind === 'd' && smallDecimal.test(value)) {
    out.push(128 | Number(value));
  } else if (kind === 't' || kind === 'n' || kind === 'p') {
    if (utf8.encode(value).length > spec.max) return false;
    putText(out, value);
  } else if (kind === 'h') {
    const hex = value.replaceAll('-', ''),
      lower = hex.toLowerCase();
    const mode = hex === lower ? 0 : hex === hex.toUpperCase() ? 1 : 2;
    out.push(mode | (value.includes('-') ? 4 : 0));
    packed(
      out,
      Array.from(lower, (char) => HEX.indexOf(char)),
      4
    );
    if (mode === 2)
      packed(
        out,
        Array.from(hex, (char) => (/[A-F]/.test(char) ? 1 : 0)),
        1
      );
  } else {
    if (!spec.fixed) integer(out, value.length);
    packed(
      out,
      Array.from(value, (char) => spec.alphabet.indexOf(char)),
      spec.bits
    );
  }
  return true;
}

export function encodeStructured(input) {
  if (!validInput(input)) return null;
  const http = input.startsWith('http://');
  const source = http ? 'https://' + input.slice(7) : input;
  for (let id = 0; id < templates.length; id++) {
    const { parts, regex } = templates[id];
    if (!source.startsWith(parts[0])) continue;
    const match = regex.exec(source);
    if (!match) continue;
    const tail = match.at(-1) || '';
    const out = [id | (http ? 128 : 0) | (tail ? 64 : 0)];
    let group = 1;
    for (let i = 1; i < parts.length; i += 2) {
      if (!putField(out, parts[i], match[group++])) return null;
    }
    if (tail) putText(out, tail);
    return out.length <= MAX_BODY_BYTES ? Uint8Array.from(out) : null;
  }
  return null;
}

export function decodeStructured(bytes) {
  if (
    !(bytes instanceof Uint8Array) ||
    !bytes.length ||
    bytes.length > MAX_BODY_BYTES
  )
    fail();
  let position = 0,
    budget = MAX_INPUT_BYTES;
  function take(length) {
    if (position + length > bytes.length) fail();
    const value = bytes.subarray(position, position + length);
    position += length;
    return value;
  }
  function readInt(maximum) {
    let value = 0,
      scale = 1;
    for (let i = 0; i < 3; i++, scale *= 128) {
      const byte = take(1)[0];
      value += (byte & 127) * scale;
      if (value > maximum) fail();
      if (!(byte & 128)) {
        if (i && byte === 0) fail();
        return value;
      }
    }
    fail();
  }
  function unpack(length, bits, alphabet) {
    const data = take(Math.ceil((length * bits) / 8)),
      result = [];
    const padding = (8 - ((length * bits) % 8)) % 8;
    if (padding && data.at(-1) & ((1 << padding) - 1)) fail();
    let buffer = 0,
      count = 0,
      index = 0;
    for (let i = 0; i < length; i++) {
      if (count < bits) {
        buffer = (buffer << 8) | data[index++];
        count += 8;
      }
      count -= bits;
      const value = (buffer >>> count) & ((1 << bits) - 1);
      if (alphabet && value >= alphabet.length) fail();
      result.push(alphabet ? alphabet[value] : value);
    }
    return result;
  }
  function readText(maximum) {
    const tag = readInt(MAX_INPUT_BYTES * 4 + 3),
      mode = tag & 3,
      size = Math.floor(tag / 4);
    if (mode === 3 || (mode !== 2 && size > maximum)) fail();
    let raw;
    if (mode === 0) raw = take(size);
    else if (mode === 1) raw = Uint8Array.from(unpack(size, 7));
    else {
      const compressed = take(size),
        length = inspectDeflate(compressed, maximum);
      raw = inflateSync(compressed, { out: new Uint8Array(length) });
      if (raw.length !== length) fail();
      // Also rejects nonzero alignment bits in stored DEFLATE blocks.
      const canonical = deflateSync(raw, { level: 6 });
      if (
        canonical.length !== size ||
        canonical.some((byte, i) => byte !== compressed[i])
      )
        fail();
    }
    return text.decode(raw);
  }
  function readField(kind) {
    const spec = fields[kind];
    if (kind === 'd' && bytes[position] >= 128) {
      const tag = take(1)[0];
      if (tag >= 192) fail();
      return String(tag & 63);
    }
    if (kind === 't' || kind === 'n' || kind === 'p')
      return readText(Math.min(budget, spec.max));
    if (kind === 'h') {
      const flag = take(1)[0],
        mode = flag & 3;
      if (flag > 6 || mode === 3) fail();
      let hex = unpack(32, 4, HEX).join('');
      if (mode === 1) {
        if (!/[a-f]/.test(hex)) fail();
        hex = hex.toUpperCase();
      }
      if (mode === 2) {
        const mask = unpack(32, 1);
        hex = Array.from(hex, (char, i) => {
          if (mask[i] && !/[a-f]/.test(char)) fail();
          return mask[i] ? char.toUpperCase() : char;
        }).join('');
        if (hex === hex.toLowerCase() || hex === hex.toUpperCase()) fail();
      }
      return flag & 4
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
    const length = spec.fixed || readInt(spec.max);
    if (!length || length > budget) fail();
    const value = unpack(length, spec.bits, spec.alphabet).join('');
    if (kind === 'd' && smallDecimal.test(value)) fail();
    return value;
  }
  const header = take(1)[0],
    entry = templates[header & 63];
  if (!entry) fail();
  let result = '';
  function append(value) {
    budget -= utf8.encode(value).length;
    if (budget < 0) fail();
    result += value;
  }
  for (let i = 0; i < entry.parts.length; i++) {
    const value = i % 2 ? readField(entry.parts[i]) : entry.parts[i];
    append(i === 0 && header & 128 ? 'http://' + value.slice(8) : value);
  }
  if (header & 64) {
    const tail = readText(budget);
    if (!tail) fail();
    append(tail);
  }
  if (position !== bytes.length || !validInput(result)) fail();
  const source = header & 128 ? 'https://' + result.slice(7) : result;
  if (!entry.regex.test(source)) fail();
  return result;
}
