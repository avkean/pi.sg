import { deflateSync, inflateSync } from 'fflate';
import { createCodec } from './context/codec.mjs';
import { unpackModel } from './context/model-format.mjs';
import { toBase64, fromBase64, seal, verify } from './bytes.mjs';
import { inspectDeflate } from './deflate-check.mjs';
import {
  encodeBytes as encodeLz,
  decodeBytes as decodeLz
} from './lz/codec.mjs';
export const MAX_INPUT_BYTES = 131072,
  MAX_CONTEXT_BYTES = 4096,
  MAX_LINK_CHARS = 8192;
const te = new TextEncoder(),
  td = new TextDecoder('utf-8', { fatal: true });
export function validate(input) {
  if (typeof input !== 'string' || input.length > MAX_INPUT_BYTES)
    throw Error('URL exceeds the 128 KiB input limit');
  if (!/^https?:\/\//i.test(input) || !URL.canParse(input))
    throw Error('An absolute HTTP or HTTPS URL is required');
  if (/[\u0000-\u0020\u007f]/.test(input))
    throw Error('URL contains whitespace or control characters');
  const bytes = te.encode(input);
  if (bytes.length > MAX_INPUT_BYTES || td.decode(bytes) !== input)
    throw Error('URL is too large or contains invalid Unicode');
  return bytes;
}
function fullUrl(payload, origin) {
  return new URL('/' + payload, origin).href;
}
function select(input, options, origin) {
  const originalLength = new URL(input).href.length;
  const choices = options
    .map((o) => ({ ...o, url: fullUrl(o.payload, origin) }))
    .filter((o) => o.url.length <= MAX_LINK_CHARS);
  const best = choices.reduce((a, b) => (b.url.length < a.url.length ? b : a), {
    codec: 'original',
    url: input,
    payload: null
  });
  if (
    best.payload !== null &&
    best.url.length >= Math.min(input.length, originalLength)
  )
    return { codec: 'original', url: input, payload: null };
  return best;
}
function fastOptions(bytes) {
  const options = [
    {
      codec: 'deflate-v1',
      payload: 'D' + toBase64(seal(deflateSync(bytes, { level: 6 }), bytes))
    }
  ];
  if (bytes.length >= 512) {
    try {
      options.push({
        codec: 'lz-v1',
        payload: 'L' + toBase64(seal(encodeLz(bytes), bytes))
      });
    } catch (error) {
      // Incompressible input at the cap can require a larger packet stream.
      if (!(error instanceof RangeError)) throw error;
    }
  }
  return options;
}
function decodeFastBody(codec, body) {
  if (codec === 'L') return decodeLz(body, { maxOutputBytes: MAX_INPUT_BYTES });
  const length = inspectDeflate(body, MAX_INPUT_BYTES);
  const bytes = inflateSync(body, { out: new Uint8Array(length) });
  if (bytes.length !== length) throw Error('Inflated length mismatch');
  return bytes;
}
export function encodeFast(input, { origin = 'https://pi.sg' } = {}) {
  const bytes = validate(input),
    result = select(input, fastOptions(bytes), origin);
  if (result.payload) {
    const frame = fromBase64(result.payload.slice(1));
    const restored = decodeFastBody(result.payload[0], frame.subarray(4));
    verify(frame, restored);
    if (td.decode(restored) !== input)
      throw Error('Internal fallback exactness check failed');
  }
  return result;
}
export function createPi(modelBytes, { subword = null } = {}) {
  const model = unpackModel(modelBytes),
    context = createCodec(model);
  function encode(input, { origin = 'https://pi.sg' } = {}) {
    const bytes = validate(input),
      options = fastOptions(bytes);
    if (bytes.length <= MAX_CONTEXT_BYTES) {
      options.push({
        codec: 'context-v1',
        payload: 'P' + toBase64(seal(context.encode(input), bytes))
      });
      if (subword)
        options.push({
          codec: 'subword-v1',
          payload: 'S' + toBase64(seal(subword.encodeBytes(bytes), bytes))
        });
    }
    const result = select(input, options, origin);
    if (result.payload && decode(result.payload) !== input)
      throw Error('Internal exactness check failed');
    return result;
  }
  function decode(payload) {
    if (
      typeof payload !== 'string' ||
      payload.length < 8 ||
      payload.length > MAX_LINK_CHARS
    )
      throw Error('Invalid link length');
    const codec = payload[0];
    if (!['P', 'D', 'S', 'L'].includes(codec) || (codec === 'S' && !subword))
      throw Error('Unsupported link version');
    const frame = fromBase64(payload.slice(1));
    if (frame.length < 5) throw Error('Truncated link');
    const body = frame.subarray(4);
    let input, bytes;
    if (codec === 'P') {
      input = context.decode(body, { maxBytes: MAX_CONTEXT_BYTES });
      bytes = validate(input);
      const canonical = context.encode(input);
      if (
        canonical.length !== body.length ||
        canonical.some((b, i) => b !== body[i])
      )
        throw Error('Noncanonical compressed link');
    } else if (codec === 'S') {
      bytes = subword.decodeBytes(body);
      if (bytes.length > MAX_CONTEXT_BYTES)
        throw Error('Decoded URL exceeds limit');
      input = td.decode(bytes);
      validate(input);
    } else {
      bytes = decodeFastBody(codec, body);
      input = td.decode(bytes);
      validate(input);
    }
    verify(frame, bytes);
    return input;
  }
  return { encode, decode, model, encodeFast };
}
