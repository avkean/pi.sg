import { createContext } from '../grammar/context.mjs';
export function createLanguageTails(contextModel, language, rich, budget) {
  const prior = 0.5,
    beta = 0.5,
    ppm = createContext(contextModel);
  const escapeDivisor = contextModel.escapeDivisor;
  const tables = new Map(),
    offsets = new Uint32Array(contextModel.tables.length + 1),
    cache = new Map();
  for (let i = 0; i < contextModel.tables.length; i++) {
    tables.set(contextModel.tables[i][0], i);
    offsets[i + 1] = offsets[i] + contextModel.tables[i][1].length;
  }
  const counts = new Uint32Array(offsets.at(-1));
  for (let i = 0; i < contextModel.tables.length; i++)
    counts.set(contextModel.tables[i][1], offsets[i]);
  function probabilities(history) {
    while (history && !tables.has(history)) history = history.slice(1);
    if (cache.has(history)) return cache.get(history);
    const d = new Float64Array(257),
      excluded = new Uint8Array(257);
    let weight = 1;
    for (let o = history.length; o >= 0; o--) {
      const row = tables.get(o ? history.slice(-o) : '');
      if (row === undefined) continue;
      const start = offsets[row],
        end = offsets[row + 1];
      let total = 0,
        types = 0;
      for (let i = start; i < end; i += 2)
        if (!excluded[counts[i]]) {
          total += counts[i + 1];
          types++;
        }
      if (!types) continue;
      const escape = Math.max(1, Math.ceil(types / escapeDivisor));
      for (let i = start; i < end; i += 2)
        if (!excluded[counts[i]]) {
          d[counts[i]] = (weight * counts[i + 1]) / (total + escape);
          excluded[counts[i]] = 1;
        }
      weight *= escape / (total + escape);
    }
    let n = 0;
    for (let i = 0; i < 257; i++) if (!excluded[i]) n++;
    for (let i = 0; i < 257; i++) if (!excluded[i]) d[i] = weight / n;
    if (cache.size > 512) cache.clear();
    cache.set(history, d);
    return d;
  }
  function initial(prefix) {
    let history = ppm.start;
    for (const b of prefix) history = ppm.advance(history, b);
    return {
      history,
      word: '',
      previous: '',
      raw: Buffer.from(prefix).subarray(-8),
      oldMix: 0.5,
      mix: prior
    };
  }
  const baseScratch = new Float64Array(257),
    dScratch = new Float64Array(257),
    freqScratch = new Uint32Array(258);
  function distribution(state) {
    const old = probabilities(state.history),
      fresh = rich.predict(state.raw),
      base = baseScratch,
      words = language.distribution(state.word, state.previous, beta),
      d = dScratch;
    for (let s = 0; s < 257; s++)
      base[s] = state.oldMix * old[s] + (1 - state.oldMix) * fresh[s];
    let letterMass = 0;
    for (let s = 97; s <= 122; s++) letterMass += base[s] + base[s - 32];
    const boundary = 1 - letterMass,
      mix = words ? state.mix : 0;
    if (words) {
      for (let s = 0; s < 257; s++) {
        const letter = s >= 65 && s <= 90 ? s + 32 : s,
          isLetter = letter >= 97 && letter <= 122;
        const q = isLetter
          ? (words[letter] * (state.word ? 1 : letterMass) * base[s]) /
            (base[letter] + base[letter - 32])
          : base[s] * (state.word ? words[256] / boundary : 1);
        d[s] = (1 - mix) * base[s] + mix * q;
      }
    } else d.set(base);
    const freq = freqScratch;
    let sum = 0;
    for (let s = 0; s < 257; s++) {
      freq[s] = sum;
      sum += Math.max(1, Math.floor(d[s] * 65200));
    }
    freq[257] = sum;
    return { cdf: freq, total: sum, d, base, mix, old };
  }
  function advance(state, s, p) {
    state.oldMix = 0.01 + (0.98 * state.oldMix * p.old[s]) / p.base[s];
    if (state.raw.length < 8)
      state.raw = Buffer.concat([state.raw, Buffer.of(s)]);
    else {
      state.raw.copyWithin(0, 1);
      state.raw[7] = s;
    }
    if ((s >= 97 && s <= 122) || (s >= 65 && s <= 90)) {
      const lower = s >= 65 && s <= 90 ? s + 32 : s;
      const posterior = p.d[s] > 0 ? 1 - ((1 - p.mix) * p.base[s]) / p.d[s] : 0;
      state.mix = Math.max(0, Math.min(1, posterior));
      state.word += String.fromCharCode(lower);
    } else {
      if (state.word) {
        state.previous = state.word;
      }
      if (s !== 45 && s !== 95 && s !== 32 && s !== 47) state.previous = '';
      state.word = '';
      state.mix = prior;
    }
    state.history = ppm.advance(state.history, s);
  }
  function writeP(coder, bytes, prefix) {
    const state = initial(prefix);
    for (let i = 0; i <= bytes.length; i++) {
      if (i % 8 === 0 && performance.now() > budget.expires)
        throw Error('Prediction time budget');
      const s = i === bytes.length ? 256 : bytes[i],
        p = distribution(state);
      coder.write(p.cdf[s], p.cdf[s + 1], p.total);
      advance(state, s, p);
    }
  }
  function readP(coder, mirror, prefix, limit) {
    const state = initial(prefix),
      out = [];
    for (let i = 0; i <= limit; i++) {
      if (i % 8 === 0 && performance.now() > budget.expires)
        throw Error('Prediction time budget');
      const p = distribution(state),
        target = coder.target(p.total);
      let lo = 0,
        hi = 257;
      while (lo + 1 < hi) {
        const m = (lo + hi) >>> 1;
        if (p.cdf[m] <= target) lo = m;
        else hi = m;
      }
      coder.consume(p.cdf[lo], p.cdf[lo + 1], p.total);
      mirror.write(p.cdf[lo], p.cdf[lo + 1], p.total);
      if (lo === 256) return Uint8Array.from(out);
      out.push(lo);
      advance(state, lo, p);
    }
    throw Error('Language output limit');
  }
  return { ppm, probabilities, writeP, readP };
}
