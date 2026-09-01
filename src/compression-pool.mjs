import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { validate } from '../codecs/core/core.mjs';
import { shareContext } from '../codecs/predict/models.mjs';
export const MAX_SERVER_INPUT_BYTES = 32 * 1024;

export class CompressionError extends Error {
  constructor(code) {
    super(code);
    this.name = 'CompressionError';
    this.code = code;
  }
}

// One persistent encoder, at most four waiting requests, and no result cache.
// The 128 MiB V8 heap budget does not include Node's native allocations.
export async function createCompressionPool({
  workerURL = new URL('./compression-worker.mjs', import.meta.url),
  deadlineMs = 50,
  startupTimeoutMs = 10_000,
  maxQueue = 4
} = {}) {
  for (const value of [deadlineMs, startupTimeoutMs]) {
    if (!Number.isFinite(value) || value <= 0)
      throw new RangeError('Invalid timeout');
  }
  if (!Number.isInteger(maxQueue) || maxQueue < 0 || maxQueue > 4) {
    throw new RangeError('Queue capacity must be between 0 and 4');
  }

  let current = null,
    closed = false,
    closePromise,
    sequence = 0;
  const queue = [],
    terminations = new Set();
  const failure = (code) => new CompressionError(code);

  function finish(job, error, decoded) {
    if (!job || job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.abort);
    const index = queue.indexOf(job);
    if (index !== -1) queue.splice(index, 1);
    if (current?.job === job) current.job = null;
    if (error) job.reject(error);
    else job.resolve(decoded);
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
        slot.worker.postMessage({ id: job.id, input: job.input });
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
        // Worker output must never become a destination/request log.
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
      if (
        message.type === 'encoded' &&
        Array.isArray(message.candidates) &&
        message.candidates.length <= 8 &&
        message.candidates.every(
          (candidate) =>
            typeof candidate?.codec === 'string' &&
            candidate.codec.length <= 64 &&
            typeof candidate.payload === 'string' &&
            /^[A-Za-z0-9_-]{6,8192}$/.test(candidate.payload)
        )
      ) {
        finish(job, null, message.candidates);
      } else if (message.type === 'invalid') {
        finish(job, failure('INVALID'));
      } else {
        return failed();
      }
      dispatch();
    });
    return ready;
  }

  function encode(input, { signal } = {}) {
    if (closed) return Promise.reject(failure('CLOSED'));
    if (signal?.aborted) return Promise.reject(failure('ABORTED'));
    try {
      if (
        typeof input !== 'string' ||
        input.length > MAX_SERVER_INPUT_BYTES ||
        validate(input).length > MAX_SERVER_INPUT_BYTES
      )
        throw Error('Input limit');
    } catch {
      return Promise.reject(failure('INVALID'));
    }
    const idle = current?.ready && !current.retired && !current.job;
    if (!idle && queue.length >= maxQueue)
      return Promise.reject(failure('BUSY'));
    const result = new Promise((resolve, reject) => {
      const job = {
        id: ++sequence,
        input,
        resolve,
        reject,
        signal,
        expires: performance.now() + deadlineMs,
        settled: false
      };
      const cancel = (code) => {
        const active = current?.job === job;
        finish(job, failure(code));
        if (active) retire(current, failure(code), true);
        else dispatch();
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
  return Object.freeze({ encode, close });
}
