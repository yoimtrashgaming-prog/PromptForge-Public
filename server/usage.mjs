// A counter per LLM, so the owner can decide what to delete.
//
// The box holds several 17-27GB models and the card holds one at a time. The
// question is not "what is installed" — `llm.catalog()` answers that — but
// "has anyone touched this since July". Nothing in the app knew that, so the
// decision was being made from memory.
//
// It is a counter and nothing more: a name, how many times it answered, when
// it last did. No tokens, no averages, no per-user breakdown — those are
// questions nobody has asked, and every extra column is another thing to keep
// true. Owner's call, 5 Sep 2026.
//
// One count per completed inference, at every site that calls `llm.stream`
// plus the vision cross-check, which talks to Ollama directly. The name
// recorded is the model that actually answered — `chooseModel` returns
// undefined for "no opinion, let the backend decide", and a row called
// `undefined` would be useless, so callers resolve it against `llm.model`
// before counting.
//
// **Nothing here is load-bearing.** Every write is wrapped: a full disk or a
// corrupt file costs the owner a statistic, and must never cost anyone a
// generation. No record() call site checks a return value, and none should
// have to.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export function createUsageStore(rootDir, config) {
  const file = path.resolve(
    rootDir,
    config.paths?.usage ?? path.join(config.paths?.data ?? 'data', 'usage.json')
  );

  // Held in memory and rewritten whole. Five people and a handful of model
  // names — the file is a few hundred bytes, the writes are one per
  // inference, and an inference takes tens of seconds. Anything cleverer
  // would be solving a problem this box does not have.
  let models = load();

  function load() {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed?.models && typeof parsed.models === 'object') return parsed.models;
    } catch {
      // Absent on a fresh install, which is normal and not worth a log line.
      // A corrupt file starts over rather than taking the app down — these
      // are counters, not anyone's work.
    }
    return {};
  }

  function save() {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ version: 1, models }, null, 2), 'utf8');
    } catch (err) {
      console.warn(`[usage] could not write ${file} — ${err.message}`);
    }
  }

  /** One completed inference. Never throws — see the header. */
  function record(model) {
    try {
      const name = String(model ?? '').trim();
      if (!name) return;
      const row = (models[name] ??= { runs: 0, first_at: null, last_at: null });
      const iso = new Date().toISOString();
      row.runs += 1;
      row.first_at ??= iso;
      row.last_at = iso;
      save();
    } catch (err) {
      console.warn(`[usage] not counted — ${err.message}`);
    }
  }

  /**
   * The table, most-used first.
   *
   * `installed` merges in what the backend actually holds, so a model nobody
   * has ever touched appears with a zero rather than being invisible — which
   * is the entire point on a free-up-disk day.
   *
   * `onlyInstalled` drops the rows with a count but no matching install. That
   * was the default reading until 8 Sep 2026, when the panel was found to be
   * three-quarters test fixtures: the suites boot the real server against a
   * stub backend under names like `qwen3:8b` and `stub-model`, and every fake
   * generation lands here, because config pins `paths.usage` to a literal path
   * that PROMPTFORGE_DATA_DIR does not redirect. 873 of 1,193 runs were
   * `scripts/check.mjs`. Those names are never in a catalogue, so "is the
   * backend serving this" separates them from real use exactly.
   *
   * **The total is recomputed over what is shown.** A hidden row that still
   * counted toward the denominator would leave every real model reading as a
   * sliver of a number that includes phantoms — which is the failure this is
   * fixing, expressed as a percentage instead of a row.
   *
   * Nothing is deleted and the filter is not silent: `hidden` says how many
   * rows it dropped, so the owner can ask for them and clear the counts. A
   * deleted-but-used model is a real case and still lives in there.
   */
  function summary({ installed = [], now = Date.now(), onlyInstalled = false } = {}) {
    const byName = new Map();
    for (const entry of installed ?? []) {
      const name = typeof entry === 'string' ? entry : entry?.model;
      if (name) {
        byName.set(String(name), typeof entry === 'string' ? null : (entry.size_bytes ?? null));
      }
    }

    // A backend that could not be reached answers with an empty list, and
    // every row would read as uninstalled. Filtering on that would empty the
    // panel on a timeout and blame it on the models — so the filter only
    // applies when there is a catalogue to filter against.
    const canFilter = onlyInstalled && byName.size > 0;

    const rows = [];
    let hidden = 0;
    let total = 0;
    for (const name of new Set([...byName.keys(), ...Object.keys(models)])) {
      const row = models[name] ?? { runs: 0, first_at: null, last_at: null };
      const last = row.last_at ? Date.parse(row.last_at) : NaN;
      if (canFilter && !byName.has(name)) {
        hidden += 1;
        continue;
      }
      total += row.runs;
      rows.push({
        model: name,
        installed: byName.has(name),
        size_bytes: byName.get(name) ?? null,
        runs: row.runs,
        first_at: row.first_at,
        last_at: row.last_at,
        days_since: Number.isNaN(last) ? null : Math.floor((now - last) / 86400000),
      });
    }

    // Among the never-used, installed first — those are the rows the owner
    // came here to find.
    rows.sort(
      (a, b) =>
        b.runs - a.runs ||
        Number(b.installed) - Number(a.installed) ||
        a.model.localeCompare(b.model)
    );
    for (const r of rows) r.share = total ? r.runs / total : 0;

    // `filtered` is what actually happened, not what was asked for — the
    // unreachable-backend case above answers false with a full table, and the
    // panel says "showing everything" rather than claiming a filter it did
    // not apply.
    return { total_runs: total, models: rows, hidden, filtered: canFilter };
  }

  /**
   * Forget one model's count.
   *
   * For after a deletion: the row would otherwise sit in the table describing
   * weights that are no longer on the disk, and a panel that keeps talking
   * about things that do not exist stops being read.
   */
  function forget(model) {
    const name = String(model ?? '').trim();
    if (!name || !(name in models)) return false;
    delete models[name];
    save();
    return true;
  }

  return { record, summary, forget, file };
}
