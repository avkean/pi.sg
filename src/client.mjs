import { createEncoder as createBoundedEncoder } from '../codecs/core/client.mjs';
import { encodeFast, normalizeOrigin } from './fast.mjs';
import { renderResult } from './surface.mjs';

export function createEncoder({
  workerUrl = new URL('./worker.js', import.meta.url),
  ...limits
} = {}) {
  const bounded = createBoundedEncoder({ ...limits, workerUrl });
  return {
    preload: () => bounded.preload(),
    close: () => bounded.close(),
    async encode(input, { origin = 'https://pi.sg', format = 'compact' } = {}) {
      const base = normalizeOrigin(origin);
      const result = await bounded.encode(input, { origin: base });
      if (result.limited) {
        const fast = encodeFast(input, { origin: base });
        return renderResult(
          { ...fast, limited: true, reason: result.reason },
          { origin: base, format }
        );
      }
      if (result.payload && result.codec !== 'original')
        return renderResult(result, { origin: base, format });
      // Older workers may return the input unchanged. Always encode it instead.
      return renderResult(
        {
          ...encodeFast(input, { origin: base }),
          limited: true,
          reason: result.reason ?? 'worker-original'
        },
        { origin: base, format }
      );
    }
  };
}
