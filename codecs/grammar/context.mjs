// Static PPM using the released model and arithmetic interval rules.
import {
  ArithmeticEncoder,
  ArithmeticDecoder,
  describe
} from '../compact/arithmetic.mjs';

export function createContext(model) {
  // Keep frequencies in one external typed buffer, rather than tens of
  // thousands of retained boxed JS frequency arrays.
  const tables = new Map(),
    offsets = new Uint32Array(model.tables.length + 1),
    order = model.order;
  for (let i = 0; i < model.tables.length; i++) {
    tables.set(model.tables[i][0], i);
    offsets[i + 1] = offsets[i] + model.tables[i][1].length;
  }
  const data = new Uint16Array(offsets.at(-1));
  for (let i = 0; i < model.tables.length; i++)
    data.set(model.tables[i][1], offsets[i]);
  const start = '\u0100'.repeat(order);
  const divisor = model.escapeDivisor ?? 1;
  const excluded = new Uint32Array(257);
  let generation = 0;
  function symbol(coder, value, history, mirror = null) {
    const mark = ++generation;
    if (generation >= 0xfffffff0) {
      excluded.fill(0);
      generation = 0;
    }
    const reading = value < 0;
    const take = (lo, hi, total) => {
      if (reading) {
        coder.consume(lo, hi, total);
        mirror?.write(lo, hi, total);
      } else coder.write(lo, hi, total);
    };
    for (let n = order; n >= 0; n--) {
      const rowId = tables.get(n ? history.slice(-n) : '');
      if (rowId === undefined) continue;
      const from = offsets[rowId],
        end = offsets[rowId + 1],
        row = data;
      let total = 0,
        types = 0,
        low = -1,
        high = -1;
      for (let i = from; i < end; i += 2)
        if (excluded[row[i]] !== mark) {
          if (row[i] === value) {
            low = total;
            high = total + row[i + 1];
          }
          total += row[i + 1];
          types++;
        }
      if (!types) continue;
      const escape = Math.max(1, Math.ceil(types / divisor)),
        sum = total + escape;
      if (reading) {
        const target = coder.target(sum);
        if (target < total) {
          let before = 0;
          for (let i = from; i < end; i += 2)
            if (excluded[row[i]] !== mark) {
              const after = before + row[i + 1];
              if (target < after) {
                take(before, after, sum);
                return row[i];
              }
              before = after;
            }
          throw Error('Invalid context symbol');
        }
      } else if (low >= 0) {
        take(low, high, sum);
        return value;
      }
      take(total, sum, sum);
      for (let i = from; i < end; i += 2) excluded[row[i]] = mark;
    }
    let total = 0,
      rank = 0;
    for (let i = 0; i <= 256; i++)
      if (excluded[i] !== mark) {
        if (i < value) rank++;
        total++;
      }
    if (!total) throw Error('Exhausted context alphabet');
    if (reading) {
      const target = coder.target(total);
      for (let i = 0; i <= 256; i++)
        if (excluded[i] !== mark) {
          if (rank === target) {
            take(rank, rank + 1, total);
            return i;
          }
          rank++;
        }
      throw Error('Invalid context literal');
    }
    if (excluded[value] === mark) throw Error('Excluded literal');
    take(rank, rank + 1, total);
    return value;
  }
  const advance = (history, b) =>
    (history + String.fromCharCode(b)).slice(-order);
  function encodeBytes(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length > 4096)
      throw new RangeError('Context byte limit');
    const coder = new ArithmeticEncoder();
    let h = start;
    for (let i = 0; i <= bytes.length; i++) {
      const s = i === bytes.length ? 256 : bytes[i];
      symbol(coder, s, h);
      h = advance(h, s);
    }
    return describe(coder.finish()).terminal.bytes;
  }
  function decodeBytes(bytes) {
    const coder = new ArithmeticDecoder(bytes),
      mirror = new ArithmeticEncoder(),
      out = [];
    let h = start;
    for (let i = 0; i <= 4096; i++) {
      const s = symbol(coder, -1, h, mirror);
      if (s === 256) {
        const check = describe(mirror.finish()).terminal.bytes;
        if (
          check.length !== bytes.length ||
          check.some((b, j) => b !== bytes[j])
        )
          throw Error('Noncanonical context stream');
        return Uint8Array.from(out);
      }
      out.push(s);
      h = advance(h, s);
    }
    throw new RangeError('Decoded context byte limit');
  }
  return {
    encodeBytes,
    decodeBytes,
    symbol,
    start,
    advance,
    model: { order, escapeDivisor: divisor, contexts: tables.size }
  };
}
