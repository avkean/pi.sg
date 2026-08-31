import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createGrammarCandidate } from './candidate.mjs';
const pins = Object.freeze({
  'majestic-262144-pool.bin':
    'c53fd2a43fd938982c514e23ca5bcd2d8d346b9eb57c42b3f46b2283e520fb48',
  'majestic-262144-meta.json':
    'fd4dd126d2f1318f23a4b01c008616973fa05b8b2db2d6669199f5c3c7dc5ba7',
  'skeleton-o6-c65536-hosts.bin':
    '26b9f67e958efe751449abe73b6e1f6c1ff185b18d58a74ffb2e12b6a28d3afb',
  'skeleton-o6-c65536-hosts-meta.json':
    '39203f1d7d33f794f1e9a512c0a42813606f04bfe54b81e1d47ea753326c23ae'
});
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
// Load immutable local models once when the worker starts. No network access.
export function loadGrammar(contextBytes) {
  if (
    digest(contextBytes) !==
    '638cc9cd45c041621bbf65fc08356546dcba80b88b99498f7cb93bd698087456'
  )
    throw Error('Frozen context model mismatch');
  const read = (name) => {
    const bytes = readFileSync(new URL('models/' + name, import.meta.url));
    if (digest(bytes) !== pins[name])
      throw Error('Frozen grammar model mismatch');
    return bytes;
  };
  return createGrammarCandidate({
    contextBytes,
    domainBytes: read('majestic-262144-pool.bin'),
    domainMeta: JSON.parse(read('majestic-262144-meta.json')),
    skeletonBytes: read('skeleton-o6-c65536-hosts.bin'),
    skeletonMeta: JSON.parse(read('skeleton-o6-c65536-hosts-meta.json'))
  });
}
