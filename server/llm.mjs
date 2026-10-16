// LLM backend abstraction.
//
// Every LLM call in the app goes through here. The backend is selected in
// config/server.yaml and never branched on anywhere else — that is the whole
// reason migration to another box is a config edit rather than a port.
//
// Backends:
//   mock      canned per-model segment output; needs nothing installed
//   ollama    OpenAI-compatible, 127.0.0.1:11434/v1
//   llamacpp  OpenAI-compatible, same shape as ollama
//   vllm      OpenAI-compatible, Linux only, post-migration
//
// This module normalises three things across them so nothing downstream has
// to care: streaming chunk shape, tool-call shape, and error shape.

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { keepAliveWireValue } from './keepalive.mjs';


export const ERR = {
  BACKEND_UNAVAILABLE: 'backend_unavailable',
  // Distinct from BACKEND_UNAVAILABLE on purpose: the backend is up and
  // answering, the tag just is not pulled. Conflating the two sends you
  // debugging Ollama when the fix is a one-line pull.
  MODEL_NOT_INSTALLED: 'model_not_installed',
  MODEL_LOADING: 'model_loading',
  TIMEOUT: 'timeout',
  GPU_OOM: 'gpu_oom',
  BAD_RESPONSE: 'bad_response',
  CANCELLED: 'cancelled',
};

export class LLMError extends Error {
  constructor(code, message, { cause, verbatim } = {}) {
    super(message);
    this.name = 'LLMError';
    this.code = code;
    this.cause = cause;
    // GPU OOM in particular must reach the user unmodified — the backend's
    // own message names the knob to turn.
    this.verbatim = verbatim ?? null;
  }
}

const OOM_PATTERN = /out of memory|CUDA error|cudaMalloc|failed to allocate|OutOfMemory|no space left on device/i;
const LOADING_PATTERN = /loading model|model is loading|not yet loaded/i;

function classify(err, bodyText = '') {
  const text = `${err?.message ?? ''} ${bodyText}`;
  if (err?.name === 'AbortError') return new LLMError(ERR.CANCELLED, 'Request cancelled.');
  if (OOM_PATTERN.test(text)) {
    return new LLMError(ERR.GPU_OOM, 'The backend ran out of GPU memory.', {
      cause: err,
      verbatim: bodyText || err?.message,
    });
  }
  if (LOADING_PATTERN.test(text)) {
    return new LLMError(ERR.MODEL_LOADING, 'The model is still loading.', { cause: err });
  }
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET|fetch failed/i.test(text)) {
    return new LLMError(
      ERR.BACKEND_UNAVAILABLE,
      // Named no backend on purpose. This said "check Ollama" until 1 Sep
      // 2026, and on a box running llamacpp it sent the owner to inspect the
      // one service that was healthy while the one that was missing went
      // unmentioned. health() knows the backend and supplies a better detail
      // when it has one; this is the fallback for when it does not.
      'Model offline — the LLM backend is not answering.',
      { cause: err }
    );
  }
  return new LLMError(ERR.BAD_RESPONSE, err?.message ?? 'Unexpected backend error.', {
    cause: err,
    verbatim: bodyText || null,
  });
}

// ───────────────────────────── mock backend ─────────────────────────────
//
// Exists for the same reason training.backend has a `stub`: the queue, the
// SSE transport, the segment parser, the failure table and every frontend
// template are all buildable and testable without a GPU. It deliberately
// produces different text per model so that "the three booru models must not
// produce identical output" is something you can actually observe in Phase 1.

const MOCK_FLAVOUR = {
  booru: (brief, quality, sep) =>
    [...quality, ...brief.toLowerCase().split(/[,\s]+/).filter(Boolean).slice(0, 8)]
      .join(', ')
      .replaceAll('_', sep === 'space' ? ' ' : '_'),
  prose: (brief) =>
    `${brief.trim().replace(/\.$/, '')}. The light falls from the left across a cluttered ` +
    `workbench, and the background settles into soft focus behind the subject.`,
};

function mockBody(model, label, brief) {
  const quality = Object.values(model.quality_presets ?? {})[0] ?? [];
  const sep = model.tag_style === 'underscore' ? 'underscore' : 'space';
  switch (label) {
    case 'Positive prompt':
      return model.template === 'booru' || model.template === 'hybrid'
        ? MOCK_FLAVOUR.booru(brief, quality, sep)
        : MOCK_FLAVOUR.prose(brief);
    case 'Negative prompt':
      return model.negative_defaults ?? 'N/A';
    case 'Enhanced prompt':
    case 'Enhanced paragraph':
      return MOCK_FLAVOUR.prose(brief);
    case 'Layer breakdown':
      return (model.layers ?? []).map((l) => `${l} — mock ${l.toLowerCase()} layer.`).join('\n');
    case 'Subject definitions':
      return '<Subject 1> is the subject described in the brief, preserved across all shots.';
    case 'Summary':
      return `[mock] ${model.default_duration ?? 10}s ${model.default_aspect_ratio ?? '16:9'} sequence from the brief.`;
    case 'Retention analysis':
      return '<Subject 1> (appears in [Shot 1]): fully_preserved.';
    case 'Detailed description':
      return `[Shot 1] 00:00-00:05 ${brief.trim()}`;
    case 'Edit prompt':
      return `[mock] ${String(brief ?? '').trim()} Keep everything else in the image unchanged.`;
    case 'Soundscape':
      return 'Low room tone, footsteps on metal, no dialogue.';
    case 'Music':
      return 'Sparse ambient pad, entering at 00:04.';
    case 'What changed':
    case 'Improvement notes':
    case 'Reasoning':
      return (
        `Mock backend — no model was called. Rendered for ${model.label} using the ` +
        `${model.template} template. Set llm.backend to "ollama" in config/server.yaml ` +
        `for real generation.`
      );
    default:
      return 'N/A';
  }
}

async function* mockStream({ model, brief, signal, refuse, chat, message }) {
  // Chat has no segment contract — it is prose — so the mock has to answer in
  // prose too. Without this branch a mock chat turn reads model.segments off
  // an undefined model and throws, which is a confusing way to learn that the
  // backend is mock.
  if (chat) {
    const reply =
      `[mock] You said: "${String(message ?? '').slice(0, 80)}". ` +
      'The mock backend does not think, it echoes — point the server at a real ' +
      'model to get an actual answer.';
    for (const piece of reply.match(/.{1,32}(\s|$)/gs) ?? [reply]) {
      if (signal?.aborted) throw new LLMError(ERR.CANCELLED, 'Request cancelled.');
      await new Promise((r) => setTimeout(r, 12));
      yield { type: 'token', text: piece };
    }
    yield { type: 'usage', usage: { backend: 'mock', prompt_tokens: 0, completion_tokens: 0 } };
    return;
  }

  const labels = refuse ? ['Refused'] : model.segments;
  for (const label of labels) {
    if (signal?.aborted) throw new LLMError(ERR.CANCELLED, 'Request cancelled.');
    const body = refuse
      ? "This request can't be built into a prompt."
      : mockBody(model, label, brief);
    yield { type: 'token', text: `===SEGMENT: ${label}===\n` };
    // Chunk the body so the progressive-render path is genuinely exercised.
    for (const piece of body.match(/.{1,48}(\s|$)/gs) ?? [body]) {
      if (signal?.aborted) throw new LLMError(ERR.CANCELLED, 'Request cancelled.');
      await new Promise((r) => setTimeout(r, 12));
      yield { type: 'token', text: piece };
    }
    yield { type: 'token', text: '\n\n' };
  }
  yield { type: 'usage', usage: { backend: 'mock', prompt_tokens: 0, completion_tokens: 0 } };
}

