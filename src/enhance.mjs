import { renderResult } from './surface.mjs';

export async function enhance(
  input,
  { origin, format = 'compact', signal, fetchImpl = fetch } = {}
) {
  if (typeof input !== 'string' || !input.isWellFormed()) return null;
  if (new TextEncoder().encode(input).length > 32 * 1024) return null;
  const timeout = AbortSignal.timeout(1500);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await fetchImpl(new URL('/api/compress', origin), {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Pi-Format': format
      },
      body: input,
      signal: combined,
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      redirect: 'error'
    });
    if (
      response.status !== 200 ||
      !/^application\/json(?:;|$)/i.test(
        response.headers.get('content-type') || ''
      )
    )
      return null;
    // Stop oversized responses before buffering them.
    const reader = response.body.getReader(),
      chunks = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 10000) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const result = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    );
    if (
      typeof result.codec !== 'string' ||
      result.codec.length > 64 ||
      typeof result.payload !== 'string'
    )
      return null;
    return {
      ...renderResult(
        { codec: result.codec, payload: result.payload },
        { origin, format }
      ),
      enhanced: true
    };
  } catch {
    return null;
  }
}
