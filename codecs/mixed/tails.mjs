import { createContext } from '../grammar/context.mjs';
import { checkPredictionDeadline } from '../predict/deadline.mjs';
import {
  advanceCategorical,
  categoricalValues,
  createCategoricalState
} from './categorical.mjs';

const EOS = 256;
const SCALE = 65200;
function append(raw, symbol, limit) {
  if (raw.length < limit) return Buffer.concat([raw, Buffer.of(symbol)]);
  raw.copyWithin(0, 1);
  raw[limit - 1] = symbol;
  return raw;
}

export function createMixedTails(
  contextModel,
  words,
  rich,
  neuralModel,
  budget,
  gates
) {
  const ppm = createContext(contextModel);
  const tables = new Map();
  const offsets = new Uint32Array(contextModel.tables.length + 1);
  for (let index = 0; index < contextModel.tables.length; index++) {
    tables.set(contextModel.tables[index][0], index);
    offsets[index + 1] = offsets[index] + contextModel.tables[index][1].length;
  }
  const counts = new Uint32Array(offsets.at(-1));
  for (let index = 0; index < contextModel.tables.length; index++)
    counts.set(contextModel.tables[index][1], offsets[index]);
  const cache = new Map();

  function ppmProbabilities(history) {
    while (history && !tables.has(history)) history = history.slice(1);
    if (cache.has(history)) return cache.get(history);
    const probabilities = new Float64Array(257);
    const excluded = new Uint8Array(257);
    let weight = 1;
    for (let order = history.length; order >= 0; order--) {
      const row = tables.get(order ? history.slice(-order) : '');
      if (row === undefined) continue;
      const start = offsets[row];
      const end = offsets[row + 1];
      let total = 0;
      let types = 0;
      for (let index = start; index < end; index += 2) {
        if (excluded[counts[index]]) continue;
        total += counts[index + 1];
        types++;
      }
      if (!types) continue;
      const escape = Math.max(1, Math.ceil(types / contextModel.escapeDivisor));
      for (let index = start; index < end; index += 2) {
        const symbol = counts[index];
        if (excluded[symbol]) continue;
        probabilities[symbol] = (weight * counts[index + 1]) / (total + escape);
        excluded[symbol] = 1;
      }
      weight *= escape / (total + escape);
    }
    let remaining = 0;
    for (let symbol = 0; symbol < 257; symbol++)
      if (!excluded[symbol]) remaining++;
    for (let symbol = 0; symbol < 257; symbol++)
      if (!excluded[symbol]) probabilities[symbol] = weight / remaining;
    if (cache.size > 512) cache.clear();
    cache.set(history, probabilities);
    return probabilities;
  }

  const statisticalBase = new Float64Array(257);
  const statisticalDistribution = new Float64Array(257);
  const neuralDistribution = new Float64Array(257);
  const statisticalFrequencies = new Uint32Array(257);
  const neuralFrequencies = new Uint32Array(257);
  const cdf = new Uint32Array(258);

  function initial(prefix) {
    let history = ppm.start;
    for (const byte of prefix) history = ppm.advance(history, byte);
    return {
      scoringMode: prefix.length ? 'tail' : 'full',
      statistical: {
        history,
        raw: Buffer.from(prefix).subarray(-8),
        oldMix: 0.5,
        word: '',
        previous: '',
        mix: 0.5
      },
      neural: {
        history,
        raw: Buffer.from(prefix).subarray(-48),
        mix: 0.5
      },
      categorical: createCategoricalState()
    };
  }

  function statistical(state) {
    const old = ppmProbabilities(state.history);
    const fresh = rich.predict(state.raw);
    for (let symbol = 0; symbol < 257; symbol++)
      statisticalBase[symbol] =
        state.oldMix * old[symbol] + (1 - state.oldMix) * fresh[symbol];
    const wordDistribution = words.distribution(
      state.word,
      state.previous,
      0.5
    );
    const mix = wordDistribution ? state.mix : 0;
    if (!wordDistribution) statisticalDistribution.set(statisticalBase);
    else {
      let letterMass = 0;
      for (let symbol = 97; symbol <= 122; symbol++)
        letterMass += statisticalBase[symbol] + statisticalBase[symbol - 32];
      const boundary = 1 - letterMass;
      for (let symbol = 0; symbol < 257; symbol++) {
        const letter = symbol >= 65 && symbol <= 90 ? symbol + 32 : symbol;
        const isLetter = letter >= 97 && letter <= 122;
        const q = isLetter
          ? (wordDistribution[letter] *
              (state.word ? 1 : letterMass) *
              statisticalBase[symbol]) /
            (statisticalBase[letter] + statisticalBase[letter - 32])
          : statisticalBase[symbol] *
            (state.word ? wordDistribution[EOS] / boundary : 1);
        statisticalDistribution[symbol] =
          (1 - mix) * statisticalBase[symbol] + mix * q;
      }
    }
    return {
      distribution: statisticalDistribution,
      old,
      base: statisticalBase,
      mix
    };
  }

  function neural(state) {
    const base = ppmProbabilities(state.history);
    const predicted = neuralModel.predict(state.raw);
    for (let symbol = 0; symbol < 257; symbol++)
      neuralDistribution[symbol] =
        (1 - state.mix) * base[symbol] + state.mix * predicted[symbol];
    return { distribution: neuralDistribution, predicted };
  }

  function frequencies(distribution, output) {
    let total = 0;
    for (let symbol = 0; symbol < 257; symbol++) {
      const frequency = Math.max(1, Math.floor(distribution[symbol] * SCALE));
      output[symbol] = frequency;
      total += frequency;
    }
    return total;
  }

  function distribution(state) {
    const left = statistical(state.statistical);
    const right = neural(state.neural);
    const leftTotal = frequencies(left.distribution, statisticalFrequencies);
    const rightTotal = frequencies(right.distribution, neuralFrequencies);
    const categorical = categoricalValues(state.categorical);
    const fixed = gates[state.scoringMode].mix(
      categorical,
      statisticalFrequencies,
      leftTotal,
      neuralFrequencies,
      rightTotal
    );
    cdf.set(fixed.cdf);
    return { cdf, total: fixed.total, left, right };
  }

  function advance(state, symbol, values) {
    const left = state.statistical;
    const leftValues = values.left;
    left.oldMix =
      0.01 +
      (0.98 * left.oldMix * leftValues.old[symbol]) / leftValues.base[symbol];
    left.raw = append(left.raw, symbol, 8);
    if ((symbol >= 65 && symbol <= 90) || (symbol >= 97 && symbol <= 122)) {
      const lower = symbol >= 65 && symbol <= 90 ? symbol + 32 : symbol;
      left.mix = leftValues.distribution[symbol]
        ? Math.max(
            0,
            Math.min(
              1,
              1 -
                ((1 - leftValues.mix) * leftValues.base[symbol]) /
                  leftValues.distribution[symbol]
            )
          )
        : 0;
      left.word += String.fromCharCode(lower);
    } else {
      if (left.word) left.previous = left.word;
      if (![45, 95, 32, 47].includes(symbol)) left.previous = '';
      left.word = '';
      left.mix = 0.5;
    }
    left.history = ppm.advance(left.history, symbol);

    const right = state.neural;
    const rightValues = values.right;
    right.mix =
      0.05 +
      0.9 *
        ((right.mix * rightValues.predicted[symbol]) /
          rightValues.distribution[symbol]);
    right.history = ppm.advance(right.history, symbol);
    right.raw = append(right.raw, symbol, 48);
    if (symbol !== EOS) advanceCategorical(state.categorical, symbol);
  }

  function writeP(coder, bytes, prefix) {
    const state = initial(prefix);
    for (let index = 0; index <= bytes.length; index++) {
      checkPredictionDeadline(budget.expires);
      const symbol = index === bytes.length ? EOS : bytes[index];
      const probabilities = distribution(state);
      coder.write(
        probabilities.cdf[symbol],
        probabilities.cdf[symbol + 1],
        probabilities.total
      );
      advance(state, symbol, probabilities);
    }
  }

  function readP(coder, mirror, prefix, limit) {
    const state = initial(prefix);
    const output = [];
    for (let index = 0; index <= limit; index++) {
      checkPredictionDeadline(budget.expires);
      const probabilities = distribution(state);
      const target = coder.target(probabilities.total);
      let low = 0;
      let high = 257;
      while (low + 1 < high) {
        const middle = (low + high) >>> 1;
        if (probabilities.cdf[middle] <= target) low = middle;
        else high = middle;
      }
      coder.consume(
        probabilities.cdf[low],
        probabilities.cdf[low + 1],
        probabilities.total
      );
      mirror.write(
        probabilities.cdf[low],
        probabilities.cdf[low + 1],
        probabilities.total
      );
      if (low === EOS) return Uint8Array.from(output);
      output.push(low);
      advance(state, low, probabilities);
    }
    throw new Error('Mixed output limit');
  }

  return { ppm, writeP, readP };
}