// ─────────────────────────── OpenAI-shaped backends ───────────────────────

/**
 * A streaming POST that is not subject to undici's 300-second headers timeout.
 *
 * `fetch` cannot do this job. Node's global fetch is undici, whose
 * `headersTimeout` defaults to 300000ms and is not reachable from application
 * code — no option on fetch, no exported dispatcher. It fires when response
 * headers have not arrived, which for a streaming backend means "no first
 * token yet".
 *
 * Invisible on fast hardware. Measured on the Tesla P40, h3's 13,188-token
 * system prompt takes ~5.4 minutes to ingest at ~40 tok/s and ollama sends no
 * headers until it finishes, so every cold h3 generation died at exactly 301s
 * with UND_ERR_HEADERS_TIMEOUT — surfacing as "fetch failed", which
 * `classify` reads as a dropped connection and reports as "Model offline".
 * The backend was healthy and 11,776 tokens into the work. `timeout_ms` was
 * therefore unenforceable above 300s; h3 declares 600000 and never reached it.
 *
 * node:http imposes no such limit, so the caller's own timer is the only
 * clock. `Readable.toWeb` returns a real web ReadableStream, so callers keep
 * using `res.body.getReader()` exactly as before.
 *
 * Two details are load-bearing, both learned by breaking test-failures:
 *
 *   - `agent: false`. Node 19+ enables keepAlive on the global agent, so a
 *     socket to a backend that has since gone away gets reused and fails
 *     mid-flight instead of refusing cleanly. fetch pools differently and the
 *     "unreachable backend errors cleanly" case depends on the clean refusal.
 *   - errors after the headers arrive must reach the READER, not the promise.
 *     The promise is already settled by then; throwing there is uncaught and
 *     takes the process down. Destroying the response propagates the error
 *     through toWeb to the generator's try/catch, which is what fetch did.
 *
 * Returns a fetch-shaped subset: { ok, status, body, text() }.
 */
function streamingPost(url, { headers, body, signal }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const mod = target.protocol === 'https:' ? httpsRequest : httpRequest;

    let settled = false;
    let response = null;

    const req = mod(
      target,
      {
        method: 'POST',
        agent: false,
        headers: { ...headers, 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        response = res;
        settled = true;
        const status = res.statusCode ?? 0;
        // `body` is lazy and `text()` never calls setEncoding. Both matter:
        // building the web stream eagerly and then calling text() on a non-200
        // put two readers on one response, setEncoding flipped it to strings,
        // and toWeb's sizing function threw ERR_INVALID_ARG_VALUE on a string
        // with no byteLength - killing the server rather than reporting the
        // HTTP error. Callers use exactly one of these, never both.
        let web = null;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          get body() {
            web ??= Readable.toWeb(res);
            return web;
          },
          text: () =>
            new Promise((done) => {
              const chunks = [];
              res.on('data', (c) => chunks.push(c));
              res.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
              res.on('error', () => done(Buffer.concat(chunks).toString('utf8')));
            }),
        });
      }
    );

    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
        return;
      }
      // Headers already delivered: hand the error to the stream instead, or it
      // is an uncaught exception that kills the server.
      response?.destroy(err);
    });

    const onAbort = () => {
      const err = new DOMException('The operation was aborted.', 'AbortError');
      if (settled) response?.destroy(err);
      req.destroy(err);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    req.end(body);
  });
}

async function* openAIStream({ baseUrl, body, timeoutMs, signal }) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await streamingPost(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, stream: true }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (controller.signal.aborted && !signal?.aborted) {
      throw new LLMError(ERR.TIMEOUT, `Generation timed out after ${timeoutMs}ms.`);
    }
    throw classify(err);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    throw classify(new Error(`HTTP ${res.status}`), text);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  // Held to the end and sent once, with the finish reason folded in, the
  // same shape Ollama's done chunk gives (`done_reason`, `truncated`).
  // Until 11 Oct 2026 this path never read finish_reason, so a Length limit
  // in tokens that cut the answer off reached the panel as "the model
  // omitted required segments" instead of "your limit cut it off": the
  // generate route's explanation keys on usage.truncated, and only the
  // Ollama path ever set it.
  let usage = null;
  let finishReason = null;
  const finalUsage = () =>
    usage || finishReason
      ? { type: 'usage', usage: { ...(usage ?? {}), done_reason: finishReason, truncated: finishReason === 'length' } }
      : null;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          const last = finalUsage();
          if (last) yield last;
          return;
        }

        let chunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue; // keep-alive or partial frame
        }

        const delta = chunk.choices?.[0]?.delta ?? {};
        if (delta.content) yield { type: 'token', text: delta.content };
        // Normalise tool calls to one shape regardless of backend.
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            yield {
              type: 'tool_call',
              index: tc.index ?? 0,
              id: tc.id ?? null,
              name: tc.function?.name ?? null,
              arguments: tc.function?.arguments ?? '',
            };
          }
        }
        // llama.cpp puts its own `timings` (prompt and decode speed, measured
        // by the server itself) beside `usage` on the last chunk. Kept, so the
        // speed of every generation can be recorded - see onUsage.
        if (chunk.usage || chunk.timings) {
          usage = { ...(usage ?? {}), ...(chunk.usage ?? {}), ...(chunk.timings ? { timings: chunk.timings } : {}) };
        }
        if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
      }
    }
    // A backend that closes without [DONE].
    const last = finalUsage();
    if (last) yield last;
  } catch (err) {
    if (controller.signal.aborted && !signal?.aborted) {
      throw new LLMError(ERR.TIMEOUT, `Generation timed out after ${timeoutMs}ms.`);
    }
    throw classify(err);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    reader.cancel().catch(() => {});
  }
}

