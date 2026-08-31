// Pi v1 tokenization/model unchanged. Decoder canonical mode is selectable per call.
import { ArithmeticEncoder, ArithmeticDecoder } from './arithmetic.mjs';
import {
  CONTEXT_COUNT,
  byteContexts,
  initialState,
  context,
  advance
} from '../core/subword/structure.mjs';
import {
  makeSpecials,
  runsAt,
  writeLiteral,
  readLiteral
} from '../core/subword/literals.mjs';

export const FORMAT = 'pi-subword-arithmetic-2';
export const MAX_INPUT_BYTES = 65536;
const TOTAL = 65536;
const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export const toBytes = (text) => {
  if (typeof text !== 'string') throw new TypeError('Expected string');
  // Check before UTF-8 allocation or Unicode scanning. A UTF-16 code-unit cap is
  // only an early rejection; encodeBytes also enforces the actual UTF-8 cap.
  if (text.length > MAX_INPUT_BYTES)
    throw new RangeError('Input exceeds character limit');
  // Reject unpaired surrogates rather than silently replace with U+FFFD.
  if (
    text.isWellFormed
      ? !text.isWellFormed()
      : /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
          text
        )
  )
    throw new TypeError('Input is not well-formed Unicode');
  return utf8.encode(text);
};
export function binary(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}
export const unbinary = (text) => Uint8Array.from(text, (c) => c.charCodeAt(0));

export function buildTrie(tokens) {
  const nodes = [{ next: new Map(), id: -1 }];
  for (let id = 0; id < tokens.length; id++) {
    let node = 0;
    for (const byte of tokens[id]) {
      let next = nodes[node].next.get(byte);
      if (next === undefined) {
        next = nodes.length;
        nodes[node].next.set(byte, next);
        nodes.push({ next: new Map(), id: -1 });
      }
      node = next;
    }
    if (nodes[node].id !== -1) throw new Error('Duplicate vocabulary token');
    nodes[node].id = id;
  }
  return nodes;
}

