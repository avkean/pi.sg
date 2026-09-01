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

  function encode(input, { deadline = Infinity } = {}) {
    const bytes = validate(input);
    if (bytes.length > 1024) return null;
    budget.expires = Math.min(deadline, performance.now() + 20);
    let best = null;
    try {
      best = {
        codec: 'statistical-v1',
        payload: 'n' + toBase64(seal(statistical.encodeBytes(bytes), bytes))
      };
      if (bytes.length <= 256) {
        const payload = 'o' + toBase64(seal(neural.encodeBytes(bytes), bytes));
        if (payload.length < best.payload.length)
          best = { codec: 'neural-v1', payload };
      }
    } catch (error) {
      if (error.message !== 'Prediction time budget') throw error;
    } finally {
      budget.expires = Infinity;
    }
    return best;
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
    let bytes;
    budget.expires = deadline;
    try {
      bytes = (ascii[0] === 'n' ? statistical : neural).decodeBytes(
        frame.subarray(4)
      );
    } finally {
      budget.expires = Infinity;
    }
    verify(frame, bytes);
    const input = textDecoder.decode(bytes);
    validate(input);
    return input;
  }

  return { encode, decode };
}
