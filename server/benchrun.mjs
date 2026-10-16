// "Run benchmark" — the owner presses it and walks away (22 Sep 2026).
//
// The owner's brief: "the run benchmark button would just run and you walk
// away, then you have a generalized idea of what speeds you get on a model".
// So: one fixed prompt, every chosen model, three runs each, and a sheet
// written into data/benchmarks/ where the Benchmarks tab picks it up. Every
// run also goes through llm.stream, so its speed reaches the metrics (and
// Grafana, when monitoring is on) the same way a real generation's does.
//
// How it shares the box with people:
//   - each model takes ONE queue ticket for all three of its runs, so nobody
//     else's generation can swap the model out mid-measurement; between
//     models, queued people go first
//   - each model starts unloaded, so "first reply" is an honest cold start,
//     and everything is unloaded at the end so the run leaves nothing
//     resident (idle offload exists for the owner's power bill)
//   - one run at a time; Cancel stops after the current generation
//
// The numbers are the LLM server's own (llama.cpp `timings`, Ollama's eval
// counters), not wall-clock guesses. Only "first reply" is timed here,
// because it is the one that includes loading the model.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const RUNS = 3;
const MAX_TOKENS = 256;

// Fixed so runs are comparable across days and machines. A few hundred
// tokens in, a couple of hundred out: long enough that decode speed settles,
// short enough that a full run over eight 27Bs stays in minutes.
const SYSTEM = 'You are a careful writer. Answer in plain prose, one paragraph, no lists, no headings.';
const PROMPT =
  'Describe, in about two hundred words, a quiet harbour town at dawn: the light on the water, ' +
  'the fishing boats coming in, the smell of the market opening, the gulls, and one old ' +
  'woman walking along the sea wall. Keep it concrete and visual, the way a painter would ' +
  'describe what they intend to paint.';

