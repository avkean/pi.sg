import { createCompressor as createBrowserCompressor } from './compressor.mjs';
import { createUnicodeCodec } from '../codecs/unicode/codec.mjs';
import { loadGrammar } from '../codecs/grammar/load.mjs';
import { validate } from '../codecs/core/core.mjs';
import { seal, verify, toBase64, fromBase64 } from '../codecs/core/bytes.mjs';
import { unwrapPayload, renderResult } from './surface.mjs';
import { createPredictor } from '../codecs/predict/codec.mjs';
import { isPredictionDeadline } from '../codecs/predict/deadline.mjs';
import {
  decodeAsciiMixed,
  decodeUnicodeMixed,
  encodeMixedFrames,
  isMixedInput,
  verifyEncodedMixedFrames
} from '../codecs/mixed/frame.mjs';
import { createMixedPredictor } from '../codecs/mixed/predictor.mjs';
import { unescapeMixedPayload } from './mixed-surface.mjs';

const MIXED_GOLDEN = [
  {
    input: 'https://example.com/',
    ascii: '!Ep:PZ',
    unicode: '垮캯'
  },
  {
    input: 'https://startup-check.invalid/q7V9_wX3?x=001#Z',
    ascii: '@-1_Ii7EY85A3m68@vD4NlAQ_yYjUmS_fIL',
    unicode: '夽琲걥ꋠ짻㺧擙㗜嘃蛌伮媘쫼넪'
  }
];