// ───────────────────────── Ollama native /api/chat ─────────────────────
//
// Ollama's OpenAI-compatible /v1 endpoint silently ignores `options`, which
// is where num_ctx lives. Sending context_length there does nothing: the
// model loads at Ollama's default (4096) no matter what config/server.yaml
// says, which is exactly the "do not leave it at the model default" failure
// the spec warns about — and it wrecks any VRAM planning.
//
// So the ollama backend talks to the native endpoint. That is precisely the
// job this module exists to do: absorb per-backend shape so nothing
// downstream branches on backend type. Callers see identical events either
// way.

async function* ollamaNativeStream({ baseUrl, body, timeoutMs, signal }) {
  // base_url is configured as .../v1 for the OpenAI shape; the native API
  // sits at the root.
  const root = baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '');
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await streamingPost(`${root}/api/chat`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, stream: true }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (controller.signal.aborted && !signal?.aborted) {
      throw new LLMError(ERR.TIMEOUT, `Generation timed out after ${timeoutMs}ms.`);
    }
    throw classify(err);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    throw classify(new Error(`HTTP ${res.status}`), text);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let nl;
      // Native streaming is newline-delimited JSON, not SSE data: frames.
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;

        let chunk;
        try {
          chunk = JSON.parse(line);
        } catch {
          continue;
        }

        if (chunk.error) throw classify(new Error(chunk.error), chunk.error);

        const content = chunk.message?.content;
        if (content) yield { type: 'token', text: content };

        for (const [i, tc] of (chunk.message?.tool_calls ?? []).entries()) {
          yield {
            type: 'tool_call',
            index: i,
            id: tc.id ?? null,
            name: tc.function?.name ?? null,
            // Native returns parsed arguments; the OpenAI shape returns a
            // JSON string. Normalise to the string form.
            arguments:
              typeof tc.function?.arguments === 'string'
                ? tc.function.arguments
                : JSON.stringify(tc.function?.arguments ?? {}),
          };
        }

        if (chunk.done) {
          const evalCount = chunk.eval_count ?? 0;
          const evalNs = chunk.eval_duration ?? 0;
          yield {
            type: 'usage',
            usage: {
              backend: 'ollama',
              done_reason: chunk.done_reason ?? null,
              // done_reason "length" means generation hit the context ceiling
              // and the answer is cut off mid-stream. The segment parser will
              // then report missing segments, which points at the prompt file
              // instead of at the real cause.
              truncated: chunk.done_reason === 'length',
              prompt_tokens: chunk.prompt_eval_count ?? 0,
              completion_tokens: evalCount,
              // Genuinely useful for judging a quant on this box.
              tokens_per_second: evalNs > 0 ? +(evalCount / (evalNs / 1e9)).toFixed(1) : null,
              // Prompt reading, measured by Ollama the same way. 0 on a fully
              // cached prompt, which speedOf treats as "no reading".
              prompt_eval_ms: chunk.prompt_eval_duration ? chunk.prompt_eval_duration / 1e6 : null,
              load_ms: chunk.load_duration ? Math.round(chunk.load_duration / 1e6) : null,
              total_ms: chunk.total_duration ? Math.round(chunk.total_duration / 1e6) : null,
            },
          };
        }
      }
    }
  } catch (err) {
    if (err instanceof LLMError) throw err;
    if (controller.signal.aborted && !signal?.aborted) {
      throw new LLMError(ERR.TIMEOUT, `Generation timed out after ${timeoutMs}ms.`);
    }
    throw classify(err);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    reader.cancel().catch(() => {});
  }
}

// ─────────────────────────────── factory ───────────────────────────────

/**
 * Which LLM writes this prompt.
 *
 * Three sources, and the order between them is the whole of the decision:
 *
 * 1. **The registry's `llm_model`, if the target declares one.** That is a
 *    measured requirement, not a preference — h3 declares the 27B because the
 *    8B fails its base-mode discipline 8 times in 10, and letting a personal
 *    setting quietly override that would produce bad h3 prompts and no
 *    explanation. The account panel says so plainly rather than silently
 *    ignoring the choice.
 * 2. **The person's `prompt_llm` preference**, for every target that does not.
 *    This is the one that matters in practice: the base model declines some of
 *    what this group makes, and an uncensored variant is a legitimate choice
 *    for prompt writing.
 * 3. **`llm.model` from server.yaml**, when nobody has expressed a view.
 *
 * Returns undefined for the third case rather than the configured name, so the
 * caller passes nothing and the backend applies its own default — one place
 * decides what the default is.
 */
export function chooseModel(modelEntry, prefs) {
  if (modelEntry?.llm_model) return modelEntry.llm_model;
  const chosen = String(prefs?.prompt_llm ?? '').trim();
  // A per-user choice wins; otherwise a target's soft default (h3's 27B), and
  // only then the deployment default. default_llm_model does NOT disable the
  // selector — it seeds it, and can be overridden.
  return chosen || modelEntry?.default_llm_model || undefined;
}

/**
 * List what an LLM server serves, without switching to it - the setup page's
 * "Test connection". Every supported backend answers the OpenAI-shaped
 * GET <base_url>/models, Ollama included when base_url ends in /v1.
 * Returns { ok, models } or { ok: false, message }; never throws.
 */
export async function probeModels(backend, baseUrl) {
  if (backend === 'mock') return { ok: true, models: [] };
  let url;
  try {
    url = new URL(`${String(baseUrl ?? '').replace(/\/$/, '')}/models`);
  } catch {
    return { ok: false, message: `"${baseUrl}" is not a URL.` };
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      return { ok: false, message: `The server answered HTTP ${res.status}. For Ollama the address usually ends in /v1.` };
    }
    const data = await res.json().catch(() => null);
    const models = (data?.data ?? []).map((m) => m?.id).filter(Boolean).sort();
    return { ok: true, models };
  } catch (err) {
    // fetch hides the reason one or two levels down: cause.code, or on a
    // dual-stack connect an AggregateError whose members carry it.
    const code = err.cause?.code ?? err.cause?.errors?.[0]?.code;
    const why = err.name === 'TimeoutError' ? 'no answer within 5 seconds'
      : code === 'ECONNREFUSED' ? 'nothing is listening on that port'
      : code === 'ENOTFOUND' ? 'that host name does not resolve'
      : (code ?? err.message);
    return { ok: false, message: `Could not reach ${url.origin} (${why}).` };
  }
}

/**
 * How fast one generation went, from whatever its backend reported, or null.
 * llama.cpp measures prompt and decode separately (`timings`); Ollama reports
 * decode speed only. Numbers the server measured, not wall-clock guesses.
 */
