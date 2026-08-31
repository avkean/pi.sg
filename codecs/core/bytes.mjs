export function toBase64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 4096)
    text += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return btoa(text)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}
export function fromBase64(text) {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1)
    throw Error('Invalid link alphabet');
  const out = Uint8Array.from(
    atob(text.replaceAll('-', '+').replaceAll('_', '/')),
    (c) => c.charCodeAt(0)
  );
  if (toBase64(out) !== text) throw Error('Noncanonical link bytes');
  return out;
}
const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  let n = i;
  for (let b = 0; b < 8; b++) n = n & 1 ? (n >>> 1) ^ 0xedb88320 : n >>> 1;
  return n >>> 0;
});
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ b) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
export function seal(body, original) {
  const crc = crc32(original),
    frame = new Uint8Array(body.length + 4);
  frame.set([crc >>> 24, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255]);
  frame.set(body, 4);
  return frame;
}
export function verify(frame, original) {
  const expected =
    (frame[0] * 0x1000000 +
      frame[1] * 0x10000 +
      frame[2] * 0x100 +
      frame[3]) >>>
    0;
  if (crc32(original) !== expected)
    throw Error('Link failed its corruption check');
}
