import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { gzip, brotliCompress, constants } from 'node:zlib';
import { createRedirectPool } from './src/redirect-pool.mjs';
import { createCompressionPool } from './src/compression-pool.mjs';
import { createCompressionAPI } from './src/compression-api.mjs';

const gzipAsync = promisify(gzip),
  brotliAsync = promisify(brotliCompress);
const root = new URL('./', import.meta.url);
const securityHeaders = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; worker-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff'
});
const routes = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/privacy', ['public/privacy.html', 'text/html; charset=utf-8']],
  ['/privacy/', ['public/privacy.html', 'text/html; charset=utf-8']],
  ['/assets/style.css', ['public/style.css', 'text/css; charset=utf-8']],
  ['/assets/app.js', ['dist/app.js', 'text/javascript; charset=utf-8']],
  ['/assets/worker.js', ['dist/worker.js', 'text/javascript; charset=utf-8']],
  ['/favicon.svg', ['public/favicon.svg', 'image/svg+xml']],
  ['/avkean_light.svg', ['public/avkean_light.svg', 'image/svg+xml']],
  ['/avkean_dark.svg', ['public/avkean_dark.svg', 'image/svg+xml']],
  [
    '/models/context-v1.bin',
    ['./models/context-v1.bin', 'application/octet-stream']
  ]
]);
const invalidAsset = ['public/invalid.html', 'text/html; charset=utf-8'];
const confirmationAsset = ['public/confirm.html', 'text/html; charset=utf-8'];

function encodingFor(header = '') {
  const qualities = new Map();
  for (const item of header.toLowerCase().split(',')) {
    const [name, ...parameters] = item.trim().split(';');
    const parameter = parameters
      .map((p) => p.trim())
      .find((p) => p.startsWith('q='));
    const q = parameter === undefined ? 1 : Number(parameter.slice(2));
    qualities.set(name, Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0);
  }
  const quality = (name) => qualities.get(name) ?? qualities.get('*') ?? 0;
  const br = quality('br'),
    gz = quality('gzip');
  const identity =
    qualities.get('identity') ?? (qualities.get('*') === 0 ? 0 : 1);
  if (br > 0 && br >= gz && br >= identity) return 'br';
  if (gz > 0 && gz >= identity) return 'gzip';
  return identity > 0 ? 'identity' : null;
}

