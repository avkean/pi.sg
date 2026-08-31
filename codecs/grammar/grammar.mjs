// Generic lossless URL fields: scheme, raw authority, slash-separated path,
// ordered query keys/values, and fragment. No site list or destination lookup.
import {
  ArithmeticEncoder,
  ArithmeticDecoder,
  describe
} from '../compact/arithmetic.mjs';
import { createContext } from './context.mjs';

export const ROLES = [
  'scheme',
  'authority',
  'path',
  'key',
  'value',
  'fragment'
];
export const ALPHABETS = [
  null,
  '0123456789',
  '0123456789abcdef',
  '0123456789ABCDEF',
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
  '0123456789-._:+,'
];
export const DELIMITERS = [
  [],
  ['', '/', '?', '#'],
  ['', '/', '?', '#'],
  ['', '=', '&', '#'],
  ['', '&', '#'],
  ['']
];
const utf8 = new TextEncoder(),
  text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function fieldsOf(input) {
  const match = /^https?:\/\//i.exec(input);
  if (!match) throw Error('Expected absolute HTTP(S) URL');
  const out = [{ role: 0, value: match[0], separator: '' }];
  let role = 1,
    pos = match[0].length;
  while (true) {
    let end = pos;
    const delimiters =
      role === 1 || role === 2
        ? '/?#'
        : role === 3
          ? '=& #'.replace(' ', '')
          : role === 4
            ? '&#'
            : '';
    while (end < input.length && !delimiters.includes(input[end])) end++;
    const separator = input[end] ?? '';
    out.push({ role, value: input.slice(pos, end), separator });
    if (!separator) return out;
    role =
      separator === '/'
        ? 2
        : separator === '?' || separator === '&'
          ? 3
          : separator === '='
            ? 4
            : 5;
    pos = end + 1;
  }
}

