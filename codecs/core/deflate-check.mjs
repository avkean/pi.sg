// Bounds-check a raw RFC1951 stream before a general inflater touches it.
// Counts output without materializing back references, rejecting a bomb before
// its expansion. No preset dictionary is allowed in this format.
const lengthBase = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67,
  83, 99, 115, 131, 163, 195, 227, 258
];
const lengthExtra = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5,
  5, 5, 0
];
const distanceBase = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769,
  1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577
];
const distanceExtra = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11,
  11, 12, 12, 13, 13
];
function tree(lengths, kind = 'literal') {
  const counts = new Uint16Array(16),
    next = new Uint16Array(16),
    tables = Array.from({ length: 16 }, () => new Map());
  for (const n of lengths) {
    if (n < 0 || n > 15) throw Error('Invalid Huffman length');
    if (n) counts[n]++;
  }
  let code = 0;
  const maximum = Math.max(...lengths);
  for (let bits = 1; bits <= 15; bits++) {
    code = (code + counts[bits - 1]) * 2;
    if (code + counts[bits] > 2 ** bits)
      throw Error('Oversubscribed Huffman tree');
    next[bits] = code;
  }
  if (
    code + counts[15] !== 2 ** 15 &&
    !(maximum === 1 && kind !== 'code-length') &&
    !(maximum === 0 && kind === 'distance')
  )
    throw Error('Incomplete Huffman tree');
  for (let s = 0; s < lengths.length; s++) {
    const n = lengths[s];
    if (n) tables[n].set(next[n]++, s);
  }
  return tables;
}
const fixedLit = tree(
    Array.from({ length: 288 }, (_, s) =>
      s < 144 ? 8 : s < 256 ? 9 : s < 280 ? 7 : 8
    )
  ),
  fixedDist = tree(Array(32).fill(5));
export function inspectDeflate(bytes, maxOutput) {
  let bit = 0,
    output = 0;
  function read(n) {
    if (bit + n > bytes.length * 8) throw Error('Truncated DEFLATE');
    let value = 0;
    for (let i = 0; i < n; i++, bit++)
      value |= ((bytes[bit >> 3] >> (bit & 7)) & 1) << i;
    return value;
  }
  function symbol(t) {
    let code = 0;
    for (let n = 1; n <= 15; n++) {
      code = code * 2 + read(1);
      const s = t[n].get(code);
      if (s !== undefined) return s;
    }
    throw Error('Invalid Huffman symbol');
  }
  let final = 0;
  do {
    final = read(1);
    const type = read(2);
    if (type === 0) {
      bit = Math.ceil(bit / 8) * 8;
      const len = read(16),
        inv = read(16);
      if ((len ^ inv) !== 65535) throw Error('Bad stored block');
      if (bit + len * 8 > bytes.length * 8)
        throw Error('Truncated stored block');
      output += len;
      if (output > maxOutput) throw Error('Decoded URL exceeds limit');
      bit += len * 8;
      continue;
    }
    if (type === 3) throw Error('Reserved DEFLATE block');
    let lit = fixedLit,
      dist = fixedDist;
    if (type === 2) {
      const nl = read(5) + 257,
        nd = read(5) + 1,
        nc = read(4) + 4;
      if (nl > 286 || nd > 32) throw Error('Invalid dynamic tree sizes');
      // RFC1951 code-length alphabet order; kept explicit rather than inferred.
      const permutation = [
        16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15
      ];
      const cl = Array(19).fill(0);
      for (let i = 0; i < nc; i++) cl[permutation[i]] = read(3);
      const ct = tree(cl, 'code-length'),
        lengths = [];
      while (lengths.length < nl + nd) {
        const s = symbol(ct);
        if (s < 16) lengths.push(s);
        else {
          let count,
            value = 0;
          if (s === 16) {
            if (!lengths.length) throw Error('Repeat without predecessor');
            count = read(2) + 3;
            value = lengths.at(-1);
          } else if (s === 17) count = read(3) + 3;
          else if (s === 18) count = read(7) + 11;
          else throw Error('Bad length repeat');
          if (lengths.length + count > nl + nd)
            throw Error('Tree repeat overflow');
          for (let i = 0; i < count; i++) lengths.push(value);
        }
      }
      if (!lengths[256]) throw Error('Missing end-of-block symbol');
      lit = tree(lengths.slice(0, nl));
      dist = tree(lengths.slice(nl), 'distance');
    }
    while (true) {
      const s = symbol(lit);
      if (s < 256) output++;
      else if (s === 256) break;
      else {
        const i = s - 257;
        if (i < 0 || i >= lengthBase.length) throw Error('Invalid length');
        const len = lengthBase[i] + read(lengthExtra[i]),
          d = symbol(dist);
        if (d >= distanceBase.length) throw Error('Invalid distance');
        const distance = distanceBase[d] + read(distanceExtra[d]);
        if (distance > output) throw Error('Back reference before output');
        output += len;
      }
      if (output > maxOutput) throw Error('Decoded URL exceeds limit');
    }
  } while (!final);
  if (Math.ceil(bit / 8) !== bytes.length)
    throw Error('Trailing DEFLATE bytes');
  if (bit % 8 && bytes.at(-1) >> bit % 8 !== 0)
    throw Error('Nonzero DEFLATE padding');
  return output;
}
