import { createPiNext } from '../codecs/compact/pi.mjs';
import { createCodec as createContext } from '../codecs/compact/context.mjs';
import { createCodec as createSubword } from '../codecs/compact/subword.mjs';
import { describe } from '../codecs/compact/arithmetic.mjs';
import { pack } from '../codecs/compact/frame.mjs';
import { validate, MAX_CONTEXT_BYTES } from '../codecs/core/core.mjs';
import { unpackModel } from '../codecs/core/context/model-format.mjs';
import subwordModel from '../codecs/core/subword/model.mjs';
import {
  crc32,
  seal,
  toBase64,
  fromBase64,
  verify
} from '../codecs/core/bytes.mjs';
import { fastCandidates, normalizeOrigin, selectEncoded } from './fast.mjs';
import { encodeStructured, decodeStructured } from './structured.mjs';
import { renderResult, unwrapPayload } from './surface.mjs';
import {
  isNativeFrame,
  fromNativeFrame,
  toNativeFrame
} from './native-frame.mjs';
import { encodePacked, decodePacked } from './packed-structured.mjs';
import { encodePercent, decodePercent } from './percent.mjs';

export { encodeFast } from './fast.mjs';

export function createCompressor(modelBytes) {
  const frozen = createPiNext(modelBytes);
  let context, subword;

  function decodePackedFrame(frame, bitLength, surface, native) {
    if (frame.length < 5 || bitLength < 40)
      throw Error('Truncated packed link');
    const decoded = decodePacked(frame.subarray(4), {
      bitLength: bitLength - 32
    });
    const input = decoded.input,
      bytes = validate(input);
    verify(frame, bytes);
    const canonical = encodePacked(input);
    if (!canonical) throw Error('Unsupported packed link');
    const sealed = seal(canonical.bytes, bytes);
    const expected = native
      ? toNativeFrame(sealed, 32 + canonical.bitLength)
      : 'x' + toBase64(sealed);
    if (expected !== surface) throw Error('Noncanonical packed link');
    return input;
  }

  function decode(payload) {
    const ascii = unwrapPayload(payload);
    if (isNativeFrame(ascii)) {
      const frame = fromNativeFrame(ascii);
      return decodePackedFrame(
        frame.bytes,
        frame.bitLength,
        frame.canonical,
        true
      );
    }
    if (typeof ascii !== 'string' || ascii.length < 6 || ascii.length > 8192)
      throw Error('Invalid link length');
    if (ascii[0] === 'x') {
      const frame = fromBase64(ascii.slice(1));
      return decodePackedFrame(frame, frame.length * 8, ascii, false);
    }
    if (ascii[0] === 'y') {
      const frame = fromBase64(ascii.slice(1));
      if (frame.length < 5) throw Error('Truncated transformed link');
      const input = decodePercent(frame.subarray(4));
      const bytes = validate(input);
      verify(frame, bytes);
      const canonical = encodePercent(input);
      if (!canonical || 'y' + toBase64(seal(canonical, bytes)) !== ascii)
        throw Error('Noncanonical transformed link');
      return input;
    }
    if (ascii[0] !== 'z') return frozen.decode(ascii);
    const frame = fromBase64(ascii.slice(1));
    if (frame.length < 5) throw Error('Truncated structured link');
    const body = frame.subarray(4);
    const input = decodeStructured(body);
    verify(frame, validate(input));
    const canonical = encodeStructured(input);
    if (
      !canonical ||
      canonical.length !== body.length ||
      canonical.some((value, i) => value !== body[i])
    )
      throw Error('Noncanonical structured link');
    return input;
  }

  function encode(
    input,
    { origin = 'https://pi.sg', format = 'compact' } = {}
  ) {
    const base = normalizeOrigin(origin);
    const existing = frozen.encode(input, { origin: base });
    const bytes = validate(input);
    const candidates = existing.payload ? [existing] : fastCandidates(bytes);
    if (!existing.payload && bytes.length <= MAX_CONTEXT_BYTES) {
      context ??= createContext(unpackModel(modelBytes));
      subword ??= createSubword(subwordModel, {
        maxInputBytes: MAX_CONTEXT_BYTES
      });
      for (const codec of 'PS') {
        try {
          const standard =
            codec === 'P' ? context.encode(input) : subword.encodeBytes(bytes);
          candidates.push({
            codec: codec === 'P' ? 'context-v1' : 'subword-v1',
            payload: codec + toBase64(seal(standard, bytes))
          });
          candidates.push({
            codec: codec === 'P' ? 'context-compact' : 'subword-compact',
            payload: pack(codec, crc32(bytes), describe(standard).terminal)
          });
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
        }
      }
    }
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
    const percent = encodePercent(input);
    if (percent)
      candidates.push({
        codec: 'percent-v1',
        payload: 'y' + toBase64(seal(percent, bytes))
      });
    // Native packed frames can fit fewer displayed characters even when their
    // plain representation ties another candidate. Compare actual outputs.
    let result = null,
      plain = null;
    for (const candidate of candidates) {
      let rendered;
      try {
        rendered = renderResult(candidate, { origin: base, format });
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        else continue;
      }
      if (!plain || candidate.payload.length < plain.payload.length)
        plain = candidate;
      if (
        !result ||
        rendered.url.length < result.url.length ||
        (rendered.url.length === result.url.length &&
          rendered.asciiPayload.length < result.asciiPayload.length)
      )
        result = rendered;
    }
    if (!result) selectEncoded([], base);
    // The bounded worker client sends only the origin. Carry a plain winner
    // too, so switching display format never selects a needlessly long link.
    if (format === 'compact' && plain.payload !== result.asciiPayload) {
      result.asciiAlternative = renderResult(plain, {
        origin: base,
        format: 'ascii'
      });
    }
    if (decode(result.payload) !== input)
      throw Error('Internal exactness check failed');
    return result;
  }

  return Object.freeze({ encode, decode });
}
