import { ArithmeticEncoder, ArithmeticDecoder } from './arithmetic.mjs';
const END = 256;
export function createCodec(model) {
  const tables = new Map(model.tables),
    start = '\u0100'.repeat(model.order);
  const encodeText = new TextEncoder(),
    decodeText = new TextDecoder('utf-8', { fatal: true });
  function distribution(key, excluded) {
    const raw = tables.get(key);
    if (!raw) return null;
    const out = [];
    let total = 0;
    for (let i = 0; i < raw.length; i += 2) {
      const s = raw[i];
      if (!excluded[s]) {
        const n = raw[i + 1];
        out.push([s, total, total + n]);
        total += n;
      }
    }
    if (!out.length) return null;
    const escape = Math.max(1, Math.ceil(out.length / model.escapeDivisor));
    return { out, escape: total, total: total + escape };
  }
  function writeSymbol(coder, symbol, history) {
    const excluded = new Uint8Array(257);
    for (let order = model.order; order >= 0; order--) {
      const key = order ? history.slice(-order) : '',
        d = distribution(key, excluded);
      if (!d) continue;
      const hit = d.out.find((x) => x[0] === symbol);
      if (hit) {
        coder.write(hit[1], hit[2], d.total);
        return;
      }
      coder.write(d.escape, d.total, d.total);
      for (const [s] of d.out) excluded[s] = 1;
    }
    let rank = 0,
      total = 0;
    for (let i = 0; i <= END; i++)
      if (!excluded[i]) {
        if (i < symbol) rank++;
        total++;
      }
    if (excluded[symbol] || !total) throw Error('Excluded literal');
    coder.write(rank, rank + 1, total);
  }
  function readSymbol(coder, history) {
    const excluded = new Uint8Array(257);
    for (let order = model.order; order >= 0; order--) {
      const key = order ? history.slice(-order) : '',
        d = distribution(key, excluded);
      if (!d) continue;
      const target = coder.target(d.total);
      if (target < 0 || target >= d.total)
        throw Error('Invalid arithmetic state');
      for (const [s, lo, hi] of d.out)
        if (target < hi) {
          coder.consume(lo, hi, d.total);
          return s;
        }
      coder.consume(d.escape, d.total, d.total);
      for (const [s] of d.out) excluded[s] = 1;
    }
    let total = 0;
    for (let i = 0; i <= END; i++) if (!excluded[i]) total++;
    if (!total) throw Error('Exhausted alphabet');
    const rank = coder.target(total);
    let index = 0;
    for (let i = 0; i <= END; i++)
      if (!excluded[i]) {
        if (index === rank) {
          coder.consume(rank, rank + 1, total);
          return i;
        }
        index++;
      }
    throw Error('Invalid literal rank');
  }
  function encode(input) {
    const bytes = encodeText.encode(input);
    if (decodeText.decode(bytes) !== input)
      throw Error('Input not exact UTF-8');
    const coder = new ArithmeticEncoder();
    let history = start;
    for (const symbol of bytes) {
      writeSymbol(coder, symbol, history);
      history = (history + String.fromCharCode(symbol)).slice(-model.order);
    }
    writeSymbol(coder, END, history);
    return coder.finish();
  }
  function decode(bytes, { maxBytes = 131072 } = {}) {
    const coder = new ArithmeticDecoder(bytes),
      out = [];
    let history = start;
    while (true) {
      const symbol = readSymbol(coder, history);
      if (symbol === END) return decodeText.decode(Uint8Array.from(out));
      if (out.length >= maxBytes) throw Error('Decoded URL exceeds limit');
      out.push(symbol);
      history = (history + String.fromCharCode(symbol)).slice(-model.order);
    }
  }
  return { encode, decode, model };
}
