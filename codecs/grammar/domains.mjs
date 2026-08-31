import {
  ArithmeticEncoder,
  ArithmeticDecoder,
  describe
} from '../compact/arithmetic.mjs';
import { tableOf, writeTable } from './grammar.mjs';
import { createTails } from './tail.mjs';
const te = new TextEncoder(),
  td = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function schemeCode(scheme) {
  let id = scheme.length === 5 ? 32 : 0;
  for (let i = 0; i < scheme.length; i++)
    if (scheme[i] !== scheme[i].toLowerCase()) id |= 1 << i;
  return id;
}
function schemeFrom(id) {
  if (!(id & 32) && id & 16) throw Error('Invalid scheme case mask');
  return [...(id & 32 ? 'https' : 'http')]
    .map((c, i) => (id & (1 << i) ? c.toUpperCase() : c))
    .join('');
}
export function locate(input, domainMap) {
  const match = /^(https?):\/\/([^/?#]*)([\s\S]*)$/i.exec(input);
  if (!match || /[^a-zA-Z0-9.:-]/.test(match[2]) || match[2].includes('['))
    return null;
  const authority = /^([^:]+)(?::([0-9]*))?$/.exec(match[2]);
  if (!authority) return null;
  let host = authority[1],
    terminalDot = host.endsWith('.');
  if (terminalDot) host = host.slice(0, -1);
  const lower = host.toLowerCase();
  for (
    let start = 0;
    start < lower.length;
    start = lower.indexOf('.', start) + 1
  ) {
    const rank = domainMap.get(lower.slice(start));
    if (rank !== undefined)
      return {
        scheme: match[1],
        authority: match[2],
        suffix: match[3],
        host,
        lower,
        rank,
        prefix: lower.slice(0, start),
        terminalDot,
        port: authority[2] ?? null,
        caseMode: host === lower ? 0 : host === lower.toUpperCase() ? 1 : 2
      };
    if (lower.indexOf('.', start) < 0) break;
  }
  return null;
}
function readTable(coder, table, mirror) {
  const value = coder.target(table.total);
  let lo = 0,
    hi = table.frequencies.length;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (table.cumulative[mid] <= value) lo = mid;
    else hi = mid;
  }
  if (!table.frequencies[lo]) throw Error('Invalid domain model symbol');
  coder.consume(table.cumulative[lo], table.cumulative[lo + 1], table.total);
  mirror.write(table.cumulative[lo], table.cumulative[lo + 1], table.total);
  return lo;
}
function bits(coder, value, width) {
  while (width > 0) {
    const n = Math.min(width, 16),
      shift = width - n,
      digit = Math.floor(value / 2 ** shift) % 2 ** n;
    coder.write(digit, digit + 1, 2 ** n);
    width -= n;
  }
}
function readBits(coder, mirror, width) {
  let value = 0;
  while (width > 0) {
    const n = Math.min(width, 16),
      total = 2 ** n,
      digit = coder.target(total);
    coder.consume(digit, digit + 1, total);
    mirror.write(digit, digit + 1, total);
    value = value * total + digit;
    width -= n;
  }
  return value;
}

export function createDomains(domains, meta, contextModel, subwordModel) {
  const ranks = Array.isArray(domains)
    ? new Map(domains.map((d, id) => [d, id]))
    : { get: (word) => domains.find(word) };
  const domainAt = (rank) =>
    Array.isArray(domains) ? domains[rank] : domains.get(rank);
  const prefixIds = new Map(meta.prefixes.map((p, id) => [p, id]));
  const tables = Object.fromEntries(
    Object.entries(meta.frequencies).map(([key, row]) => [key, tableOf(row)])
  );
  const knownRanks =
    meta.knownRanks && new Map(meta.knownRanks.map((rank, id) => [rank, id]));
  const tails = createTails(contextModel, subwordModel);
  function writeHeader(coder, match, subword) {
    coder.write(subword ? 1 : 0, subword ? 2 : 1, 2);
    writeTable(coder, tables.scheme, schemeCode(match.scheme));
    const bucket = Math.floor(Math.log2(match.rank + 1));
    let useRank = true;
    if (knownRanks) {
      const id = knownRanks.get(match.rank),
        escape = meta.knownRanks.length;
      useRank =
        id === undefined ||
        tables.knownRank.costs[id] >
          tables.knownRank.costs[escape] + tables.rank.costs[bucket] + bucket;
      writeTable(coder, tables.knownRank, useRank ? escape : id);
    }
    if (useRank) {
      writeTable(coder, tables.rank, bucket);
      bits(coder, match.rank + 1 - 2 ** bucket, bucket);
    }
    const prefixId = prefixIds.get(match.prefix) ?? meta.prefixes.length;
    writeTable(coder, tables.prefix, prefixId);
    if (prefixId === meta.prefixes.length) {
      if (match.prefix.length > 255)
        throw new RangeError('Authority prefix limit');
      bits(coder, match.prefix.length, 8);
      let h = tails.ppm.start;
      for (const b of te.encode(match.scheme + '://'))
        h = tails.ppm.advance(h, b);
      for (const b of te.encode(match.prefix)) {
        tails.ppm.symbol(coder, b, h);
        h = tails.ppm.advance(h, b);
      }
    }
    writeTable(coder, tables.case, match.caseMode);
    if (match.caseMode === 2)
      for (let i = 0; i < match.host.length; i++)
        if (/[a-z]/.test(match.lower[i]))
          bits(coder, match.host[i] === match.lower[i] ? 0 : 1, 1);
    writeTable(coder, tables.dot, match.terminalDot ? 1 : 0);
    writeTable(coder, tables.port, match.port !== null ? 1 : 0);
    if (match.port !== null) {
      if (match.port.length > 31) throw new RangeError('Port spelling limit');
      bits(coder, match.port.length, 5);
      for (const c of match.port) {
        const n = Number(c);
        coder.write(n, n + 1, 10);
      }
    }
  }
  function encodeBytes(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length > 4096)
      throw new RangeError('Domain codec byte limit');
    const input = td.decode(bytes),
      match = locate(input, ranks);
    if (!match || match.prefix.length > 255 || (match.port?.length ?? 0) > 31)
      return null;
    const prefix = te.encode(match.scheme + '://' + match.authority),
      suffix = te.encode(match.suffix),
      candidates = [];
    for (const subword of [false, true]) {
      const coder = new ArithmeticEncoder();
      writeHeader(coder, match, subword);
      if (subword) tails.writeS(coder, suffix, prefix);
      else tails.writeP(coder, suffix, prefix);
      candidates.push(describe(coder.finish()).terminal.bytes);
    }
    return candidates.reduce((best, body) =>
      body.length < best.length ? body : best
    );
  }
  function decodeBytes(bytes) {
    const coder = new ArithmeticDecoder(bytes),
      mirror = new ArithmeticEncoder(),
      subword = readBits(coder, mirror, 1);
    const scheme = schemeFrom(readTable(coder, tables.scheme, mirror));
    const knownId = knownRanks
      ? readTable(coder, tables.knownRank, mirror)
      : -1;
    let rank;
    if (knownId >= 0 && knownId < meta.knownRanks.length)
      rank = meta.knownRanks[knownId];
    else {
      const bucket = readTable(coder, tables.rank, mirror);
      rank = 2 ** bucket + readBits(coder, mirror, bucket) - 1;
    }
    if (rank >= domains.length) throw Error('Domain rank out of bounds');
    const prefixId = readTable(coder, tables.prefix, mirror);
    let prefix = meta.prefixes[prefixId];
    if (prefixId === meta.prefixes.length) {
      const length = readBits(coder, mirror, 8);
      prefix = '';
      let h = tails.ppm.start;
      for (const b of te.encode(scheme + '://')) h = tails.ppm.advance(h, b);
      for (let i = 0; i < length; i++) {
        const b = tails.ppm.symbol(coder, -1, h, mirror);
        if (b < 33 || b > 126) throw Error('Invalid prefix byte');
        prefix += String.fromCharCode(b);
        h = tails.ppm.advance(h, b);
      }
    }
    let host = prefix + domainAt(rank);
    const caseMode = readTable(coder, tables.case, mirror);
    if (caseMode === 1) host = host.toUpperCase();
    if (caseMode === 2)
      host = [...host]
        .map((c) =>
          /[a-z]/.test(c) && readBits(coder, mirror, 1) ? c.toUpperCase() : c
        )
        .join('');
    if (readTable(coder, tables.dot, mirror)) host += '.';
    if (readTable(coder, tables.port, mirror)) {
      host += ':';
      const length = readBits(coder, mirror, 5);
      for (let i = 0; i < length; i++) host += readBitsDecimal();
    }
    const start = te.encode(scheme + '://' + host);
    if (start.length > 4096) throw new RangeError('Domain prefix output limit');
    const suffix = subword
      ? tails.readS(coder, mirror, start, 4096 - start.length)
      : tails.readP(coder, mirror, start, 4096 - start.length);
    const check = describe(mirror.finish()).terminal.bytes;
    if (check.length !== bytes.length || check.some((b, i) => b !== bytes[i]))
      throw Error('Noncanonical domain stream');
    const result = new Uint8Array(start.length + suffix.length);
    result.set(start);
    result.set(suffix, start.length);
    return result;
    function readBitsDecimal() {
      const n = coder.target(10);
      coder.consume(n, n + 1, 10);
      mirror.write(n, n + 1, 10);
      return String(n);
    }
  }
  return {
    encodeBytes,
    decodeBytes,
    domains,
    meta,
    locate: (input) => locate(input, ranks)
  };
}
