#!/usr/bin/env node
//
// The run counter, and the filter that keeps the panel honest.
//
// Written on 8 Sep 2026, after the panel was found reporting `qwen3:8b` as 73%
// of all runs on a box that does not serve `qwen3:8b`. They were test runs:
// the suites boot the real server against a stub backend under fixture names,
// and every fake generation is recorded, because config/server.yaml pins
// `paths.usage` to a literal path and PROMPTFORGE_DATA_DIR only rewrites
// `paths.data`. 873 of 1,193 counted runs were `scripts/check.mjs`.
//
// So the cases below are mostly about that: a name the backend does not serve
// is not shown by default, the percentages are computed over what IS shown,
// and none of it happens when the catalogue could not be read.
//
// This suite writes to its own file under the OS temp directory — the module
// takes its path from config, and a test for a leaking counter that leaked
// into the live counter would be a poor advertisement.

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createUsageStore } from '../server/usage.mjs';

let failed = 0;
function ok(cond, label, detail) {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}`);
  if (!cond) {
    failed += 1;
    if (detail !== undefined) console.log(`       ${JSON.stringify(detail)}`);
  }
}

const dir = mkdtempSync(path.join(tmpdir(), 'promptforge-usage-'));
const store = (name = 'usage.json') =>
  createUsageStore(dir, { paths: { usage: path.join(dir, name) } });

console.log('\nCounting');
{
  const usage = store('count.json');
  usage.record('big-model');
  usage.record('big-model');
  usage.record('small-model');
  const { models, total_runs } = usage.summary({ installed: [] });
  ok(total_runs === 3, 'every record is one run', total_runs);
  ok(models[0].model === 'big-model' && models[0].runs === 2, 'most-used first', models[0]);
  ok(models[0].first_at && models[0].last_at, 'first and last are both stamped', models[0]);

  // The header's promise: no call site checks a return value, so nothing here
  // may throw on input the callers can actually produce.
  usage.record(undefined);
  usage.record('');
  usage.record(null);
  ok(usage.summary({ installed: [] }).total_runs === 3, 'a nameless run is not counted');
}

console.log('\nThe catalogue merge');
{
  const usage = store('merge.json');
  usage.record('used-model');
  const { models } = usage.summary({
    installed: [{ model: 'used-model', size_bytes: 5e9 }, { model: 'untouched-model' }],
  });
  const untouched = models.find((r) => r.model === 'untouched-model');
  ok(untouched?.runs === 0, 'an installed model nobody has picked shows a zero', untouched);
  ok(untouched?.installed === true, 'and is marked installed', untouched);
  ok(models.find((r) => r.model === 'used-model')?.size_bytes === 5e9, 'size comes from the catalogue');
}

console.log('\nOnly what the backend serves');
{
  const usage = store('filter.json');
  for (let i = 0; i < 3; i += 1) usage.record('real-model');
  for (let i = 0; i < 97; i += 1) usage.record('qwen3:8b'); // what a test suite leaves behind

  const all = usage.summary({ installed: [{ model: 'real-model' }] });
  ok(all.models.length === 2, 'unfiltered still shows every name', all.models.map((r) => r.model));
  ok(all.filtered === false, 'and says it did not filter');

  const shown = usage.summary({ installed: [{ model: 'real-model' }], onlyInstalled: true });
  ok(shown.models.length === 1 && shown.models[0].model === 'real-model',
    'a name the backend does not serve is dropped', shown.models.map((r) => r.model));
  ok(shown.hidden === 1, 'and is counted rather than vanishing', shown.hidden);
  ok(shown.filtered === true, 'and the panel is told the filter applied');

  // The point of the whole change. With the phantom in the denominator the
  // real model reads as 3% of the box's work; it is all of it.
  ok(shown.total_runs === 3, 'the total is recomputed over what is shown', shown.total_runs);
  ok(shown.models[0].share === 1, 'so the share is of real runs, not of the fixtures',
    shown.models[0].share);

  // Deleted weights are the case the filter must not swallow silently: the
  // count is still reachable, and Reset count is on that row.
  const back = usage.summary({ installed: [{ model: 'real-model' }], onlyInstalled: false });
  ok(back.models.some((r) => r.model === 'qwen3:8b' && r.runs === 97),
    'and asking for everything brings it back to be cleared');
}

console.log('\nAn unreachable backend');
{
  const usage = store('offline.json');
  usage.record('real-model');
  // llm.catalog() answers null on a failed poll and the route passes []. Every
  // row would look uninstalled; filtering on that empties the panel and blames
  // the models for a network timeout.
  const out = usage.summary({ installed: [], onlyInstalled: true });
  ok(out.models.length === 1, 'no catalogue means no filter', out.models);
  ok(out.filtered === false, 'and the panel is told so', out.filtered);
  ok(out.hidden === 0, 'nothing is reported hidden', out.hidden);
}

console.log('\nForgetting');
{
  const usage = store('forget.json');
  usage.record('gone-model');
  ok(usage.forget('gone-model') === true, 'a counted model can be forgotten');
  ok(usage.forget('gone-model') === false, 'twice is not an error, it is a no');
  ok(usage.summary({ installed: [] }).total_runs === 0, 'and the count is actually gone');

  // Rewritten whole on every write — the file on disk is the state, not a log
  // that has to be replayed.
  const usage2 = store('forget.json');
  ok(usage2.summary({ installed: [] }).models.length === 0, 'and it stays gone across a restart');
}

console.log('\nA corrupt file');
{
  const usage = store('broken.json');
  usage.record('a-model');
  const file = path.join(dir, 'broken.json');
  ok(JSON.parse(readFileSync(file, 'utf8')).version === 1, 'the file is versioned');

  const { writeFileSync } = await import('node:fs');
  writeFileSync(file, '{ not json', 'utf8');
  const reopened = store('broken.json');
  ok(reopened.summary({ installed: [] }).total_runs === 0,
    'a corrupt file starts over rather than taking the app down');
  reopened.record('a-model');
  ok(reopened.summary({ installed: [] }).total_runs === 1, 'and counting resumes');
}

rmSync(dir, { recursive: true, force: true });

console.log('\n──────────────────────────────────────────────────────────');
console.log(failed === 0 ? 'ALL PASSED' : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
