'use strict';
// Main-thread side of the local translation engine. Owns the worker, serialises
// requests onto it, and reports whether the engine is usable at all.
//
// @huggingface/transformers is an optionalDependency: it and onnxruntime are
// ~380MB, which is a lot to force on a deployment that is happy with a hosted
// engine. So this module never requires it directly - it checks it resolves,
// and the worker imports it. When it is absent the provider simply reports
// itself unconfigured and the chain moves on.

const path = require('path');
const { Worker } = require('worker_threads');

const WORKER_PATH = path.join(__dirname, 'translate-local-worker.js');

// How long the engine may sit loaded with nobody using it.
//
// A resident language package is several hundred MB of RSS, and it was being
// held for the lifetime of the process: one agent translating one ticket in the
// morning cost the server that memory until the next deploy. Translation is
// bursty and rare compared with everything else this server does, so the models
// go away when the burst ends and come back from the disk cache - a couple of
// seconds on the next request, against hundreds of MB the rest of the day.
// Set TRANSLATE_LOCAL_IDLE_MS=0 to keep them resident (a box with RAM to spare
// and an inbox that is translated all day), or raise it if the reload on the
// next ticket is more annoying than the memory. Two minutes was the first guess
// and it was too generous: agents translate a ticket, read it, and move on, so
// the window mostly measured how long the memory was held for nobody.
const IDLE_SHUTDOWN_MS = Number(process.env.TRANSLATE_LOCAL_IDLE_MS ?? 45_000);

// A V8 heap ceiling for the worker thread, in MB. Off by default because the
// model weights and every tensor are native allocations that this does not
// count - it bounds the JS side only, which is the string arrays this module
// passes around. Worth setting on a small box as a backstop: the worker dies
// with an error the parent already reports and falls through to another engine,
// which beats the kernel picking a process to kill.
const HEAP_LIMIT_MB = Number(process.env.TRANSLATE_LOCAL_HEAP_MB || 0);

function localEngineInstalled() {
  try {
    require.resolve('@huggingface/transformers');
    return true;
  } catch (_) {
    return false;
  }
}

let worker = null;
let workerReady = null;
let nextId = 1;
const pending = new Map();
// One request at a time. Inference saturates a core, and two concurrent tickets
// would each take twice as long rather than either finishing sooner.
let queue = Promise.resolve();

// The worker must not hold the process open when idle, or a shutdown waits on
// it. But it must keep the loop alive while a request is in flight - unref'd
// throughout, a script whose only pending work is the worker's startup exits
// silently mid-await.
function holdProcess() { if (worker) worker.ref(); }
function releaseProcess() { if (worker && pending.size === 0) worker.unref(); }

// Tear the worker down once it has been idle long enough. Terminating the thread
// is what actually returns the memory: disposing the pipelines inside it releases
// the ONNX sessions, but the thread's own heap and arenas only go back to the OS
// when it exits.
//
// Unref'd, so a pending shutdown never keeps the process alive - and cancelled
// the moment another request arrives, because a translation must never race a
// terminate.
let idleTimer = null;
function cancelIdleShutdown() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}
function scheduleIdleShutdown() {
  cancelIdleShutdown();
  if (!(IDLE_SHUTDOWN_MS > 0) || !worker) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    // Something started while the timer was waiting to fire: leave it alone,
    // the next completion schedules a fresh one.
    if (!worker || pending.size) return;
    const dying = worker;
    worker = null;
    workerReady = null;
    // A clean terminate must not look like a crash to the exit handler below,
    // which would reject requests that no longer exist and log a failure.
    dying.removeAllListeners();
    dying.terminate().catch(() => { /* it is going away either way */ });
  }, IDLE_SHUTDOWN_MS);
  idleTimer.unref?.();
}

