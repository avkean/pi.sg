import { readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';

const root = new URL('../../', import.meta.url);
const hashes = JSON.parse(readFileSync(new URL('models/checksums.json', root)));
const contextPath = 'models/predict-v1/context.bin';
let sharedContext;

function verifyModel(name, bytes) {
  if (
    !hashes[name] ||
    createHash('sha256').update(bytes).digest('hex') !== hashes[name]
  )
    throw Error('Compression model checksum mismatch');
  return bytes;
}

export function readModel(name) {
  if (!Object.hasOwn(hashes, name)) throw Error('Unknown compression model');
  return verifyModel(name, readFileSync(new URL(name, root)));
}

export function contextBytes(shared) {
  if (shared === undefined) return readModel(contextPath);
  if (!(shared instanceof SharedArrayBuffer) || shared.byteLength !== 22331384)
    throw Error('Invalid shared compression model');
  return verifyModel(contextPath, Buffer.from(shared));
}

// Both workers read the same immutable bytes, including after a worker restart.
export function shareContext() {
  if (sharedContext) return sharedContext;
  const shared = new SharedArrayBuffer(22331384),
    bytes = Buffer.from(shared);
  const fd = openSync(new URL(contextPath, root), 'r');
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw Error('Truncated compression model');
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, offset))
      throw Error('Compression model length');
  } finally {
    closeSync(fd);
  }
  verifyModel(contextPath, bytes);
  sharedContext = shared;
  return shared;
}
