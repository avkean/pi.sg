import { encodeFast } from './core.mjs';
export function createEncoder({
  timeoutMs = 150,
  startupMs = 10000,
  maxPending = 8,
  workerUrl = new URL('./worker-browser.mjs', import.meta.url)
} = {}) {
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 5000 ||
    !Number.isFinite(startupMs) ||
    startupMs < 1 ||
    startupMs > 60000 ||
    !Number.isInteger(maxPending) ||
    maxPending < 1 ||
    maxPending > 64
  )
    throw Error('Invalid worker limits');
  const pending = new Map();
  let worker = null,
    ready = false,
    startupTimer,
    sequence = 0,
    closed = false;
  function finish(job, result) {
    clearTimeout(job.timer);
    pending.delete(job.id);
    job.resolve(result);
  }
  function reset(reason) {
    const old = worker;
    worker = null;
    ready = false;
    clearTimeout(startupTimer);
    old?.terminate();
    for (const job of [...pending.values()])
      finish(job, { ...job.fallback, limited: true, reason });
  }
  function submit(job) {
    if (job.submitted) return;
    job.submitted = true;
    try {
      worker.postMessage({
        id: job.id,
        input: job.input,
        options: job.options
      });
    } catch {
      finish(job, { ...job.fallback, limited: true, reason: 'worker-failure' });
    }
  }
  function start() {
    if (worker) return;
    const w = new Worker(workerUrl, { type: 'module' });
    worker = w;
    startupTimer = setTimeout(() => {
      if (worker === w) reset('model-timeout');
    }, startupMs);
    w.onmessage = ({ data }) => {
      if (worker !== w) return;
      if (data.startupError) {
        reset('worker-failure');
        return;
      }
      if (data.ready) {
        ready = true;
        clearTimeout(startupTimer);
        for (const job of [...pending.values()]) submit(job);
        return;
      }
      const job = pending.get(data.id);
      if (!job) return;
      finish(
        job,
        data.error
          ? { ...job.fallback, limited: true, reason: 'worker-error' }
          : { ...data.result, limited: false }
      );
    };
    w.onerror = () => {
      if (worker === w) reset('worker-failure');
    };
  }
  function encode(input, options = {}) {
    if (closed) return Promise.reject(Error('Encoder is closed'));
    let fallback;
    try {
      fallback = encodeFast(input, options);
    } catch (error) {
      return Promise.reject(error);
    }
    if (pending.size >= maxPending)
      return Promise.resolve({ ...fallback, limited: true, reason: 'busy' });
    try {
      start();
    } catch {
      return Promise.resolve({
        ...fallback,
        limited: true,
        reason: 'worker-failure'
      });
    }
    return new Promise((resolve) => {
      const job = {
        id: ++sequence,
        resolve,
        fallback,
        timer: null,
        input,
        options: { origin: options.origin },
        submitted: false
      };
      job.timer = setTimeout(() => {
        if (job.submitted) reset('deadline');
        else finish(job, { ...fallback, limited: true, reason: 'deadline' });
      }, timeoutMs);
      pending.set(job.id, job);
      if (ready) submit(job);
    });
  }
  function preload() {
    if (closed) return false;
    try {
      start();
      return true;
    } catch {
      return false;
    }
  }
  function close() {
    closed = true;
    reset('closed');
  }
  return { encode, preload, close };
}
