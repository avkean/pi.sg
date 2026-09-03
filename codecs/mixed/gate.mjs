import { EMBEDDING_WIDTHS, FEATURE_SIZES } from './categorical.mjs';

const SYMBOLS = 257;
const FEATURE_COUNT = 21;
const Q15 = 1 << 15;
const Q16 = 1 << 16;
const Q20 = 1 << 20;
const Q24 = 1 << 24;
const CDF_SCALE = 65200;
const MAX_INPUT_Q15 = 20 * Q15;
const MAX_ENTROPY_Q20 = 8394506;

const groupMasks = new Uint8Array(SYMBOLS);
for (let symbol = 0; symbol < SYMBOLS; symbol++) {
  const digit = symbol >= 48 && symbol <= 57;
  const lower = symbol >= 97 && symbol <= 122;
  const upper = symbol >= 65 && symbol <= 90;
  const token = digit || lower || upper || symbol === 45 || symbol === 95;
  const delimiter =
    symbol === 35 ||
    symbol === 38 ||
    symbol === 47 ||
    symbol === 61 ||
    symbol === 63 ||
    symbol === 256;
  groupMasks[symbol] =
    Number(digit) |
    (Number(lower) << 1) |
    (Number(upper) << 2) |
    (Number(token) << 3) |
    (Number(delimiter) << 4);
}

