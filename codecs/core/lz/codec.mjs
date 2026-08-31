// LZ77 fallback, wire v1.
export const MAX_BYTES = 131072;
export const MAX_DISTANCE = 65535;
export const MAX_PROBES = 4;
const HASH_BITS = 16;
const MAX_TAG = MAX_BYTES * 2;

function checkBytes(bytes, name) {
  if (!(bytes instanceof Uint8Array))
    throw new TypeError(`${name} must be a Uint8Array`);
  if (bytes.length > MAX_BYTES)
    throw new RangeError(`${name} exceeds ${MAX_BYTES} bytes`);
}

function wordAt(bytes, position) {
  return (
    bytes[position] |
    (bytes[position + 1] << 8) |
    (bytes[position + 2] << 16) |
    (bytes[position + 3] << 24)
  );
}

function hash(word) {
  return Math.imul(word, 0x9e3779b1) >>> (32 - HASH_BITS);
}

// Canonical unsigned little-endian base-128 integers, bounded to three bytes.
function readVarint(bytes, cursor, maximum) {
  let value = 0;
  for (let shift = 0; shift <= 14; shift += 7) {
    if (cursor.position >= bytes.length) throw new Error('Truncated varint');
    const byte = bytes[cursor.position++];
    value |= (byte & 127) << shift;
    if (!(byte & 128)) {
      if ((shift !== 0 && byte === 0) || value > maximum)
        throw new Error('Noncanonical or oversized varint');
      return value;
    }
  }
  throw new Error('Varint exceeds three bytes');
}

/** Exact bytes -> packet stream. Throws if input OR encoded output exceeds cap. */
export function encodeBytes(input) {
  checkBytes(input, 'Input');
  if (input.length === 0) return new Uint8Array();
  const heads = new Int32Array(1 << HASH_BITS);
  heads.fill(-1);
  const previous = new Int32Array(input.length);
  let output = new Uint8Array(Math.min(MAX_BYTES, input.length + 8));
  let written = 0;

  function ensure(count) {
    const needed = written + count;
    if (needed > MAX_BYTES)
      throw new RangeError(
        'Encoded output exceeds 131072 bytes; keep the original'
      );
    if (needed > output.length) {
      const bigger = new Uint8Array(
        Math.min(MAX_BYTES, Math.max(needed, output.length * 2))
      );
      bigger.set(output);
      output = bigger;
    }
  }
  function writeVarint(value) {
    do {
      ensure(1);
      const low = value & 127;
      value >>>= 7;
      output[written++] = low | (value ? 128 : 0);
    } while (value);
  }
  function literal(start, length) {
    if (length === 0) return;
    writeVarint(length * 2);
    ensure(length);
    output.set(input.subarray(start, start + length), written);
    written += length;
  }
  function insert(position) {
    const bucket = hash(wordAt(input, position));
    previous[position] = heads[bucket];
    heads[bucket] = position;
  }

  let position = 0,
    literalStart = 0;
  while (position + 4 <= input.length) {
    const word = wordAt(input, position);
    let candidate = heads[hash(word)];
    let bestLength = 0,
      bestDistance = 0;
    const remaining = input.length - position;
    for (let probes = 0; probes < MAX_PROBES && candidate >= 0; probes++) {
      const distance = position - candidate;
      // Chains are newest-first, so all following entries are even farther away.
      if (distance > MAX_DISTANCE) break;
      if (
        wordAt(input, candidate) === word &&
        (bestLength === 0 ||
          input[candidate + bestLength] === input[position + bestLength])
      ) {
        let length = 4;
        // Reads may cross position: the original bytes establish an overlapping
        // match, reproduced by forward copying at decode time.
        while (
          length < remaining &&
          input[candidate + length] === input[position + length]
        )
          length++;
        if (length > bestLength) {
          bestLength = length;
          bestDistance = distance;
          if (length === remaining) break;
        }
      }
      candidate = previous[candidate];
    }
    if (bestLength >= 4) {
      literal(literalStart, position - literalStart);
      writeVarint((bestLength - 4) * 2 + 1);
      writeVarint(bestDistance);
      const end = position + bestLength;
      // Every input position is inserted at most once, including skipped bytes.
      for (let p = position; p < end && p + 4 <= input.length; p++) insert(p);
      position = end;
      literalStart = end;
    } else {
      insert(position);
      position++;
    }
  }
  literal(literalStart, input.length - literalStart);
  return output.slice(0, written);
}

/** Packet stream -> exact bytes; validates the ENTIRE stream before allocation. */
export function decodeBytes(bytes, { maxOutputBytes = MAX_BYTES } = {}) {
  checkBytes(bytes, 'Encoded input');
  if (
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 0 ||
    maxOutputBytes > MAX_BYTES
  ) {
    throw new RangeError(
      'maxOutputBytes must be an integer between 0 and 131072'
    );
  }
  // Keep preflight and expansion on one stable snapshot, even if the caller
  // supplied a Uint8Array backed by a concurrently writable SharedArrayBuffer.
  bytes = new Uint8Array(bytes);
  const cursor = { position: 0 };
  let length = 0;
  while (cursor.position < bytes.length) {
    const tag = readVarint(bytes, cursor, MAX_TAG);
    if (tag & 1) {
      const count = (tag >>> 1) + 4;
      const distance = readVarint(bytes, cursor, MAX_DISTANCE);
      if (distance === 0 || distance > length)
        throw new Error('Invalid match distance');
      if (count > maxOutputBytes - length)
        throw new RangeError('Decoded output exceeds limit');
      length += count;
    } else {
      const count = tag >>> 1;
      if (count === 0) throw new Error('Zero-length literal packet');
      if (count > bytes.length - cursor.position)
        throw new Error('Truncated literal packet');
      if (count > maxOutputBytes - length)
        throw new RangeError('Decoded output exceeds limit');
      cursor.position += count;
      length += count;
    }
  }

  const output = new Uint8Array(length);
  cursor.position = 0;
  let position = 0;
  while (cursor.position < bytes.length) {
    const tag = readVarint(bytes, cursor, MAX_TAG);
    if (tag & 1) {
      const count = (tag >>> 1) + 4;
      const distance = readVarint(bytes, cursor, MAX_DISTANCE);
      // Deliberately forward copy; TypedArray.set on an overlapping unfilled
      // range would not implement LZ repetition correctly.
      for (let i = 0; i < count; i++)
        output[position + i] = output[position + i - distance];
      position += count;
    } else {
      const count = tag >>> 1;
      output.set(
        bytes.subarray(cursor.position, cursor.position + count),
        position
      );
      cursor.position += count;
      position += count;
    }
  }
  return output;
}
