import { deflateSync, inflateSync } from 'fflate/browser';
import {
  validate,
  MAX_INPUT_BYTES,
  MAX_LINK_CHARS
} from '../codecs/core/core.mjs';
import { toBase64, fromBase64, seal, verify } from '../codecs/core/bytes.mjs';
import { inspectDeflate } from '../codecs/core/deflate-check.mjs';
import {
  encodeBytes as encodeLz,
  decodeBytes as decodeLz
} from '../codecs/core/lz/codec.mjs';
import { encodeStructured, decodeStructured } from './structured.mjs';
import { encodePacked, decodePacked } from './packed-structured.mjs';

export const OUTPUT_LIMIT_MESSAGE =
  'Compressed link exceeds the 8,192-character limit.';

export function normalizeOrigin(origin = 'https://pi.sg') {
  const base = new URL(origin);
  if (!/^https?:$/.test(base.protocol) || base.username || base.password) {
    throw Error('HTTP(S) origin required');
  }
  return base.origin;
}

// Preserve the frozen candidate order, compression settings and wire bytes.
export function fastCandidates(bytes) {
  const candidates = [
    {
      codec: 'deflate-v1',
      payload: 'D' + toBase64(seal(deflateSync(bytes, { level: 6 }), bytes))
    }
  ];
  if (bytes.length >= 512) {
    try {
      candidates.push({
        codec: 'lz-v1',
        payload: 'L' + toBase64(seal(encodeLz(bytes), bytes))
      });
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
  }
  return candidates;
}

export function selectEncoded(candidates, origin) {
  let best = null;
  for (const candidate of candidates) {
    const url = origin + '/' + candidate.payload;
    if (
      url.length <= MAX_LINK_CHARS &&
      (!best || url.length < best.url.length)
    ) {
      best = { ...candidate, url };
    }
  }
  if (!best) throw new RangeError(OUTPUT_LIMIT_MESSAGE);
  return best;
}

export function encodeFast(input, { origin = 'https://pi.sg' } = {}) {
  const bytes = validate(input);
  const candidates = fastCandidates(bytes);
  const structured = encodeStructured(input);
  if (structured)
    candidates.push({
      codec: 'structured-v1',
      payload: 'z' + toBase64(seal(structured, bytes))
    });
  const packed = encodePacked(input);
  if (packed)
    candidates.push({
      codec: 'packed-v1',
      payload: 'x' + toBase64(seal(packed.bytes, bytes)),
      frameBitLength: 32 + packed.bitLength
    });
  const result = selectEncoded(candidates, normalizeOrigin(origin));
  const frame = fromBase64(result.payload.slice(1)),
    body = frame.subarray(4);
  let restored;
  if (result.payload[0] === 'x') {
    restored = new TextEncoder().encode(decodePacked(body).input);
  } else if (result.payload[0] === 'z') {
    restored = new TextEncoder().encode(decodeStructured(body));
  } else if (result.payload[0] === 'L') {
    restored = decodeLz(body, { maxOutputBytes: MAX_INPUT_BYTES });
  } else {
    const length = inspectDeflate(body, MAX_INPUT_BYTES);
    restored = inflateSync(body, { out: new Uint8Array(length) });
    if (restored.length !== length) throw Error('Inflated length mismatch');
  }
  verify(frame, restored);
  if (
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      restored
    ) !== input
  ) {
    throw Error('Internal fallback exactness check failed');
  }
  return result;
}
