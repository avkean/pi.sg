import { readFile } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { createDecoder } from './server-compressor.mjs';
import { isPredictionDeadline } from '../codecs/predict/deadline.mjs';

const model = await readFile(
  new URL('../models/context-v1.bin', import.meta.url)
);
const pi = createDecoder(model, workerData);
pi.warmup();

parentPort.on('message', ({ id, payload, timeoutMs }) => {
  try {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300)
      throw new Error('Invalid decode timeout');
    const decoded = pi.decode(payload, {
      deadline: performance.now() + timeoutMs
    });
    parentPort.postMessage({ id, type: 'decoded', decoded });
  } catch (error) {
    // Neither the submitted payload nor decoder error text leaves this worker.
    parentPort.postMessage({
      id,
      type: isPredictionDeadline(error) ? 'timeout' : 'invalid'
    });
  }
});
parentPort.postMessage({ type: 'ready' });
