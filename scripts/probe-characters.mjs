// resolveCharacters against the REAL tag database.
//
// scripts/test-characters.mjs runs on a 15-row stub so it can live in
// `npm run check`. That proves the logic; it cannot prove the logic survives
// 181,714 real rows, where a name like "rem" has neighbours the stub does not.
// This is the sanity pass over real data. No network, no model, no GPU — the
// tag database is sqlite on disk, and traits lookup is not called here.
//
//   node scripts/probe-characters.mjs ["a brief of your own"]

import { createTagStore } from '../server/tags.mjs';
import { loadConfig } from '../server/config.mjs';
import { resolveCharacters } from '../server/character.mjs';

// loadConfig returns { config, applied, error }, not the config. Unwrapping it
// wrong is silent — every setting below falls back to its default, so this
// probe measured the defaults rather than the shipped file until 27 Aug 2026.
const { config } = loadConfig(process.cwd(), 'server');
const tags = createTagStore(process.cwd(), config);

if (!tags.loaded) {
  console.error('tag database not loaded — run: npm run update-tags');
  process.exit(1);
}

const custom = process.argv.slice(2).join(' ').trim();

// Each row is [brief, what should happen]. The expectations are the point:
// the first two are the cases that got auto-resolve rejected in traits.mjs.
const CASES = custom
  ? [[custom, null]]
  : [
      ['miku singing on a neon stage', 'must NOT resolve to a kancolle ship'],
      ['rem in a maid outfit', 'rem_(re:zero) or nothing — never remilia_scarlet'],
      ['Mualani surfing a big wave in Natlan', 'mualani_(genshin_impact)'],
      ['Makima from Chainsaw Man on a rain-slick Tokyo rooftop', 'makima_(chainsaw_man)'],
      ['Zhongli from Genshin Impact sitting alone in a teahouse', 'zhongli_(genshin_impact)'],
      ['Fern from Frieren as a steampunk mechanic', 'fern_(sousou_no_frieren)'],
      ['ganyu and xiao on a cliff at sunrise', 'both, or an honest abstention'],
      ['a lighthouse keeper hauling rope in a storm', 'nothing — no character named'],
      ['two knights resting against a broken wall at evening', 'nothing'],
      ['a cup of tea on a low table, morning light', 'nothing'],
      ['an astronaut sitting on a rock watching a ringed planet', 'nothing'],
      ['2b from nier walking through a flooded ruin', '2b_(nier:automata)'],
    ];

console.log(`\ntag database: ${tags.info().rows ?? '?'} rows\n`);

for (const [brief, expect] of CASES) {
  const t0 = Date.now();
  const out = resolveCharacters(brief, tags, {
    minPostCount: config.characters?.min_post_count ?? 50,
    minSoloPostCount: config.characters?.min_solo_post_count ?? 500,
    maxCharacters: config.characters?.max_characters ?? 3,
  });
  const ms = Date.now() - t0;

  console.log(`"${brief}"`);
  if (expect) console.log(`   expect  ${expect}`);
  for (const r of out.resolved) {
    console.log(`   RESOLVED ${r.tag}  (${r.via}, ${r.post_count} posts)`);
  }
  for (const a of out.ambiguous) {
    console.log(`   ambiguous "${a.name}" -> ${a.candidates.join(', ')}`);
  }
  if (!out.resolved.length && !out.ambiguous.length) console.log('   (nothing)');
  console.log(`   ${ms}ms\n`);
}
