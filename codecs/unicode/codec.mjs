import {
  deflateRawSync,
  inflateRawSync,
  brotliCompressSync,
  brotliDecompressSync,
  constants as z
} from 'node:zlib';
import {
  MAX_BYTES,
  MODES,
  Writer,
  Reader,
  fail,
  equal,
  transform,
  restore,
  splitHigh,
  joinHigh
} from './transform.mjs';
import { createCodec as createSubword } from '../compact/subword.mjs';
import { createCodec as createContext } from '../compact/context.mjs';
import { unpackModel } from '../core/context/model-format.mjs';
import subwordModel from '../core/subword/model.mjs';
import { seal, verify, toBase64, fromBase64 } from '../core/bytes.mjs';
import { toWide, fromWide } from '../../src/wide.mjs';

export const MAX_INPUT_BYTES = MAX_BYTES,
  MAX_TRANSFORM_BYTES = MAX_BYTES;
export const MAX_ENHANCER_INPUT_BYTES = 32 * 1024;
export const MAX_BODY_BYTES = 6128,
  MAX_LINK_CHARS = 8192,
  MAX_SKELETON_BYTES = 2048;
export const MARKER = 'u'; // Issued server Unicode format; retain its decoder and transforms.
const encoder = new TextEncoder(),
  decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const ORIGIN = 'https://pi.sg/';
function valid(input) {
  return (
    typeof input === 'string' &&
    input.length <= MAX_BYTES &&
    /^https?:\/\//i.test(input) &&
    !/[\u0000-\u0020\u007f]/.test(input) &&
    URL.canParse(input) &&
    input.isWellFormed()
  );
}
function inputBytes(input) {
  if (!valid(input)) return null;
  const raw = encoder.encode(input);
  return raw.length <= MAX_BYTES ? raw : null;
}
function compress(bytes, method, quality) {
  if (method === 0) return bytes;
  if (method === 1) return deflateRawSync(bytes, { level: 6 });
  if (method === 2)
    return brotliCompressSync(bytes, {
      params: {
        [z.BROTLI_PARAM_QUALITY]: quality,
        [z.BROTLI_PARAM_LGWIN]: 17,
        [z.BROTLI_PARAM_SIZE_HINT]: bytes.length
      }
    });
  fail('Unknown compressor');
}
function decompress(bytes, method, limit) {
  if (!bytes.length || limit < 1 || limit > MAX_BYTES)
    fail('Invalid compressed length');
  if (method === 0) {
    if (bytes.length > limit) fail('Decoded length limit');
    return bytes;
  }
  if (method !== 1 && method !== 2) fail('Unknown compressor');
  // RFC 7932 section 9.1. Reject >17-bit windows and reserved/large-window
  // escapes before entering native Brotli. Accept standard windows 10..17.
  if (
    method === 2 &&
    bytes[0] & 1 &&
    ((bytes[0] & 15) !== 1 || (bytes[0] & 127) === 17)
  )
    fail('Brotli window limit');
  const options = {
    maxOutputLength: limit,
    info: true,
    rejectGarbageAfterEnd: true
  };
  if (method === 2)
    options.params = { [z.BROTLI_DECODER_PARAM_LARGE_WINDOW]: 0 };
  const result =
    method === 1
      ? inflateRawSync(bytes, options)
      : brotliDecompressSync(bytes, options);
  // bytesWritten also rejects trailing bytes on Node versions predating the
  // rejectGarbageAfterEnd option. Never decode an unbounded temporary first.
  if (
    result.engine.bytesWritten !== bytes.length ||
    result.buffer.length > limit
  )
    fail('Trailing compressed data');
  return result.buffer;
}
function makeBody(
  rawLength,
  layout,
  mode,
  method,
  compressed,
  skeleton,
  skeletonMethod
) {
  const out = new Writer(MAX_BYTES);
  out.put(0x10 | layout);
  out.put(MODES.indexOf(mode) | (method << 4));
  out.uint(rawLength);
  if (layout) {
    out.put(skeletonMethod);
    out.uint(skeleton.length);
    out.append(skeleton);
  }
  out.append(compressed);
  return out.finish();
}
export function measureBody(body) {
  // Exact transport cost, including 32-bit CRC, six-bit marker, base64 padding
  // removal, the wide sentinel, and all method/length headers in body.
  const ascii = 1 + Math.ceil(((body.length + 4) * 8) / 6),
    wide = Math.ceil((ascii * 6 + 1) / 15);
  const compactFits = ORIGIN.length + wide * 9 <= MAX_LINK_CHARS;
  return {
    bodyBytes: body.length,
    asciiTail: ascii,
    visibleTail: compactFits ? wide : ascii,
    utf8Tail: compactFits ? wide * 3 : ascii,
    serializedTail: compactFits ? wide * 9 : ascii,
    visibleFull: ORIGIN.length + (compactFits ? wide : ascii),
    serializedFull: ORIGIN.length + (compactFits ? wide * 9 : ascii)
  };
}
export function renderBody(body, raw, format = 'compact') {
  if (!['ascii', 'compact'].includes(format)) fail('Unknown transport');
  const asciiPayload = MARKER + toBase64(seal(body, raw));
  if (asciiPayload.length + ORIGIN.length > MAX_LINK_CHARS)
    fail('Link length limit');
  const wide = toWide(asciiPayload),
    payload =
      format === 'compact' &&
      new URL(ORIGIN + wide).href.length <= MAX_LINK_CHARS
        ? wide
        : asciiPayload;
  return {
    body,
    asciiPayload,
    payload,
    url: ORIGIN + payload,
    metrics: {
      bodyBytes: body.length,
      asciiTail: asciiPayload.length,
      visibleTail: [...payload].length,
      utf8Tail: encoder.encode(payload).length,
      serializedTail: new URL(ORIGIN + payload).href.length - ORIGIN.length,
      visibleFull: ORIGIN.length + [...payload].length,
      serializedFull: new URL(ORIGIN + payload).href.length
    }
  };
}

