'use strict';
// Local machine translation, in a worker thread.
//
// This is the only engine that needs no key, no account and no quota: the model
// runs in this process and the text never leaves the machine. That is what makes
// whole-ticket translation affordable - a full thread is thousands of characters,
// which would exhaust a free hosted tier on one ticket.
//
// It lives in a worker for one reason: inference is synchronous, CPU-bound and
// takes about a second per sentence. Run it on the main thread and a fifty
// segment ticket stops answering every other agent's requests for a minute.
//
// Models are Helsinki-NLP opus-mt, one per language pair, ~40-80MB each,
// downloaded on first use and then cached on disk - the "install a language
// package on demand" behaviour. They are pairwise, not multilingual: the
// many-to-English model was tested and is not good enough to put in front of a
// client ("je souhaite annuler ma reservation" came back as "I want to warm up
// the mahe"), whereas the dedicated pairs read correctly.

const { parentPort, workerData } = require('worker_threads');
const path = require('path');

// Quantised weights. fp32 was tried first and the process was killed loading it
// on an 8GB box; q8 fits, loads in half the time, and the output was
// indistinguishable in testing.
const DTYPE = 'q8';
// Each resident model is a few hundred MB of RSS. Two covers the normal case (a
// language and its reverse, or two busy inboxes) without putting the server at
// risk of being killed.
const MAX_RESIDENT_MODELS = Number(workerData?.maxModels || 2);
const CACHE_DIR = workerData?.cacheDir || path.join(__dirname, 'data', 'mt-models');

// Pairs published as ONNX. Anything not here is reached by pivoting through
// English, which is why en is on both sides of almost every entry.
const AVAILABLE_PAIRS = new Set([
  'ar-en', 'de-en', 'de-fr', 'en-ar', 'en-de', 'en-es', 'en-fr', 'en-it',
  'en-nl', 'en-ro', 'en-ru', 'en-zh', 'es-en', 'fr-de', 'fr-en', 'it-en',
  'ja-en', 'ko-en', 'nl-en', 'pl-en', 'ru-en', 'tr-en', 'zh-en'
]);

let transformers = null;
const resident = new Map(); // "fr-en" -> { pipeline, lastUsed }

async function getTransformers() {
  if (!transformers) {
    transformers = await import('@huggingface/transformers');
    transformers.env.cacheDir = CACHE_DIR;
    // Downloads are the whole point - a language package arrives the first time
    // someone asks for that language.
    transformers.env.allowRemoteModels = true;
  }
  return transformers;
}

// Base language, since models are keyed by language and not locale: zh-TW and
// zh share a model, fr-CA and fr likewise.
function base(code) { return String(code || '').split('-')[0].toLowerCase(); }

// How to get from one language to another: a direct model, or two hops through
// English. Returns null when neither exists.
function route(from, to) {
  const a = base(from);
  const b = base(to);
  if (!a || !b || a === b) return [];
  if (AVAILABLE_PAIRS.has(`${a}-${b}`)) return [`${a}-${b}`];
  if (a !== 'en' && b !== 'en' && AVAILABLE_PAIRS.has(`${a}-en`) && AVAILABLE_PAIRS.has(`en-${b}`)) {
    return [`${a}-en`, `en-${b}`];
  }
  return null;
}

async function getPipeline(pair) {
  const hit = resident.get(pair);
  if (hit) { hit.lastUsed = Date.now(); return hit.pipeline; }

  const { pipeline } = await getTransformers();
  // First call for a language downloads it; later calls read the disk cache.
  const built = await pipeline('translation', `Xenova/opus-mt-${pair}`, { dtype: DTYPE });
  resident.set(pair, { pipeline: built, lastUsed: Date.now() });

  // Evict least-recently-used beyond the cap, and dispose properly - dropping
  // the reference alone leaves the ONNX session holding its memory.
  while (resident.size > MAX_RESIDENT_MODELS) {
    let oldest = null;
    for (const [key, value] of resident) {
      if (!oldest || value.lastUsed < resident.get(oldest).lastUsed) oldest = key;
    }
    if (oldest === pair || oldest === null) break;
    const evicted = resident.get(oldest);
    resident.delete(oldest);
    try { await evicted.pipeline.dispose?.(); } catch (_) { /* best effort */ }
  }
  return built;
}

// One hop over every string. The pipeline takes an array, so this is one call
// rather than one per segment.
async function runHop(pair, texts) {
  const translate = await getPipeline(pair);
  const out = await translate(texts);
  const list = Array.isArray(out) ? out : [out];
  return list.map((item, i) => {
    const text = item?.translation_text;
    // A hop that produces nothing keeps the input, so a later hop still has
    // something to work with and the caller falls back to the original.
    return typeof text === 'string' && text.trim() ? text : texts[i];
  });
}

parentPort.on('message', async (msg) => {
  const { id, kind } = msg || {};
  try {
    if (kind === 'route') {
      // Asked before committing: can this pair be served at all?
      parentPort.postMessage({ id, ok: true, result: { route: route(msg.source, msg.target) } });
      return;
    }
    if (kind === 'warm') {
      const hops = route(msg.source, msg.target);
      if (!hops) throw new Error(`no model route from ${msg.source} to ${msg.target}`);
      for (const hop of hops) await getPipeline(hop);
      parentPort.postMessage({ id, ok: true, result: { warmed: hops } });
      return;
    }
    if (kind === 'translate') {
      const hops = route(msg.source, msg.target);
      if (!hops) throw new Error(`no model route from ${msg.source} to ${msg.target}`);
      let texts = msg.texts;
      // Already in the target language: nothing to do, and no model to load.
      if (!hops.length) {
        parentPort.postMessage({ id, ok: true, result: { texts, hops } });
        return;
      }
      for (const hop of hops) texts = await runHop(hop, texts);
      parentPort.postMessage({ id, ok: true, result: { texts, hops } });
      return;
    }
    throw new Error(`unknown message kind: ${kind}`);
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: String(error?.message || error) });
  }
});

parentPort.postMessage({ ready: true });
