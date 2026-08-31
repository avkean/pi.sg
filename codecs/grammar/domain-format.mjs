// Fixed rank dictionary. Reverse characters, sort lexically, and front-code;
// restore source ranks from three-byte integers. Portable and bounded.
const MAGIC = [80, 71, 72, 1],
  MAX_DOMAINS = 262144;
export function packDomains(domains) {
  if (!domains.length || domains.length > MAX_DOMAINS)
    throw new RangeError('Domain count');
  const out = [
    ...MAGIC,
    domains.length >>> 24,
    (domains.length >>> 16) & 255,
    (domains.length >>> 8) & 255,
    domains.length & 255
  ];
  const rows = domains
    .map((domain, rank) => [domain.split('').reverse().join(''), rank])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  let previous = '';
  for (const [word, rank] of rows) {
    if (!/^[a-z0-9.-]+$/.test(word) || word.length > 253 || word === previous)
      throw Error('Invalid domain');
    let common = 0;
    while (
      common < word.length &&
      common < previous.length &&
      word[common] === previous[common]
    )
      common++;
    out.push(
      common,
      word.length - common,
      (rank >>> 16) & 255,
      (rank >>> 8) & 255,
      rank & 255
    );
    for (let i = common; i < word.length; i++) out.push(word.charCodeAt(i));
    previous = word;
  }
  return Uint8Array.from(out);
}
export function unpackDomains(bytes) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length < 8 ||
    bytes.length > 8 * 1024 * 1024 ||
    MAGIC.some((b, i) => bytes[i] !== b)
  )
    throw Error('Unknown domain dictionary');
  const count =
    bytes[4] * 2 ** 24 + bytes[5] * 65536 + bytes[6] * 256 + bytes[7];
  if (!count || count > MAX_DOMAINS)
    throw new RangeError('Domain dictionary count');
  const domains = new Array(count);
  let previous = '',
    at = 8;
  for (let i = 0; i < count; i++) {
    if (at + 5 > bytes.length) throw Error('Truncated domain entry');
    const prefix = bytes[at++],
      suffix = bytes[at++],
      rank = bytes[at++] * 65536 + bytes[at++] * 256 + bytes[at++];
    if (
      prefix > previous.length ||
      prefix + suffix > 253 ||
      !suffix ||
      at + suffix > bytes.length ||
      rank >= count ||
      domains[rank] !== undefined
    )
      throw Error('Invalid domain entry');
    let word = previous.slice(0, prefix);
    for (let n = 0; n < suffix; n++) word += String.fromCharCode(bytes[at++]);
    if (!/^[a-z0-9.-]+$/.test(word) || word <= previous)
      throw Error('Noncanonical domain order');
    domains[rank] = word.split('').reverse().join('');
    previous = word;
  }
  if (at !== bytes.length) throw Error('Trailing domain dictionary bytes');
  return domains;
}

// Server format v2 retains no per-domain JS strings/Map. Rank-ordered ASCII
// pool + offsets + sorted rank indices permit bounded binary-search lookup.
export function packDomainPool(domains) {
  if (!domains.length || domains.length > MAX_DOMAINS)
    throw new RangeError('Domain count');
  const poolSize = domains.reduce((n, s) => n + s.length, 0),
    count = domains.length;
  const bytes = new Uint8Array(12 + 4 * (count + 1) + 4 * count + poolSize),
    view = new DataView(bytes.buffer);
  bytes.set([80, 71, 72, 2]);
  view.setUint32(4, count, true);
  view.setUint32(8, poolSize, true);
  const offsetsAt = 12,
    ranksAt = offsetsAt + 4 * (count + 1),
    poolAt = ranksAt + 4 * count;
  let pos = 0;
  for (let rank = 0; rank < count; rank++) {
    const domain = domains[rank];
    if (!/^[a-z0-9.-]+$/.test(domain) || domain.length > 253)
      throw Error('Invalid domain');
    view.setUint32(offsetsAt + 4 * rank, pos, true);
    for (const c of domain) bytes[poolAt + pos++] = c.charCodeAt(0);
  }
  view.setUint32(offsetsAt + 4 * count, pos, true);
  const ranks = Array.from({ length: count }, (_, rank) => rank).sort((a, b) =>
    domains[a] < domains[b] ? -1 : domains[a] > domains[b] ? 1 : 0
  );
  for (let i = 0; i < count; i++)
    view.setUint32(ranksAt + 4 * i, ranks[i], true);
  return bytes;
}
export function openDomainPool(bytes) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length < 16 ||
    bytes.length > 8 * 1024 * 1024 ||
    [80, 71, 72, 2].some((b, i) => bytes[i] !== b)
  )
    throw Error('Invalid domain pool');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    length = view.getUint32(4, true),
    poolSize = view.getUint32(8, true);
  if (!length || length > MAX_DOMAINS)
    throw new RangeError('Domain pool count');
  const offsetsAt = 12,
    ranksAt = offsetsAt + 4 * (length + 1),
    poolAt = ranksAt + 4 * length;
  if (poolAt + poolSize !== bytes.length) throw Error('Domain pool size');
  const offset = (rank) => view.getUint32(offsetsAt + 4 * rank, true),
    rankAt = (i) => view.getUint32(ranksAt + 4 * i, true),
    decoder = new TextDecoder('utf-8', { fatal: true });
  const seen = new Uint8Array(length);
  let previous = '';
  for (let i = 0; i < length; i++) {
    const rank = rankAt(i);
    if (rank >= length || seen[rank])
      throw Error('Invalid domain rank permutation');
    seen[rank] = 1;
    const a = offset(rank),
      b = offset(rank + 1);
    if (b <= a || b > poolSize || b - a > 253)
      throw Error('Invalid domain offsets');
    const word = decoder.decode(bytes.subarray(poolAt + a, poolAt + b));
    if (!/^[a-z0-9.-]+$/.test(word) || word <= previous)
      throw Error('Invalid domain pool order');
    previous = word;
  }
  if (offset(0) !== 0 || offset(length) !== poolSize)
    throw Error('Domain pool boundary');
  function get(rank) {
    if (!Number.isInteger(rank) || rank < 0 || rank >= length)
      throw Error('Domain rank range');
    return decoder.decode(
      bytes.subarray(poolAt + offset(rank), poolAt + offset(rank + 1))
    );
  }
  function find(word) {
    let lo = 0,
      hi = length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1,
        rank = rankAt(mid),
        start = poolAt + offset(rank),
        end = poolAt + offset(rank + 1);
      let i = 0;
      while (
        start + i < end &&
        i < word.length &&
        bytes[start + i] === word.charCodeAt(i)
      )
        i++;
      const comparison =
        start + i === end
          ? i === word.length
            ? 0
            : -1
          : i === word.length
            ? 1
            : bytes[start + i] - word.charCodeAt(i);
      if (comparison === 0) return rank;
      if (comparison < 0) lo = mid + 1;
      else hi = mid;
    }
    return undefined;
  }
  return Object.freeze({ length, get, find, byteLength: bytes.length });
}
