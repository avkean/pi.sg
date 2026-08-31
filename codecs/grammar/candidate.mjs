// Isolated, synchronous, browser-compatible candidate. No I/O or destination
// lookup. The caller loads the exact frozen models once per worker.
import { unpackModel } from '../core/context/model-format.mjs';
import subwordModel from '../core/subword/model.mjs';
import { validate } from '../core/core.mjs';
import { seal, verify, toBase64, fromBase64 } from '../core/bytes.mjs';
import { renderResult, unwrapPayload } from '../../src/surface.mjs';
import { openDomainPool } from './domain-format.mjs';
import { createDomains } from './domains.mjs';
import { createSkeleton } from './skeleton.mjs';

export const MAX_INPUT_BYTES = 4096,
  MARKER = 'w',
  VERSION = 1,
  DOMAIN_COUNT = 262144;
const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export function createGrammarCandidate({
  contextBytes,
  domainBytes,
  domainMeta,
  skeletonBytes = null,
  skeletonMeta = null
}) {
  const context = unpackModel(contextBytes),
    domains = openDomainPool(domainBytes);
  if (
    domainMeta.count !== DOMAIN_COUNT ||
    domainMeta.count !== domains.length ||
    domainMeta.format !== 'pi-majestic-host-tail-1'
  )
    throw Error('Domain model mismatch');
  const domain = createDomains(domains, domainMeta, context, subwordModel);
  const skeleton =
    skeletonBytes && createSkeleton(unpackModel(skeletonBytes), skeletonMeta);
  function encodeBytes(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length > MAX_INPUT_BYTES)
      return null;
    const candidates = [];
    for (const [flags, codec] of [
      [0, domain],
      [1, skeleton]
    ]) {
      if (!codec) continue;
      try {
        candidates.push([flags, codec.encodeBytes(bytes)]);
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
      }
    }
    let chosen = null;
    for (const [flags, body] of candidates) {
      if (
        body === null ||
        body.length + 1 > 6145 ||
        (chosen && chosen.length <= body.length + 1)
      )
        continue;
      chosen = new Uint8Array(body.length + 1);
      chosen[0] = (VERSION << 4) | flags;
      chosen.set(body, 1);
    }
    return chosen;
  }
  function decodeBytes(body) {
    if (
      !(body instanceof Uint8Array) ||
      body.length < 2 ||
      body.length > 6145 ||
      body[0] >>> 4 !== VERSION ||
      (body[0] & 15) > 1
    )
      throw Error('Unknown grammar body version/flags');
    const flags = body[0] & 15;
    if (flags && !skeleton) throw Error('Skeleton model unavailable');
    const restored = (flags ? skeleton : domain).decodeBytes(body.subarray(1));
    if (restored.length > MAX_INPUT_BYTES)
      throw new RangeError('Grammar output limit');
    return restored;
  }
  function decode(payload) {
    const ascii = unwrapPayload(payload);
    if (
      typeof ascii !== 'string' ||
      ascii.length < 8 ||
      ascii.length > 8192 ||
      ascii[0] !== MARKER
    )
      throw Error('Unknown grammar link');
    const frame = fromBase64(ascii.slice(1));
    if (frame.length < 6) throw Error('Truncated grammar link');
    const bytes = decodeBytes(frame.subarray(4)),
      input = text.decode(bytes);
    validate(input);
    verify(frame, bytes);
    return input;
  }
  function encode(input, options = {}) {
    const bytes = validate(input),
      body = encodeBytes(bytes);
    if (!body) return null;
    let result;
    try {
      result = renderResult(
        {
          codec: 'url-grammar-v1',
          payload: MARKER + toBase64(seal(body, bytes))
        },
        options
      );
    } catch (error) {
      if (error instanceof RangeError) return null;
      throw error;
    }
    if (decode(result.payload) !== input)
      throw Error('Grammar exactness check');
    return result;
  }
  return Object.freeze({
    encodeBytes,
    decodeBytes,
    encode,
    decode,
    maxInputBytes: MAX_INPUT_BYTES,
    marker: MARKER
  });
}
