import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { isNativeFrame } from './native-frame.mjs';
import { isDense, isDenseWide } from './dense.mjs';
import { recoverCanonical } from './wide.mjs';
import { shareContext } from '../codecs/predict/models.mjs';
import { isMixedInput } from '../codecs/mixed/frame.mjs';

export class RedirectError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RedirectError';
    this.code = code;
  }
}

function isWideInput(payload) {
  try {
    recoverCanonical(payload);
    return true;
  } catch {
    return false;
  }
}

// One persistent decoder, at most 16 waiting requests, and no result cache.
// The 128 MiB V8 heap budget does not include Node's native allocations.
export async function createRedirectPool({
  workerURL = new URL('./redirect-worker.mjs', import.meta.url),
  deadlineMs = 300,
  startupTimeoutMs = 10_000,
  maxQueue = 16
} = {}) {
  for (const value of [deadlineMs, startupTimeoutMs]) {
    if (!Number.isFinite(value) || value <= 0)
      throw new RangeError('Invalid timeout');
  }
  if (!Number.isInteger(maxQueue) || maxQueue < 0 || maxQueue > 16) {
    throw new RangeError('Queue capacity must be between 0 and 16');
  }

  let current = null,
    closed = false,
    closePromise,
    sequence = 0;
  const queue = [],
    terminations = new Set();
  const failure = (code) => new RedirectError(code);

  function settle(job, error, decoded) {
    if (!job || job.settled) return;
    job.settled = true;
    job.signal?.removeEventListener('abort', job.abort);
    if (error) job.reject(error);
    else job.resolve(decoded);
  }

  function finish(job, error, decoded) {
    if (!job || job.released) return;
    job.released = true;
    clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.abort);
    const index = queue.indexOf(job);
    if (index !== -1) queue.splice(index, 1);
    if (current?.job === job) current.job = null;
    settle(job, error, decoded);
  }

  function rejectQueue(error) {
    for (const job of [...queue]) finish(job, error);
  }

  function retire(slot, error, restart) {
    if (slot.retired) return;
    slot.retired = true;
    clearTimeout(slot.startupTimer);
    slot.rejectReady(error);
    finish(slot.job, error);
    // Wait for termination before allocating a replacement worker.
    const stopping = slot.worker
      .terminate()
      .catch(() => {})
      .then(() => {
        if (current === slot) current = null;
        if (!closed && restart) spawn().catch(rejectQueue);
      });
    terminations.add(stopping);
    stopping.then(() => terminations.delete(stopping));
  }

  function dispatch() {
    const slot = current;
    if (closed || !slot?.ready || slot.retired || slot.job) return;
    let job;
    while ((job = queue.shift())) {
      if (performance.now() >= job.expires) {
        finish(job, failure('DEADLINE'));
        continue;
      }
      slot.job = job;
      try {
        slot.worker.postMessage({
          id: job.id,
          payload: job.payload,
          timeoutMs: Math.min(
            300,
            Math.max(1, Math.floor(job.expires - performance.now() - 10))
          )
        });
      } catch {
        retire(slot, failure('UNAVAILABLE'), true);
      }
      return;
    }
  }

  function spawn() {
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    let worker;
    try {
      worker = new Worker(workerURL, {
        execArgv: [],
        workerData: { sharedContext: shareContext() },
        resourceLimits: {
          maxOldGenerationSizeMb: 112,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4
        },
        // Decoder output must never become a destination/request log.
        stdout: true,
        stderr: true
      });
    } catch {
      rejectReady(failure('UNAVAILABLE'));
      return ready;
    }
    worker.stdout.resume();
    worker.stderr.resume();
    const slot = {
      worker,
      rejectReady,
      ready: false,
      retired: false,
      job: null
    };
    current = slot;
    slot.startupTimer = setTimeout(() => {
      const error = failure('UNAVAILABLE');
      retire(slot, error, false);
      rejectQueue(error);
    }, startupTimeoutMs);
    const failed = () => {
      if (slot.retired) return;
      const error = failure('UNAVAILABLE');
      retire(slot, error, slot.ready);
      if (!slot.ready) rejectQueue(error);
    };
    worker.once('error', failed);
    worker.once('exit', failed);
    worker.on('message', (message) => {
      if (slot.retired || current !== slot) return;
      if (!slot.ready && message?.type === 'ready') {
        slot.ready = true;
        clearTimeout(slot.startupTimer);
        resolveReady();
        dispatch();
        return;
      }
      const job = slot.job;
      if (!slot.ready || !job || message?.id !== job.id) return failed();
      if (performance.now() >= job.expires) {
        return retire(slot, failure('DEADLINE'), true);
      }
      if (message.type === 'decoded' && typeof message.decoded === 'string') {
        finish(job, null, message.decoded);
      } else if (message.type === 'timeout') {
        finish(job, failure('DEADLINE'));
      } else if (message.type === 'invalid') {
        finish(job, failure('INVALID'));
      } else {
        return failed();
      }
      dispatch();
    });
    return ready;
  }

  function decode(payload, { signal } = {}) {
    if (closed) return Promise.reject(failure('CLOSED'));
    if (signal?.aborted) return Promise.reject(failure('ABORTED'));
    if (
      typeof payload !== 'string' ||
      (!/^[A-Za-z0-9_-]{6,8192}$/.test(payload) &&
        !isDense(payload) &&
        !isDenseWide(payload) &&
        !isWideInput(payload) &&
        !isNativeFrame(payload) &&
        !isMixedInput(payload))
    ) {
      return Promise.reject(failure('INVALID'));
    }
    const idle = current?.ready && !current.retired && !current.job;
    if (!idle && queue.length >= maxQueue)
      return Promise.reject(failure('BUSY'));
    const result = new Promise((resolve, reject) => {
      const job = {
        id: ++sequence,
        payload,
        resolve,
        reject,
        signal,
        expires: performance.now() + deadlineMs,
        settled: false,
        released: false
      };
      const cancel = (code) => {
        const active = current?.job === job;
        const error = failure(code);
        if (active && code === 'ABORTED') {
          settle(job, error);
        } else {
          finish(job, error);
          if (active) retire(current, error, true);
          else dispatch();
        }
      };
      job.timer = setTimeout(() => cancel('DEADLINE'), deadlineMs);
      job.abort = () => cancel('ABORTED');
      signal?.addEventListener('abort', job.abort, { once: true });
      queue.push(job);
    });
    if (!current) spawn().catch(rejectQueue);
    dispatch();
    return result;
  }

  function close() {
    if (closePromise) return closePromise;
    closed = true;
    const error = failure('CLOSED');
    rejectQueue(error);
    if (current) retire(current, error, false);
    closePromise = Promise.all([...terminations]).then(() => {});
    return closePromise;
  }

  try {
    await spawn();
  } catch (error) {
    await close();
    throw error;
  }
  return Object.freeze({ decode, close });
}
