// A lossless structural preprocessor and its byte-context codec. Typed fields
// enter the context stream as control symbols; their data shares the arithmetic
// stream with the skeleton instead of confusing its byte statistics.
import {
  ArithmeticEncoder,
  ArithmeticDecoder,
  describe
} from '../compact/arithmetic.mjs';
import { createContext } from './context.mjs';
import { fieldsOf, normalize, tableOf, writeTable } from './grammar.mjs';

export const TYPES = [
  { name: 'decimal', alphabet: '0123456789' },
  { name: 'hex-lower', alphabet: '0123456789abcdef' },
  { name: 'hex-upper', alphabet: '0123456789ABCDEF' },
  {
    name: 'base64url',
    alphabet: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  },
  {
    name: 'base64',
    alphabet: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  },
  { name: 'uuid-lower', alphabet: '0123456789abcdef', uuid: true },
  { name: 'uuid-upper', alphabet: '0123456789ABCDEF', uuid: true }
];
export const HOST = 7,
  SCHEME = 8,
  HOST_RAW = 9,
  HOST_END = 10;
const te = new TextEncoder(),
  td = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export const binary = (bytes) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
};
const unbinary = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const reversed = (host) => host.split('.').reverse().join('.');
function classification(value, opaque = true) {
  if (/^[0-9]{4,}$/.test(value)) return 0;
  if (/^[0-9a-f]{8,}$/.test(value)) return 1;
  if (/^[0-9A-F]{8,}$/.test(value)) return 2;
  if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)) return 5;
  if (/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(value)) return 6;
  if (
    opaque &&
    value.length >= 8 &&
    /[A-Z]/.test(value) &&
    /[a-z]/.test(value) &&
    /[0-9]/.test(value)
  ) {
    if (/^[A-Za-z0-9_-]+$/.test(value)) return 3;
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(value) && !value.includes('=')) return 4;
  }
  return -1;
}
function schemeId(value) {
  const s = value.slice(0, -3);
  let mask = 0;
  for (let i = 0; i < s.length; i++)
    if (s[i] !== s[i].toLowerCase()) mask |= 1 << i;
  return (s.length === 5 ? 32 : 0) | mask;
}
function schemeText(id) {
  let result = id & 32 ? 'https' : 'http';
  if (!(id & 32) && id & 16) throw Error('Noncanonical scheme mask');
  result = [...result]
    .map((c, i) => (id & (1 << i) ? c.toUpperCase() : c))
    .join('');
  return result + '://';
}
export function preprocess(bytes, meta) {
  const input = td.decode(bytes),
    fields = fieldsOf(input),
    events = [],
    hosts = meta.hostIds ?? new Map(meta.hosts.map((s, id) => [s, id]));
  const emit = (value) => {
    for (const b of te.encode(value)) events.push({ symbol: b });
  };
  for (const field of fields) {
    const { role, value, separator } = field;
    if (role === 0 && meta.authority !== false) {
      events.push({
        symbol: SCHEME,
        id: schemeId(value),
        after: binary(te.encode(value))
      });
    } else if (role === 1 && meta.authority !== false) {
      const raw = binary(te.encode(value)),
        id = hosts.get(raw);
      if (id !== undefined) events.push({ symbol: HOST, id, after: raw });
      else {
        events.push({ symbol: HOST_RAW });
        for (const b of reversed(raw)) events.push({ symbol: b.charCodeAt(0) });
        events.push({ symbol: HOST_END, after: raw });
      }
    } else if (role >= 2) {
      const whole = classification(value, meta.opaque !== false);
      if (whole >= 0 && value.length <= 4096)
        events.push({ symbol: whole, data: value, role });
      else {
        let pos = 0;
        for (const match of value.matchAll(/[A-Za-z0-9_+-]+/g)) {
          emit(value.slice(pos, match.index));
          const type = classification(match[0], meta.opaque !== false);
          if (type >= 0) events.push({ symbol: type, data: match[0], role });
          else {
            let at = 0;
            for (const digits of match[0].matchAll(/[0-9]{4,}/g)) {
              emit(match[0].slice(at, digits.index));
              events.push({ symbol: 0, data: digits[0], role });
              at = digits.index + digits[0].length;
            }
            emit(match[0].slice(at));
          }
          pos = match.index + match[0].length;
        }
        emit(value.slice(pos));
      }
    } else emit(value);
    if (separator) events.push({ symbol: separator.charCodeAt(0) });
  }
  events.push({ symbol: 256 });
  return events;
}
export const historyAfter = (history, event, order) =>
  event.after !== undefined
    ? (history + event.after).slice(-order)
    : (history + String.fromCharCode(event.symbol)).slice(-order);
