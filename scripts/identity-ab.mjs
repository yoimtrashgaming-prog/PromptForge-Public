// Measure one identity call both ways: what the trait lookup returns for a
// character with and without a group.
//
//   node scripts/identity-ab.mjs <character> <tag>[,<tag>...]
//   node scripts/identity-ab.mjs "fubuzilla_(shirakami_fubuki)" shirakami_fubuki
//
// Run it ON THE P40: it reads the live tag database and asks danbooru for a
// fresh sample. Each side gets its own cache under data/tags/ab-*.sqlite, so
// neither answer leaks into the other or into the running app.
//
// Measure a pair BEFORE adding it to config/same-person.yaml. The file is
// always loaded, so once a pair is listed both sides come back grouped and
// identical; comment the line out to re-measure it.
//
// Read the two trait lists, not just the companion line. A group is right when
// the grouped side gains the character's own face (Fubuzilla's `fox_girl`) and
// wrong when it loses what makes the tag distinct (Seele's alter ego losing
// `black_dress`, Joker losing his mask) or picks up a stranger as the new
// companion. See docs/character-identities.md.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.mjs';
import { createTagStore } from '../server/tags.mjs';
import { createTraitStore } from '../server/traits.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [who, others] = process.argv.slice(2);
if (!who || !others) {
  console.error('usage: identity-ab.mjs <character> <tag>[,<tag>...]');
  process.exit(2);
}

const { config, error } = loadConfig(ROOT, 'server');
if (!config) {
  console.error(error ?? 'config/server.yaml did not load');
  process.exit(1);
}
const tagStore = createTagStore(ROOT, config, { warn: () => {} });

for (const [label, extra] of [['ungrouped', []], ['grouped', [[who, ...others.split(',')]]]]) {
  const store = createTraitStore(ROOT, {
    ...config,
    traits: { ...config.traits, db_path: `data/tags/ab-${label}.sqlite`, same_person: extra },
  }, { warn: () => {} });
  const r = await store.lookup(who, tagStore, { refresh: true });
  console.log(`${label.padEnd(9)} companion=${r.companion ?? 'none'} mixed=${!!r.mixed}`);
  console.log(`          ${(r.traits ?? []).map((t) => t.tag ?? t).join(', ')}`);
}
