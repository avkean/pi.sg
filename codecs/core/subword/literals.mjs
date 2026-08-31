// Bounded literal runs complement the learned pieces. No integer factoring,
// global search, regex backtracking, or whole-input arbitrary-size integers.
export const SPECIALS = Object.freeze([
  { name: 'digits', alphabet: '0123456789', minimum: 4, maximum: 1024 },
  {
    name: 'hex-lower',
    alphabet: '0123456789abcdef',
    minimum: 8,
    maximum: 1024
  },
  {
    name: 'hex-upper',
    alphabet: '0123456789ABCDEF',
    minimum: 8,
    maximum: 1024
  },
  {
    name: 'base64url',
    alphabet:
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',
    minimum: 12,
    maximum: 1024
  }
]);
export function makeSpecials(definitions = []) {
  if (definitions.length > 8) throw new Error('Too many literal alphabets');
  return definitions.map((def) => {
    if (
      typeof def.alphabet !== 'string' ||
      def.alphabet.length < 2 ||
      def.alphabet.length > 128 ||
      !Number.isInteger(def.minimum) ||
      def.minimum < 1 ||
      !Number.isInteger(def.maximum) ||
      def.maximum < def.minimum ||
      def.maximum > 1024
    )
      throw new Error('Invalid literal definition');
    const reverse = new Int16Array(256).fill(-1);
    const alphabet = Uint8Array.from(def.alphabet, (c) => c.charCodeAt(0));
    for (let i = 0; i < alphabet.length; i++) {
      if (def.alphabet.charCodeAt(i) > 255 || reverse[alphabet[i]] >= 0)
        throw new Error('Literal alphabet is not unique bytes');
      reverse[alphabet[i]] = i;
    }
    const costs = Float64Array.from({ length: def.maximum + 1 }, (_, n) =>
      n < def.minimum
        ? Infinity
        : n * Math.log2(alphabet.length) +
          2 * Math.floor(Math.log2(n - def.minimum + 1)) +
          1
    );
    return { ...def, alphabet, reverse, costs };
  });
}
export function runsAt(bytes, specials) {
  return specials.map((s) => {
    const runs = new Uint16Array(bytes.length);
    for (let i = bytes.length - 1; i >= 0; i--)
      if (s.reverse[bytes[i]] >= 0)
        runs[i] = Math.min(s.maximum, 1 + (runs[i + 1] ?? 0));
    return runs;
  });
}
export function writeLiteral(encoder, special, bytes, from, length) {
  let n = length - special.minimum + 1;
  const bits = Math.floor(Math.log2(n));
  for (let i = 0; i < bits; i++) encoder.put(0, 1, 2);
  for (let i = bits; i >= 0; i--) encoder.put((n >>> i) & 1, 1, 2);
  for (let i = from; i < from + length; i++) {
    const digit = special.reverse[bytes[i]];
    if (digit < 0) throw new Error('Literal mismatch');
    encoder.put(digit, 1, special.alphabet.length);
  }
}
export function readLiteral(decoder, mirror, special, outputLimit) {
  function take(total) {
    const symbol = decoder.scaled(total);
    decoder.take(symbol, 1, total);
    mirror?.put(symbol, 1, total);
    return symbol;
  }
  let zeros = 0;
  while (take(2) === 0)
    if (++zeros > 10) throw new Error('Literal run length limit');
  let n = 1;
  for (let i = 0; i < zeros; i++) n = n * 2 + take(2);
  const length = n + special.minimum - 1;
  if (length > special.maximum || length > outputLimit)
    throw new RangeError('Literal output limit');
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++)
    bytes[i] = special.alphabet[take(special.alphabet.length)];
  return bytes;
}
