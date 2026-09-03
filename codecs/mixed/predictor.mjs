import { createRequire } from 'node:module';
import { unpackModel } from '../core/context/model-format.mjs';
import { validate } from '../core/core.mjs';
import { openDomainPool } from '../grammar/domain-format.mjs';
import { createDomains } from '../predict/domains.mjs';
import { contextBytes, readModel } from '../predict/models.mjs';
import { loadWords } from '../predict/words.mjs';
import { checkPredictionDeadline } from '../predict/deadline.mjs';
import { describe } from '../compact/arithmetic.mjs';
import { loadMixedGates } from './assets.mjs';
import { createMixedTails } from './tails.mjs';

const require = createRequire(import.meta.url);
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function createMixedPredictor(shared) {
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
  const contextScratch = new Float64Array(257);
  const neuralScratch = new Float64Array(257);
  const budget = { expires: Infinity };
  const tails = createMixedTails(
    context,
    loadWords(),
    { predict: (bytes) => nativeContext.predict(bytes, contextScratch) },
    { predict: (bytes) => nativeNeural.predict(bytes, neuralScratch) },
    budget,
    loadMixedGates()
  );
  const codec = createDomains(domains, meta, tails, 256, {
    captureTrace: true
  });

  function encodeCandidates(input, { deadline = Infinity } = {}) {
    checkPredictionDeadline(deadline);
    const bytes = validate(input);
    checkPredictionDeadline(deadline);
    if (bytes.length > 256) return [];
    budget.expires = deadline;
    try {
      const candidates = codec.encodeCandidates(bytes).map((candidate) => {
        const description = describe(candidate.body);
        if (!description?.interval)
          throw new Error('Missing arithmetic interval');
        if (!(description.trace instanceof Uint32Array))
          throw new Error('Missing arithmetic trace');
        return {
          route: candidate.route,
          body: candidate.body,
          bytes,
          bitLength: description.terminal.bitLength,
          interval: description.interval,
          trace: description.trace
        };
      });
      checkPredictionDeadline(deadline);
      return candidates;
    } finally {
      budget.expires = Infinity;
    }
  }

  function decodeRational(source, { deadline = Infinity } = {}) {
    if (typeof source?.bit !== 'function')
      throw new Error('Invalid mixed prediction source');
    checkPredictionDeadline(deadline);
    budget.expires = deadline;
    try {
      const result = codec.decodeRational(source);
      const input = decoder.decode(result.bytes);
      validate(input);
      checkPredictionDeadline(deadline);
      return { input, ...result };
    } finally {
      budget.expires = Infinity;
    }
  }

  return Object.freeze({ encodeCandidates, decodeRational });
}