export function normalize(counts, total = 32768) {
  const sum = counts.reduce((a, b) => a + b, 0);
  if (!sum || counts.length > total) throw Error('Invalid grammar counts');
  const frequencies = counts.map((n) =>
    n ? Math.max(1, Math.floor((n / sum) * (total - counts.length))) : 0
  );
  const used = frequencies.reduce((a, b) => a + b, 0),
    best = counts.indexOf(Math.max(...counts));
  frequencies[best] += total - used;
  return frequencies;
}
export function tableOf(frequencies) {
  const cumulative = new Uint32Array(frequencies.length + 1),
    costs = new Float64Array(frequencies.length);
  for (let i = 0; i < frequencies.length; i++)
    cumulative[i + 1] = cumulative[i] + frequencies[i];
  const total = cumulative.at(-1);
  for (let i = 0; i < frequencies.length; i++)
    costs[i] = frequencies[i] ? Math.log2(total / frequencies[i]) : Infinity;
  return { frequencies, cumulative, total, costs };
}
export function writeTable(coder, table, id) {
  if (!table.frequencies[id]) throw Error('Unsupported grammar symbol');
  coder.write(table.cumulative[id], table.cumulative[id + 1], table.total);
}
function readTable(coder, table, mirror) {
  const target = coder.target(table.total);
  let lo = 0,
    hi = table.frequencies.length;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (table.cumulative[mid] <= target) lo = mid;
    else hi = mid;
  }
  if (!table.frequencies[lo]) throw Error('Invalid grammar symbol');
  coder.consume(table.cumulative[lo], table.cumulative[lo + 1], table.total);
  mirror.write(table.cumulative[lo], table.cumulative[lo + 1], table.total);
  return lo;
}
const binary = (bytes) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
};
export function createGrammar(model, contextModel) {
  const ppm = createContext(contextModel);
  const dictionaries = model.dictionaries.map(
    (words) => new Map(words.map((s, id) => [s, id]))
  );
  const types = model.types.map(tableOf),
    lengths = model.lengths.map((rows) => rows.map(tableOf)),
    transitions = model.transitions.map((row) =>
      row.length ? tableOf(row) : null
    );
  const reverses = ALPHABETS.map(
    (alphabet) =>
      alphabet &&
      Int16Array.from({ length: 256 }, (_, n) =>
        alphabet.indexOf(String.fromCharCode(n))
      )
  );
  function rawCost(bytes, history) {
    let cost = 0;
    const counter = {
      write: (lo, hi, total) => {
        cost += Math.log2(total / (hi - lo));
      }
    };
    for (const b of bytes) {
      ppm.symbol(counter, b, history);
      history = ppm.advance(history, b);
    }
    return cost;
  }
  function plan(role, bytes, history, ppmCost = null) {
    const word = binary(bytes),
      dict = dictionaries[role],
      table = types[role],
      base = dict.size;
    const found = dict.get(word);
    let id = found ?? -1,
      cost = found === undefined ? Infinity : table.costs[found],
      mode = -1;
    const lengthId = Math.min(256, bytes.length),
      extra = bytes.length >= 256 ? 12 : 0;
    for (let m = 0; m < ALPHABETS.length; m++) {
      const reverse = reverses[m];
      if (reverse && bytes.some((b) => reverse[b] < 0)) continue;
      const dataCost = m
        ? bytes.length * Math.log2(ALPHABETS[m].length)
        : (ppmCost ?? rawCost(bytes, history));
      const estimate =
        table.costs[base + m] +
        lengths[role][m].costs[lengthId] +
        extra +
        dataCost;
      if (estimate < cost) {
        cost = estimate;
        id = base + m;
        mode = m;
      }
    }
    if (id < 0 || !Number.isFinite(cost))
      throw Error('No grammar field encoding');
    return { id, mode, cost };
  }
  function encodeBytes(bytes, { observe = null, cachedFields = null } = {}) {
    if (!(bytes instanceof Uint8Array) || bytes.length > 4096)
      throw new RangeError('Grammar byte limit');
    const input = text.decode(bytes),
      fields = cachedFields ?? fieldsOf(input),
      coder = new ArithmeticEncoder();
    let history = ppm.start;
    for (const field of fields) {
      const data = field.bytes ?? utf8.encode(field.value),
        { role, separator } = field;
      const choice = plan(role, data, history, field.ppmCost ?? null);
      observe?.(field, choice);
      writeTable(coder, types[role], choice.id);
      if (choice.mode >= 0) {
        writeTable(
          coder,
          lengths[role][choice.mode],
          Math.min(256, data.length)
        );
        if (data.length >= 256)
          coder.write(data.length - 256, data.length - 255, 4096);
        if (choice.mode) {
          const alphabet = ALPHABETS[choice.mode],
            reverse = reverses[choice.mode];
          for (const b of data)
            coder.write(reverse[b], reverse[b] + 1, alphabet.length);
          for (const b of data) history = ppm.advance(history, b);
        } else
          for (const b of data) {
            ppm.symbol(coder, b, history);
            history = ppm.advance(history, b);
          }
      } else for (const b of data) history = ppm.advance(history, b);
      if (role > 0 && role < 5)
        writeTable(
          coder,
          transitions[role],
          DELIMITERS[role].indexOf(separator)
        );
      if (separator) history = ppm.advance(history, separator.charCodeAt(0));
    }
    return describe(coder.finish()).terminal.bytes;
  }
  function decodeBytes(bytes) {
    const coder = new ArithmeticDecoder(bytes),
      mirror = new ArithmeticEncoder(),
      out = new Uint8Array(4096);
    let size = 0,
      role = 0,
      history = ppm.start;
    function add(b) {
      if (size >= out.length) throw new RangeError('Grammar output limit');
      out[size++] = b;
      history = ppm.advance(history, b);
    }
    function uniform(total) {
      const n = coder.target(total);
      coder.consume(n, n + 1, total);
      mirror.write(n, n + 1, total);
      return n;
    }
    for (let steps = 0; steps <= 4098; steps++) {
      const id = readTable(coder, types[role], mirror),
        dict = model.dictionaries[role];
      if (id < dict.length)
        for (const char of dict[id]) add(char.charCodeAt(0));
      else {
        const mode = id - dict.length;
        let length = readTable(coder, lengths[role][mode], mirror);
        if (length === 256) length += uniform(4096);
        if (size + length > 4096) throw new RangeError('Grammar field limit');
        for (let i = 0; i < length; i++) {
          const b = mode
            ? ALPHABETS[mode].charCodeAt(uniform(ALPHABETS[mode].length))
            : ppm.symbol(coder, -1, history, mirror);
          if (b > 255) throw Error('Unexpected PPM end in field');
          add(b);
        }
      }
      if (role === 0) {
        role = 1;
        continue;
      }
      const separator =
        role === 5
          ? ''
          : DELIMITERS[role][readTable(coder, transitions[role], mirror)];
      if (!separator) {
        const check = describe(mirror.finish()).terminal.bytes;
        if (
          check.length !== bytes.length ||
          check.some((b, i) => b !== bytes[i])
        )
          throw Error('Noncanonical grammar stream');
        return out.slice(0, size);
      }
      add(separator.charCodeAt(0));
      role =
        separator === '/'
          ? 2
          : separator === '?' || separator === '&'
            ? 3
            : separator === '='
              ? 4
              : 5;
    }
    throw Error('Too many grammar fields');
  }
  return { encodeBytes, decodeBytes, plan, rawCost, ppm, model };
}
