import { createCompressor as createBrowserCompressor } from './compressor.mjs';
import { createUnicodeCodec } from '../codecs/unicode/codec.mjs';
import { loadGrammar } from '../codecs/grammar/load.mjs';
import { validate } from '../codecs/core/core.mjs';
import { seal, verify, toBase64, fromBase64 } from '../codecs/core/bytes.mjs';
import { unwrapPayload, renderResult } from './surface.mjs';
import { createPredictor } from '../codecs/predict/codec.mjs';

export function createCompressor(
  modelBytes,
  { sharedContext, prediction = true } = {}
) {
  const unicode = createUnicodeCodec(modelBytes),
    grammar = loadGrammar(modelBytes);
  // Extra compression doesn't need a second copy of the browser models.
  let browser, predictor;
  const getBrowser = () => (browser ??= createBrowserCompressor(modelBytes));
  const getPredictor = () => (predictor ??= createPredictor(sharedContext));
  function decode(payload) {
    const ascii = unwrapPayload(payload);
    if (typeof ascii === 'string' && (ascii[0] === 'n' || ascii[0] === 'o'))
      return getPredictor().decode(ascii);
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
    const started = performance.now();
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
    if (prediction && raw.length <= 1024) {
      const predictor = getPredictor();
      const candidate = predictor.encode(input, { deadline: started + 18 });
      try {
        if (
          candidate &&
          candidates.every(
            (existing) => candidate.payload.length < existing.payload.length
          )
        ) {
          // Leave time for verification before the worker's hard deadline.
          if (
            predictor.decode(candidate.payload, { deadline: started + 30 }) !==
            input
          )
            throw Error('Extra compression exactness check failed');
          candidates.push(candidate);
        }
      } catch (error) {
        if (error.message !== 'Prediction time budget') throw error;
      }
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
  function warmup({ decoder = false } = {}) {
    if (decoder) getBrowser();
    unicode.encodeBody('https://example.com/?q=%E4%B8%AD');
    grammar.encode('https://www.example.com/12345678?value=ABCdef1234-_');
    if (prediction) {
      // Compile the hot paths before starting a job's deadline.
      const samples = [
        'https://www.example.com/a-short-link?value=12345&ref=home',
        'https://docs.google.com/document/d/ABCdef1234567890/edit?usp=sharing',
        'https://example.com/how-to-make-a-good-cup-of-coffee?q=%E4%B8%AD'
      ];
      for (let i = 0; i < 12; i++) {
        encodeAdditional(samples[i % samples.length]);
      }
    }
  }
  return Object.freeze({ encode, decode, encodeAdditional, warmup });
}
