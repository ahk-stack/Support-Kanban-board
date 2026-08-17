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

function startWorker(options) {
  if (worker) { holdProcess(); return workerReady; }
  worker = new Worker(WORKER_PATH, {
    workerData: { cacheDir: options.cacheDir, maxModels: options.maxModels }
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
    if (!msg || msg.id === undefined) return;
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

function send(kind, payload, options, timeoutMs) {
  const run = async () => {
    await startWorker(options);
    const id = nextId++;
    return await new Promise((resolve, reject) => {
      // Loading a language package for the first time is a download; translating
      // a long thread is a minute of CPU. Both need a ceiling, or a wedged
      // worker holds an agent's request open indefinitely.
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`local translation timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); releaseProcess(); resolve(value); },
        reject: (error) => { clearTimeout(timer); releaseProcess(); reject(error); }
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
  translateTexts: (texts, source, target, options, timeoutMs) =>
    send('translate', { texts, source, target }, options, timeoutMs)
};
