export function createNeuralTails(model, base, budget) {
  const { ppm, probabilities } = base,
    prior = 0.5,
    share = 0.1;
  function initial(prefix) {
    let history = ppm.start;
    for (const b of prefix) history = ppm.advance(history, b);
    return { history, raw: Buffer.from(prefix).subarray(-48), mix: prior };
  }
  const cdfScratch = new Uint32Array(258),
    dScratch = new Float64Array(257);
  function distribution(state) {
    const base = probabilities(state.history),
      neural = model.predict(state.raw),
      cdf = cdfScratch,
      d = dScratch;
    let sum = 0;
    for (let s = 0; s < 257; s++) {
      d[s] = (1 - state.mix) * base[s] + state.mix * neural[s];
      cdf[s] = sum;
      sum += Math.max(1, Math.floor(d[s] * 65200));
    }
    cdf[257] = sum;
    return { cdf, total: sum, d, neural };
  }
  function advance(state, s, p) {
    state.mix =
      share * prior + (1 - share) * ((state.mix * p.neural[s]) / p.d[s]);
    state.history = ppm.advance(state.history, s);
    if (state.raw.length < 48)
      state.raw = Buffer.concat([state.raw, Buffer.of(s)]);
    else {
      state.raw.copyWithin(0, 1);
      state.raw[47] = s;
    }
  }
  function writeP(coder, bytes, prefix) {
    const state = initial(prefix);
    for (let i = 0; i <= bytes.length; i++) {
      if (budget && performance.now() > budget.expires)
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
      if (budget && performance.now() > budget.expires)
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
    throw Error('Raw neural output limit');
  }
  return { ppm, writeP, readP };
}
