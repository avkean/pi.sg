import { createRequire } from 'node:module';
import { unpackModel } from '../core/context/model-format.mjs';
import { openDomainPool } from '../grammar/domain-format.mjs';
import { validate } from '../core/core.mjs';
import { seal, verify, toBase64, fromBase64 } from '../core/bytes.mjs';
import { readModel, contextBytes } from './models.mjs';
import { createDomains } from './domains.mjs';
import { createLanguageTails } from './language.mjs';
import { createNeuralTails } from './neural.mjs';
import { loadWords } from './words.mjs';
import { describe } from '../compact/arithmetic.mjs';
import { isPredictionDeadline } from './deadline.mjs';

const require = createRequire(import.meta.url);
const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function createPredictor(shared) {
  const context = unpackModel(readModel('models/context-v1.bin'));
  const domains = openDomainPool(
    readModel('codecs/grammar/models/majestic-262144-pool.bin')
  );
  const meta = JSON.parse(
    readModel('codecs/grammar/models/majestic-262144-meta.json')
  );
  const nativeContext = require('../../dist/context.node');
  const nativeNeural = require('../../dist/neural.node');
  nativeContext.load(contextBytes(shared));
  nativeNeural.load(readModel('models/predict-v1/neural.bin'));
  const contextScratch = new Float64Array(257),
    neuralScratch = new Float64Array(257);
  const budget = { expires: Infinity };
  const language = createLanguageTails(
    context,
    loadWords(),
    {
      predict: (bytes) => nativeContext.predict(bytes, contextScratch)
    },
    budget
  );
  const statistical = createDomains(domains, meta, language, 1024);
  const neural = createDomains(
    domains,
    meta,
    createNeuralTails(
      {
        predict: (bytes) => nativeNeural.predict(bytes, neuralScratch)
      },
      language,
      budget
    ),
    256
  );

  function encodeDetailed(input, { deadline = Infinity } = {}) {
    const bytes = validate(input);
    if (bytes.length > 1024) return null;
    budget.expires = Math.min(deadline, performance.now() + 20);
    let best = null;
    try {
      const body = statistical.encodeBytes(bytes);
      best = {
        codec: 'statistical-v1',
        mode: 0,
        body,
        bytes,
        payload: 'n' + toBase64(seal(body, bytes))
      };
      if (bytes.length <= 256) {
        const neuralBody = neural.encodeBytes(bytes);
        const payload = 'o' + toBase64(seal(neuralBody, bytes));
        if (payload.length < best.payload.length)
          best = {
            codec: 'neural-v1',
            mode: 1,
            body: neuralBody,
            bytes,
            payload
          };
      }
    } catch (error) {
      if (!isPredictionDeadline(error)) throw error;
    } finally {
      budget.expires = Infinity;
    }
    if (best) {
      const description = describe(best.body);
      if (!description?.interval)
        throw new Error('Missing arithmetic interval');
      best.bitLength = description.terminal.bitLength;
      best.interval = description.interval;
    }
    return best;
  }

  function encode(input, options) {
    const result = encodeDetailed(input, options);
    return result && { codec: result.codec, payload: result.payload };
  }

  function decodeBody(mode, body, { deadline = Infinity } = {}) {
    if ((mode !== 0 && mode !== 1) || !(body instanceof Uint8Array))
      throw new Error('Invalid prediction body');
    budget.expires = deadline;
    try {
      const bytes = (mode === 0 ? statistical : neural).decodeBytes(body);
      const input = textDecoder.decode(bytes);
      validate(input);
      return { input, bytes };
    } finally {
      budget.expires = Infinity;
    }
  }

  function decodeRational(mode, source, { deadline = Infinity } = {}) {
    if ((mode !== 0 && mode !== 1) || typeof source?.bit !== 'function')
      throw new Error('Invalid prediction source');
    budget.expires = deadline;
    try {
      const result = (mode === 0 ? statistical : neural).decodeRational(source);
      const input = textDecoder.decode(result.bytes);
      validate(input);
      return { input, ...result };
    } finally {
      budget.expires = Infinity;
    }
  }

  function decode(ascii, { deadline = Infinity } = {}) {
    if (
      typeof ascii !== 'string' ||
      !['n', 'o'].includes(ascii[0]) ||
      ascii.length < 8 ||
      ascii.length > 2048
    )
      throw Error('Invalid prediction frame');
    const frame = fromBase64(ascii.slice(1));
    if (frame.length < 5) throw Error('Truncated prediction frame');
    const result = decodeBody(ascii[0] === 'n' ? 0 : 1, frame.subarray(4), {
      deadline
    });
    verify(frame, result.bytes);
    return result.input;
  }

  return { encode, encodeDetailed, decode, decodeBody, decodeRational };
}
