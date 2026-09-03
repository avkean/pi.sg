import { MAX_LINK_CHARS } from '../codecs/core/core.mjs';
import { fromWide } from './wide.mjs';
import { isNativeFrame, toNativeFrame } from './native-frame.mjs';
import { fromBase64 } from '../codecs/core/bytes.mjs';
import {
  fromDense,
  fromDenseWide,
  isDense,
  isDenseWide,
  toDense,
  toDenseWide
} from './dense.mjs';
import {
  isAsciiMixedPayload,
  isUnicodeMixedPayload
} from '../codecs/mixed/frame.mjs';

// A display alphabet is a transport choice, separate from the compressor.
// Both forms carry the same versioned, checksummed payload.
export function renderResult(
  result,
  { origin = 'https://pi.sg', format = 'compact' } = {}
) {
  const base = new URL(origin);
  if (!/^https?:$/.test(base.protocol) || base.username || base.password)
    throw Error('HTTP(S) origin required');
  if (format !== 'compact' && format !== 'ascii')
    throw Error('Unknown link format');
  if (format === 'ascii' && result.asciiAlternative)
    result = { ...result, ...result.asciiAlternative };
  const mixed = result.codec === 'mixed-v1';
  const asciiPayload = mixed
    ? result.asciiPayload
    : isNativeFrame(result.payload) && typeof result.asciiPayload === 'string'
      ? result.asciiPayload
      : unwrapPayload(result.payload);
  if (typeof asciiPayload === 'string' && asciiPayload.length > MAX_LINK_CHARS)
    throw new RangeError('Compressed link exceeds the 8,192-character limit.');
  if (
    typeof asciiPayload !== 'string' ||
    (mixed
      ? !isAsciiMixedPayload(asciiPayload)
      : !/^[A-Za-z0-9_-]{6,8192}$/.test(asciiPayload))
  )
    throw Error('Invalid encoded payload');
  const ascii = mixed ? asciiPayload : toDense(asciiPayload);
  const plain = base.origin + '/' + ascii;
  if (plain.length > MAX_LINK_CHARS)
    throw new RangeError('Compressed link exceeds the 8,192-character limit.');
  let payload = ascii,
    transport = 'ascii';
  if (format === 'compact' && !mixed) {
    const wide = toDenseWide(asciiPayload);
    const oldWide =
      asciiPayload[0] === 'x' && Number.isInteger(result.frameBitLength)
        ? toNativeFrame(
            fromBase64(asciiPayload.slice(1)),
            result.frameBitLength
          )
        : wide;
    for (const candidate of [oldWide, wide]) {
      const wideUrl = base.origin + '/' + candidate;
      if (
        candidate.length < payload.length &&
        new URL(wideUrl).href.length <= MAX_LINK_CHARS
      ) {
        payload = candidate;
        transport = 'compact';
      }
    }
  }
  if (format === 'compact' && mixed) {
    if (!isUnicodeMixedPayload(result.unicodePayload))
      throw Error('Invalid mixed Unicode payload');
    const directUrl = new URL(base.origin + '/' + result.unicodePayload);
    if (
      directUrl.origin !== base.origin ||
      directUrl.search ||
      directUrl.hash ||
      directUrl.href.length > MAX_LINK_CHARS ||
      decodeURIComponent(directUrl.pathname.slice(1)) !== result.unicodePayload
    )
      throw Error('Invalid mixed Unicode URL');
    if (result.unicodePayload.length < payload.length) {
      payload = result.unicodePayload;
      transport = 'direct';
    }
  }
  return {
    ...result,
    payload,
    asciiPayload,
    transport,
    url: base.origin + '/' + payload
  };
}

export function unwrapPayload(payload) {
  if (typeof payload === 'string' && payload.includes('%')) {
    if (
      payload.length > MAX_LINK_CHARS ||
      !/^(?:%[A-Fa-f0-9]{2})+$/.test(payload)
    )
      throw Error('Invalid escaped compact payload');
    payload = decodeURIComponent(payload);
    if (!/[^\x00-\x7f]/.test(payload))
      throw Error('Escaped ASCII payloads are not supported');
  }
  if (isNativeFrame(payload)) return payload;
  if (isDenseWide(payload)) return fromDenseWide(payload);
  if (typeof payload === 'string' && /[^\x00-\x7f]/.test(payload))
    return fromWide(payload);
  return isDense(payload) ? fromDense(payload) : payload;
}
