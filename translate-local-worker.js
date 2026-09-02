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
const DTYPE = String(workerData?.dtype || 'q8');

// ------------------------------------------------------------ memory ceilings
//
// Measured on this repo's model cache, one language pair, a mail-shaped body of
// 35 text runs, three tickets in a row:
//
//   arena on  (what ORT does by default):  414 -> 571 -> 682MB RSS, peak 675MB
//   arena off (what this sets):            414 -> 416 -> 409MB RSS, peak 571MB
//
// That climb is the whole complaint. ONNX Runtime's CPU allocator keeps an arena
// of freed blocks per session so the next inference can reuse them, and since
// every ticket is a different shape it kept adding new ones - a translation
// footprint that only ever went up, until the worker was torn down. Turning the
// arena and the mem-pattern planner off makes each batch hand its memory back,
// which trades roughly two thirds more wall clock for a flat ~410MB instead of
// an unbounded climb. TRANSLATE_LOCAL_ARENA=on restores the old, faster,
// hungrier behaviour on a box with the RAM for it.
//
// The rest of the footprint is the model itself: ~300MB per resident pair once
// its ONNX sessions are built (a 107MB q8 file on disk). That is the floor while
// a translation is running, and the reason MAX_RESIDENT_MODELS defaults to one
// and the parent tears the whole worker down when the burst ends - measured,
// that takes RSS from 424MB back to 54MB.
const ARENA = !!workerData?.arena;
// Threads turned out not to be a memory lever at all - 0 (ORT decides) and 2
// measured within noise of each other on peak RSS - so this only decides how
// much CPU translation takes from the web server it shares a box with.
const THREADS = Math.max(0, Number(workerData?.threads ?? 0));
const SESSION_OPTIONS = {
  enableCpuMemArena: ARENA,
  enableMemPattern: ARENA,
  executionMode: 'sequential',
  ...(THREADS > 0 ? { intraOpNumThreads: THREADS, interOpNumThreads: 1 } : {})
};

// Beam search width, left at the model's own 4 - and worth recording why, since
// "decode one candidate instead of four" is the obvious-looking saving here and
// it is not one. Measured after the batching fix below: greedy peaked at 539MB
// against 568MB for four beams, which is inside the run-to-run noise, and it was
// *slower* - 7.3s against 6.1s over 24 rows - because greedy keeps generating
// where a beam search has already settled. Output on a mail-shaped body was
// identical. So this knob exists to document a dead end; lowering it buys
// nothing, and beam search is the better decoder on long sentences.
const BEAMS = Math.max(1, Number(workerData?.beams || 4));
// Each resident model is ~300MB of RSS once its ONNX sessions are built (from a
// 107MB q8 file on disk), so the default is one: a pivot route (fr->de is fr-en
// then en-de) loads its second model, evicts the first, and the pair costs one
// model's memory instead of two. The reload afterwards is a couple of seconds
// off the disk cache. Raise it to 2 on a box with RAM to spare and an inbox
// translated all day, which keeps a language and its reverse warm. They are
// released either way once the engine goes idle - see unloadAll and the
// parent's idle shutdown, which measured RSS going from 424MB back to 54MB.
const MAX_RESIDENT_MODELS = Math.max(1, Number(workerData?.maxModels || 1));
// A hard ceiling on generated tokens. The pipeline's own default is 256 and the
// model window is 512. It bounds the damage when the model runs away - see the
// batching note below, where a finished row keeps emitting periods until the
// budget is spent - and the per-batch figure is derived from the longest row in
// that batch, so a batch of short nodes is bounded by its own length.
const MAX_NEW_TOKENS = Math.max(32, Number(workerData?.maxNewTokens || 256));
function newTokenBudget(rows) {
  const longest = rows.reduce((n, t) => Math.max(n, t.length), 0);
  // Half the characters plus headroom: translations run longer than their
  // source in some pairs (en->de is the usual example), and truncating a
  // client's sentence is worse than spending the tokens.
  return Math.max(48, Math.min(MAX_NEW_TOKENS, Math.ceil(longest / 2) + 32));
}
const CACHE_DIR = workerData?.cacheDir || path.join(__dirname, 'data', 'mt-models');