export function createBenchRunner({ llm, queue, sysmon, speedOf, benchDir, owner }) {
  let job = null; // the current or last run

  const now = () => Date.now();

  function status() {
    return job
      ? {
          state: job.state,
          models: job.models,
          current: job.current,
          done: job.results.length,
          total: job.models.length,
          started_at: job.startedAt,
          finished_at: job.finishedAt,
          sheet: job.sheet,
          error: job.error,
          results: job.results,
        }
      : { state: 'idle' };
  }

  function cancel() {
    if (job?.state === 'running') job.cancelled = true;
    return status();
  }

  async function one(model) {
    const runs = [];
    let firstReplyS = null;
    for (let i = 0; i < RUNS; i += 1) {
      if (job.cancelled) break;
      const t0 = now();
      let firstToken = null;
      let speed = null;
      for await (const ev of llm.stream({
        system: SYSTEM,
        messages: [{ role: 'user', content: PROMPT }],
        model,
        temperature: 0.2,
        thinking: false,
        maxTokens: MAX_TOKENS,
      })) {
        if (ev.type === 'token' && firstToken == null) firstToken = now();
        if (ev.type === 'usage') speed = speedOf(ev.usage) ?? speed;
      }
      if (i === 0 && firstToken != null) firstReplyS = (firstToken - t0) / 1000;
      if (speed) runs.push(speed);
    }
    const rate = (tok, sec) => (sec > 0 ? tok / sec : null);
    // Speeds from the WARM runs only. The first run straight after loading
    // measured ~10x slower than the next two in the first real test (28 tok/s
    // against ~315 on a 1.7B), and averaging it in understated the model
    // badly. The cold cost is what first_reply_s is for.
    const warm = runs.length > 1 ? runs.slice(1) : runs;
    const decode = warm.map((r) => rate(r.completion_tokens, r.decode_seconds)).filter((x) => x != null);
    // Prompt reading the other way round: from the FIRST run only. The warm
    // runs send the identical prompt, which the server serves from its cache
    // - the second real test read 16,708 tok/s off that, a measure of the
    // cache and not of reading. Straight after a load nothing is cached.
    const pt = runs[0]?.prompt_tokens ?? 0;
    const ps = runs[0]?.prompt_seconds ?? 0;
    const ct = warm.reduce((a, r) => a + r.completion_tokens, 0);
    const ds = warm.reduce((a, r) => a + r.decode_seconds, 0);
    return {
      model,
      runs: runs.length,
      first_reply_s: firstReplyS,
      prompt_tps: rate(pt, ps),
      decode_tps: rate(ct, ds),
      decode_min: decode.length ? Math.min(...decode) : null,
      decode_max: decode.length ? Math.max(...decode) : null,
      tokens: ct,
    };
  }

  async function run(models) {
    for (const model of models) {
      if (job.cancelled) break;
      job.current = model;
      const ticket = queue.enqueue({ user: owner(), model, kind: 'benchmark' });
      try {
        await ticket.started;
        await llm.unloadAll().catch(() => {});
        job.results.push(await one(model));
      } catch (err) {
        job.results.push({ model, error: err.message ?? String(err) });
      } finally {
        ticket.release();
      }
    }
    job.current = null;
    await llm.unloadAll().catch(() => {});
    if (job.results.length) job.sheet = await writeSheet();
    job.state = job.cancelled ? 'cancelled' : 'done';
    job.finishedAt = new Date().toISOString();
  }

  function start(models) {
    if (job?.state === 'running') return { ok: false, message: 'A benchmark is already running.' };
    const list = [...new Set((models ?? []).map(String).filter(Boolean))];
    if (!list.length) return { ok: false, message: 'Pick at least one model.' };
    job = {
      state: 'running',
      models: list,
      current: null,
      results: [],
      cancelled: false,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      sheet: null,
      error: null,
    };
    run(list).catch((err) => {
      job.state = 'failed';
      job.error = err.message;
      job.finishedAt = new Date().toISOString();
      console.warn(`[benchmark] run failed: ${err.message}`);
    });
    return { ok: true };
  }

  const fmt = (n, d = 1) => (n == null || !Number.isFinite(n) ? '—' : n.toFixed(d));

  async function writeSheet() {
    let gpus = null;
    try {
      gpus = (await sysmon.read())?.gpu ?? null;
    } catch { /* no GPU reading */ }
    const when = new Date(job.startedAt);
    const stamp = when.toISOString().slice(0, 16).replace('T', ' ');
    const hardware = gpus?.length
      ? gpus.map((g) => `${g.name} (${Math.round(g.total / 1024 ** 3)} GB)`).join(', ')
      : 'no GPU reported';
    const lines = [
      `# Benchmark run, ${stamp} UTC`,
      '',
      `**Hardware:** ${hardware}. **Backend:** ${llm.backend}. ${job.cancelled ? '**Cancelled part-way.**' : ''}`,
      '',
      `Each model: unloaded, then the same fixed prompt ${RUNS} times, up to ${MAX_TOKENS} tokens out, ` +
        'thinking off. The first run gives the cold start and the prompt reading speed (nothing is ' +
        'cached yet); writing speed comes from the runs after it. All speeds are measured by the LLM server itself.',
      '',
      '| Model | First reply (cold, s) | Prompt reading (tok/s) | Writing (tok/s) | Writing range | Runs |',
      '|---|---:|---:|---:|---:|---:|',
      ...job.results.map((r) =>
        r.error
          ? `| ${r.model} | failed: ${r.error.replace(/\|/g, '/')} | | | | 0 |`
          : `| ${r.model} | ${fmt(r.first_reply_s)} | ${fmt(r.prompt_tps, 0)} | **${fmt(r.decode_tps)}** | ${fmt(r.decode_min)}–${fmt(r.decode_max)} | ${r.runs} |`
      ),
      '',
      '**First reply** includes loading the model from disk, so it is mostly how fast your drive and',
      'card can take the weights. **Writing** is the number to compare models by.',
      '',
    ];
    mkdirSync(benchDir, { recursive: true });
    const file = `benchmark-${when.toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{4})$/, '$1-$2')}.md`;
    writeFileSync(path.join(benchDir, file), lines.join('\n'));
    console.log(`[benchmark] wrote data/benchmarks/${file}`);
    return file;
  }

  return { start, cancel, status };
}
