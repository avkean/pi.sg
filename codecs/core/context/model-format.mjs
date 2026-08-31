function put(out, n) {
  while (n >= 128) {
    out.push(n % 128 | 128);
    n = Math.floor(n / 128);
  }
  out.push(n);
}
export function packModel(model) {
  const out = [80, 67, 1, model.order, model.escapeDivisor];
  put(out, model.tables.length);
  let previous = '';
  for (const [key, table] of model.tables) {
    let prefix = 0;
    while (prefix < key.length && key[prefix] === previous[prefix]) prefix++;
    put(out, prefix);
    put(out, key.length - prefix);
    for (let i = prefix; i < key.length; i++) put(out, key.charCodeAt(i));
    put(out, table.length / 2);
    let prev = -1;
    for (let i = 0; i < table.length; i += 2) {
      put(out, table[i] - prev);
      put(out, table[i + 1]);
      prev = table[i];
    }
    previous = key;
  }
  return Uint8Array.from(out);
}
export function unpackModel(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > 2_000_000)
    throw Error('Invalid model bytes');
  let at = 0;
  function get() {
    let n = 0,
      m = 1;
    for (let i = 0; i < 4; i++) {
      if (at >= bytes.length) throw Error('Truncated model');
      const b = bytes[at++];
      n += (b & 127) * m;
      if (!(b & 128)) {
        if (i > 0 && b === 0) throw Error('Noncanonical model integer');
        return n;
      }
      m *= 128;
    }
    throw Error('Model integer overflow');
  }
  if (bytes[at++] !== 80 || bytes[at++] !== 67 || bytes[at++] !== 1)
    throw Error('Unknown model');
  const order = bytes[at++],
    escapeDivisor = bytes[at++];
  if (order < 1 || order > 8 || escapeDivisor < 1 || escapeDivisor > 16)
    throw Error('Bad model parameters');
  const count = get();
  if (count > 100000) throw Error('Model too large');
  let previous = '';
  const tables = [],
    keys = new Set();
  for (let i = 0; i < count; i++) {
    const prefix = get(),
      suffix = get();
    if (prefix > previous.length || prefix + suffix > order)
      throw Error('Bad context');
    let key = previous.slice(0, prefix);
    for (let n = 0; n < suffix; n++) {
      const s = get();
      if (s > 256) throw Error('Bad context symbol');
      key += String.fromCharCode(s);
    }
    if (keys.has(key)) throw Error('Duplicate model context');
    keys.add(key);
    const pairs = get();
    if (pairs > 257) throw Error('Bad model table');
    const table = [];
    let prev = -1,
      total = 0;
    for (let j = 0; j < pairs; j++) {
      const s = prev + get(),
        freq = get();
      if (s <= prev || s > 256 || freq < 1) throw Error('Bad symbol frequency');
      table.push(s, freq);
      prev = s;
      total += freq;
    }
    if (total >= 65000) throw Error('Model frequency overflow');
    tables.push([key, table]);
    previous = key;
  }
  if (at !== bytes.length) throw Error('Trailing model bytes');
  return { version: 1, order, escapeDivisor, tables };
}
