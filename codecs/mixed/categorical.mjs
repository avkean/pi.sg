export const FEATURE_SIZES = [4, 258, 7, 512, 6, 9, 11, 11];
export const EMBEDDING_WIDTHS = [4, 4, 2, 2, 2, 3, 2, 2];

const END = 256;

function isToken(symbol) {
  return (
    (symbol >= 48 && symbol <= 57) ||
    (symbol >= 65 && symbol <= 90) ||
    (symbol >= 97 && symbol <= 122) ||
    symbol === 45 ||
    symbol === 95
  );
}

function byteClass(value) {
  if (value === END) return 0;
  if (value >= 48 && value <= 57) return 1;
  if (value >= 97 && value <= 122) return 2;
  if (value >= 65 && value <= 90) return 3;
  if (value === 45 || value === 95) return 4;
  return value < 128 ? 5 : 6;
}

function runClass(run) {
  if (!run.length) return 0;
  let digits = true;
  let lower = true;
  let upper = true;
  let lowerHex = true;
  let upperHex = true;
  let lowerToken = true;
  let mixedToken = true;
  for (const value of run) {
    const isDigit = value >= 48 && value <= 57;
    const isLower = value >= 97 && value <= 122;
    const isUpper = value >= 65 && value <= 90;
    digits &&= isDigit;
    lower &&= isLower;
    upper &&= isUpper;
    lowerHex &&= isDigit || (value >= 97 && value <= 102);
    upperHex &&= isDigit || (value >= 65 && value <= 70);
    lowerToken &&= isDigit || isLower || value === 45 || value === 95;
    mixedToken &&=
      isDigit || isLower || isUpper || value === 45 || value === 95;
  }
  if (digits) return 1;
  if (lower) return 2;
  if (upper) return 3;
  if (lowerHex) return 4;
  if (upperHex) return 5;
  if (lowerToken) return 6;
  if (mixedToken) return 7;
  return 8;
}

function lengthBucket(length) {
  if (length < 5) return length;
  if (length < 8) return 5;
  if (length < 12) return 6;
  if (length < 16) return 7;
  if (length < 24) return 8;
  if (length < 32) return 9;
  return 10;
}

export function createCategoricalState() {
  return {
    role: 0,
    previous: END,
    previous2: END,
    delimiter: 0,
    run: [],
    fieldPosition: 0
  };
}

export function categoricalValues(state) {
  return [
    state.role,
    state.previous + 1,
    byteClass(state.previous),
    ((state.previous2 + 1) * 257 + state.previous + 1) % 512,
    state.delimiter,
    runClass(state.run),
    lengthBucket(state.run.length),
    lengthBucket(state.fieldPosition)
  ];
}

export function advanceCategorical(state, symbol) {
  if (!Number.isSafeInteger(symbol) || symbol < 0 || symbol > 255)
    throw new Error('Invalid categorical symbol');
  state.previous2 = state.previous;
  state.previous = symbol;
  state.fieldPosition++;
  if (isToken(symbol)) state.run.push(symbol);
  else state.run.length = 0;
  if (symbol === 35) state.delimiter = 1;
  else if (symbol === 38) state.delimiter = 2;
  else if (symbol === 47) state.delimiter = 3;
  else if (symbol === 61) state.delimiter = 4;
  else if (symbol === 63) state.delimiter = 5;

  if (state.role !== 3 && symbol === 35) {
    state.role = 3;
    state.fieldPosition = 0;
  } else if (state.role === 0 && symbol === 63) {
    state.role = 1;
    state.fieldPosition = 0;
  } else if (state.role === 1 && symbol === 61) {
    state.role = 2;
    state.fieldPosition = 0;
  } else if ((state.role === 1 || state.role === 2) && symbol === 38) {
    state.role = 1;
    state.fieldPosition = 0;
  } else if (state.role === 0 && symbol === 47) {
    state.fieldPosition = 0;
  }
}