export function createCompressor(
  modelBytes,
  { sharedContext, prediction = true } = {}
) {
  const unicode = createUnicodeCodec(modelBytes),
    grammar = loadGrammar(modelBytes);
  // Extra compression doesn't need a second copy of the browser models.
  let browser,
    predictor,
    mixed,
    mixedVerified = false;
  const getBrowser = () => (browser ??= createBrowserCompressor(modelBytes));
  const getPredictor = () => (predictor ??= createPredictor(sharedContext));
  const getMixed = () => (mixed ??= createMixedPredictor(sharedContext));
  function decodeOld(payload, options) {
    const ascii = unwrapPayload(payload);
    if (typeof ascii === 'string' && (ascii[0] === 'n' || ascii[0] === 'o'))
      return getPredictor().decode(ascii, options);
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

  function acceptsLegacy(payload, options) {
    try {
      decodeOld(payload, options);
      return true;
    } catch (error) {
      if (isPredictionDeadline(error)) throw error;
      return false;
    }
  }

  function decode(payload, options = {}) {
    const supplied = payload;
    try {
      return decodeOld(payload, options);
    } catch (legacyError) {
      try {
        payload = unescapeMixedPayload(payload);
      } catch {
        throw legacyError;
      }
      if (!isMixedInput(payload)) throw legacyError;
      const legacy = new Map();
      if (payload === supplied) legacy.set(payload, false);
      const accepts = (candidate) => {
        if (!legacy.has(candidate))
          legacy.set(candidate, acceptsLegacy(candidate, options));
        return legacy.get(candidate);
      };
      const result = /[^\x00-\x7f]/.test(payload)
        ? decodeUnicodeMixed(payload, getMixed(), accepts, options)
        : decodeAsciiMixed(payload, getMixed(), accepts, options);
      return result.input;
    }
  }

  function encodeMixed(input, raw, started) {
    const candidates = getMixed().encodeCandidates(input, {
      deadline: started + 36
    });
    if (!candidates.length) return null;
    const legacy = new Map();
    const accepts = (payload, options = {}) => {
      if (!legacy.has(payload))
        legacy.set(
          payload,
          acceptsLegacy(payload, {
            deadline: Math.min(options.deadline ?? Infinity, started + 42)
          })
        );
      return legacy.get(payload);
    };
    const frames = encodeMixedFrames(raw, candidates, accepts, {
      deadline: started + 45
    });
    const verifyOptions = { deadline: started + 48 };
    verifyEncodedMixedFrames(frames, candidates, accepts, raw, verifyOptions);
    return {
      codec: 'mixed-v1',
      asciiPayload: frames.ascii.payload,
      unicodePayload: frames.unicode.payload
    };
  }

  function encodeAdditional(input) {
    const started = performance.now();
    const raw = validate(input);
    if (raw.length > 32 * 1024) return [];
    const candidates = [];
    if (prediction && raw.length <= 256) {
      try {
        const candidate = encodeMixed(input, raw, started);
        if (candidate) candidates.push(candidate);
      } catch (error) {
        if (!isPredictionDeadline(error)) throw error;
      }
    }
    const unicodeBody = unicode.encodeBody(input);
    if (unicodeBody) {
      const candidate = {
        codec: 'unicode-v1',
        payload: 'u' + toBase64(seal(unicodeBody.body, raw))
      };
      if (decode(candidate.payload) !== input)
        throw Error('Extra compression exactness check failed');
      candidates.push(candidate);
    }
    const grammarBody = grammar.encodeBytes(raw);
    if (grammarBody) {
      const candidate = {
        codec: 'url-grammar-v1',
        payload: 'w' + toBase64(seal(grammarBody, raw))
      };
      if (decode(candidate.payload) !== input)
        throw Error('Extra compression exactness check failed');
      candidates.push(candidate);
    }
    if (
      prediction &&
      raw.length <= 1024 &&
      !candidates.some((candidate) => candidate.codec === 'mixed-v1')
    ) {
      const predictor = getPredictor();
      try {
        const candidate = predictor.encode(input, {
          deadline: Math.min(started + 40, performance.now() + 18)
        });
        if (candidate) {
          if (
            predictor.decode(candidate.payload, { deadline: started + 48 }) !==
            input
          )
            throw Error('Extra compression exactness check failed');
          candidates.push(candidate);
        }
      } catch (error) {
        if (!isPredictionDeadline(error)) throw error;
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

  function verifyMixedModel({ decoderOnly = false } = {}) {
    if (mixedVerified) return;
    const codec = decoderOnly ? null : getMixed();
    for (const vector of MIXED_GOLDEN) {
      if (!decoderOnly) {
        const raw = validate(vector.input);
        const frames = encodeMixedFrames(
          raw,
          codec.encodeCandidates(vector.input),
          (payload) => acceptsLegacy(payload),
          {}
        );
        if (
          frames.ascii.payload !== vector.ascii ||
          frames.unicode.payload !== vector.unicode
        )
          throw new Error('Mixed model self-check failed');
      }
      if (
        decode(vector.ascii) !== vector.input ||
        decode(vector.unicode) !== vector.input
      )
        throw new Error('Mixed model self-check failed');
    }
    mixedVerified = true;
  }

  function warmup({ decoder = false } = {}) {
    if (decoder) {
      getBrowser();
      // Loading the legacy models can exceed a request's deadline.
      getPredictor();
      getMixed();
      verifyMixedModel({ decoderOnly: true });
      return;
    }
    unicode.encodeBody('https://example.com/?q=%E4%B8%AD');
    grammar.encode('https://www.example.com/12345678?value=ABCdef1234-_');
    if (prediction) {
      // Compile the hot paths before starting a job's deadline.
      getPredictor();
      const samples = [
        'https://www.example.com/a-short-link?value=12345&ref=home',
        'https://docs.google.com/document/d/ABCdef1234567890/edit?usp=sharing',
        'https://example.com/how-to-make-a-good-cup-of-coffee?q=%E4%B8%AD'
      ];
      for (let i = 0; i < 12; i++) {
        encodeAdditional(samples[i % samples.length]);
      }
      for (const input of samples) {
        const candidate = getPredictor().encode(input);
        if (candidate && getPredictor().decode(candidate.payload) !== input)
          throw Error('Prediction self-check failed');
      }
    }
    if (prediction) verifyMixedModel();
  }
  return Object.freeze({ encode, decode, encodeAdditional, warmup });
}

export function createDecoder(modelBytes, options = {}) {
  const compressor = createCompressor(modelBytes, {
    ...options,
    prediction: false
  });
  return Object.freeze({
    decode: compressor.decode,
    warmup: () => compressor.warmup({ decoder: true })
  });
}
