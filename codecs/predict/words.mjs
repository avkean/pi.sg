import { readModel } from './models.mjs';
export function loadWords() {
  const words = [],
    frequencies = [];
  const text = readModel('models/predict-v1/words.tsv').toString('utf8').trim();
  let line = 0;
  while (line < text.length) {
    const tab = text.indexOf('\t', line),
      newline = text.indexOf('\n', tab);
    const end = newline < 0 ? text.length : newline;
    words.push(text.slice(line, tab));
    frequencies.push(Number(text.slice(tab + 1, end)));
    line = end + 1;
  }
  const cumulative = new Float64Array(words.length + 1);
  for (let i = 0; i < words.length; i++)
    cumulative[i + 1] = cumulative[i] + frequencies[i];
  const bytes = readModel('models/predict-v1/bigrams.bin');
  const data = new Uint32Array(
      bytes.buffer,
      bytes.byteOffset,
      bytes.length / 4
    ),
    offsets = new Uint32Array(words.length),
    lengths = new Uint32Array(words.length);
  let at = 1;
  for (let i = 0; i < words.length; i++) {
    const n = data[at++];
    offsets[i] = at;
    lengths[i] = n;
    let sum = 0;
    for (let j = 0; j < n; j++) {
      sum += data[at + 2 * j + 1];
      data[at + 2 * j + 1] = sum;
    }
    at += 2 * n;
  }
  function lower(key) {
    let l = 0,
      r = words.length;
    while (l < r) {
      const m = (l + r) >>> 1;
      if (words[m] < key) l = m + 1;
      else r = m;
    }
    return l;
  }
  function biMass(prev, lo, hi) {
    if (prev < 0 || !lengths[prev]) return 0;
    const off = offsets[prev],
      n = lengths[prev];
    function end(k) {
      let l = 0,
        r = n;
      while (l < r) {
        const m = (l + r) >>> 1;
        if (data[off + 2 * m] < k) l = m + 1;
        else r = m;
      }
      return l === 0 ? 0 : data[off + 2 * (l - 1) + 1];
    }
    return end(hi) - end(lo);
  }
  const cache = new Map(),
    scratch = new Float64Array(257);
  function node(prefix) {
    if (cache.has(prefix)) return cache.get(prefix);
    const lo = lower(prefix),
      hi = lower(prefix + '{');
    if (lo === hi) return null;
    const pairs = [];
    if (words[lo] === prefix) {
      pairs.push([256, lo, lo + 1, frequencies[lo]]);
    }
    for (let n = 0; n < 26; n++) {
      const a = lower(prefix + String.fromCharCode(97 + n)),
        b = lower(prefix + String.fromCharCode(98 + n));
      if (a < b) {
        const mass = cumulative[b] - cumulative[a];
        pairs.push([97 + n, a, b, mass]);
      }
    }
    if (cache.size > 2048) cache.clear();
    cache.set(prefix, pairs);
    return pairs;
  }
  function distribution(prefix, previous, beta = 1) {
    const n = node(prefix);
    if (!n) return null;
    const index = lower(previous);
    const prev = words[index] === previous ? index : -1,
      biTotal =
        prev < 0 || !lengths[prev]
          ? 0
          : data[offsets[prev] + 2 * (lengths[prev] - 1) + 1],
      alpha = prev < 0 ? 1 : lengths[prev] * 2 + 8;
    const unigramWeight = biTotal ? alpha / (biTotal + alpha) : 1;
    const global = cumulative.at(-1),
      biScale = biTotal ? beta / (biTotal + alpha) : 0,
      uniScale = unigramWeight / global;
    const d = scratch;
    d.fill(0);
    let sum = 0;
    for (const [s, lo, hi, mass] of n) {
      const v = mass * uniScale + biScale * biMass(prev, lo, hi);
      d[s] = v;
      sum += v;
    }
    for (const [s] of n) d[s] /= sum;
    return d;
  }
  return { distribution };
}
