// Experimental P/S-only framing. This namespace has never been deployed.
// The frozen P/S/D/L markers remain exclusively assigned to Pi v1.
export const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export const PREFIXES = [...ALPHABET]
  .filter((c) => !'PSDL'.includes(c))
  .slice(0, 32)
  .join('');
export const MAX_PAYLOAD_CHARS = 8192;
const reverse = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) reverse[ALPHABET.charCodeAt(i)] = i;
export function bitsToBytes(bits) {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++)
    if (bits[i]) bytes[i >>> 3] |= 1 << (7 - (i & 7));
  return bytes;
}
export function pack(codec, checksum, body) {
  const id = 'PS'.indexOf(codec);
  if (
    id < 0 ||
    codec.length !== 1 ||
    !Number.isInteger(checksum) ||
    checksum < 0 ||
    checksum > 0xffffffff
  )
    throw Error('Invalid frame header');
  if (
    !(body?.bytes instanceof Uint8Array) ||
    !Number.isInteger(body.bitLength) ||
    body.bitLength < 0 ||
    body.bitLength > 49000 ||
    body.bytes.length !== Math.ceil(body.bitLength / 8)
  )
    throw new RangeError('Body limit');
  let output = PREFIXES[id * 16 + (checksum >>> 28)];
  const total = 28 + body.bitLength;
  for (let i = 0; i < total; i += 6) {
    let digit = 0;
    for (let j = i; j < i + 6; j++) {
      let value = 0;
      if (j < 28) value = (checksum >>> (27 - j)) & 1;
      else if (j < total) {
        const p = j - 28;
        value = (body.bytes[p >>> 3] >>> (7 - (p & 7))) & 1;
      }
      digit = digit * 2 + value;
    }
    output += ALPHABET[digit];
  }
  // Bare-link parsers can trim a final underscore. The unique zero guard is
  // verified by decoding and re-encoding, including the complete checksum.
  if (output.endsWith('_')) output += 'A';
  if (output.length > MAX_PAYLOAD_CHARS) throw new RangeError('Payload limit');
  return output;
}
export function unpack(payload) {
  if (
    typeof payload !== 'string' ||
    payload.length < 6 ||
    payload.length > MAX_PAYLOAD_CHARS
  )
    throw new RangeError('Payload limit');
  const index = PREFIXES.indexOf(payload[0]);
  if (index < 0) throw Error('Unknown link version');
  let checksum = index & 15,
    position = 0;
  const digits = new Uint8Array(payload.length - 1);
  for (let i = 1; i < payload.length; i++) {
    const c = payload.charCodeAt(i),
      n = c < 128 ? reverse[c] : -1;
    if (n < 0) throw Error('Invalid link alphabet');
    digits[i - 1] = n;
  }
  const read = () => {
    if (position >= digits.length * 6) throw Error('Truncated frame');
    const value =
      (digits[Math.floor(position / 6)] >>> (5 - (position % 6))) & 1;
    position++;
    return value;
  };
  for (let i = 0; i < 28; i++) checksum = checksum * 2 + read();
  const length = digits.length * 6 - position,
    bytes = new Uint8Array(Math.ceil(length / 8));
  for (let i = 0; i < length; i++)
    if (read()) bytes[i >>> 3] |= 1 << (7 - (i & 7));
  return { codec: 'PS'[index >>> 4], checksum, bytes };
}
