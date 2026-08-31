import { createCompressor as createBrowserCompressor } from './compressor.mjs';
import { createUnicodeCodec } from '../codecs/unicode/codec.mjs';
import { loadGrammar } from '../codecs/grammar/load.mjs';
import { validate } from '../codecs/core/core.mjs';
import { seal, verify, toBase64, fromBase64 } from '../codecs/core/bytes.mjs';
import { unwrapPayload, renderResult } from './surface.mjs';

export function createCompressor(modelBytes) {
  const unicode = createUnicodeCodec(modelBytes),
    grammar = loadGrammar(modelBytes);
  // Extra compression doesn't need a second copy of the browser models.
  let browser;
  const getBrowser = () => (browser ??= createBrowserCompressor(modelBytes));
  function decode(payload) {
    const ascii = unwrapPayload(payload);
    if (typeof ascii === 'string' && ascii[0] === 'w')
      return grammar.decode(ascii);
    if (typeof ascii === 'string' && ascii[0] === 'u') {
      if (ascii.length < 6 || ascii.length > 8192)
        throw Error('Invalid link size');
      const frame = fromBase64(ascii.slice(1));
      if (frame.length < 8) throw Error('Truncated Unicode frame');
      const input = unicode.decodeBody(frame.subarray(4));
      verify(frame, validate(input));
      return input;
    }
    return getBrowser().decode(payload);
  }
  function encodeAdditional(input) {
    const raw = validate(input);
    if (raw.length > 32 * 1024) return [];
    const candidates = [],
      u = unicode.encodeBody(input);
    if (u) {
      const candidate = {
        codec: 'unicode-v1',
        payload: 'u' + toBase64(seal(u.body, raw))
      };
      if (decode(candidate.payload) !== input)
        throw Error('Extra compression exactness check failed');
      candidates.push(candidate);
    }
    const body = grammar.encodeBytes(raw);
    if (body) {
      const candidate = {
        codec: 'url-grammar-v1',
        payload: 'w' + toBase64(seal(body, raw))
      };
      if (decode(candidate.payload) !== input)
        throw Error('Extra compression exactness check failed');
      candidates.push(candidate);
    }
    return candidates;
  }
  function encode(input, options = {}) {
    let best, error;
    try {
      best = getBrowser().encode(input, options);
    } catch (failure) {
      if (!(failure instanceof RangeError)) throw failure;
      error = failure;
    }
    for (const candidate of encodeAdditional(input)) {
      let result;
      try {
        result = renderResult(candidate, options);
      } catch (failure) {
        if (!(failure instanceof RangeError)) throw failure;
        continue;
      }
      if (!best || result.url.length < best.url.length) best = result;
    }
    if (!best) throw error ?? Error('No encoded candidate');
    return best;
  }
  function warmup() {
    unicode.encodeBody('https://example.com/?q=%E4%B8%AD');
    grammar.encode('https://www.example.com/12345678?value=ABCdef1234-_');
  }
  return Object.freeze({ encode, decode, encodeAdditional, warmup });
}