/** Node-only candidate. Optional frozen P model adds a second ASCII skeleton codec.
 * This factory neither imports nor modifies the app's encoder/decoder registry.
 */
export function createUnicodeCodec(contextModelBytes) {
  let subword, context;
  const getS = () =>
    (subword ??= createSubword(subwordModel, {
      maxInputBytes: MAX_SKELETON_BYTES
    }));
  const getP = () => {
    if (!contextModelBytes) fail('Context model required for this body');
    return (context ??= createContext(unpackModel(contextModelBytes)));
  };
  function encodeBody(
    input,
    { profile = 'small', quality = 5, format = 'compact' } = {}
  ) {
    if (
      !['small', 'fast', 'thorough'].includes(profile) ||
      ![4, 5, 6].includes(quality) ||
      !['compact', 'ascii'].includes(format)
    )
      fail('Invalid encoding option');
    const raw = inputBytes(input);
    if (
      !raw ||
      (profile === 'small' && raw.length > MAX_ENHANCER_INPUT_BYTES) ||
      !/[%\u0080-\uffff]/.test(input)
    )
      return null;
    const large = raw.length > 8192;
    const modes =
      profile === 'thorough'
        ? MODES
        : large || profile === 'small'
          ? ['bytes', 'split16', 'window']
          : ['bytes', 'utf16le', 'split16', 'window'];
    let best = null;
    const attempts = { transforms: 0, compressions: 0, bodyCandidates: 0 };
    const compressedCache = new WeakMap();
    function offer(layout, mode, bytes, sk, skMethod) {
      const methods =
        profile !== 'small'
          ? [0, 1, 2]
          : layout
            ? [0, 1]
            : large
              ? [2]
              : mode === 'bytes'
                ? [1, 2]
                : [1];
      for (const method of methods) {
        let cached = compressedCache.get(bytes);
        if (!cached) {
          cached = new Map();
          compressedCache.set(bytes, cached);
        }
        let compressed = cached.get(method);
        if (!compressed) {
          if (method) attempts.compressions++;
          compressed = compress(bytes, method, quality);
          cached.set(method, compressed);
        }
        attempts.bodyCandidates++;
        if (compressed.length > MAX_BODY_BYTES) continue;
        const body = makeBody(
          raw.length,
          layout,
          mode,
          method,
          compressed,
          sk,
          skMethod
        );
        if (body.length > MAX_BODY_BYTES) continue;
        const metrics = measureBody(body),
          score = format === 'ascii' ? metrics.asciiTail : metrics.visibleTail;
        if (
          !best ||
          score < best.score ||
          (score === best.score && body.length < best.body.length)
        )
          best = {
            body,
            score,
            info: {
              layout: layout ? 'split' : 'whole',
              mode,
              method: ['raw', 'deflate6', 'brotli'][method],
              quality: method === 2 ? quality : null,
              skeleton: layout ? ['S', 'P', 'brotli'][skMethod] : null
            }
          };
      }
    }
    for (const mode of modes) {
      let bytes;
      try {
        attempts.transforms++;
        bytes = transform(raw, mode);
      } catch (e) {
        if (e.message !== 'Transform output limit') throw e;
        continue;
      }
      offer(0, mode, bytes);
    }
    // Learned URL models are only attempted on small ASCII skeletons. Long
    // inputs use the bounded native compressors and no arithmetic-model work.
    if (!large) {
      const { skeleton, parts } = splitHigh(raw);
      if (
        parts.length &&
        parts.length <= 128 &&
        skeleton.length <= MAX_SKELETON_BYTES
      ) {
        const skeletons = [[0, getS().encodeBytes(skeleton)]];
        attempts.compressions++;
        if (contextModelBytes) {
          skeletons.push([1, getP().encode(decoder.decode(skeleton))]);
          attempts.compressions++;
        }
        for (const mode of profile === 'small'
          ? ['bytes', 'utf16le', 'split16', 'window']
          : modes) {
          const side = new Writer();
          let bytes;
          try {
            for (const p of parts) {
              attempts.transforms++;
              const b = transform(p, mode);
              side.uint(b.length);
              side.append(b);
            }
            bytes = side.finish();
          } catch (e) {
            if (e.message !== 'Transform output limit') throw e;
            continue;
          }
          for (const [skMethod, sk] of skeletons)
            offer(1, mode, bytes, sk, skMethod);
        }
      }
    }
    return best ? { body: best.body, info: { ...best.info, attempts } } : null;
  }
  function decodeBody(body) {
    if (
      !(body instanceof Uint8Array) ||
      body.length < 4 ||
      body.length > MAX_BODY_BYTES
    )
      fail('Invalid Unicode body');
    const r = new Reader(body),
      version = r.byte(),
      flags = r.byte(),
      layout = version & 1;
    if (
      (version & 0xfe) !== 0x10 ||
      flags & 0xc0 ||
      (flags & 15) >= MODES.length ||
      flags >>> 4 > 2
    )
      fail('Unsupported Unicode body');
    const mode = MODES[flags & 15],
      method = flags >>> 4,
      originalLength = r.uint();
    if (originalLength < 8) fail('Invalid original length');
    let raw;
    if (!layout)
      raw = restore(
        decompress(r.take(r.remaining), method, MAX_BYTES),
        mode,
        originalLength
      );
    else {
      const skMethod = r.byte(),
        skLength = r.uint(MAX_BODY_BYTES),
        sk = r.take(skLength);
      let skeleton;
      if (!skLength || skMethod > 2) fail('Invalid skeleton method');
      if (skMethod === 0) skeleton = getS().decodeBytes(sk);
      else if (skMethod === 1) {
        skeleton = encoder.encode(
          getP().decode(sk, { maxBytes: MAX_SKELETON_BYTES })
        );
        if (!equal(getP().encode(decoder.decode(skeleton)), sk))
          fail('Noncanonical context skeleton');
      } else skeleton = decompress(sk, 2, MAX_SKELETON_BYTES);
      if (skeleton.length > MAX_SKELETON_BYTES) fail('Skeleton limit');
      const side = decompress(r.take(r.remaining), method, MAX_BYTES);
      raw = joinHigh(skeleton, side, mode, originalLength);
      const canonical = splitHigh(raw),
        expected = new Writer();
      if (
        !canonical.parts.length ||
        canonical.parts.length > 128 ||
        !equal(canonical.skeleton, skeleton)
      )
        fail('Noncanonical skeleton');
      for (const p of canonical.parts) {
        const b = transform(p, mode);
        expected.uint(b.length);
        expected.append(b);
      }
      if (!equal(expected.finish(), side)) fail('Noncanonical side stream');
    }
    if (raw.length !== originalLength) fail('Original length mismatch');
    const input = decoder.decode(raw);
    if (!valid(input)) fail('Invalid HTTP(S) destination');
    return input;
  }
  function encode(input, options = {}) {
    const result = encodeBody(input, options);
    return result
      ? {
          ...renderBody(result.body, encoder.encode(input), options.format),
          info: result.info
        }
      : null;
  }
  function decode(payload) {
    if (
      typeof payload !== 'string' ||
      !payload ||
      payload.length > MAX_LINK_CHARS
    )
      fail('Payload length limit');
    if (payload.includes('%')) {
      if (!/^(?:%[\da-fA-F]{2})+$/.test(payload))
        fail('Invalid serialized payload');
      payload = decodeURIComponent(payload);
      if (!/[^\x00-\x7f]/.test(payload))
        fail('Escaped ASCII is not a transport');
    }
    const ascii = /[^\x00-\x7f]/.test(payload) ? fromWide(payload) : payload;
    if (ascii[0] !== MARKER || ascii.length + ORIGIN.length > MAX_LINK_CHARS)
      fail('Unknown experimental marker');
    const frame = fromBase64(ascii.slice(1));
    if (frame.length < 8) fail('Truncated frame');
    const input = decodeBody(frame.subarray(4));
    verify(frame, encoder.encode(input));
    return input;
  }
  return Object.freeze({ encode, decode, encodeBody, decodeBody });
}
