import { deflateSync, inflateSync } from 'fflate/browser';
import {
  validate,
  MAX_INPUT_BYTES,
  MAX_CONTEXT_BYTES,
  MAX_LINK_CHARS
} from '../core/core.mjs';
import { toBase64, fromBase64, seal, verify, crc32 } from '../core/bytes.mjs';
import { inspectDeflate } from '../core/deflate-check.mjs';
import {
  encodeBytes as encodeLz,
  decodeBytes as decodeLz
} from '../core/lz/codec.mjs';
import { unpackModel } from '../core/context/model-format.mjs';
import subwordModel from '../core/subword/model.mjs';
import { createCodec as createP } from './context.mjs';
import { createCodec as createS } from './subword.mjs';
import { describe } from './arithmetic.mjs';
import { pack, unpack } from './frame.mjs';
export { MAX_INPUT_BYTES, MAX_CONTEXT_BYTES, MAX_LINK_CHARS };
const utf8 = new TextEncoder(),
  text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function createPiNext(modelBytes) {
  const context = createP(unpackModel(modelBytes)),
    subword = createS(subwordModel, { maxInputBytes: MAX_CONTEXT_BYTES });
  const encodeBody = (codec, bytes) =>
    codec === 'P'
      ? context.encode(text.decode(bytes))
      : subword.encodeBytes(bytes);
  function fastBody(codec, body) {
    if (codec === 'L')
      return decodeLz(body, { maxOutputBytes: MAX_INPUT_BYTES });
    const length = inspectDeflate(body, MAX_INPUT_BYTES),
      bytes = inflateSync(body, { out: new Uint8Array(length) });
    if (bytes.length !== length) throw Error('Inflated length mismatch');
    return bytes;
  }
  function decode(payload) {
    if (
      typeof payload !== 'string' ||
      payload.length < 6 ||
      payload.length > MAX_LINK_CHARS
    )
      throw Error('Invalid link length');
    if ('PSDL'.includes(payload[0])) {
      if (payload.length < 8) throw Error('Truncated legacy link');
      const codec = payload[0],
        frame = fromBase64(payload.slice(1));
      if (frame.length < 5) throw Error('Truncated legacy frame');
      const body = frame.subarray(4);
      let bytes;
      if (codec === 'P') {
        bytes = utf8.encode(
          context.decode(body, { maxBytes: MAX_CONTEXT_BYTES })
        );
        const canonical = encodeBody(codec, bytes);
        if (
          canonical.length !== body.length ||
          canonical.some((v, i) => v !== body[i])
        )
          throw Error('Noncanonical legacy link');
      } else if (codec === 'S') bytes = subword.decodeBytes(body);
      else bytes = fastBody(codec, body);
      const input = text.decode(bytes);
      validate(input);
      verify(frame, bytes);
      return input;
    }
    const frame = unpack(payload);
    const bytes =
      frame.codec === 'P'
        ? utf8.encode(
            context.decode(frame.bytes, { maxBytes: MAX_CONTEXT_BYTES })
          )
        : subword.decodeBytes(frame.bytes, { canonicalCheck: false });
    const input = text.decode(bytes);
    validate(input);
    if (crc32(bytes) !== frame.checksum)
      throw Error('Link failed its corruption check');
    const body = describe(encodeBody(frame.codec, bytes)).terminal;
    if (pack(frame.codec, frame.checksum, body) !== payload)
      throw Error('Noncanonical compact link');
    return input;
  }
  function encode(input, { origin = 'https://pi.sg' } = {}) {
    const bytes = validate(input),
      base = new URL(origin);
    if (!/^https?:$/.test(base.protocol) || base.username || base.password)
      throw Error('HTTP(S) origin required');
    const limit = Math.min(input.length, new URL(input).href.length);
    let best = { codec: 'original', url: input, payload: null };
    function consider(codec, payload) {
      const url = base.origin + '/' + payload;
      if (
        url.length > MAX_LINK_CHARS ||
        url.length >= limit ||
        url.length >= best.url.length
      )
        return;
      best = { codec, url, payload };
    }
    consider(
      'deflate-v1',
      'D' + toBase64(seal(deflateSync(bytes, { level: 6 }), bytes))
    );
    if (bytes.length >= 512) {
      try {
        consider('lz-v1', 'L' + toBase64(seal(encodeLz(bytes), bytes)));
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
      }
    }
    if (bytes.length <= MAX_CONTEXT_BYTES)
      for (const codec of 'PS') {
        try {
          const standard = encodeBody(codec, bytes);
          consider(
            codec === 'P' ? 'context-v1' : 'subword-v1',
            codec + toBase64(seal(standard, bytes))
          );
          consider(
            codec === 'P' ? 'context-compact' : 'subword-compact',
            pack(codec, crc32(bytes), describe(standard).terminal)
          );
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
        }
      }
    if (best.payload && decode(best.payload) !== input)
      throw Error('Internal exactness check failed');
    return best;
  }
  return Object.freeze({ encode, decode });
}
