import { readFile } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { createCompressor } from './server-compressor.mjs';

const model = await readFile(
  new URL('../models/context-v1.bin', import.meta.url)
);
const pi = createCompressor(model, workerData);
pi.warmup({ decoder: true });

parentPort.on('message', ({ id, payload }) => {
  try {
    const decoded = pi.decode(payload);
    parentPort.postMessage({ id, type: 'decoded', decoded });
  } catch {
    // Neither the submitted payload nor decoder error text leaves this worker.
    parentPort.postMessage({ id, type: 'invalid' });
  }
});
parentPort.postMessage({ type: 'ready' });
