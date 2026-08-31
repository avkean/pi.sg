import { createCompressor } from './compressor.mjs';
const ready = fetch(new URL('../models/context-v1.bin', import.meta.url), {
  signal: AbortSignal.timeout(10000)
}).then(async (response) => {
  if (!response.ok) throw Error('Compressor unavailable');
  return createCompressor(new Uint8Array(await response.arrayBuffer()));
});
ready
  .then(() => postMessage({ ready: true }))
  .catch(() => postMessage({ startupError: 'Compressor unavailable' }));
self.onmessage = async ({ data: { id, input, options } }) => {
  try {
    postMessage({ id, result: (await ready).encode(input, options) });
  } catch (error) {
    postMessage({ id, error: String(error) });
  }
};
