import { MAX_LINK_CHARS } from '../codecs/core/core.mjs';
import { toWide, fromWide } from './wide.mjs';
import { isNativeFrame, toNativeFrame } from './native-frame.mjs';
import { fromBase64 } from '../codecs/core/bytes.mjs';

export function withConfirmation(url, enabled = false) {
  if (!enabled) return url;
  const link = url + '~';
  if (new URL(link).href.length > MAX_LINK_CHARS)
    throw new RangeError(
      'The confirmation marker would exceed the link size limit.'
    );
  return link;
}

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
  const asciiPayload =
    isNativeFrame(result.payload) && typeof result.asciiPayload === 'string'
      ? result.asciiPayload
      : unwrapPayload(result.payload);
  if (typeof asciiPayload === 'string' && asciiPayload.length > MAX_LINK_CHARS)
    throw new RangeError('Compressed link exceeds the 8,192-character limit.');
  if (
    typeof asciiPayload !== 'string' ||
    !/^[A-Za-z0-9_-]{6,8192}$/.test(asciiPayload)
  )
    throw Error('Invalid encoded payload');
  const plain = base.origin + '/' + asciiPayload;
  if (plain.length > MAX_LINK_CHARS)
    throw new RangeError('Compressed link exceeds the 8,192-character limit.');
  let payload = asciiPayload,
    transport = 'ascii';
  if (format === 'compact') {
    const wide =
      asciiPayload[0] === 'x' && Number.isInteger(result.frameBitLength)
        ? toNativeFrame(
            fromBase64(asciiPayload.slice(1)),
            result.frameBitLength
          )
        : toWide(asciiPayload);
    const wideUrl = base.origin + '/' + wide;
    // Count the actual escaped URL too: a small-looking link must still fit
    // the request limits used by the redirect server.
    if (
      wide.length < asciiPayload.length &&
      new URL(wideUrl).href.length <= MAX_LINK_CHARS
    ) {
      payload = wide;
      transport = 'compact';
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
  return typeof payload === 'string' && /[^\x00-\x7f]/.test(payload)
    ? fromWide(payload)
    : payload;
}