function integer(value, name) {
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid integer: ${name}`);
  return value;
}

function clamp(value, lower, upper) {
  return Math.max(lower, Math.min(upper, value));
}

function roundEven(numerator, denominator) {
  const sign = numerator < 0 ? -1 : 1;
  const absolute = Math.abs(numerator);
  let quotient = Math.floor(absolute / denominator);
  const remainder = absolute - quotient * denominator;
  if (
    remainder * 2 > denominator ||
    (remainder * 2 === denominator && quotient % 2 === 1)
  )
    quotient++;
  return quotient === 0 ? 0 : sign * quotient;
}

export function roundNearestEven(numerator, denominator) {
  integer(numerator, 'rounding numerator');
  integer(denominator, 'rounding denominator');
  if (denominator <= 0) throw new Error('Invalid rounding denominator');
  return roundEven(numerator, denominator);
}

function validateFrequencies(frequencies, total, name) {
  if (
    !(frequencies instanceof Uint32Array) ||
    frequencies.length !== SYMBOLS ||
    !Number.isSafeInteger(total) ||
    total < SYMBOLS ||
    total > 65536
  )
    throw new Error(`Invalid ${name} frequencies`);
  let sum = 0;
  for (const frequency of frequencies) {
    if (frequency < 1) throw new Error(`Invalid ${name} frequency`);
    sum += frequency;
  }
  if (sum !== total) throw new Error(`Invalid ${name} total`);
}

function topTwo(frequencies) {
  let top = 0;
  let second = 0;
  let symbol = 0;
  for (let index = 0; index < SYMBOLS; index++) {
    const frequency = frequencies[index];
    if (frequency > top) {
      second = top;
      top = frequency;
      symbol = index;
    } else if (frequency > second) second = frequency;
  }
  return { top, second, symbol };
}

function entropyQ20(frequencies, total, log2Q24) {
  let numerator = total * log2Q24[total];
  for (const frequency of frequencies)
    numerator -= frequency * log2Q24[frequency];
  return clamp(roundEven(numerator, 16 * total), 0, MAX_ENTROPY_Q20);
}

function ratioQ20(numerator, denominator) {
  return roundEven(numerator * Q20, denominator);
}

function writeObservedFeatures(
  output,
  masses,
  left,
  leftTotal,
  right,
  rightTotal,
  log2Q24,
  validate
) {
  if (validate) {
    validateFrequencies(left, leftTotal, 'left expert');
    validateFrequencies(right, rightTotal, 'right expert');
    if (!(log2Q24 instanceof Uint32Array) || log2Q24.length !== 65537)
      throw new Error('Invalid log2 table');
  }
  const leftPeak = topTwo(left);
  const rightPeak = topTwo(right);
  let overlap = 0;
  let dot = 0;
  masses.fill(0);
  for (let symbol = 0; symbol < SYMBOLS; symbol++) {
    const leftValue = left[symbol];
    const rightValue = right[symbol];
    overlap += Math.min(leftValue * rightTotal, rightValue * leftTotal);
    dot += leftValue * rightValue;
    const mask = groupMasks[symbol];
    if (mask & 1) {
      masses[0] += leftValue;
      masses[1] += rightValue;
    }
    if (mask & 2) {
      masses[2] += leftValue;
      masses[3] += rightValue;
    }
    if (mask & 4) {
      masses[4] += leftValue;
      masses[5] += rightValue;
    }
    if (mask & 8) {
      masses[6] += leftValue;
      masses[7] += rightValue;
    }
    if (mask & 16) {
      masses[8] += leftValue;
      masses[9] += rightValue;
    }
  }
  const denominator = leftTotal * rightTotal;
  output[0] = entropyQ20(left, leftTotal, log2Q24);
  output[1] = entropyQ20(right, rightTotal, log2Q24);
  output[2] = ratioQ20(leftPeak.top, leftTotal);
  output[3] = ratioQ20(rightPeak.top, rightTotal);
  output[4] = ratioQ20(leftPeak.second, leftTotal);
  output[5] = ratioQ20(rightPeak.second, rightTotal);
  output[6] = ratioQ20(overlap, denominator);
  output[7] = ratioQ20(dot, denominator);
  output[8] = leftPeak.symbol * 4096;
  output[9] = rightPeak.symbol * 4096;
  output[10] = leftPeak.symbol === rightPeak.symbol ? Q20 : 0;
  for (let index = 0; index < masses.length; index += 2) {
    output[11 + index] = ratioQ20(masses[index], leftTotal);
    output[12 + index] = ratioQ20(masses[index + 1], rightTotal);
  }
  return output;
}

export function observedFeatures(left, leftTotal, right, rightTotal, log2Q24) {
  return writeObservedFeatures(
    new Int32Array(FEATURE_COUNT),
    new Float64Array(10),
    left,
    leftTotal,
    right,
    rightTotal,
    log2Q24,
    true
  );
}

function validateArray(values, length, name) {
  if (!Array.isArray(values) || values.length !== length)
    throw new Error(`Invalid fixed tensor: ${name}`);
  for (const value of values) integer(value, name);
}

function validateSigned32(values, length, name) {
  validateArray(values, length, name);
  if (values.some((value) => value < -0x80000000 || value > 0x7fffffff))
    throw new Error(`Fixed tensor exceeds signed 32-bit storage: ${name}`);
}

function validateModel(model) {
  if (
    model?.format !== 'pi-mixframe-fixed-gate-v1' ||
    !['tail', 'full'].includes(model.scoringMode) ||
    !Array.isArray(model.observedMeanQ20) ||
    !Array.isArray(model.observedScaleQ20) ||
    model.observedMeanQ20.length !== FEATURE_COUNT ||
    model.observedScaleQ20.length !== FEATURE_COUNT ||
    model.observedScaleQ20.some(
      (value) => !Number.isSafeInteger(value) || value <= 0
    ) ||
    !Array.isArray(model.embeddings) ||
    model.embeddings.length !== FEATURE_SIZES.length ||
    !Array.isArray(model.layers) ||
    model.layers.length !== 3
  )
    throw new Error('Invalid fixed gate model');
  validateSigned32(model.observedMeanQ20, FEATURE_COUNT, 'observed mean');
  validateSigned32(model.observedScaleQ20, FEATURE_COUNT, 'observed scale');
  let inputWidth = FEATURE_COUNT;
  const inputBounds = [];
  for (let index = 0; index < model.embeddings.length; index++) {
    const embedding = model.embeddings[index];
    const rows = FEATURE_SIZES[index];
    const width = EMBEDDING_WIDTHS[index];
    if (embedding.rows !== rows || embedding.width !== width)
      throw new Error('Invalid fixed embedding shape');
    validateSigned32(embedding.valuesQ15, rows * width, 'embedding');
    for (let column = 0; column < width; column++) {
      let maximum = 0;
      for (let row = 0; row < rows; row++)
        maximum = Math.max(
          maximum,
          Math.abs(embedding.valuesQ15[row * width + column])
        );
      inputBounds.push(maximum);
    }
    inputWidth += width;
  }
  inputBounds.push(...new Array(FEATURE_COUNT).fill(MAX_INPUT_Q15));
  const hidden = model.scoringMode === 'tail' ? [32, 16] : [64, 32];
  const widths = [inputWidth, ...hidden, 1];
  for (let index = 0; index < model.layers.length; index++) {
    const layer = model.layers[index];
    if (
      layer.inputWidth !== widths[index] ||
      layer.outputWidth !== widths[index + 1]
    )
      throw new Error('Invalid fixed layer shape');
    validateSigned32(
      layer.weightsQ16,
      layer.inputWidth * layer.outputWidth,
      'network weight'
    );
    validateSigned32(layer.biasQ31, layer.outputWidth, 'network bias');
    const sourceBounds =
      index === 0 ? inputBounds : new Array(layer.inputWidth).fill(Q15);
    for (let row = 0; row < layer.outputWidth; row++) {
      let bound = Math.abs(layer.biasQ31[row]);
      const start = row * layer.inputWidth;
      for (let column = 0; column < layer.inputWidth; column++)
        bound +=
          Math.abs(layer.weightsQ16[start + column]) * sourceBounds[column];
      if (!Number.isSafeInteger(bound))
        throw new Error('Fixed layer exceeds exact JavaScript integer range');
    }
  }
}

function tableTanh(table, value) {
  return value < 0 ? -table[-value] : table[value];
}

function affine(layer, source, output) {
  for (let row = 0; row < layer.outputWidth; row++) {
    let accumulator = layer.biasQ31[row];
    const start = row * layer.inputWidth;
    for (let column = 0; column < layer.inputWidth; column++)
      accumulator += layer.weightsQ16[start + column] * source[column];
    output[row] = accumulator;
  }
  return output;
}

export function loadFixedGate(model, { log2Q24, tanhQ15 }) {
  validateModel(model);
  if (!(log2Q24 instanceof Uint32Array) || log2Q24.length !== 65537)
    throw new Error('Invalid log2 table');
  if (!(tanhQ15 instanceof Uint16Array) || tanhQ15.length !== 65537)
    throw new Error('Invalid tanh table');
  const input = new Float64Array(42);
  const observed = new Int32Array(FEATURE_COUNT);
  const normalizedQ15 = new Int32Array(FEATURE_COUNT);
  const masses = new Float64Array(10);
  const affineOutputs = model.layers.map(
    (layer) => new Float64Array(layer.outputWidth)
  );
  const hiddenQ15 = model.layers
    .slice(0, -1)
    .map((layer) => new Int32Array(layer.outputWidth));
  const decision = {
    hiddenQ15,
    logitQ12: 0,
    maximumUnclampedInputQ15: 0,
    normalizedQ15,
    observed,
    saturatedInputs: 0,
    weightQ16: 0
  };
  const frequencies = new Uint32Array(SYMBOLS);
  const cdf = new Uint32Array(SYMBOLS + 1);
  const mixed = { ...decision, cdf, frequencies, total: 0 };

  function calculateWeight(
    categorical,
    left,
    leftTotal,
    right,
    rightTotal,
    validate
  ) {
    if (
      !Array.isArray(categorical) ||
      categorical.length !== FEATURE_SIZES.length
    )
      throw new Error('Invalid categorical features');
    let offset = 0;
    for (let index = 0; index < model.embeddings.length; index++) {
      const embedding = model.embeddings[index];
      const row = categorical[index];
      if (!Number.isSafeInteger(row) || row < 0 || row >= embedding.rows)
        throw new Error('Categorical feature out of range');
      const start = row * embedding.width;
      for (let column = 0; column < embedding.width; column++)
        input[offset++] = embedding.valuesQ15[start + column];
    }
    writeObservedFeatures(
      observed,
      masses,
      left,
      leftTotal,
      right,
      rightTotal,
      log2Q24,
      validate
    );
    let saturatedInputs = 0;
    let maximumUnclampedInputQ15 = 0;
    for (let index = 0; index < FEATURE_COUNT; index++) {
      const centered = observed[index] - model.observedMeanQ20[index];
      const value = roundEven(centered * Q15, model.observedScaleQ20[index]);
      maximumUnclampedInputQ15 = Math.max(
        maximumUnclampedInputQ15,
        Math.abs(value)
      );
      if (value < -MAX_INPUT_Q15 || value > MAX_INPUT_Q15) saturatedInputs++;
      normalizedQ15[index] = clamp(value, -MAX_INPUT_Q15, MAX_INPUT_Q15);
      input[offset++] = normalizedQ15[index];
    }
    let source = input;
    for (let index = 0; index < model.layers.length; index++) {
      const layer = model.layers[index];
      const sums = affine(layer, source, affineOutputs[index]);
      if (index === model.layers.length - 1) {
        const logitQ12 = clamp(
          roundEven(sums[0], 1 << 19),
          -(8 << 12),
          8 << 12
        );
        decision.logitQ12 = logitQ12;
        decision.maximumUnclampedInputQ15 = maximumUnclampedInputQ15;
        decision.saturatedInputs = saturatedInputs;
        decision.weightQ16 = Q15 + tableTanh(tanhQ15, logitQ12);
        return decision;
      }
      const output = hiddenQ15[index];
      for (let row = 0; row < output.length; row++) {
        const preQ13 = clamp(
          roundEven(sums[row], 1 << 18),
          -(8 << 13),
          8 << 13
        );
        output[row] = tableTanh(tanhQ15, preQ13);
      }
      source = output;
    }
    throw new Error('Fixed gate has no output');
  }

  function weight(categorical, left, leftTotal, right, rightTotal) {
    return calculateWeight(
      categorical,
      left,
      leftTotal,
      right,
      rightTotal,
      true
    );
  }

  function mix(categorical, left, leftTotal, right, rightTotal) {
    validateFrequencies(left, leftTotal, 'left expert');
    validateFrequencies(right, rightTotal, 'right expert');
    calculateWeight(categorical, left, leftTotal, right, rightTotal, false);
    let total = 0;
    for (let symbol = 0; symbol < SYMBOLS; symbol++) {
      cdf[symbol] = total;
      const leftQ24 = roundEven(left[symbol] * Q24, leftTotal);
      const rightQ24 = roundEven(right[symbol] * Q24, rightTotal);
      const mixedQ24 = clamp(
        leftQ24 + roundEven(decision.weightQ16 * (rightQ24 - leftQ24), Q16),
        0,
        Q24
      );
      const frequency = Math.max(1, Math.floor((CDF_SCALE * mixedQ24) / Q24));
      frequencies[symbol] = frequency;
      total += frequency;
    }
    cdf[SYMBOLS] = total;
    if (total > 65536) throw new Error('Fixed mixed CDF exceeds coder range');
    mixed.logitQ12 = decision.logitQ12;
    mixed.maximumUnclampedInputQ15 = decision.maximumUnclampedInputQ15;
    mixed.saturatedInputs = decision.saturatedInputs;
    mixed.weightQ16 = decision.weightQ16;
    mixed.total = total;
    return mixed;
  }

  return { mix, weight };
}
