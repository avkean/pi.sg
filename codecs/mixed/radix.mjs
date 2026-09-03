import { checkPredictionDeadline } from '../predict/deadline.mjs';
import {
  ArithmeticDecoder,
  ArithmeticEncoder,
  describe
} from '../compact/arithmetic.mjs';

function equalValues(left, right) {
  return (
    ArrayBuffer.isView(left) &&
    ArrayBuffer.isView(right) &&
    left.constructor === right.constructor &&
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
}

function equalInterval(left, right) {
  return (
    left &&
    right &&
    left.tailWidth === right.tailWidth &&
    left.lower === right.lower &&
    left.upper === right.upper &&
    left.terminalBitLength === right.terminalBitLength &&
    equalValues(left.prefix, right.prefix)
  );
}

function sameCandidate(left, right) {
  return (
    left?.route === right?.route &&
    left?.bitLength === right?.bitLength &&
    equalValues(left?.body, right?.body) &&
    equalValues(left?.bytes, right?.bytes) &&
    equalValues(left?.trace, right?.trace) &&
    equalInterval(left?.interval, right?.interval)
  );
}

export function verifyArithmeticCandidates(
  candidates,
  expectedBytes,
  { deadline = Infinity } = {}
) {
  if (
    !Array.isArray(candidates) ||
    candidates.length === 0 ||
    !(expectedBytes instanceof Uint8Array)
  )
    throw new TypeError('Generated candidates required');
  let source = '';
  for (const byte of expectedBytes) source += String.fromCharCode(byte);
  for (const candidate of candidates) {
    checkPredictionDeadline(deadline);
    if (
      !(candidate?.body instanceof Uint8Array) ||
      !(candidate.bytes instanceof Uint8Array) ||
      !(candidate.trace instanceof Uint32Array) ||
      candidate.trace.length === 0 ||
      candidate.trace.length % 3 !== 0 ||
      !Number.isSafeInteger(candidate.bitLength) ||
      candidate.bitLength < 0 ||
      !equalValues(candidate.bytes, expectedBytes)
    )
      throw new Error('Invalid generated candidate');
    const captured = describe(candidate.body);
    if (
      captured?.source !== source ||
      !equalValues(captured.trace, candidate.trace) ||
      !equalInterval(captured.interval, candidate.interval) ||
      captured.terminal.bitLength !== candidate.bitLength ||
      !equalValues(captured.terminal.bytes, candidate.body)
    )
      throw new Error('Generated candidate source differs');
    expand(candidate.interval);
    const replay = new ArithmeticEncoder();
    for (let index = 0; index < candidate.trace.length; index += 3) {
      if ((index & 127) === 0) checkPredictionDeadline(deadline);
      replay.write(
        candidate.trace[index],
        candidate.trace[index + 1],
        candidate.trace[index + 2]
      );
    }
    const description = describe(replay.finish());
    if (
      !equalInterval(description.interval, candidate.interval) ||
      description.terminal.bitLength !== candidate.bitLength ||
      !equalValues(description.terminal.bytes, candidate.body)
    )
      throw new Error('Incomplete generated candidate trace');
  }
}

export class RationalBits {
  constructor(numerator, denominator) {
    if (
      typeof numerator !== 'bigint' ||
      typeof denominator !== 'bigint' ||
      numerator < 0n ||
      denominator <= 0n ||
      numerator >= denominator
    )
      throw new RangeError('Invalid frame point');
    this.remainder = numerator;
    this.denominator = denominator;
  }

  bit() {
    this.remainder *= 2n;
    if (this.remainder < this.denominator) return 0;
    this.remainder -= this.denominator;
    return 1;
  }
}

function expand(interval) {
  if (
    !(interval?.prefix instanceof Uint8Array) ||
    !Number.isInteger(interval.tailWidth) ||
    interval.tailWidth < 1 ||
    typeof interval.lower !== 'bigint' ||
    typeof interval.upper !== 'bigint' ||
    interval.lower < 0n ||
    interval.upper <= interval.lower ||
    interval.upper > 1n << BigInt(interval.tailWidth)
  )
    throw new Error('Invalid arithmetic interval');
  let prefix = 0n;
  for (const bit of interval.prefix) {
    if (bit !== 0 && bit !== 1) throw new Error('Invalid interval prefix');
    prefix = (prefix << 1n) | BigInt(bit);
  }
  const shift = BigInt(interval.tailWidth);
  return {
    denominator: 1n << BigInt(interval.prefix.length + interval.tailWidth),
    lower: (prefix << shift) + interval.lower,
    upper: (prefix << shift) + interval.upper
  };
}

export function createRadixFrame({
  headerStates,
  minimumLength = 1,
  maximumLength,
  maximumPointTries = 4096,
  initialGrid,
  nextGrid,
  pointText,
  textPoint
}) {
  if (
    !Number.isSafeInteger(headerStates) ||
    headerStates < 2 ||
    !Number.isSafeInteger(minimumLength) ||
    minimumLength < 1 ||
    !Number.isSafeInteger(maximumLength) ||
    maximumLength < minimumLength ||
    !Number.isSafeInteger(maximumPointTries) ||
    maximumPointTries < 1 ||
    typeof initialGrid !== 'bigint' ||
    initialGrid < 2n ||
    typeof nextGrid !== 'function' ||
    typeof pointText !== 'function' ||
    typeof textPoint !== 'function'
  )
    throw new TypeError('Invalid radix frame transport');

  function select(interval, header, acceptsLegacy, deadline = Infinity) {
    if (
      !Number.isSafeInteger(header) ||
      header < 0 ||
      header >= headerStates ||
      typeof acceptsLegacy !== 'function'
    )
      throw new Error('Invalid frame header');
    checkPredictionDeadline(deadline);
    const expanded = expand(interval);
    const lower = BigInt(header) * expanded.denominator + expanded.lower;
    const upper = BigInt(header) * expanded.denominator + expanded.upper;
    const combined = BigInt(headerStates) * expanded.denominator;
    let grid = initialGrid;
    let rejectedLegacy = 0;
    for (let length = minimumLength; length <= maximumLength; length++) {
      checkPredictionDeadline(deadline);
      const first = (lower * grid) / combined + 1n;
      const last = (upper * grid - 1n) / combined;
      let attempts = 0;
      for (let point = first; point <= last; point++) {
        if (++attempts > maximumPointTries)
          throw new RangeError('Frame point search limit');
        if ((attempts & 63) === 0) checkPredictionDeadline(deadline);
        const payload = pointText(point, length);
        if (acceptsLegacy(payload, { deadline })) {
          rejectedLegacy++;
          continue;
        }
        checkPredictionDeadline(deadline);
        return { payload, rejectedLegacy };
      }
      grid = nextGrid(grid);
    }
    throw new RangeError('Frame payload limit');
  }

  function encode(bytes, interval, checksum, acceptsLegacy, options = {}) {
    if (!(bytes instanceof Uint8Array) || typeof checksum !== 'function')
      throw new Error('Invalid frame input');
    const deadline = options.deadline ?? Infinity;
    checkPredictionDeadline(deadline);
    const check = checksum(bytes);
    if (!Number.isSafeInteger(check) || check < 0 || check >= headerStates)
      throw new Error('Invalid frame checksum');
    return { ...select(interval, check, acceptsLegacy, deadline), check };
  }

  function encodeShortest(
    bytes,
    candidates,
    checksum,
    acceptsLegacy,
    options = {}
  ) {
    if (!(bytes instanceof Uint8Array) || !Array.isArray(candidates))
      throw new Error('Invalid frame candidates');
    const deadline = options.deadline ?? Infinity;
    let best = null;
    for (const candidate of candidates) {
      checkPredictionDeadline(deadline);
      if (!candidate?.interval) throw new Error('Missing frame interval');
      const result = {
        ...candidate,
        ...encode(bytes, candidate.interval, checksum, acceptsLegacy, {
          deadline
        })
      };
      if (
        !best ||
        result.payload.length < best.payload.length ||
        (result.payload.length === best.payload.length &&
          result.payload < best.payload)
      )
        best = result;
    }
    if (!best) throw new Error('No frame candidate');
    return best;
  }

  function read(payload, predictor, checksum, acceptsLegacy, options = {}) {
    if (
      typeof predictor?.decodeRational !== 'function' ||
      typeof checksum !== 'function' ||
      typeof acceptsLegacy !== 'function'
    )
      throw new TypeError('Frame decoder required');
    const deadline = options.deadline ?? Infinity;
    checkPredictionDeadline(deadline);
    const { canonical, point, grid } = textPoint(payload);
    checkPredictionDeadline(deadline);
    if (acceptsLegacy(canonical, { deadline }))
      throw new Error('Frame overlaps an older link');
    const header = Number((BigInt(headerStates) * point) / grid);
    const numerator = BigInt(headerStates) * point - BigInt(header) * grid;
    const result = predictor.decodeRational(new RationalBits(numerator, grid), {
      deadline
    });
    checkPredictionDeadline(deadline);
    if (checksum(result.bytes) !== header)
      throw new Error('Frame checksum failed');
    return { canonical, result, header, deadline };
  }

  function decode(payload, predictor, checksum, acceptsLegacy, options = {}) {
    if (typeof predictor?.encodeCandidates !== 'function')
      throw new TypeError('Frame decoder required');
    const { canonical, result, header, deadline } = read(
      payload,
      predictor,
      checksum,
      acceptsLegacy,
      options
    );
    const expected = encodeShortest(
      result.bytes,
      predictor.encodeCandidates(result.input, { deadline }),
      checksum,
      acceptsLegacy,
      { deadline }
    ).payload;
    checkPredictionDeadline(deadline);
    if (expected !== canonical) throw new Error('Noncanonical frame');
    return { ...result, check: header };
  }

  function verify(
    payload,
    predictor,
    checksum,
    acceptsLegacy,
    expectedBytes,
    options = {}
  ) {
    if (!(expectedBytes instanceof Uint8Array))
      throw new TypeError('Expected frame bytes required');
    const { result, header } = read(
      payload,
      predictor,
      checksum,
      acceptsLegacy,
      options
    );
    if (result.bytes.length !== expectedBytes.length)
      throw new Error('Frame round-trip failed');
    for (let index = 0; index < expectedBytes.length; index++)
      if (result.bytes[index] !== expectedBytes[index])
        throw new Error('Frame round-trip failed');
    return { ...result, check: header };
  }

  function verifyEncoded(
    frame,
    candidates,
    checksum,
    acceptsLegacy,
    expectedBytes,
    options = {}
  ) {
    if (
      typeof frame?.payload !== 'string' ||
      !(frame.bytes instanceof Uint8Array) ||
      !(frame.trace instanceof Uint32Array) ||
      !Array.isArray(candidates) ||
      typeof checksum !== 'function' ||
      typeof acceptsLegacy !== 'function' ||
      !(expectedBytes instanceof Uint8Array)
    )
      throw new TypeError('Generated frame required');
    const deadline = options.deadline ?? Infinity;
    checkPredictionDeadline(deadline);
    if (!candidates.some((candidate) => sameCandidate(frame, candidate)))
      throw new Error('Generated frame has no matching candidate');
    const expected = encodeShortest(
      expectedBytes,
      candidates,
      checksum,
      acceptsLegacy,
      { deadline }
    ).payload;
    if (frame.payload !== expected)
      throw new Error('Generated frame is not the shortest canonical payload');
    const { canonical, point, grid } = textPoint(frame.payload);
    if (canonical !== frame.payload)
      throw new Error('Noncanonical generated frame');
    if (acceptsLegacy(canonical, { deadline }))
      throw new Error('Frame overlaps an older link');
    const header = Number((BigInt(headerStates) * point) / grid);
    if (checksum(expectedBytes) !== header)
      throw new Error('Generated frame checksum failed');
    const numerator = BigInt(headerStates) * point - BigInt(header) * grid;
    const decoder = new ArithmeticDecoder(new RationalBits(numerator, grid));
    for (let index = 0; index < frame.trace.length; index += 3) {
      if ((index & 127) === 0) checkPredictionDeadline(deadline);
      const low = frame.trace[index];
      const high = frame.trace[index + 1];
      const total = frame.trace[index + 2];
      const target = decoder.target(total);
      if (target < low || target >= high)
        throw new Error('Generated frame arithmetic replay failed');
      decoder.consume(low, high, total);
    }
    checkPredictionDeadline(deadline);
    return { check: header };
  }

  return { decode, encode, encodeShortest, select, verify, verifyEncoded };
}