// ------------------------------------------------------------------- batching
//
// The pipeline takes an array, and handing it the whole ticket at once looks
// like the cheap thing to do. It is the opposite. A batch is padded to its
// longest member and the decoder runs until every row in it has finished, so a
// batch costs (rows x longest row), not the sum of its rows. A real mail body is
// a few long paragraphs among a hundred short nodes - "Bonjour,", a name, a
// signature line, an empty table cell - so one batch of 200 nodes charges every
// one of those short nodes the full length of the longest paragraph.
//
// Measured against this repo's model cache, a 200-node body of that shape sent
// as a single batch did not finish in ten minutes and peaked over 1.3GB of RSS.
// That is the "cannot translate an opened ticket" failure: the request outlives
// the gateway, the gateway answers 502 with an HTML body, and the toast has no
// reason in it to print beyond the status code.
//
// So: sort by length, group like with like, and cap each group by both row count
// and padded cost. The sort is what makes the cap effective - neighbours in a
// sorted list are nearly the same length, so almost no padding is added.
const MAX_BATCH_ROWS = Math.max(1, Number(workerData?.batchRows || 8));
// Rows x longest-row-chars. 3200 is eight rows of 400 chars, or thirty-two of
// 100 - either way a couple of seconds of CPU and a bounded tensor.
const MAX_BATCH_COST = Math.max(200, Number(workerData?.batchCost || 3200));
// opus-mt has a 512-token window. A text node longer than that is split on
// sentence boundaries and rejoined afterwards, because the alternative is the
// model quietly truncating it: a client's paragraph that stops mid-sentence
// reads as our bug and is invisible without the original beside it.
const MAX_TEXT_CHARS = Number(workerData?.maxTextChars || 480);

/* The other reason a batch has to be homogeneous, and this one is not about
   cost. Batching a long row together with a very short one corrupts every row
   in the batch: transformers.js keeps generating for sequences that have
   already finished, and because Marian's pad token is in the model's own
   bad_words_ids it emits periods instead - a run exactly as long as the token
   budget that was left.

     tr(['Bonjour,', 'Merci de nous confirmer.', <371-char paragraph>])
       -> "Hello,......................................." (224 dots)
       -> "Thank you for confirming......................" (193 dots)
       -> "<the paragraph>.............................." (131 dots)

   The same rows one at a time, or batched with rows of a similar length, come
   back clean. It is length *ratio* that does it - 371 chars beside 8 breaks,
   371 beside 190 does not - so cap the spread inside a batch. Sorting already
   puts similar lengths next to each other, which makes this cheap: it only
   splits a batch where the sorted run genuinely jumps.

   Reproduced against @huggingface/transformers 4.2.0 with Xenova/opus-mt-fr-en
   at q8. Raise TRANSLATE_LOCAL_BATCH_RATIO to relax it if a later version fixes
   the underlying bug; 1 disables batching of unequal rows altogether. */
const MAX_BATCH_RATIO = Math.max(1, Number(workerData?.batchRatio || 8));

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
  const built = await pipeline('translation', `Xenova/opus-mt-${pair}`, {
    dtype: DTYPE,
    session_options: SESSION_OPTIONS
  });
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

// Release every resident model. The parent calls this when nobody has translated
// anything for a while: a language package sitting idle is several hundred MB of
// RSS held against the chance that someone translates another ticket, and
// reloading it from the disk cache costs a couple of seconds.
async function unloadAll() {
  const entries = [...resident.values()];
  resident.clear();
  for (const entry of entries) {
    try { await entry.pipeline.dispose?.(); } catch (_) { /* best effort */ }
  }
  return entries.length;
}

// Split a long text into pieces the model's window can hold, keeping every
// delimiter attached so rejoining is plain concatenation - no character of the
// client's text is invented or dropped. Sentence ends first; a "sentence" that
// is still too long (a pasted log line, a list of URLs) is cut at a space.
function splitLongText(text) {
  if (text.length <= MAX_TEXT_CHARS) return [text];
  const pieces = [];
  let rest = text;
  while (rest.length > MAX_TEXT_CHARS) {
    const window = rest.slice(0, MAX_TEXT_CHARS);
    let cut = Math.max(
      window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '),
      window.lastIndexOf('\n')
    );
    // Only take a boundary that actually divides the window; one at character 3
    // would turn a paragraph into hundreds of fragments.
    cut = cut > MAX_TEXT_CHARS * 0.4 ? cut + 1 : -1;
    if (cut < 0) {
      const space = window.lastIndexOf(' ');
      cut = space > MAX_TEXT_CHARS * 0.4 ? space + 1 : MAX_TEXT_CHARS;
    }
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) pieces.push(rest);
  return pieces;
}

// Group row indices into batches of similar-length rows, capped by row count and
// by padded cost. Returns an array of index arrays.
function planBatches(rows) {
  const order = rows.map((_, i) => i).sort((a, b) => rows[a].length - rows[b].length);
  const batches = [];
  let current = [];
  let longest = 0;
  let shortest = Infinity;
  for (const i of order) {
    const nextLongest = Math.max(longest, rows[i].length);
    const cost = (current.length + 1) * nextLongest;
    // A blank row has no length to take a ratio against, and it is never the
    // row that breaks - blank batches skip the model entirely - so measure the
    // spread against the shortest row that has any content.
    const span = Math.max(1, Math.min(shortest, rows[i].length || Infinity));
    if (current.length && (current.length >= MAX_BATCH_ROWS || cost > MAX_BATCH_COST || nextLongest > span * MAX_BATCH_RATIO)) {
      batches.push(current);
      current = [];
      longest = 0;
      shortest = Infinity;
    }
    current.push(i);
    longest = Math.max(longest, rows[i].length);
    if (rows[i].length) shortest = Math.min(shortest, rows[i].length);
  }
  if (current.length) batches.push(current);
  return batches;
}