export function speedOf(usage) {
  const t = usage?.timings;
  if (t && t.predicted_n > 0 && t.predicted_ms > 0) {
    return {
      completion_tokens: t.predicted_n,
      decode_seconds: t.predicted_ms / 1000,
      prompt_tokens: t.prompt_n ?? 0,
      prompt_seconds: (t.prompt_ms ?? 0) / 1000,
    };
  }
  if (usage?.tokens_per_second > 0 && usage.completion_tokens > 0) {
    return {
      completion_tokens: usage.completion_tokens,
      decode_seconds: usage.completion_tokens / usage.tokens_per_second,
      prompt_tokens: usage.prompt_eval_ms > 0 ? usage.prompt_tokens ?? 0 : 0,
      prompt_seconds: usage.prompt_eval_ms > 0 ? usage.prompt_eval_ms / 1000 : 0,
    };
  }
  return null;
}

export function createLLM(config, { onUsage } = {}) {
  const llm = config.llm ?? {};
  let backend = llm.backend ?? 'mock';
  let baseUrl = llm.base_url ?? 'http://127.0.0.1:11434/v1';
  const timeoutMs = llm.timeout_ms ?? 120000;
  // Beside runtime.json in the data directory, so PROMPTFORGE_DATA_DIR moves it
  // too and a test run never rewrites a real install's backend.
  const BACKEND_STATE_FILE = resolve(config.paths?.data ?? 'data', 'backend.json');

  function validateBackend(name, url) {
    if (!['mock', 'ollama', 'llamacpp', 'vllm'].includes(name)) {
      return `unknown backend "${name}" — expected mock, ollama, llamacpp or vllm`;
    }
    if (name !== 'mock') {
      try { new URL(url); } catch { return `invalid base_url "${url}"`; }
    }
    return null;
  }

  const err = validateBackend(backend, baseUrl);
  if (err) throw new Error(`config/server.yaml: ${err}`);

  // Load persisted backend state (survives restarts). Written by the admin
  // Backend panel and the first-run setup; it outranks server.yaml the way
  // data/runtime.json does. Validated before use, so a hand-edited file with
  // a typo is skipped with a warning rather than stopping the app.
  try {
    if (existsSync(BACKEND_STATE_FILE)) {
      const saved = JSON.parse(readFileSync(BACKEND_STATE_FILE, 'utf8'));
      const bad = saved.backend && saved.base_url ? validateBackend(saved.backend, saved.base_url) : 'incomplete';
      if (bad) {
        console.warn(`[llm] ignoring data/backend.json: ${bad}`);
      } else {
        backend = saved.backend;
        baseUrl = saved.base_url;
        if (saved.model) llm.model = saved.model;
        console.log(`[llm] loaded persisted backend: ${backend} at ${baseUrl}${saved.model ? ` (${saved.model})` : ''}`);
      }
    }
  } catch (err) {
    console.warn(`[llm] failed to load persisted backend state: ${err.message}`);
  }

  function persistBackend() {
    try {
      writeFileSync(BACKEND_STATE_FILE, JSON.stringify({ backend, base_url: baseUrl, model: llm.model ?? null }, null, 2));
    } catch (err) {
      console.warn(`[llm] failed to persist backend state: ${err.message}`);
    }
  }

  /**
   * Switch backend, base URL and/or default model at runtime. No restart
   * needed for generation. Returns null on success, error string on failure.
   */
  function setBackend(newBackend, newBaseUrl, newModel) {
    const validation = validateBackend(newBackend, newBaseUrl ?? baseUrl);
    if (validation) return validation;
    backend = newBackend;
    if (newBaseUrl) baseUrl = newBaseUrl.replace(/\/$/, '');
    // The default model travels with the server: the one the old server
    // served is rarely installed on the new one. Mutates config.llm, which is
    // what every "nobody picked a model" fallback in server.mjs reads.
    if (newModel) llm.model = String(newModel);
    persistBackend();
    // Invalidate the model catalog cache — it's backend-specific.
    catalogCache.value = null;
    capabilityCache.clear();
    console.log(`[llm] backend switched to ${backend} at ${baseUrl} (default model ${llm.model})`);
    return null;
  }

  function getBackendInfo() {
    return { backend, base_url: baseUrl, model: llm.model ?? null, saved: existsSync(BACKEND_STATE_FILE) };
  }

  async function health() {
    if (backend === 'mock') {
      return { ok: true, backend, model: 'mock', detail: 'Mock backend — no model is being called.' };
    }
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        return { ok: false, backend, model: llm.model, code: ERR.BACKEND_UNAVAILABLE, detail: `HTTP ${res.status}` };
      }
      const data = await res.json().catch(() => ({}));
      const installed = (data.data ?? []).map((m) => m.id);
      const present = installed.includes(llm.model);
      return {
        ok: present,
        backend,
        model: llm.model,
        installed,
        code: present ? null : ERR.MODEL_NOT_INSTALLED,
        detail: present
          ? null
          : backend === 'ollama'
            ? `${llm.model} is not installed. Run: ollama pull ${llm.model}`
            // "ollama pull" is not a thing you can do to a llama.cpp server,
            // and this fires there for a reason worth naming: llama-server
            // reports its model as the blob path unless started with --alias,
            // so the name mismatches and the model reads as missing while it
            // is in fact loaded and generating.
            : `${backend} is serving ${installed.join(', ') || 'nothing'}, not ${llm.model}. ` +
              `Set --alias on the server to match, or change llm.model.`,
      };
    } catch (err) {
      const e = classify(err);
      // Name the backend that is actually down. This inherited "check Ollama"
      // from classify until 1 Sep 2026, which on a llamacpp box pointed the
      // owner at the one service that was healthy.
      const detail =
        e.code === ERR.BACKEND_UNAVAILABLE
          ? `Model offline — the ${backend} backend at ${baseUrl} is not answering.`
          : e.message;
      return { ok: false, backend, model: llm.model, code: e.code, detail };
    }
  }

  /**
   * What is actually resident in VRAM right now, as opposed to what is
   * configured or pulled.
   *
   * `health()` answers "is the configured model installed", which is a
   * different question and the one the status dot needs. On a box five people
   * share, and where h3 overrides to a 27B that cannot be resident alongside
   * the 8B, "what is on the GPU" is its own fact — and the honest answer
   * changes on its own as Ollama expires an idle model.
   *
   * Ollama and llama-swap. Any other backend loads at server start and holds
   * one model, so there is nothing to ask; those return null and the UI omits
   * the row rather than inventing one.
   *
   * **This said "Ollama-only" until 3 Sep 2026, and the reason it gave stopped
   * being true on 1 Sep.** That reason was that every other backend "loads at
   * server start and holds one model" — true of the single-model
   * `llamacpp.service`, and false of llama-swap, which swaps between five
   * models on demand and drops each after a 300s TTL. So the panel read
   * "Nothing loaded" while a 17GB model sat on the card, which is the one
   * question this row exists to answer. Reported by the owner, who noticed the
   * app was not showing what was live on the GPU.
   *
   * Never throws. This is decoration on a status poll, and a box with a
   * backend briefly unreachable must not turn a status response into an error.
   */
  /**
   * llama-swap's running models with their state ('starting', 'ready', ...),
   * for the idle clock. Null when it cannot be read or this is not llama-swap.
   */
  async function runningStates() {
    if (backend !== 'llamacpp') return null;
    const root = baseUrl.replace(/[/]v1[/]?$/, '').replace(/[/]$/, '');
    try {
      const res = await fetch(`${root}/running`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return null;
      const data = await res.json().catch(() => ({}));
      return (data.running ?? []).filter((m) => m?.model).map((m) => ({ model: m.model, state: m.state }));
    } catch {
      return null;
    }
  }

  async function resident() {
    if (backend === 'llamacpp') return residentLlamaSwap();
    if (backend !== 'ollama') return null;
    // /api/ps is the native API, not the OpenAI-compatible surface, so the
    // /v1 suffix has to come off.
    const root = baseUrl.replace(/[/]v1[/]?$/, '').replace(/[/]$/, '');
    try {
      const res = await fetch(`${root}/api/ps`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return null;
      const data = await res.json().catch(() => ({}));
      return (data.models ?? []).map((m) => ({
        model: m.name ?? m.model,
        size_bytes: m.size ?? null,
        // How long before Ollama drops it. keep_alive is 15m here, so this
        // counts down visibly while nobody is generating.
        expires_in_seconds: m.expires_at
          ? Math.max(0, Math.round((new Date(m.expires_at).getTime() - Date.now()) / 1000))
          : null,
        // What fraction sits on the card. Ollama reports size_vram separately
        // and a partial offload is the difference between "fast" and "why is
        // this taking four minutes".
        vram_bytes: m.size_vram ?? null,
      }));
    } catch {
      return null;
    }
  }

  /**
   * The same question, asked of llama-swap.
   *
   * Two endpoints, because llama-swap splits what Ollama's /api/ps returns in
   * one: `/running` names the models it currently has processes for, and
   * `/metrics` carries the card's real memory from the `nvidia-smi --loop 5`
   * llama-swap already runs. That second number is better than Ollama's: it is
   * what the card actually holds, not a per-model estimate.
   *
   * Three fields are deliberately shaped or withheld:
   *
   * - `expires_in_seconds` stays NULL even though `/running` reports a `ttl`.
   *   That ttl is the CONFIGURED 300, not the remaining time, and the panel
   *   renders this field as a live countdown — feeding it a constant would
   *   paint a timer frozen at 5:00, which is worse than no timer at all
   *   because it looks like an answer.
   * - `size_bytes` comes from stat-ing the `--model` path out of the launch
   *   command. That is the weights file, which is the honest analogue of what
   *   Ollama reports, and it is what makes the "partly on CPU" comparison in
   *   residentLine() possible on a card this tight.
   * - `vram_bytes` is the WHOLE CARD's usage, so it is attributed only when
   *   exactly one model is running. With two it would credit one model for
   *   both, and a wrong number here reads as a partial offload that is not
   *   happening. One at a time is the normal state — a second 27B does not fit
   *   — but normal is not always.
   */
  async function residentLlamaSwap() {
    const root = baseUrl.replace(/[/]v1[/]?$/, '').replace(/[/]$/, '');
    try {
      const res = await fetch(`${root}/running`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return null;
      const data = await res.json().catch(() => ({}));
      const running = (data.running ?? []).filter((m) => m?.model);
      if (!running.length) return [];

      // Card memory, from llama-swap's own nvidia-smi poll. Best-effort: a
      // build without the metrics endpoint still gets model names.
      let cardUsed = null;
      try {
        const mres = await fetch(`${root}/metrics`, { signal: AbortSignal.timeout(3000) });
        if (mres.ok) {
          const body = await mres.text();
          const hit = /^llamaswap_gpu_memory_used_bytes\{[^}]*\}\s+([0-9.e+]+)$/m.exec(body);
          if (hit) {
            const n = Number(hit[1]);
            if (Number.isFinite(n) && n > 0) cardUsed = n;
          }
        }
      } catch {
        /* metrics are a bonus; the model names are the point */
      }

      return running.map((m) => ({
        model: m.model,
        size_bytes: modelFileBytes(m.cmd),
        expires_in_seconds: null,
        vram_bytes: running.length === 1 ? cardUsed : null,
      }));
    } catch {
      return null;
    }
  }

  /** Bytes of the `--model` file named in a llama-swap launch command, or null. */
  function modelFileBytes(cmd) {
    const hit = /--model\s+(\S+)/.exec(String(cmd ?? ''));
    if (!hit) return null;
    try {
      return statSync(hit[1]).size;
    } catch {
      // The blob path is a deployment detail and may not be readable by this
      // process. Not worth a warning on a status poll that runs every 10s.
      return null;
    }
  }

  // What /api/tags said, and when. The chat model selector wants a size beside
  // every installed model so "this will load a 17GB model" is visible before
  // the click, and /api/status is polled every 10 seconds by everyone signed
  // in. The pulled list changes when somebody runs `ollama pull`, which is not
  // a 10-second event, so a short cache turns five pollers into one request a
  // minute rather than one every two seconds.
  let catalogCache = { at: 0, value: null };
  const CATALOG_TTL_MS = 60000;

  /**
   * Every model this backend has pulled, with its size on disk.
   *
   * Separate from `health()` because the OpenAI-compatible `/v1/models`
   * surface reports ids and nothing else — no size, no parameter count, no
   * quantisation. Those come from Ollama's native `/api/tags`, which is the
   * same split `resident()` already lives on.
   *
   * Ollama-only; every other backend holds one model that was chosen at start,
   * so there is nothing to list. Those return null and the selector falls back
   * to plain names. Never throws — this is decoration on a status poll.
   */
  // What a model can DO, as the model itself reports it.
  //
  // Added 25 Aug 2026 for the vision badge. The point of reading it rather
  // than keeping a list in the frontend is that a hardcoded list goes stale
  // the moment somebody pulls something, and that capability does not track
  // anything guessable from the name: on this box qwen3:8b and qwen3:1.7b
  // report no vision while the Qwen3.8 27B and the Huihui 9B beside them both
  // do, and the P40 runs an entirely different set again. Ask the model.
  //
  // /api/tags does NOT carry this - only /api/show does, one call per model.
  // That is why it is cached separately and far harder than the size cache:
  // capabilities are a property of the model's manifest, so for a given tag
  // they cannot change while this process lives. One burst on the first poll,
  // then nothing. A failure is deliberately NOT cached, or one timeout would
  // mark a model as sightless for the life of the server.
  const capabilityCache = new Map();

  async function capabilitiesFor(root, model) {
    if (capabilityCache.has(model)) return capabilityCache.get(model);
    try {
      const res = await fetch(`${root}/api/show`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: model }),
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) return null;
      const data = await res.json().catch(() => ({}));
      const list = Array.isArray(data.capabilities) ? data.capabilities : null;
      if (list) capabilityCache.set(model, list);
      return list;
    } catch {
      return null;
    }
  }
  /**
   * Where to ask what a model can DO, when the prompt backend cannot say.
   *
   * Only Ollama answers /api/show. Prompt generation moved to llama.cpp on
   * 1 Sep 2026, and llama-swap's /v1/models reports ids and nothing else — so
   * every model in the picker lost its vision badge that day and nothing said
   * so. The same silence killed the reference cross-check for three days, and
   * the fix is the same one: ask the backend that would actually be shown a
   * picture, which is reference_vision.base_url.
   *
   * A model that backend has never heard of stays null, which renders as no
   * badge. That is the honest answer rather than a pessimistic one: it may
   * well be able to see, but not down the path this app sends pictures.
   */
  const capabilityUrl =
    config.reference_vision?.base_url ?? (backend === 'ollama' ? baseUrl : null);

  /**
   * …unless the config says outright, which on llama.cpp it must.
   *
   * Vision there is a property of how llama-swap STARTS a model: an entry with
   * `--mmproj` can see and one without cannot, and no endpoint reports it. So
   * reference_vision.vision_models names them, the gate in
   * server/visiontags.mjs reads the same list, and the badge and the gate
   * cannot disagree — which they did for a week, in the direction where the
   * badge said nothing and the gate said no.
   */
  const declaredVision = Array.isArray(config.reference_vision?.vision_models)
    ? config.reference_vision.vision_models
    : null;

  async function catalog() {
    if (backend === 'mock') return null;

    // OpenAI-shaped backends list what they serve at /v1/models. A bare
    // llama-server reports the single model it loaded; llama-swap reports
    // every model it is configured to swap between, which is what makes the
    // model pickers work at all on those backends.
    //
    // None of them report size, quantisation or capabilities, so those stay
    // null. Null means "unknown" here and not "no": callers must not read a
    // missing capability list as a model saying it cannot do something. See
    // toolsFor in server.mjs, which trusts the config on these backends
    // rather than inferring absence from silence.
    if (backend !== 'ollama') {
      if (catalogCache.value && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
        return catalogCache.value;
      }
      try {
        const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) return catalogCache.value;
        const data = await res.json().catch(() => ({}));
        const value = (data.data ?? [])
          .map((m) => m?.id)
          .filter(Boolean)
          .map((id) => ({
            model: id,
            size_bytes: null,
            parameter_size: null,
            quantization: null,
            capabilities: null,
            vision: null,
          }));
        if (!value.length) return catalogCache.value;
        // Capabilities from the backend that has them — see capabilityUrl.
        // Cached per model for the life of the process, so this is one burst
        // on the first poll and nothing thereafter, and a failure leaves the
        // row at null rather than claiming the model is sightless.
        if (declaredVision) {
          for (const row of value) row.vision = declaredVision.includes(row.model);
        } else if (capabilityUrl) {
          const root = capabilityUrl.replace(/[/]v1[/]?$/, '').replace(/[/]$/, '');
          await Promise.all(value.map(async (row) => {
            const list = await capabilitiesFor(root, row.model);
            row.capabilities = list;
            row.vision = list ? list.includes('vision') : null;
          }));
        }
        catalogCache.value = value;
        catalogCache.at = Date.now();
        return value;
      } catch {
        return catalogCache.value;
      }
    }

    if (catalogCache.value && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
      return catalogCache.value;
    }
    const root = baseUrl.replace(/[/]v1[/]?$/, '').replace(/[/]$/, '');
    try {
      const res = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return catalogCache.value;
      const data = await res.json().catch(() => ({}));
      const value = (data.models ?? []).map((m) => ({
        model: m.name ?? m.model,
        size_bytes: m.size ?? null,
        parameter_size: m.details?.parameter_size ?? null,
        quantization: m.details?.quantization_level ?? null,
      }));
      // In parallel, and never fatal: a model whose capabilities could not be
      // read gets null, which the UI renders as no badge rather than as a
      // claim that it cannot see.
      await Promise.all(value.map(async (row) => {
        const list = await capabilitiesFor(root, row.model);
        row.capabilities = list;
        row.vision = list ? list.includes('vision') : null;
      }));
      catalogCache = { at: Date.now(), value };
      return value;
    } catch {
      // The last good answer beats no answer: a selector that empties itself
      // because one poll timed out is worse than one showing a stale size.
      return catalogCache.value;
    }
  }

  /**
   * Drop a model out of VRAM now, rather than waiting out keep_alive.
   *
   * Ollama has no explicit unload verb: a generate request with keep_alive 0
   * and no prompt loads nothing and sets the expiry to immediate, which is the
   * documented way to do it. Native API, so the /v1 suffix comes off.
   *
   * Why anyone wants it: keep_alive is 15m here because ComfyUI shares this
   * card, and "I need the GPU back right now" otherwise means waiting a
   * quarter of an hour or generating something you do not want on a smaller
   * model. Owner-gated, because it takes the card away from whoever is using
   * it.
   *
   * Ollama and llama-swap (backend `llamacpp`), which has its own per-model
   * unload route. Anything else loads one model at start and holds it for the
   * life of the process, so there is nothing to unload and saying so is better
   * than pretending it worked.
   */
  /**
   * How long Ollama holds a model in VRAM after a request.
   *
   * Starts at config/server.yaml's llm.keep_alive and is settable at runtime,
   * because the right answer changes with what else wants the card: 15m suits
   * a working session with ComfyUI sharing the GPU, "0" suits handing the card
   * straight back after one generation, and "-1" suits a box that does nothing
   * else. Making that a restart-and-edit-config operation meant nobody ever
   * changed it.
   *
   * Held here rather than mutated on the config object from outside, so there
   * is one owner of the value and every request reads the same place.
   */
  let keepAlive = llm.keep_alive ?? null;
  const getKeepAlive = () => keepAlive;
  const setKeepAlive = (value) => {
    keepAlive = value;
    return keepAlive;
  };

  async function unload(model) {
    const name = String(model ?? '').trim();
    if (!name) return { ok: false, model: name, detail: 'No model named.' };
    const root = baseUrl.replace(/[/]v1[/]?$/, '').replace(/[/]$/, '');

    // llama-swap has an unload verb of its own, per model. This branch was
    // missing until 11 Sep 2026 and the button answered "holds one model for
    // the life of the process" — the single-model llamacpp.service reason,
    // which stopped being true when llama-swap replaced it on 1 Sep. It
    // mattered more once ttl went to 0 that same day: nothing expires on its
    // own any more, so this is the only way to hand the card back. Reported by
    // A user. The model id goes in raw: llama-swap's route is a catch-all,
    // and a tag's slashes are part of the id (checked on the box, v252).
    if (backend === 'llamacpp') {
      try {
        const res = await fetch(`${root}/api/models/unload/${name}`, {
          method: 'POST',
          signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          return { ok: false, model: name, detail: text.slice(0, 200) || `HTTP ${res.status}` };
        }
        return { ok: true, model: name, detail: null };
      } catch (err) {
        return { ok: false, model: name, detail: classify(err).message };
      }
    }

    if (backend !== 'ollama') {
      return { ok: false, model: name, detail: `${backend} holds one model for the life of the process - nothing to unload` };
    }
    try {
      const res = await fetch(`${root}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: name, keep_alive: 0 }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, model: name, detail: text.slice(0, 200) || `HTTP ${res.status}` };
      }
      await res.json().catch(() => ({}));
      // The catalog is unaffected - the model is still pulled, just not
      // resident - but resident() is read straight from Ollama on the next
      // poll, so nothing here needs invalidating.
      return { ok: true, model: name, detail: null };
    } catch (err) {
      return { ok: false, model: name, detail: classify(err).message };
    }
  }

  /**
   * Everything currently resident, dropped in one go.
   *
   * Reads what is loaded rather than taking a list from the caller: the client
   * would be working from a poll up to ten seconds old, and unloading a model
   * that already expired on its own is a confusing no-op to report.
   *
   * `skip`, when given, names models to leave loaded: the idle clock passes
   * llm.offload_exempt through it, the owner's Unload button does not.
   */
  async function unloadAll({ skip = null } = {}) {
    const loaded = ((await resident()) ?? []).filter((m) => !skip || !skip(m.model));
    if (!loaded.length) return { ok: true, unloaded: [], failed: [], detail: 'nothing was loaded' };
    const results = await Promise.all(loaded.map((m) => unload(m.model)));
    return {
      ok: results.every((r) => r.ok),
      unloaded: results.filter((r) => r.ok).map((r) => r.model),
      failed: results.filter((r) => !r.ok).map((r) => ({ model: r.model, detail: r.detail })),
      detail: null,
    };
  }

  /**
   * A message whose content is an array of parts, rewritten for Ollama.
   *
   * The OpenAI shape carries a picture INSIDE the content array, as an
   * `image_url` part beside the text. Ollama's native /api/chat keeps the two
   * apart: `content` stays a plain string and the pictures ride in a sibling
   * `images` array of bare base64, no data-URI wrapper.
   *
   * So the caller builds one shape — the OpenAI one, because that is what
   * this box serves — and this is the only place that knows the other exists.
   * Same split server/visiontags.mjs makes for the non-streaming read; the
   * two were written from the same pair of API docs on 8 Sep 2026.
   *
   * String content is returned untouched, so every existing caller is
   * unaffected: this only fires on a message that actually carries an image.
   */
  function forOllama(messages) {
    return messages.map((m) => {
      if (!Array.isArray(m.content)) return m;
      const text = m.content
        .filter((p) => p?.type === 'text')
        .map((p) => p.text)
        .join('\n');
      const images = m.content
        .filter((p) => p?.type === 'image_url')
        // The data-URI prefix is an OpenAI convention and Ollama chokes on
        // it. Stripped rather than rejected, since a bare base64 string is
        // also a legal thing for a caller to have put here.
        .map((p) => String(p.image_url?.url ?? '').replace(/^data:[^;]+;base64,/, ''))
        .filter(Boolean);
      return images.length ? { ...m, content: text, images } : { ...m, content: text };
    });
  }

  /**
   * Stream a chat completion. Yields normalised events:
   *   { type: 'token', text }
   *   { type: 'tool_call', index, id, name, arguments }
   *   { type: 'usage', usage }
   * Throws LLMError.
   *
   * `messages[].content` may be a string or an array of OpenAI content parts
   * — `{ type: 'text' }` and `{ type: 'image_url' }`. The array form is how a
   * reference image reaches the model that writes the prompt; see the
   * reference block in server.mjs. Verified on the P40 8 Sep 2026: llama-swap
   * streams a reply to an image on this same path, cold load included.
   */
  /**
   * Every generation's usage passes through here once, whichever route started
   * it, so its speed is recorded in one place rather than at every caller.
   * The hook must never break a generation.
   */
  async function* stream(opts) {
    // Abort events do not replay when a queued call starts after cancellation.
    if (opts.signal?.aborted) throw new LLMError(ERR.CANCELLED, 'Request cancelled.');
    // Per-model sampling defaults (llm.sampling in server.yaml). The caller's
    // own value wins; the config only fills what was left unset.
    const defaults = llm.sampling?.[opts.model ?? llm.model];
    if (defaults) {
      opts = { ...opts };
      for (const key of ['temperature', 'top_p', 'presence_penalty']) {
        if (opts[key] == null && defaults[key] != null) opts[key] = defaults[key];
      }
    }
    for await (const ev of streamInner(opts)) {
      if (ev.type === 'usage' && onUsage) {
        try { onUsage(opts.model ?? llm.model, ev.usage); } catch { /* metrics only */ }
      }
      yield ev;
    }
  }

  async function* streamInner({ system, messages = [], model, temperature, top_p, presence_penalty, thinking, tools, signal, mock, timeoutMs: override, contextLength, maxTokens }) {
    if (backend === 'mock') {
      yield* mockStream({ ...mock, signal });
      return;
    }

    // Per-model override, because one global timeout does not fit models with
    // wildly different output budgets. H3 with thinking on generates ~8,500
    // tokens for a seven-segment answer and needs minutes, while a booru
    // model is done in seconds.
    const effectiveTimeout = override ?? timeoutMs;

    const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;

    if (backend === 'ollama') {
      yield* ollamaNativeStream({
        baseUrl,
        timeoutMs: effectiveTimeout,
        signal,
        body: {
          model: model ?? llm.model,
          messages: forOllama(msgs),
          ...(tools ? { tools } : {}),
          ...(thinking != null ? { think: Boolean(thinking) } : {}),
          // How long Ollama keeps the model in VRAM after this request.
          // Unset, Ollama defaults to 5 minutes, which is short enough that a
          // pause to think between prompts goes cold. Configurable because
          // the right answer depends on whether anything else wants the card
          // — see llm.keep_alive in config/server.yaml. Through
          // keepAliveWireValue, because Ollama rejects the string "-1".
          ...(keepAlive != null ? { keep_alive: keepAliveWireValue(keepAlive) } : {}),
          options: {
            // Per-model context override. num_ctx is a load-time parameter,
            // so a model whose context differs from the resident one forces
            // an Ollama reload — see the note on h3 in config/models.yaml.
            ...(contextLength ?? llm.context_length
              ? { num_ctx: contextLength ?? llm.context_length }
              : {}),
            ...(temperature != null ? { temperature } : {}),
            ...(top_p != null ? { top_p } : {}),
            // Describe's anti-loop control (26 Sep 2026); unset everywhere else.
            ...(presence_penalty != null ? { presence_penalty } : {}),
            // A hard ceiling on generated tokens, set only when the person
            // asked for one — there is no default and there must not be. Left
            // unset, Ollama generates until the model stops or the context
            // runs out, which is the behaviour every measurement in this
            // project was taken under.
            //
            // This is a guillotine, not a target: the model is not told to
            // finish early, it is cut off mid-token. `done_reason` comes back
            // "length" when it bites, which is already surfaced as
            // `usage.truncated` and is what lets the generate route explain a
            // missing segment as "your limit cut it off" instead of blaming
            // the prompt file.
            ...(maxTokens != null ? { num_predict: maxTokens } : {}),
          },
        },
      });
      return;
    }

    // llama.cpp and vLLM take context at server start, not per request.
    yield* openAIStream({
      baseUrl,
      timeoutMs: effectiveTimeout,
      signal,
      body: {
        model: model ?? llm.model,
        messages: msgs,
        ...(temperature != null ? { temperature } : {}),
        ...(top_p != null ? { top_p } : {}),
        ...(presence_penalty != null ? { presence_penalty } : {}),
        ...(maxTokens != null ? { max_tokens: maxTokens } : {}),
        ...(tools ? { tools } : {}),
        // The OpenAI shape has no equivalent of Ollama's `think`, and leaving
        // it out is not neutral: a reasoning model thinks by default, and this
        // config turns thinking OFF for prompt generation because the task is
        // a rewrite and the reasoning is pure latency.
        //
        // Measured 1 Sep 2026 against llama-server with Qwen3.5-27B. Omitted,
        // an 80-token budget went 75 tokens into `delta.reasoning_content`
        // and emitted no `delta.content` at all — a blank panel and a
        // finish_reason of "length", with nothing to say why. With this set
        // the reasoning chunks go to zero and the tags flow.
        //
        // chat_template_kwargs rather than `reasoning_effort`, which also
        // worked: this branch serves vllm as well, and the kwargs form is
        // what both accept.
        //
        // A STRING `thinking` means thinking on at that effort level. Added
        // 2 Sep 2026 to make the on/off question measurable at all: the
        // Qwen3.8 template reports `supports_reasoning_effort` and accepts
        // exactly 'xhigh' | 'medium' | 'low', aliasing 'high' to 'xhigh' and
        // raising on anything else. Verified against the live template on the
        // P40, not inferred from the model card.
        //
        // Effort is a *steer*, not a cap. The template implements it by
        // injecting a sentence — "Keep your thinking brief" for low, "think
        // carefully through the task" for xhigh — and injects nothing at all
        // for medium, which therefore means the model's untouched default
        // rather than a midpoint. Nothing here reserves budget for the answer.
        ...(typeof thinking === 'string'
          ? {
              chat_template_kwargs: { enable_thinking: true },
              reasoning_effort: thinking,
            }
          : thinking != null
            ? { chat_template_kwargs: { enable_thinking: Boolean(thinking) } }
            : {}),
      },
    });
  }

  /**
   * Load the model into VRAM without generating anything.
   *
   * Ollama loads on demand and unloads after `keep_alive`, so the first
   * request after an idle spell pays the full load — tens of seconds for a
   * 14GB model. This is what the Warm up button calls, so that cost is paid
   * deliberately before writing a prompt rather than accidentally after.
   *
   * An empty `messages` array is the documented way to ask Ollama to load a
   * model and stop: it returns as soon as the model is resident.
   *
   * llama.cpp is served through llama-swap, which loads on demand the same
   * way. Until 18 Sep 2026 this answered "backend loads at start" for it — the
   * single-model llamacpp.service reason, stale since llama-swap replaced that
   * on 1 Sep — so the button did nothing and said so in a toast. llama-swap's
   * `/upstream/<model>/health` starts the model and answers once it is ready,
   * which is exactly a warm-up. vLLM still loads at start.
   */
  async function warmup({ model, contextLength, signal } = {}) {
    if (backend === 'mock') return { ok: true, backend, warmed: false, detail: 'mock backend' };

    const root = baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '');
    const started = Date.now();
    // Whatever the caller resolved, or the configured default when it resolved
    // nothing. Warming a model nobody is about to use is worse than not warming:
    // it pays a load, holds VRAM, and leaves the model that IS about to be used
    // fighting for what is left.
    const name = model ?? llm.model;

    if (backend === 'llamacpp') {
      try {
        // The id goes in raw, slashes and all, as in unload(): llama-swap
        // matches the configured model names against the path.
        const res = await fetch(`${root}/upstream/${name}/health`, {
          signal: signal ?? AbortSignal.timeout(300000),
        });
        const text = await res.text().catch(() => '');
        if (!res.ok) {
          // llama-swap answers in JSON ({"error":{"message":"model not found"}});
          // the toast wants the sentence, not the envelope.
          let detail = text.slice(0, 200) || `HTTP ${res.status}`;
          try { detail = JSON.parse(text)?.error?.message ?? detail; } catch { /* plain text */ }
          return { ok: false, backend, warmed: false, detail: `${name}: ${detail}` };
        }
        return { ok: true, backend, warmed: true, model: name, seconds: +((Date.now() - started) / 1000).toFixed(1) };
      } catch (err) {
        return { ok: false, backend, warmed: false, detail: classify(err).message };
      }
    }
    if (backend !== 'ollama') {
      return { ok: true, backend, warmed: false, detail: 'backend loads at start' };
    }
    // The context the generation will ask for, not the global one. num_ctx is a
    // load-time parameter, so warming at the wrong one means ollama reloads on
    // the first real request and the warm bought nothing.
    const numCtx = contextLength ?? llm.context_length;
    try {
      const res = await fetch(`${root}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: name,
          messages: [],
          ...(numCtx ? { options: { num_ctx: numCtx } } : {}),
          ...(keepAlive != null ? { keep_alive: keepAliveWireValue(keepAlive) } : {}),
        }),
        signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, backend, warmed: false, detail: text.slice(0, 200) || `HTTP ${res.status}` };
      }
      await res.text();
      return {
        ok: true,
        backend,
        warmed: true,
        model: name,
        seconds: +((Date.now() - started) / 1000).toFixed(1),
      };
    } catch (err) {
      return { ok: false, backend, warmed: false, detail: err.message };
    }
  }

  return {
    // Getters, not values: setBackend() changes these live, and a snapshot
    // here left every llm.backend check in server.mjs on the old backend.
    get backend() { return backend; },
    get baseUrl() { return baseUrl; },
    get model() { return llm.model; },
    timeoutMs,
    health, resident, runningStates, catalog, unload, unloadAll, stream, warmup,
    getKeepAlive, setKeepAlive,
    setBackend, getBackendInfo,
  };
}
