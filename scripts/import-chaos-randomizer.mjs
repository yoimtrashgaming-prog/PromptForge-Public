// Turn the Total Chaos Randomizer ComfyUI workflow into config/randomizer.json.
//
// The vocabulary in that workflow is the owner's, built over months, and it is
// far better than anything generated from tag-database patterns: it knows that
// "Pupil Shape" is a thing worth randomizing and that "Sclera" belongs under
// Eyes. Retyping it would have introduced errors and lost the grouping, so
// this reads it.
//
// ── How the nesting is recovered ──────────────────────────────────────────
//
// ComfyUI groups have no membership list. A group is a rectangle, and a node
// belongs to it if the node's position falls inside it — which is also how
// nesting is expressed: "H: Hair Color" is a small rectangle sitting inside
// the larger "HAIR" rectangle, so a node inside the small one is inside both.
//
// So containment is computed, and for each term node the SMALLEST containing
// group is its child category and the next one out is its parent. That is the
// whole algorithm, and it is why the output matches the layout on screen.
//
// Usage:
//   node scripts/import-chaos-randomizer.mjs <workflow.json> [--out FILE]
//
// Prints a summary to stderr and writes the config to --out (default
// config/randomizer.json). Existing output is overwritten, so keep it under
// git and read the diff — this is a generator, not a merge.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Groups PromptForge already covers with a dedicated control. Quality presets,
// negatives and styles all live in config/models.yaml per model, and a second
// place to set them would be two sources of truth for the same output — the
// owner's call, 5 Sep 2026.
const SKIP_GROUPS = [
  /^POSITIVE PROMPTS$/i,
  /^NEGATIVE PROMPTS$/i,
  /^Art Style$/i,
  /^P:/,
  /^N:/,
  /^AS:/,
];

const inside = (pos, [gx, gy, gw, gh]) =>
  pos[0] >= gx && pos[0] <= gx + gw && pos[1] >= gy && pos[1] <= gy + gh;

const area = ([, , w, h]) => w * h;

// A group, for counting only. The resolving happens in randomizer.py.
const GROUP = /\{([^{}]*)\}/g;

/**
 * `{a|b|b|c}` -> `{a|b:2|c}`. Lossless, and says out loud what the repeat
 * meant.
 *
 * Repetition was the only way to weight an option in the ComfyUI picker,
 * which has no weight syntax — the owner's explanation, 5 Sep 2026. This
 * script does have one, so the intent is written down instead of encoded in a
 * duplicate that reads like an accident. `b:2` and `b|b` behave identically;
 * randomizer.py honours both, so nothing breaks either way.
 */