/* Safety net for the batching bug above. The ratio cap is a prediction about
   when the library misbehaves; this is a check on what it actually returned, so
   a corrupted row cannot reach a client even if a future version breaks under
   some batch shape we did not predict.

   Only a *trailing* run of one repeated punctuation mark counts, and only when
   the source does not end that way itself - so a client writing "Help!!!!!" or
   an ellipsis keeps every character, while 200 machine-generated periods do
   not. Anything trimmed is logged: silently repairing a model's output is how a
   real regression stays invisible. */
const TRAILING_RUN = /([^\w\s])\1{4,}\s*$/;
function stripRunawayRepeat(source, translated) {
  if (typeof translated !== 'string') return translated;
  const m = TRAILING_RUN.exec(translated);
  if (!m) return translated;
  const mark = m[1];
  // How many of that mark the client's own text ends with; keep at least that
  // many, so "Merci !!!" does not come back as "Thanks".
  const tail = String(source || '').trimEnd();
  let keep = 0;
  while (keep < tail.length && tail[tail.length - 1 - keep] === mark) keep += 1;
  console.warn(`local translation: trimmed ${m[0].trim().length} repeated "${mark}" from a row (library batch bug); kept ${keep}`);
  return translated.slice(0, m.index) + mark.repeat(keep);
}

// One hop over every string: split what is too long, batch by length, translate
// each batch, then put every piece back where it came from.
async function runHop(pair, texts, onProgress) {
  const translate = await getPipeline(pair);

  // Flatten to pieces, remembering which text each piece came from.
  const rows = [];
  const layout = texts.map(text => splitLongText(String(text ?? '')).map(piece => {
    rows.push(piece);
    return rows.length - 1;
  }));

  const out = new Array(rows.length);
  const batches = planBatches(rows);
  let done = 0;
  for (const batch of batches) {
    // Blank rows are dropped per row, not per batch. A batch made entirely of
    // them was already skipped, but one blank row travelling with real content
    // still went to the model - and asking opus-mt to translate " " is where it
    // invents a sentence ("The Commission's proposal is based on the following
    // conclusions:" came back from a single space). They pass through untouched
    // and cost nothing.
    const send = batch.filter(i => rows[i].trim());
    batch.filter(i => !rows[i].trim()).forEach(i => { out[i] = rows[i]; });
    if (send.length) {
      const input = send.map(i => rows[i]);
      const result = await translate(input, {
        num_beams: BEAMS,
        max_new_tokens: newTokenBudget(input)
      });
      const list = Array.isArray(result) ? result : [result];
      send.forEach((i, k) => {
        const text = stripRunawayRepeat(rows[i], list[k]?.translation_text);
        // A row that produces nothing keeps its input, so a later hop still has
        // something to work with and the caller falls back to the original.
        out[i] = typeof text === 'string' && text.trim() ? text : rows[i];
      });
    }
    done += batch.length;
    if (onProgress) onProgress(done, rows.length);
  }

  // Rejoin: a text that was never split is its single piece, one that was gets
  // its pieces concatenated back in original order, delimiters and all.
  return layout.map(ids => (ids.length === 1 ? out[ids[0]] : ids.map(id => out[id]).join('')));
}

parentPort.on('message', async (msg) => {
  const { id, kind } = msg || {};
  try {
    if (kind === 'route') {
      // Asked before committing: can this pair be served at all?
      parentPort.postMessage({ id, ok: true, result: { route: route(msg.source, msg.target) } });
      return;
    }
    if (kind === 'unload') {
      parentPort.postMessage({ id, ok: true, result: { unloaded: await unloadAll() } });
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
      // Progress is per batch, not per hop. A hundred-node body is now dozens
      // of small batches rather than one opaque wait, and the parent uses these
      // to tell a slow translation from a wedged one.
      for (let h = 0; h < hops.length; h++) {
        texts = await runHop(hops[h], texts, (done, total) => {
          parentPort.postMessage({ progress: { id, hop: h + 1, hops: hops.length, done, total } });
        });
      }
      parentPort.postMessage({ id, ok: true, result: { texts, hops } });
      return;
    }
    throw new Error(`unknown message kind: ${kind}`);
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: String(error?.message || error) });
  }
});

parentPort.postMessage({ ready: true });
