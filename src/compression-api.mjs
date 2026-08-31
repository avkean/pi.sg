import { MAX_SERVER_INPUT_BYTES } from './compression-pool.mjs';
import { renderResult } from './surface.mjs';

// One process-wide budget: no IP addresses, input strings or results are kept.
export function createCompressionAPI({
  pool,
  origin,
  now = () => performance.now()
}) {
  let tokens = 10,
    updated = now();
  return async function compress(req, res, send) {
    if (req.method !== 'POST')
      return send(req, res, 405, 'Use POST.', { Allow: 'POST' });
    if (
      (req.headers.origin && req.headers.origin !== origin) ||
      req.headers['sec-fetch-site'] === 'cross-site'
    ) {
      return send(req, res, 403, 'Use the compressor on this site.');
    }
    if (
      !/^text\/plain(?:;\s*charset=utf-8)?$/i.test(
        req.headers['content-type'] || ''
      )
    )
      return send(req, res, 415, 'Send a web address as UTF-8 text.');
    const format = req.headers['x-pi-format'] || 'compact';
    if (format !== 'compact' && format !== 'ascii')
      return send(req, res, 400, 'Invalid link format.');
    const length = req.headers['content-length'];
    if (
      length !== undefined &&
      (!/^\d+$/.test(length) || Number(length) > MAX_SERVER_INPUT_BYTES)
    )
      return send(
        req,
        res,
        413,
        'Use browser compression for addresses over 32 KiB.'
      );
    const current = now();
    tokens = Math.min(10, tokens + Math.max(0, current - updated) / 100);
    updated = current;
    if (tokens < 1)
      return send(req, res, 429, 'Extra compression is busy.', {
        'Retry-After': '1'
      });
    tokens--;
    const controller = new AbortController();
    const disconnected = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once('close', disconnected);
    const timer = setTimeout(() => {
      controller.abort();
      req.destroy();
    }, 1500);
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_SERVER_INPUT_BYTES) {
          controller.abort();
          return send(
            req,
            res,
            413,
            'Use browser compression for addresses over 32 KiB.'
          );
        }
        chunks.push(chunk);
      }
      clearTimeout(timer);
      const input = new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: true
      }).decode(Buffer.concat(chunks, size));
      const candidates = await pool.encode(input, {
        signal: controller.signal
      });
      let best = null;
      for (const candidate of candidates) {
        let result;
        try {
          result = renderResult(candidate, { origin, format });
        } catch {
          continue;
        }
        if (
          !best ||
          result.url.length < best.url.length ||
          (result.url.length === best.url.length &&
            result.asciiPayload.length < best.asciiPayload.length)
        )
          best = result;
      }
      if (!best) return send(req, res, 204);
      // Return only the link representation, never echo the submitted address.
      send(
        req,
        res,
        200,
        JSON.stringify({ codec: best.codec, payload: best.asciiPayload }),
        { 'Content-Type': 'application/json; charset=utf-8' }
      );
    } catch (error) {
      if (res.destroyed) return;
      const invalid = error.code === 'INVALID' || error instanceof TypeError;
      send(
        req,
        res,
        invalid ? 400 : 503,
        invalid ? 'Invalid web address.' : 'Extra compression is busy.',
        invalid ? {} : { 'Retry-After': '1' }
      );
    } finally {
      clearTimeout(timer);
      res.removeListener('close', disconnected);
    }
  };
}
