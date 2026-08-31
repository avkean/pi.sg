import { readFile } from 'node:fs/promises';
import { parentPort } from 'node:worker_threads';
import { createCompressor } from './server-compressor.mjs';
const compressor = createCompressor(
  await readFile(new URL('../models/context-v1.bin', import.meta.url))
);
compressor.warmup();
parentPort.on('message', ({ id, input }) => {
  try {
    parentPort.postMessage({
      id,
      type: 'encoded',
      candidates: compressor.encodeAdditional(input)
    });
  } catch {
    parentPort.postMessage({ id, type: 'invalid' });
  }
});
parentPort.postMessage({ type: 'ready' });