export async function serve({
  port = 8788,
  host = '127.0.0.1',
  publicOrigin,
  testMode = false
} = {}) {
  if (publicOrigin !== undefined) {
    const address = new URL(publicOrigin);
    if (
      !['http:', 'https:'].includes(address.protocol) ||
      address.username ||
      address.password ||
      address.href !== address.origin + '/'
    )
      throw new Error('PI_APP_ORIGIN must be an HTTP or HTTPS origin.');
    publicOrigin = address.origin;
  }
  const pool = await createRedirectPool();
  let compressionPool;
  try {
    compressionPool = await createCompressionPool();
  } catch {
    compressionPool = {
      encode: async () => {
        throw Error('Unavailable');
      },
      close: async () => {}
    };
  }
  const assets = new Map();
  let closePromise, compressionAPI;

  // Only fixed routes may reach the filesystem.
  function loadAsset([file, type]) {
    if (!assets.has(file)) {
      const pending = readFile(new URL(file, root))
        .then(async (bytes) => {
          const [br, gz] = await Promise.all([
            brotliAsync(bytes, {
              params: { [constants.BROTLI_PARAM_QUALITY]: 5 }
            }),
            gzipAsync(bytes)
          ]);
          const etag = `W/"${createHash('sha256').update(bytes).digest('base64url')}"`;
          return { type, identity: bytes, br, gzip: gz, etag };
        })
        .catch((error) => {
          assets.delete(file);
          throw error;
        });
      assets.set(file, pending);
    }
    return assets.get(file);
  }

  function send(req, res, status, body = '', headers = {}) {
    if (res.destroyed || res.writableEnded) return;
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
    res.writeHead(status, {
      ...securityHeaders,
      'Content-Type': 'text/plain; charset=utf-8',
      ...(status !== 204 && status !== 304
        ? { 'Content-Length': bytes.length }
        : {}),
      ...headers
    });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  }

  async function sendAsset(req, res, descriptor, status, immutable = false) {
    const asset = await loadAsset(descriptor);
    const encoding =
      encodingFor(req.headers['accept-encoding']) ||
      (status === 400 ? 'identity' : null);
    if (!encoding)
      return send(req, res, 406, 'No acceptable representation.', {
        Vary: 'Accept-Encoding'
      });
    const headers = {
      'Content-Type': asset.type,
      'Cache-Control':
        status === 200
          ? immutable
            ? 'public, max-age=31536000, immutable'
            : 'no-cache'
          : 'no-store',
      Vary: 'Accept-Encoding',
      ...(status === 200 ? { ETag: asset.etag } : {}),
      ...(encoding !== 'identity' ? { 'Content-Encoding': encoding } : {})
    };
    if (
      status === 200 &&
      req.headers['if-none-match']?.split(',').some((tag) => {
        const value = tag.trim();
        return (
          value === '*' || value.replace(/^W\//, '') === asset.etag.slice(2)
        );
      })
    )
      return send(req, res, 304, '', headers);
    send(req, res, status, asset[encoding], headers);
  }

  async function invalid(req, res) {
    try {
      await sendAsset(req, res, invalidAsset, 400);
    } catch {
      send(req, res, 400, 'This link is invalid, damaged, or unsupported.');
    }
  }

  async function confirm(req, res, destination) {
    const template = await loadAsset(confirmationAsset);
    // Work backwards from the path so lookalike text in credentials isn't highlighted.
    const hostEnd = destination.href.indexOf(
      '/',
      destination.protocol.length + 2
    );
    const hostStart = hostEnd - destination.host.length;
    const values = {
      prefix: destination.href.slice(0, hostStart),
      host: destination.host,
      suffix: destination.href.slice(hostEnd),
      url: destination.href
    };
    const escapes = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };
    const page = template.identity
      .toString()
      .replace(/\{\{(prefix|host|suffix|url)\}\}/g, (_, key) =>
        values[key].replace(/[&<>"']/g, (character) => escapes[character])
      );
    send(req, res, 200, page, {
      'Content-Type': confirmationAsset[1],
      'X-Robots-Tag': 'noindex, nofollow'
    });
  }

  async function handle(req, res) {
    if (req.url === '/api/compress') return compressionAPI(req, res, send);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(req, res, 405, 'Use GET or HEAD.', { Allow: 'GET, HEAD' });
    }
    const raw = req.url;
    if (raw === '/health') return send(req, res, 200, 'ok');
    if (
      testMode &&
      /^\/test\/landing(?:[/?][A-Za-z0-9_~.!$&'()*+,;=:@%/?-]*)?$/.test(raw)
    ) {
      return send(req, res, 200, 'Local test destination reached.');
    }
    const descriptor = routes.get(raw);
    if (descriptor) {
      try {
        return await sendAsset(
          req,
          res,
          descriptor,
          200,
          raw === '/models/context-v1.bin'
        );
      } catch {
        return send(req, res, 503, 'This asset is not available yet.', {
          'Retry-After': '1'
        });
      }
    }
    if (typeof raw !== 'string' || raw[0] !== '/' || raw.length > 8193) {
      return invalid(req, res);
    }
    const marked = raw.endsWith('~');
    const encoded = raw.slice(1, marked ? -1 : undefined);
    if (!encoded || /[/?#\\]/.test(encoded)) return invalid(req, res);
    let payload = encoded;
    if (encoded.includes('%')) {
      try {
        if (!/^(?:%[A-Fa-f0-9]{2})+$/.test(encoded)) return invalid(req, res);
        payload = decodeURIComponent(encoded);
        if (
          !payload.isWellFormed() ||
          !/[^\x00-\x7f]/.test(payload) ||
          /[%/?#\\]/.test(payload)
        )
          return invalid(req, res);
      } catch {
        return invalid(req, res);
      }
    }

    const controller = new AbortController();
    const disconnected = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once('close', disconnected);
    try {
      const decoded = await pool.decode(payload, { signal: controller.signal });
      const destination = new URL(decoded);
      if (
        destination.protocol !== 'http:' &&
        destination.protocol !== 'https:'
      ) {
        return invalid(req, res);
      }
      await confirm(req, res, destination);
    } catch (error) {
      if (res.destroyed) return;
      if (error.code === 'INVALID') return invalid(req, res);
      send(req, res, 503, 'The decoder is busy. Please try again.', {
        'Retry-After': '1'
      });
    } finally {
      res.removeListener('close', disconnected);
    }
  }

  const server = http.createServer(
    {
      maxHeaderSize: 16 * 1024,
      headersTimeout: 5000,
      requestTimeout: 5000,
      keepAliveTimeout: 5000
    },
    (req, res) => {
      handle(req, res).catch(() =>
        send(req, res, 503, 'Service unavailable.', { 'Retry-After': '1' })
      );
    }
  );

  function rejectSocket(socket, status, message, headers = {}) {
    if (socket.destroyed || !socket.writable || socket.writableEnded) return;
    const body = Buffer.from(message);
    const fields = {
      ...securityHeaders,
      ...headers,
      Connection: 'close',
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': body.length
    };
    socket.end(
      `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\n${Object.entries(
        fields
      )
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join('')}\r\n${message}`
    );
  }
  server.on('connect', (_req, socket) =>
    rejectSocket(socket, 405, 'Use GET or HEAD.', { Allow: 'GET, HEAD' })
  );
  server.on('upgrade', (req, socket) =>
    rejectSocket(
      socket,
      req.method === 'GET' || req.method === 'HEAD' ? 400 : 405,
      'Protocol upgrades are unavailable.'
    )
  );
  server.on('clientError', (error, socket) => {
    rejectSocket(
      socket,
      error.code === 'HPE_HEADER_OVERFLOW' ? 431 : 400,
      'Invalid request.'
    );
  });

  try {
    server.listen(port, host);
    await once(server, 'listening');
  } catch (error) {
    server.close();
    await pool.close();
    await compressionPool.close();
    throw error;
  }
  const origin = `http://${host.includes(':') ? `[${host}]` : host}:${server.address().port}`;
  compressionAPI = createCompressionAPI({
    pool: compressionPool,
    origin: publicOrigin ?? origin
  });
  return {
    server,
    origin,
    close() {
      if (!closePromise) {
        closePromise = Promise.all([
          pool.close(),
          compressionPool.close(),
          new Promise((resolveClose) => {
            server.close(resolveClose);
            server.closeAllConnections();
          })
        ]).then(() => {});
      }
      return closePromise;
    }
  };
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const running = await serve({
      port: Number(process.env.PI_APP_PORT || 8788),
      host: process.env.PI_APP_HOST || '127.0.0.1',
      publicOrigin: process.env.PI_APP_ORIGIN
    });
    console.log(`Pi: ${running.origin}`);
    const stop = () => {
      void running.close();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch {
    console.error('Could not start Pi.');
    process.exitCode = 1;
  }
}