function readTable(coder, table, mirror) {
  const target = coder.target(table.total);
  let lo = 0,
    hi = table.frequencies.length;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (table.cumulative[mid] <= target) lo = mid;
    else hi = mid;
  }
  if (!table.frequencies[lo]) throw Error('Invalid preprocessor symbol');
  coder.consume(table.cumulative[lo], table.cumulative[lo + 1], table.total);
  mirror.write(table.cumulative[lo], table.cumulative[lo + 1], table.total);
  return lo;
}
export function createSkeleton(contextModel, meta) {
  const ppm = createContext(contextModel),
    { order } = contextModel;
  const hosts = tableOf(meta.hostFrequencies),
    scheme = tableOf(meta.schemeFrequencies),
    lengths = meta.lengths.map((rows) => rows.map(tableOf));
  const runtime = {
    ...meta,
    hostIds: new Map(meta.hosts.map((s, id) => [s, id]))
  };
  function encodeBytes(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length > 4096)
      throw new RangeError('Skeleton byte limit');
    const events = preprocess(bytes, runtime),
      coder = new ArithmeticEncoder();
    let history = ppm.start;
    for (const event of events) {
      const { symbol } = event;
      ppm.symbol(coder, symbol, history);
      if (symbol === HOST) writeTable(coder, hosts, event.id);
      else if (symbol === SCHEME) writeTable(coder, scheme, event.id);
      else if (symbol < TYPES.length) {
        const type = TYPES[symbol],
          value = type.uuid ? event.data.replaceAll('-', '') : event.data;
        if (!type.uuid) {
          writeTable(
            coder,
            lengths[event.role][symbol],
            Math.min(256, value.length)
          );
          if (value.length >= 256)
            coder.write(value.length - 256, value.length - 255, 4096);
        }
        for (const c of value) {
          const n = type.alphabet.indexOf(c);
          coder.write(n, n + 1, type.alphabet.length);
        }
      }
      history = historyAfter(history, event, order);
    }
    return describe(coder.finish()).terminal.bytes;
  }
  function decodeBytes(bytes) {
    const coder = new ArithmeticDecoder(bytes),
      mirror = new ArithmeticEncoder(),
      out = [];
    let history = ppm.start,
      role = meta.authority !== false ? 0 : 0,
      schemeSlashes = 0,
      rawHost = null;
    function append(value, parse = true) {
      if (out.length + value.length > 4096)
        throw new RangeError('Skeleton output limit');
      for (const b of value) {
        out.push(b);
        if (!parse) continue;
        if (role === 0) {
          if (b === 47) schemeSlashes++;
          if (schemeSlashes === 2) role = 1;
        } else if (role < 5 && b === 35) role = 5;
        else if (role === 1 && b === 47) role = 2;
        else if ((role === 1 || role === 2) && b === 63) role = 3;
        else if (role === 3 && b === 61) role = 4;
        else if ((role === 3 || role === 4) && b === 38) role = 3;
      }
    }
    function uniform(total) {
      const n = coder.target(total);
      coder.consume(n, n + 1, total);
      mirror.write(n, n + 1, total);
      return n;
    }
    for (let steps = 0; steps <= 8192; steps++) {
      const symbol = ppm.symbol(coder, -1, history, mirror),
        event = { symbol };
      if (symbol === 256) {
        if (rawHost !== null) throw Error('Unterminated authority');
        const check = describe(mirror.finish()).terminal.bytes;
        if (
          check.length !== bytes.length ||
          check.some((b, i) => b !== bytes[i])
        )
          throw Error('Noncanonical skeleton stream');
        return Uint8Array.from(out);
      }
      if (rawHost !== null) {
        if (symbol === HOST_END) {
          event.after = reversed(rawHost);
          append(unbinary(event.after), false);
          rawHost = null;
        } else {
          if (symbol < 32 || symbol === 127 || rawHost.length >= 4096)
            throw Error('Invalid authority byte');
          rawHost += String.fromCharCode(symbol);
        }
      } else if (symbol === SCHEME) {
        if (out.length || meta.authority === false)
          throw Error('Invalid scheme position');
        event.after = schemeText(readTable(coder, scheme, mirror));
        append(unbinary(event.after));
        role = 1;
      } else if (symbol === HOST || symbol === HOST_RAW) {
        if (role !== 1 || meta.authority === false)
          throw Error('Invalid authority position');
        if (symbol === HOST) {
          event.after = meta.hosts[readTable(coder, hosts, mirror)];
          append(unbinary(event.after), false);
        } else rawHost = '';
      } else if (symbol < TYPES.length) {
        if (role < 2) throw Error('Invalid typed field position');
        const type = TYPES[symbol];
        let length = type.uuid
          ? 32
          : readTable(coder, lengths[role][symbol], mirror);
        if (!type.uuid && length === 256) length += uniform(4096);
        if (length < 1 || out.length + length > 4096)
          throw new RangeError('Typed field length');
        let value = '';
        for (let i = 0; i < length; i++)
          value += type.alphabet[uniform(type.alphabet.length)];
        if (type.uuid)
          value =
            value.slice(0, 8) +
            '-' +
            value.slice(8, 12) +
            '-' +
            value.slice(12, 16) +
            '-' +
            value.slice(16, 20) +
            '-' +
            value.slice(20);
        append(unbinary(value));
      } else {
        if (symbol < 32 || symbol === 127)
          throw Error('Unexpected skeleton control');
        append([symbol]);
      }
      history = historyAfter(history, event, order);
    }
    throw Error('Skeleton step limit');
  }
  return {
    encodeBytes,
    decodeBytes,
    contextModel: { order, escapeDivisor: contextModel.escapeDivisor },
    meta
  };
}