function collapse(body) {
  const counts = new Map();
  for (const piece of body.split('|')) {
    const term = piece.trim();
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  let squashed = 0;
  const parts = [];
  for (const [term, n] of counts) {
    if (n > 1) squashed += n - 1;
    // A term already ending in `:<digits>` would be re-read as a weight, so
    // it is left repeated rather than given a weight that changes its text.
    parts.push(n > 1 && !/:\d{1,3}$/.test(term) ? `${term}:${n}` : Array(n).fill(term).join('|'));
  }
  return { body: parts.join('|'), squashed, distinct: counts.size };
}

/**
 * Read one widget value into a template, and count what is in it.
 *
 * The first version of this split on `|` and deduplicated, which was wrong
 * twice over — and both mistakes looked like tidying, which is why they are
 * written down:
 *
 * 1. **96 of the 166 nodes are templates, not lists.** "Angel" is
 *    `{wings}, {halo}, {clothes}, {glow}` — four slots, one pick from each,
 *    which is what makes the result a coherent angel instead of a loose wing.
 *    Flattening it produced a bag of fragments.
 * 2. **Repeated options are weighting.** `{halo|broken halo|no halo|no halo}`
 *    asks for no halo twice as often. Deduplicating silently reweighted every
 *    list that used the trick.
 *
 * So the structure is preserved and only the repeats are rewritten, into the
 * explicit `:N` weight that means the same thing.
 */
function inspect(raw) {
  const raw_ = String(raw ?? '').trim();
  if (!raw_) return null;
  const groups = [...raw_.matchAll(GROUP)];
  if (!groups.length) return null;

  let squashed = 0;
  let options = 0;
  const template = raw_.replace(GROUP, (_, body) => {
    const c = collapse(body);
    squashed += c.squashed;
    options += c.distinct;
    return `{${c.body}}`;
  });

  // A single group with a single option randomises nothing.
  if (groups.length === 1 && options < 2) return null;
  return { template, slots: groups.length, options, squashed };
}

// Child labels to rename. The canvas calls these camera; the prompt must not.
//
// "camera" in an image prompt draws a camera — the owner's correction, 5 Sep
// 2026. His own terms were already clean (from above, from behind, dutch
// angle) and only the LABELS said it, which never reach a model. Renamed
// anyway so the panel teaches the right word, and enforced on terms below so
// nothing added later reintroduces it.
const RENAME_CHILD = [
  [/^camera angle$/i, 'Viewer Angle'],
  // Widened rather than renamed for its own sake: Face carried eye makeup and
  // nothing for lips or cheeks, so the narrow name was describing a gap.
  [/^(eye )?makeup( \/ around eyes)?$/i, 'Makeup'],
  // Two slips in the source group titles. Labels only — no term is affected —
  // but they are what the panel shows. Fixed here rather than in the workflow
  // so a re-import cannot bring them back; fix them at source too and this
  // simply stops matching.
  [/^raccon$/i, 'Raccoon'],
  // "AQ Octopus" has no colon, so the prefix stripper leaves it whole while
  // every one of its neighbours loses theirs.
  [/^aq octopus$/i, 'Octopus'],
];

/** Terms that would put a camera in the picture. Never merged. */
const BANNED_TERM = /\bcameras?\b/i;

// Sub-categories to fold into another one. `from` is emptied and disappears.
//
// Empty, and that is the answer rather than an oversight.
//
// NSFW's Background was folded into Environment's for a few hours on 5 Sep
// 2026 and then put back: what the owner wanted was a SFW selector and an
// NSFW selector, not one of each merged. The two lists answer the same
// question — where is this happening — for two different kinds of picture,
// and which one you tick is the choice.
//
// Background (Training) stays separate from both regardless. Its ten entries
// are plain backdrops for dataset work, and mixing scenery into them would
// break the one thing it is for.
const MERGE_CHILD = [];

// Sub-categories to move to a different box, optionally renamed.
//
// Both background lists belong under Environment — they answer the same
// question, "where is this happening", and having one of them filed under
// NSFW meant scrolling to a different box to find half the answer. Split by
// rating, together in one place, which is what the owner asked for after a
// straight merge turned out to be the wrong shape.
//
// Background (Training) is untouched by any of this: its ten plain backdrops
// are for dataset work and neither list belongs in it.
const MOVE_CHILD = [
  { id: 'environment_background_showcase', label: 'Background (SFW)' },
  { id: 'nsfw_background', toBox: 'Environment', label: 'Background (NSFW)' },
  // Environment effects was a two-tick box sitting next to Environment, which
  // is a box heading for a category that fits inside the one beside it. The
  // emptied box is dropped automatically.
  { id: 'environment_effects_aura_effects', toBox: 'Environment', label: 'Aura / Effects' },
  { id: 'environment_effects_weather', toBox: 'Environment', label: 'Weather' },

  // ── The creature reorganisation, 5 Sep 2026 ──
  //
  // The seven species boxes were split the way they are because the ComfyUI
  // Fast Groups Bypasser is a flat button list and the owner did not want it
  // a mile long — his words. That is a layout constraint of a different
  // program. These boxes collapse, so the constraint does not apply and the
  // grouping can be what the things actually are.
  //
  // Kemonomimi and New mammals were one category that grew in two sittings:
  // Cat is `cat ears, cat tail, {pupils}, {fangs}` and Cow is `cow ears,
  // {horns}, {tail}, {pattern}` — the same template for the same idea.
  { id: 'kemonomimi_dragon', toBox: 'Mythical' },
  { id: 'aquatic_mermaid', toBox: 'Mythical' },
  { id: 'other_species_ghost', toBox: 'Undead & horror' },
  // Fantasy creatures was three categories in one bin: plants, undead, myth.
  { id: 'fantasy_creatures_mushroom', toBox: 'Plants & fungi' },
  { id: 'fantasy_creatures_moss', toBox: 'Plants & fungi' },
  { id: 'fantasy_creatures_dryad', toBox: 'Plants & fungi' },
  { id: 'fantasy_creatures_flower', toBox: 'Plants & fungi' },
  { id: 'fantasy_creatures_cactus', toBox: 'Plants & fungi' },
  { id: 'fantasy_creatures_venus_flytrap', toBox: 'Plants & fungi' },
  { id: 'fantasy_creatures_zombie', toBox: 'Undead & horror' },
  { id: 'fantasy_creatures_mummy', toBox: 'Undead & horror' },
  { id: 'fantasy_creatures_eldritch_horror', toBox: 'Undead & horror' },
];

// Whole boxes to empty into another. Every child moves and the box disappears.
const MOVE_BOX = [
  { from: 'New mammals', into: 'Mammals' },
  { from: 'Kemonomimi', into: 'Mammals' },
  { from: 'Reptile / amphibian / bird', into: 'Birds, reptiles & amphibians' },
  { from: 'Insects / arachnids', into: 'Insects & arachnids' },
  // What is left of these two after the moves above is myth either way.
  { from: 'Other species', into: 'Mythical' },
  { from: 'Fantasy creatures', into: 'Mythical' },
];

/** Empty one box into another, creating the destination if needed. */
function applyBoxMoves(categories) {
  const done = [];
  for (const { from, into } of MOVE_BOX) {
    const src = categories.find((b) => b.label === from);
    if (!src) continue;
    let dest = categories.find((b) => b.label === into);
    if (!dest) {
      dest = { id: slug(into), label: into, children: [] };
      categories.push(dest);
    }
    let moved = 0;
    for (const kid of src.children) {
      kid.id = slug(`${into}_${kid.label}`);
      // A name colliding inside the destination keeps both templates rather
      // than letting the second silently win.
      const clash = dest.children.find((k) => k.id === kid.id);
      if (clash) clash.templates.push(...kid.templates);
      else dest.children.push(kid);
      moved += 1;
    }
    src.children = [];
    done.push({ from, into, moved });
  }
  return done;
}

// Sub-categories the extras file replaces wholesale.
//
// Weapons/Items was one 123-entry list inside Clothing, which is two problems:
// it is not clothing, and one draw from it gave you a katana or a spellbook or
// a rocket launcher with equal odds. config/randomizer-extra.json rebuilds it
// as its own box split five ways — melee, ranged, firearms, fantasy, future —
// so the original has to go or every weapon would exist twice.
const DROP_CHILD = [
  'clothing_female_weapons_items',
  // Replaced by merged versions in the extras file rather than deleted.
  //
  // Spider, Arachne and Tarantula were one subject in three entries, and so
  // were Snake, Naga and Lamia — the owner spotted the first pair and the
  // rest fell out of checking. Dropping the duplicates would have lost what
  // each had that the others did not: Arachne's half-and-half lower body,
  // Tarantula's hairy legs, Lamia's iridescent scales. So the survivor takes
  // the best of all of them.
  //
  // Wolf and Fox absorb Werewolf and Kitsune the same way, with the fuller
  // transformation weighted rare so the ordinary animal-eared version stays
  // the common draw — one entry with a range, rather than two entries with
  // an arbitrary line between them.
  'insects_arachnids_spider',
  'birds_reptiles_amphibians_snake',
  'mammals_wolf',
  'mammals_fox',
  // Colour widened and nothing else touched. Dragon had no colour at all —
  // its scales slot never said what colour they were.
  'mythical_slime_girl',
  'mythical_demon',
  'mythical_dragon',
];

function applyChildDrops(categories) {
  let dropped = 0;
  for (const box of categories) {
    const before = box.children.length;
    box.children = box.children.filter((k) => !DROP_CHILD.includes(k.id));
    dropped += before - box.children.length;
  }
  return dropped;
}

// Individual terms filed in the wrong list.
//
// Spotted by the owner asking why a cathedral was in the NSFW backgrounds —
// it is a place of worship. Checking the rest found nineteen of the same
// kind: public venues, open scenery, sky, and pure lighting effects, none of
// which are private in any particular way. They were written as atmosphere,
// which is why they landed in an atmosphere list.
//
// Deliberately KEPT on the NSFW side: "rain against window" and "snow falling
// outside window" describe being indoors looking out, which is the cosy half
// of the idea rather than the weather.
const MOVE_TERMS = [
  {
    from: 'environment_background_nsfw',
    to: 'environment_background_sfw',
    terms: [
      // Places of worship
      'incense-filled temple', 'sunbeam through cathedral window',
      // Public venues
      'dimly lit bar', 'dimly lit jazz club',
      // Open scenery
      'starlit field of flowers', 'lavender field at dusk', 'cherry blossom canopy',
      'paper lantern lit path', 'fog-filled greenhouse', 'rain-soaked gazebo',
      'midnight rooftop cityscape', 'glowing ember campfire',
      // Sky, not a place
      'crescent moon night sky',
      // Lighting and effects, not a setting
      'reflection in still water', 'stained glass light filtering in',
      'bokeh city lights behind glass', 'rain-streaked glass overlooking city',
      'soft spotlight in darkness', 'velvet curtain backdrop',
    ],
  },
];

/** Move named terms from one flat list to another. */
function applyTermMoves(categories) {
  const byId = new Map();
  for (const box of categories) for (const kid of box.children) byId.set(kid.id, kid);
  const done = [];

  for (const { from, to, terms } of MOVE_TERMS) {
    const src = byId.get(from);
    const dst = byId.get(to);
    if (!src || !dst) {
      console.error(`  !! term move needs both ${from} and ${to}`);
      continue;
    }
    const sg = [...src.templates[0].matchAll(GROUP)];
    const dg = [...dst.templates[0].matchAll(GROUP)];
    if (sg.length !== 1 || dg.length !== 1) {
      console.error('  !! term moves only work between flat lists');
      continue;
    }
    const wanted = new Set(terms.map((t) => t.toLowerCase()));
    const keep = [];
    const taken = [];
    for (const opt of sg[0][1].split('|')) {
      const term = opt.trim();
      (wanted.has(term.replace(/:\d{1,3}$/, '').toLowerCase()) ? taken : keep).push(term);
    }
    // Named rather than silently ignored: a term that has been reworded since
    // this list was written would otherwise stay put with no explanation.
    const missing = terms.filter(
      (t) => !taken.some((x) => x.replace(/:\d{1,3}$/, '').toLowerCase() === t.toLowerCase())
    );
    for (const m of missing) console.error(`  !! term to move not found: ${m}`);

    const have = new Set(
      dg[0][1].split('|').map((o) => o.trim().replace(/:\d{1,3}$/, '').toLowerCase())
    );
    const fresh = taken.filter((t) => !have.has(t.replace(/:\d{1,3}$/, '').toLowerCase()));

    src.templates[0] = `{${keep.join('|')}}`;
    if (fresh.length) dst.templates[0] = `{${dg[0][1]}|${fresh.join('|')}}`;
    done.push({ from, to, moved: taken.length, added: fresh.length });
  }
  return done;
}

/** Move and rename sub-categories. Ids are rebuilt from the new labels. */
function applyChildMoves(categories) {
  const moved = [];
  for (const { id, toBox, label } of MOVE_CHILD) {
    let kid = null;
    for (const box of categories) {
      const found = box.children.find((k) => k.id === id);
      if (found) {
        kid = found;
        if (toBox && box.label !== toBox) box.children = box.children.filter((k) => k !== found);
        break;
      }
    }
    if (!kid) {
      console.error(`  !! move target not found: ${id}`);
      continue;
    }
    let dest = toBox ? categories.find((b) => b.label === toBox) : null;
    if (toBox && !dest) {
      // Created rather than refused: moves run before the extras file builds
      // its boxes, and a destination that does not exist yet is the normal
      // case for a reorganisation.
      dest = { id: slug(toBox), label: toBox, children: [] };
      categories.push(dest);
    }
    const from = kid.label;
    if (label) kid.label = label;
    const home = dest ?? categories.find((b) => b.children.includes(kid));
    kid.id = slug(`${home.label}_${kid.label}`);
    if (dest && !dest.children.includes(kid)) dest.children.push(kid);
    moved.push({ from, to: `${home.label} / ${kid.label}`, id: kid.id });
  }
  // Boxes emptied by a move should not linger as empty headers.
  return { moved, categories: categories.filter((b) => b.children.length) };
}

/** Fold one sub-category's templates into another, then drop it. */
function applyChildMerges(categories) {
  const byId = new Map();
  for (const box of categories) for (const kid of box.children) byId.set(kid.id, kid);
  const done = [];

  for (const { from, into } of MERGE_CHILD) {
    const src = byId.get(from);
    const dst = byId.get(into);
    if (!src || !dst) continue;

    // Both flat single-group lists, or this cannot be a merge — a composed
    // template has slots, and there is no answer to which slot absorbs a
    // loose list.
    const sg = [...src.templates[0].matchAll(GROUP)];
    const dg = [...dst.templates[0].matchAll(GROUP)];
    if (src.templates.length !== 1 || dst.templates.length !== 1 || sg.length !== 1 || dg.length !== 1) {
      continue;
    }
    const have = new Set(
      dg[0][1].split('|').map((o) => o.trim().replace(/:\d{1,3}$/, '').toLowerCase())
    );
    const fresh = sg[0][1]
      .split('|')
      .map((o) => o.trim())
      .filter((o) => o && !have.has(o.replace(/:\d{1,3}$/, '').toLowerCase()) && !BANNED_TERM.test(o));

    if (fresh.length) dst.templates[0] = `{${dg[0][1]}|${fresh.join('|')}}`;
    for (const box of categories) box.children = box.children.filter((k) => k.id !== from);
    done.push({ from, into, moved: fresh.length });
  }
  return done;
}

/**
 * Merge config/randomizer-extra.json into the generated categories.
 *
 * Kept in a separate file because this one is overwritten on every re-import
 * and hand-written additions would go with it. Every term there was already
 * checked against the Danbooru database; what happens here is deduplication —
 * a term the owner already has must not be added again, or it silently
 * doubles its own odds, which is the same weighting bug in reverse.
 */
function applyExtras(categories, extrasFile) {
  let file;
  try {
    file = JSON.parse(readFileSync(extrasFile, 'utf8'));
  } catch {
    return { added: 0, skipped: 0, missing: [], created: 0 };
  }
  const extras = file.additions ?? {};

  // Whole categories that exist nowhere in the source workflow.
  //
  // The workflow is women's clothing throughout, so a men's section cannot be
  // imported from it — it has to be written. Same shape as an imported
  // category so nothing downstream can tell the difference: a box with
  // children, each child a list of terms.
  //
  // A `box` that already exists gains the children rather than being
  // duplicated, which is what lets new sub-categories join Clothing.
  let created = 0;
  for (const spec of file.new_categories ?? []) {
    const label = String(spec.box ?? '').trim();
    if (!label) continue;
    let box = categories.find((b) => b.label === label);
    if (!box) {
      box = { id: slug(label), label, children: [] };
      categories.push(box);
    }
    for (const kid of spec.children ?? []) {
      const kidLabel = String(kid.label ?? '').trim();
      // A creature is four slots, not one flat list, so a child may carry a
      // raw composed template instead of `terms`.
      const raw = typeof kid.template === 'string' ? kid.template.trim() : '';
      const terms = (kid.terms ?? []).map((t) => String(t).trim()).filter((t) => t && !BANNED_TERM.test(t));
      if (!kidLabel || (!raw && terms.length < 2)) continue;
      if (raw) {
        if (BANNED_TERM.test(raw)) continue;
        const id = slug(`${label}_${kidLabel}`);
        if (box.children.some((k) => k.id === id)) {
          // Silently skipping here cost a whole set of merged entries once:
          // the drop that should have cleared the way ran too early, and the
          // replacements disappeared without a word.
          console.error(`  !! ${id} already exists — template not applied`);
        } else {
          box.children.push({ id, label: kidLabel, templates: [raw] });
          created += 1;
        }
        continue;
      }
      const id = slug(`${label}_${kidLabel}`);
      // A sub-category that already exists takes the terms as additions
      // rather than becoming a second entry with the same name.
      const existing = box.children.find((k) => k.id === id);
      if (existing) {
        extras[id] = [...(extras[id] ?? []), ...terms];
        continue;
      }
      const seen = new Set();
      const unique = terms.filter((t) => {
        const k = t.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      box.children.push({ id, label: kidLabel, templates: [`{${unique.join('|')}}`] });
      created += 1;
    }
  }

  const byId = new Map();
  for (const box of categories) for (const kid of box.children) byId.set(kid.id, kid);

  let added = 0;
  let skipped = 0;
  const missing = [];

  for (const [id, terms] of Object.entries(extras)) {
    const kid = byId.get(id);
    if (!kid) {
      // A category that was renamed or merged away. Named rather than ignored:
      // a silently dropped list is indistinguishable from one that merged.
      missing.push(id);
      continue;
    }
    // Only a flat single-group template can take additions. A composed one is
    // slot-by-slot and there is no answer to which slot a loose term joins.
    const groups = [...kid.templates[0].matchAll(GROUP)];
    if (kid.templates.length !== 1 || groups.length !== 1) {
      missing.push(`${id} (composed template)`);
      continue;
    }
    const body = groups[0][1];
    const have = new Set(
      body.split('|').map((o) => o.trim().replace(/:\d{1,3}$/, '').toLowerCase())
    );
    const fresh = [];
    for (const term of terms) {
      const clean = String(term).trim();
      if (!clean || BANNED_TERM.test(clean)) {
        skipped += 1;
        continue;
      }
      if (have.has(clean.toLowerCase())) {
        skipped += 1;
        continue;
      }
      have.add(clean.toLowerCase());
      fresh.push(clean);
    }
    if (fresh.length) {
      kid.templates[0] = `{${body}|${fresh.join('|')}}`;
      added += fresh.length;
    }
  }
  return { added, skipped, missing, created };
}

const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);

function main() {
  const args = process.argv.slice(2);
  const source = args.find((a) => !a.startsWith('--'));
  if (!source) {
    console.error('Usage: node scripts/import-chaos-randomizer.mjs <workflow.json> [--out FILE]');
    process.exit(1);
  }
  const outIdx = args.indexOf('--out');
  const outFile = outIdx >= 0 ? args[outIdx + 1] : 'config/randomizer.json';

  const wf = JSON.parse(readFileSync(source, 'utf8'));
  const sub = (wf.definitions?.subgraphs ?? []).find((s) => s.name === 'Wildcards');
  if (!sub) {
    console.error('No "Wildcards" subgraph in that file.');
    process.exit(1);
  }

  const groups = (sub.groups ?? []).map((g) => ({
    title: String(g.title ?? '').trim(),
    bounding: g.bounding,
  }));

  // Every node that actually carries a term list.
  const termNodes = (sub.nodes ?? []).filter(
    (n) => n.type === 'PrimitiveStringMultiline' && Array.isArray(n.widgets_values)
  );

  const tree = new Map();
  let kept = 0;
  let skipped = 0;
  let squashed = 0;

  for (const node of termNodes) {
    const spec = inspect(node.widgets_values[0]);
    if (!spec) continue;

    const containing = groups
      .filter((g) => Array.isArray(g.bounding) && inside(node.pos, g.bounding))
      .sort((a, b) => area(a.bounding) - area(b.bounding));
    if (!containing.length) continue;

    const child = containing[0];
    // The next rectangle out is the parent. A node whose only container is its
    // own group has no parent box, and is filed under its own name.
    const parent = containing[1] ?? child;

    if (SKIP_GROUPS.some((re) => re.test(child.title) || re.test(parent.title))) {
      skipped += 1;
      continue;
    }

    // Keyed on the CLEANED label, not the raw title, which is what makes the
    // merges above actually merge: `BODY VISIBILITY (Training Datasets)` and
    // `BODY` are two rectangles on the canvas and one box here, and keying on
    // the raw title gave two boxes that both rendered as "Body".
    const parentKey = prettyParent(parent.title);
    if (!tree.has(parentKey)) {
      tree.set(parentKey, { label: parentKey, children: new Map() });
    }
    // **The GROUP's title, not the node's.** They disagree on 36 of the 165
    // term nodes, and the group is the one that is right: it is the label on
    // the toggle in the Fast Groups Bypasser, so it is the name the owner
    // reads and the name he asks for things by.
    //
    // Caught 5 Sep 2026 by exactly that — "there's a body coverage which on
    // the newest one is labeled lewd/nude". The node inside `BV: Lewd/Nude`
    // is titled `Coverage Level`, and preferring the node title had renamed
    // his category to something he does not call it. Same story for
    // `E: Color` (node: "Eye Color") and `H: Hair Styles` (node: "Hair
    // Style").
    //
    // The node title is the fallback for a group whose title is only a
    // prefix.
    const fromGroup = prettyChild(child.title);
    const label = fromGroup || prettyChild(String(node.title ?? ''));
    const bucket = tree.get(parentKey).children;
    // Two nodes with the same name inside one box: keep both templates, and
    // let the roll pick between them. Merging their text would splice two
    // independent templates into one sentence.
    if (bucket.has(label)) {
      bucket.get(label).push(spec);
    } else {
      bucket.set(label, [spec]);
    }
    squashed += spec.squashed;
    kept += 1;
  }

  let categories = [...tree.entries()]
    // Ids come from the cleaned label, not the canvas title: they end up in
    // URLs and request bodies, and "other_species_toggle_each" carries a
    // layout instruction from a program nobody here is running.
    .map(([, node]) => ({
      id: slug(node.label),
      label: node.label,
      children: [...node.children.entries()].map(([label, specs]) => ({
        id: slug(`${node.label}_${label}`),
        label,
        templates: specs.map((s) => s.template),
      })),
    }))
    .filter((c) => c.children.length);

  // Danbooru terms on top of the owner's own lists — breadth he asked for, on
  // categories he named. Merged after the tree is built so it can address
  // final ids, and deduplicated so a term he already has does not double its
  // own odds by appearing twice.
  // Merges and moves first, so an addition list targets final ids and is
  // deduplicated against everything already sitting in the category.
  const merges = applyChildMerges(categories);
  const moves = applyChildMoves(categories);
  categories = moves.categories;
  // Whole-box moves last of the structural steps: the per-child moves above
  // pull the exceptions out first (Dragon is not a mammal, Mermaid is not a
  // fish), and this sweeps up what is left.
  const boxMoves = applyBoxMoves(categories);
  categories = categories.filter((b) => b.children.length);
  // AFTER the moves, not before: a drop names the id a category ends up with,
  // and running this first silently matched nothing for everything that had
  // been moved or renamed.
  const dropped = applyChildDrops(categories);

  const extrasFile = path.join(path.dirname(outFile), 'randomizer-extra.json');
  const extras = applyExtras(categories, extrasFile);
  // Last, so a term can move between two lists that the extras file has only
  // just finished filling.
  const termMoves = applyTermMoves(categories);

  // Deliberate order, not alphabetical.
  //
  // Alphabetical put Aquatic first and scattered the seven species boxes
  // between Body, Environment and NSFW, so related things were never near
  // each other. This reads as the order you actually build a shot in: what
  // the picture is, then who is in it, then what they look like, then what
  // they are wearing, then what species they are. NSFW last because it is the
  // one block a person may want to scroll past.
  //
  // A box not named here sorts alphabetically after the ones that are, so a
  // category added later appears rather than vanishing.
  const ORDER = [
    // The shot
    'Scene', 'Pose / viewer', 'Environment',
    // The person
    'Body', 'Face', 'Eyes', 'Hair',
    // What they are wearing and carrying
    'Clothing female', 'Clothing male', 'Accessories', 'Weapons',
    // What they are
    // Real creatures first, then the imagined ones, then the dead. Each is
    // what the thing IS rather than where its rectangle sat on a canvas.
    'Mammals', 'Birds, reptiles & amphibians', 'Aquatic', 'Insects & arachnids',
    'Plants & fungi', 'Mythical', 'Undead & horror',
    // Last on purpose
    'NSFW',
  ];
  const rank = (label) => {
    const i = ORDER.indexOf(label);
    return i === -1 ? ORDER.length : i;
  };
  categories.sort((a, b) => rank(a.label) - rank(b.label) || a.label.localeCompare(b.label));

  const out = {
    _comment: [
      'GENERATED — do not hand-edit. Regenerate with:',
      '  node scripts/import-chaos-randomizer.mjs <workflow.json>',
      '',
      'Source: the Total Chaos Randomizer ComfyUI workflow. The vocabulary is',
      "the owner's; the nesting is recovered from the group rectangles on that",
      'canvas, so the boxes here are the boxes on screen there.',
      '',
      'Positive prompts, negative prompts and art style are deliberately absent:',
      'PromptForge sets those per model in config/models.yaml, and a second',
      'place to set them would be two sources of truth for one output.',
      '',
      'Nothing here reaches an LLM. scripts/randomizer.py picks from these',
      "lists and writes the result into the person's brief.",
    ],
    source: path.basename(source),
    generated_at: new Date().toISOString().slice(0, 10),
    categories,
  };

  writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n', 'utf8');

  const childCount = categories.reduce((n, c) => n + c.children.length, 0);
  // Options rather than templates: "138 sub-categories" says nothing about how
  // much variety is behind them, and the option count is the number that does.
  const optionCount = categories.reduce(
    (n, c) =>
      n +
      c.children.reduce(
        (m, k) =>
          m +
          k.templates.reduce(
            (o, t) => o + [...t.matchAll(GROUP)].reduce((p, g) => p + g[1].split('|').length, 0),
            0
          ),
        0
      ),
    0
  );
  console.error(`Wrote ${outFile}`);
  console.error(`  ${categories.length} boxes, ${childCount} sub-categories, ${optionCount} options`);
  console.error(`  kept ${kept} nodes, skipped ${skipped} as already-covered`);
  console.error(`  collapsed ${squashed} repeated options into explicit weights`);
  if (dropped) console.error(`  dropped ${dropped} sub-categor${dropped===1?"y":"ies"} replaced by randomizer-extra.json`);
  for (const m of moves.moved) console.error(`  moved ${m.from} -> ${m.to}`);
  for (const m of boxMoves) console.error(`  emptied ${m.from} into ${m.into} (${m.moved} sub-categories)`);
  for (const m of termMoves) console.error(`  moved ${m.moved} terms ${m.from} -> ${m.to} (${m.added} new)`);
  for (const m of merges) {
    console.error(`  folded ${m.from} into ${m.into} (${m.moved} terms moved)`);
  }
  console.error(
    `  merged ${extras.added} extra terms from randomizer-extra.json ` +
      `(${extras.skipped} already present or banned), ${extras.created} new sub-categories`
  );
  // Loud, because a category id that no longer resolves means an addition list
  // is silently doing nothing.
  for (const id of extras.missing) console.error(`  !! extras target not found: ${id}`);
  for (const c of categories) {
    console.error(`  ${c.label}: ${c.children.map((k) => k.label).join(', ')}`);
  }
}

// The canvas titles carry two kinds of noise: prefixes that existed to sort
// rectangles on a 2D surface, and ALL CAPS used as a heading style. Neither
// means anything in a checkbox list, and both make the panel harder to read
// than the canvas it came from.
// Phase 1: canvas bookkeeping that means nothing in a checkbox list.
const STRIP_PARENT = [
  [/\(toggle each\)/i, ''],
  [/\(training datasets\)/i, ''],
  [/:?\s*species\s*$/i, ''],
];

// Phase 3: names that survive the sentence-casing in phase 2, because an
// acronym is not a shouted word. This runs LAST for that reason — putting it
// first turned NSFW into "Nsfw" one line later, and putting the strip list
// last left "AQUATIC" shouting because the casing had already run on a title
// that still had "Species" attached to it.
// Boxes that arrive separate on the canvas and belong together in a panel.
//
// A ComfyUI group is a rectangle you have to be able to reach with a mouse, so
// splitting Environment in two is a layout decision. A checkbox list has no
// such constraint, and two boxes with four ticks between them is worse than
// one box with four ticks — the owner's call, 5 Sep 2026.
//
// Safe because the children keep their own names: "Lighting (Showcase)" and
// "Lighting (Training)" stay distinct inside the merged box. Two children that
// DID collide would merge into one entry with both templates, which is the
// same behaviour as two identically-named nodes in one group.
const RENAME_PARENT = [
  [/^nsfw$/i, 'NSFW'],
  [/^environment[\s—:-]*(detailed|training)\b.*$/i, 'Environment'],
  [/^environment:\s*/i, 'Environment — '],
  [/^body visibility$/i, 'Body'],
  // Two boxes both reading "Other" would be a coin toss every time. This one
  // is the fantasy roster — elf, succubus, fairy — and the other is the
  // catch-all.
  [/^other$/i, 'Other species'],
  // "Everything else" described where the box sat on a canvas, not what is in
  // it: mushroom, moss, dryad, venus flytrap, cactus and flower alongside
  // centaur, sphinx, phoenix, unicorn, minotaur, zombie, mummy and an
  // eldritch horror. Every one is a character type, so the honest name is the
  // kind of character rather than the leftover bin.
  [/^everything else$/i, 'Fantasy creatures'],
  // Every one of the imported clothing categories is women's wear — the
  // workflow was built that way. Saying so lets a men's section exist beside
  // it instead of contradicting it. Owner's call, 5 Sep 2026.
  [/^clothing$/i, 'Clothing female'],
  // Same reason as the child rename below: the panel should not teach the
  // word "camera" for something that is viewer-relative framing.
  [/^pose \/ camera$/i, 'Pose / viewer'],
];

/** "KEMONOMIMI: Species (Toggle Each)" -> "Kemonomimi". */
function prettyParent(title) {
  let out = String(title).trim();
  // 1. Drop the canvas bookkeeping, so the casing test below sees the real
  //    title rather than one with " Species (Toggle Each)" hanging off it.
  for (const [re, to] of STRIP_PARENT) out = out.replace(re, to).trim();
  // 2. Sentence-case anything shouting. A title written in real mixed case was
  //    written that way deliberately and is left alone.
  if (out === out.toUpperCase()) {
    out = out.charAt(0) + out.slice(1).toLowerCase();
  }
  // 3. Put back the names that are not shouting, they are just short.
  for (const [re, to] of RENAME_PARENT) out = out.replace(re, to).trim();
  return out.replace(/\s*\/\s*/g, ' / ').trim();
}

/**
 * "H: Hair Color" -> "Hair Color", "Aquatic: Mermaid" -> "Mermaid".
 *
 * Everything before a colon goes, because in this workflow the part before the
 * colon is always the box the node already sits in — the prefix was how you
 * tell two "Color" nodes apart on a canvas, and inside its own box it is pure
 * repetition. Only strips when something is left afterwards.
 */
function prettyChild(title) {
  const text = String(title).trim();
  const cut = text.replace(/^[^:]{1,24}:\s*/, '').trim();
  let out = cut || text;
  for (const [re, to] of RENAME_CHILD) out = out.replace(re, to);
  return out;
}

main();