export function createCodec(
  model,
  { maxInputBytes = MAX_INPUT_BYTES, canonical = true } = {}
) {
  if (
    ![FORMAT, 'pi-subword-arithmetic-1'].includes(model.format) ||
    model.total !== TOTAL ||
    model.contexts !== CONTEXT_COUNT
  )
    throw new Error('Unsupported subword model');
  if (
    !Number.isInteger(maxInputBytes) ||
    maxInputBytes < 0 ||
    maxInputBytes > MAX_INPUT_BYTES
  )
    throw new RangeError('Input limit');
  const tokens = model.tokens.map(unbinary),
    specials = makeSpecials(model.specials),
    eof = tokens.length,
    count = eof + 1 + specials.length;
  if (count < 257 || count > 20000) throw new Error('Vocabulary size limit');
  for (let i = 0; i < 256; i++)
    if (tokens[i].length !== 1 || tokens[i][0] !== i)
      throw new Error('Invalid byte fallback');
  if (tokens.some((t) => !t.length || t.length > 128))
    throw new Error('Token length limit');
  if (model.frequencies.length !== CONTEXT_COUNT)
    throw new Error('Context table mismatch');
  const trie = buildTrie(tokens);
  const tables = model.frequencies.map((row) => {
    if (row.length !== count) throw new Error('Frequency table length');
    const cumulative = new Uint32Array(count + 1),
      lookup = new Uint16Array(TOTAL),
      costs = new Float64Array(count);
    for (let id = 0; id < count; id++) {
      const f = row[id];
      if (
        !Number.isInteger(f) ||
        f < 0 ||
        f > TOTAL ||
        ((id < 256 || id === eof) && f === 0)
      )
        throw new Error('Invalid model frequency');
      cumulative[id + 1] = cumulative[id] + f;
      if (cumulative[id + 1] > TOTAL) throw new Error('Frequency overflow');
      lookup.fill(id, cumulative[id], cumulative[id + 1]);
      costs[id] = f ? Math.log2(TOTAL / f) : Infinity;
    }
    if (cumulative[count] !== TOTAL)
      throw new Error('Frequency total mismatch');
    return { cumulative, lookup, costs, frequency: Uint32Array.from(row) };
  });
  function tokenize(bytes, strategy = 'dp') {
    if (!(bytes instanceof Uint8Array))
      throw new TypeError('Expected Uint8Array');
    if (bytes.length > maxInputBytes)
      throw new RangeError('Input exceeds byte limit');
    if (strategy !== 'dp' && strategy !== 'greedy')
      throw new Error('Unknown tokenizer');
    const ctx = byteContexts(bytes),
      ids = [],
      positions = [],
      lengths = [];
    const runs = runsAt(bytes, specials);
    const choices = new Uint16Array(bytes.length);
    const chosenLengths = new Uint16Array(bytes.length);
    if (strategy === 'dp') {
      const best = new Float64Array(bytes.length + 1);
      best[bytes.length] = tables[ctx[bytes.length]].costs[eof];
      for (let i = bytes.length - 1; i >= 0; i--) {
        const costs = tables[ctx[i]].costs;
        let bestCost = costs[bytes[i]] + best[i + 1],
          bestId = bytes[i],
          bestLength = 1,
          node = 0;
        for (let j = i; j < bytes.length && j < i + 128; j++) {
          const next = trie[node].next.get(bytes[j]);
          if (next === undefined) break;
          node = next;
          const id = trie[node].id;
          if (id < 0) continue;
          const c = costs[id] + best[j + 1];
          if (
            c < bestCost - 1e-10 ||
            (Math.abs(c - bestCost) <= 1e-10 && id < bestId)
          ) {
            bestCost = c;
            bestId = id;
            bestLength = j + 1 - i;
          }
        }
        for (let s = 0; s < specials.length; s++) {
          const special = specials[s],
            id = eof + 1 + s,
            run = runs[s][i];
          if (!Number.isFinite(costs[id]) || run < special.minimum) continue;
          const max = Math.min(64, run);
          for (let len = special.minimum; len <= max; len++) {
            const c = costs[id] + special.costs[len] + best[i + len];
            if (c < bestCost - 1e-10) {
              bestCost = c;
              bestId = id;
              bestLength = len;
            }
          }
          if (run > max) {
            const c = costs[id] + special.costs[run] + best[i + run];
            if (c < bestCost - 1e-10) {
              bestCost = c;
              bestId = id;
              bestLength = run;
            }
          }
        }
        choices[i] = bestId;
        chosenLengths[i] = bestLength;
        best[i] = bestCost;
      }
    }
    for (let i = 0; i < bytes.length; ) {
      let id = choices[i],
        length = chosenLengths[i];
      if (strategy === 'greedy') {
        let node = 0;
        id = bytes[i];
        for (let j = i; j < bytes.length && j < i + 128; j++) {
          const next = trie[node].next.get(bytes[j]);
          if (next === undefined) break;
          node = next;
          const match = trie[node].id;
          if (match >= 0 && tables[ctx[i]].frequency[match]) id = match;
        }
        length = tokens[id].length;
        // Greedy ablation: longest byte piece, with literal run only when it is
        // longer and has a lower average estimated cost than that first piece.
        for (let s = 0; s < specials.length; s++) {
          const run = runs[s][i],
            sid = eof + 1 + s;
          if (
            run >= specials[s].minimum &&
            run > length &&
            (tables[ctx[i]].costs[sid] + specials[s].costs[run]) / run <
              tables[ctx[i]].costs[id] / length
          ) {
            id = sid;
            length = run;
          }
        }
      }
      ids.push(id);
      positions.push(i);
      lengths.push(length);
      i += length;
    }
    ids.push(eof);
    positions.push(bytes.length);
    lengths.push(0);
    return { ids, positions, lengths, contexts: positions.map((i) => ctx[i]) };
  }
  function encodeSymbols(ids, contexts, bytes, positions, lengths) {
    const encoder = new ArithmeticEncoder();
    for (let i = 0; i < ids.length; i++) {
      const table = tables[contexts[i]],
        id = ids[i];
      encoder.put(table.cumulative[id], table.frequency[id]);
      if (id > eof)
        writeLiteral(
          encoder,
          specials[id - eof - 1],
          bytes,
          positions[i],
          lengths[i]
        );
    }
    return encoder.finish();
  }
  function encodeBytes(bytes, { strategy = 'dp' } = {}) {
    const { ids, contexts, positions, lengths } = tokenize(bytes, strategy);
    return encodeSymbols(ids, contexts, bytes, positions, lengths);
  }
  function decodeBytes(payload, { canonicalCheck = canonical } = {}) {
    if (!(payload instanceof Uint8Array))
      throw new TypeError('Expected Uint8Array');
    if (payload.length > maxInputBytes * 3 + 16)
      throw new RangeError('Payload exceeds byte limit');
    const decoder = new ArithmeticDecoder(payload),
      state = initialState();
    const out = new Uint8Array(maxInputBytes),
      mirror = canonicalCheck ? new ArithmeticEncoder() : null;
    let pos = 0;
    for (let steps = 0; steps <= maxInputBytes; steps++) {
      const ctx = context(state),
        table = tables[ctx];
      const id = table.lookup[decoder.scaled()];
      decoder.take(table.cumulative[id], table.frequency[id]);
      mirror?.put(table.cumulative[id], table.frequency[id]);
      if (id === eof) {
        if (canonicalCheck) {
          const check = mirror.finish();
          if (
            check.length !== payload.length ||
            check.some((b, i) => b !== payload[i])
          )
            throw new Error('Noncanonical or truncated arithmetic stream');
        }
        return out.slice(0, pos);
      }
      const token =
        id > eof
          ? readLiteral(
              decoder,
              mirror,
              specials[id - eof - 1],
              maxInputBytes - pos
            )
          : tokens[id];
      if (pos + token.length > maxInputBytes)
        throw new RangeError('Decoded output exceeds byte limit');
      out.set(token, pos);
      pos += token.length;
      advance(state, token);
    }
    throw new Error('Missing end marker');
  }
  return Object.freeze({
    format: model.format,
    modelHash: model.sha256 ?? null,
    tokens,
    tables,
    specials,
    tokenize,
    encodeBytes,
    decodeBytes,
    encode: (input, options) => encodeBytes(toBytes(input), options),
    decode: (payload) => utf8Decoder.decode(decodeBytes(payload))
  });
}
