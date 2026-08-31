// Reuse frozen P/S probabilities for the suffix, starting with the actual
// already-decoded authority state. No per-position P/S mixture is introduced.
import { createContext } from './context.mjs';
import {
  createCodec as createSubword,
  buildTrie
} from '../core/subword/codec.mjs';
import {
  byteContexts,
  initialState,
  context,
  advance
} from '../core/subword/structure.mjs';
import {
  runsAt,
  writeLiteral,
  readLiteral
} from '../core/subword/literals.mjs';

export function createTails(contextModel, subwordModel) {
  // Do not retain the full old codec's closure/trie as well as our suffix trie.
  const { tokens, tables, specials } = createSubword(subwordModel, {
    maxInputBytes: 4096
  });
  const ppm = createContext(contextModel),
    sub = { tokens, tables, specials },
    trie = buildTrie(tokens),
    eof = tokens.length;
  function historyFor(prefix) {
    let h = ppm.start;
    for (const b of prefix) h = ppm.advance(h, b);
    return h;
  }
  function planSubword(bytes, prefix) {
    const combined = new Uint8Array(prefix.length + bytes.length);
    combined.set(prefix);
    combined.set(bytes, prefix.length);
    const contexts = byteContexts(combined).subarray(prefix.length),
      runs = runsAt(bytes, sub.specials);
    const costs = new Float64Array(bytes.length + 1),
      ids = new Uint16Array(bytes.length + 1),
      lengths = new Uint16Array(bytes.length + 1);
    costs[bytes.length] = sub.tables[contexts[bytes.length]].costs[eof];
    ids[bytes.length] = eof;
    for (let i = bytes.length - 1; i >= 0; i--) {
      const table = sub.tables[contexts[i]];
      let best = table.costs[bytes[i]] + costs[i + 1],
        id = bytes[i],
        length = 1,
        node = 0;
      for (let j = i; j < bytes.length && j < i + 128; j++) {
        const next = trie[node].next.get(bytes[j]);
        if (next === undefined) break;
        node = next;
        const candidate = trie[node].id;
        if (candidate < 0) continue;
        const c = table.costs[candidate] + costs[j + 1];
        if (
          c < best - 1e-10 ||
          (Math.abs(c - best) <= 1e-10 && candidate < id)
        ) {
          best = c;
          id = candidate;
          length = j + 1 - i;
        }
      }
      for (let si = 0; si < sub.specials.length; si++) {
        const special = sub.specials[si],
          sid = eof + 1 + si,
          run = runs[si][i];
        if (run < special.minimum || !Number.isFinite(table.costs[sid]))
          continue;
        for (let n = special.minimum; n <= Math.min(run, 64); n++) {
          const c = table.costs[sid] + special.costs[n] + costs[i + n];
          if (c < best - 1e-10) {
            best = c;
            id = sid;
            length = n;
          }
        }
        if (run > 64) {
          const c = table.costs[sid] + special.costs[run] + costs[i + run];
          if (c < best - 1e-10) {
            best = c;
            id = sid;
            length = run;
          }
        }
      }
      costs[i] = best;
      ids[i] = id;
      lengths[i] = length;
    }
    return { contexts, ids, lengths, cost: costs[0] };
  }
  function writeP(coder, bytes, prefix) {
    let h = historyFor(prefix);
    for (let i = 0; i <= bytes.length; i++) {
      const s = i === bytes.length ? 256 : bytes[i];
      ppm.symbol(coder, s, h);
      h = ppm.advance(h, s);
    }
  }
  function writeS(coder, bytes, prefix, plan = planSubword(bytes, prefix)) {
    for (let i = 0; i <= bytes.length; ) {
      const id = plan.ids[i],
        table = sub.tables[plan.contexts[i]];
      coder.put(table.cumulative[id], table.frequency[id]);
      if (id === eof) return;
      if (id > eof)
        writeLiteral(
          coder,
          sub.specials[id - eof - 1],
          bytes,
          i,
          plan.lengths[i]
        );
      i += plan.lengths[i];
    }
  }
  function readP(coder, mirror, prefix, limit) {
    const out = [];
    let history = historyFor(prefix);
    for (let i = 0; i <= limit; i++) {
      const s = ppm.symbol(coder, -1, history, mirror);
      if (s === 256) return Uint8Array.from(out);
      out.push(s);
      history = ppm.advance(history, s);
    }
    throw new RangeError('P suffix output limit');
  }
  function readS(coder, mirror, prefix, limit) {
    const state = initialState();
    advance(state, prefix);
    const out = new Uint8Array(limit),
      reader = {
        scaled: (total) => coder.target(total ?? 65536),
        take: (lo, freq, total = 65536) => coder.consume(lo, lo + freq, total)
      };
    let pos = 0;
    for (let steps = 0; steps <= limit; steps++) {
      const table = sub.tables[context(state)],
        id = table.lookup[coder.target(65536)];
      coder.consume(table.cumulative[id], table.cumulative[id + 1], 65536);
      mirror.put(table.cumulative[id], table.frequency[id]);
      if (id === eof) return out.slice(0, pos);
      const token =
        id > eof
          ? readLiteral(reader, mirror, sub.specials[id - eof - 1], limit - pos)
          : sub.tokens[id];
      if (pos + token.length > limit)
        throw new RangeError('S suffix output limit');
      out.set(token, pos);
      pos += token.length;
      advance(state, token);
    }
    throw Error('Missing S suffix end');
  }
  return { ppm, planSubword, writeP, writeS, readP, readS };
}
