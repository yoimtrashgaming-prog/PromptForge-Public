// What the tag filter would remove, before it removes it.
//
//   node scripts/preview-tag-filter.mjs                    # pulls from danbooru
//   node scripts/preview-tag-filter.mjs --cache <file.json> # reuses a pull
//
// The filter in server/tagfilter.mjs is the one part of the tag import that
// is a judgement rather than a transfer, so it gets looked at rather than
// trusted. This prints the tally by class, the biggest thing each class
// removed, and — the half that matters more — the biggest things it KEPT, so
// a rule that has quietly started eating real vocabulary is visible.
//
// `--cache` exists because a full pull is ~150 requests against somebody
// else's server and the filter is worth iterating on more than once.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fetchTags } from '../server/danbooru-tags.mjs';
import { filterTags, judgeTag } from '../server/tagfilter.mjs';

const args = process.argv.slice(2);
const cacheIdx = args.indexOf('--cache');
const cache = cacheIdx >= 0 ? args[cacheIdx + 1] : null;
const CAT = { 0: 'general', 1: 'artist', 3: 'copyright', 4: 'character', 5: 'meta' };

let tags;
if (cache && existsSync(cache)) {
  const raw = JSON.parse(readFileSync(cache, 'utf8'));
  tags = Array.isArray(raw) ? raw : raw.tags;
  console.log(`${tags.length.toLocaleString()} tags from ${cache}\n`);
} else {
  console.log('pulling from danbooru…');
  tags = await fetchTags({
    minPostCount: 50,
    onProgress: (page, n) => { if (page % 25 === 0) console.log(`  page ${page}: ${n.toLocaleString()}`); },
  });
  if (cache) writeFileSync(cache, JSON.stringify(tags));
  console.log(`${tags.length.toLocaleString()} tags\n`);
}

const { kept, dropped, tally, examples } = filterTags(tags);

console.log(`keeping ${kept.length.toLocaleString()}, dropping ${dropped.length.toLocaleString()} ` +
  `(${(100 * dropped.length / tags.length).toFixed(2)}%)\n`);

console.log('dropped, by class:');
for (const [why, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  const ex = examples[why];
  console.log(`  ${why.padEnd(18)} ${String(n).padStart(5)}   biggest: ${ex.name} (${ex.post_count.toLocaleString()})`);
}

// The check that matters. Anything dropped with a large post count is either
// genuine bookkeeping — in which case its size is expected, `commentary` is
// on millions of posts — or a rule that has caught something real.
console.log('\nthe 25 biggest tags this drops — read these, they are where a bad rule shows:');
for (const t of dropped.sort((a, b) => b.post_count - a.post_count).slice(0, 25)) {
  console.log(`  ${t.name.padEnd(38)} ${String(t.post_count).padStart(9)}  ${CAT[t.category] ?? t.category}  [${judgeTag(t).why}]`);
}

// Per category, so "we dropped 4% overall" cannot hide "we dropped 60% of
// the artists".
console.log('\nkept vs dropped, per category:');
const per = {};
for (const t of tags) {
  const c = CAT[t.category] ?? String(t.category);
  per[c] ??= { kept: 0, dropped: 0 };
  per[c][judgeTag(t).keep ? 'kept' : 'dropped'] += 1;
}
for (const [c, v] of Object.entries(per).sort((a, b) => (b[1].kept + b[1].dropped) - (a[1].kept + a[1].dropped))) {
  const total = v.kept + v.dropped;
  console.log(`  ${c.padEnd(11)} kept ${String(v.kept).padStart(6)}  dropped ${String(v.dropped).padStart(5)}  (${(100 * v.dropped / total).toFixed(1)}%)`);
}