function startWorker(options) {
  cancelIdleShutdown();
  if (worker) { holdProcess(); return workerReady; }
  worker = new Worker(WORKER_PATH, {
    workerData: {
      cacheDir: options.cacheDir,
      maxModels: options.maxModels,
      batchRows: options.batchRows,
      batchCost: options.batchCost,
      maxTextChars: options.maxTextChars,
      beams: options.beams,
      threads: options.threads,
      maxNewTokens: options.maxNewTokens,
      dtype: options.dtype,
      arena: options.arena,
      batchRatio: options.batchRatio
    },
    ...(HEAP_LIMIT_MB > 0 ? { resourceLimits: { maxOldGenerationSizeMb: HEAP_LIMIT_MB } } : {})
  });
  workerReady = new Promise((resolve, reject) => {
    // A worker that never reports ready - a broken install, a missing native
    // binary - must fail rather than leave the caller waiting forever.
    const timer = setTimeout(() => reject(new Error('local translation worker did not start within 60s')), 60_000);
    const onFirst = (msg) => {
      if (msg?.ready) { clearTimeout(timer); worker.off('message', onFirst); resolve(); }
    };
    worker.on('message', onFirst);
    worker.once('error', (error) => { clearTimeout(timer); reject(error); });
  });

  worker.on('message', (msg) => {
    if (!msg) return;
    // Per-batch progress. It is not a result, it is proof of life: it pushes the
    // request's deadline out, so the timeout below measures "stopped making
    // progress" rather than "took a while", and a long thread can no longer be
    // killed halfway through for being long.
    if (msg.progress) {
      const inFlight = pending.get(msg.progress.id);
      if (inFlight) inFlight.touch(msg.progress);
      return;
    }
    if (msg.id === undefined) return;
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new Error(msg.error || 'local translation failed'));
  });

  // A worker that dies takes its in-flight request with it. Fail those loudly
  // and drop the handle so the next request starts a fresh one, rather than
  // queueing forever against a corpse.
  const die = (error) => {
    for (const [, entry] of pending) entry.reject(error);
    pending.clear();
    worker = null;
    workerReady = null;
  };
  worker.on('error', (error) => die(error instanceof Error ? error : new Error(String(error))));
  worker.on('exit', (code) => {
    if (code !== 0) die(new Error(`local translation worker exited with code ${code}`));
  });

  return workerReady;
}

function send(kind, payload, options, timeoutMs, onProgress) {
  const run = async () => {
    await startWorker(options);
    const id = nextId++;
    return await new Promise((resolve, reject) => {
      // Loading a language package for the first time is a download; translating
      // a long thread is minutes of CPU. Both need a ceiling, or a wedged worker
      // holds an agent's request open indefinitely. The clock is reset by every
      // progress report, so this is a stall timeout and not a length limit.
      let timer = null;
      const arm = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          pending.delete(id);
          releaseProcess();
          scheduleIdleShutdown();
          reject(new Error(`local translation stalled for ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      };
      arm();
      const settle = (fn) => (value) => {
        if (timer) clearTimeout(timer);
        releaseProcess();
        // Nothing left to do: start the clock on giving the memory back.
        if (pending.size === 0) scheduleIdleShutdown();
        fn(value);
      };
      pending.set(id, {
        touch: (progress) => { arm(); if (onProgress) onProgress(progress); },
        resolve: settle(resolve),
        reject: settle(reject)
      });
      worker.postMessage({ id, kind, ...payload });
    });
  };
  // Chain onto the queue, and make sure one failure does not poison it.
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  return result;
}

module.exports = {
  localEngineInstalled,
  routeFor: (source, target, options, timeoutMs = 15_000) =>
    send('route', { source, target }, options, timeoutMs),
  warm: (source, target, options, timeoutMs) =>
    send('warm', { source, target }, options, timeoutMs),
  translateTexts: (texts, source, target, options, timeoutMs, onProgress) =>
    send('translate', { texts, source, target }, options, timeoutMs, onProgress),
  // For the health/diagnostics view: is a model loaded right now, and is a
  // translation running? Answers "why is this pod using 700MB" without a heap
  // dump.
  status: () => ({
    loaded: !!worker,
    inFlight: pending.size,
    idleShutdownMs: IDLE_SHUTDOWN_MS,
    heapLimitMb: HEAP_LIMIT_MB || null
  })
};
