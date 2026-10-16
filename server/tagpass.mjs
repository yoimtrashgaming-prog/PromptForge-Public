// The third pass: every tag the model wrote, checked after generation.
//
// A user's report on v4, 13 Sep 2026: "The lexicon has 'lowered pants' in it,
// and should replace it with 'pants pull', but I'm still getting it. So it's
// not doing the verification / replacement." It was not. v4 used the lexicon
// only BEFORE generation, as a list for the model to read, and nothing
// checked what the model then wrote. `trousers down` does nothing in Anima and
// `pants pull` works, so a fake tag that survives is a concept lost.
//
// Two shapes of positive prompt, and the pass is as strict as the shape
// allows:
//
// - LABELLED, from Anima v5: `Core tags:`, `Text modifiers:` and
//   `Description:` lines — a user's own split, from his skill. Every core tag is
//   verified: kept if it is real, replaced if the lexicon maps it to a real
//   tag, removed if neither. Modifiers and the description are never touched —
//   A user: "tags should be compared to the lexicon (but not the text
//   modifiers)". The three lines are then joined into the one line Anima
//   takes, tags first and prose last.
//
// - ONE LIST, from every other prompt: tags, modifiers and prose run together
//   and nothing marks which is which, so an unknown item may be a legitimate
//   modifier. Here the pass only REPLACES — `lowered pants` becomes `pants
//   pull` — and never removes, and a user's listed modifiers are left alone.
//
// No model call. The lexicon is a map and this is a loop over one prompt.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { normalizePhrase } from './lexicon.mjs';
import { looksLikeProse } from './positive.mjs';

/** modifierVocabulary() over a file, or an empty set when it cannot be read. */
export function loadModifierVocabulary(rootDir, rel) {
  if (!rel) return new Set();
  try {
    return modifierVocabulary(readFileSync(path.resolve(rootDir, rel), 'utf8'));
  } catch {
    return new Set();
  }
}

const SECTION = { 'core tags': 'tags', 'text modifiers': 'modifiers', description: 'description' };

// Tolerates the markdown a model sometimes wraps a label in: **Core tags:**
const LABEL = /^\s*[*_]*\s*(core tags|text modifiers|description)\s*[*_]*\s*:\s*[*_]*\s*/i;

// What the Anima card itself defines and no danbooru table holds: the score
// ladder and the year tags. The quality words and ratings are in config, as
// `lexicon.always_valid`.
const CARD_PATTERNS = [/^score_\d(?:_up)?$/, /^year \d{4}$/];

const items = (s) =>
  String(s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/** Comparable form: escapes off, then the lexicon's own normalisation. */
const keyOf = (s) => normalizePhrase(String(s ?? '').replace(/\\([()])/g, '$1'));

/** `(chibi:2)` is the tag `chibi` at weight 2. */
function unweigh(item) {
  const m = /^\((.+):\s*(\d+(?:\.\d+)?)\)$/.exec(item);
  return m ? { text: m[1].trim(), weight: m[2] } : { text: item, weight: null };
}

/** A canonical underscore tag, spelled the way this model writes tags. */
function spell(tag, variant, weight) {
  const s = variant === 'space' ? tag.replace(/_/g, ' ').replace(/([()])/g, '\\$1') : tag;
  return weight ? `(${s}:${weight})` : s;
}

/**
 * The labelled shape, or null when the text carries no label at all.
 *
 * Anything before the first label counts as tags — a model that starts
 * straight in with its tags and only labels the later lines has still said
 * which is which.
 */
export function splitLabelled(text) {
  const parts = { tags: [], modifiers: [], description: [] };
  let current = 'tags';
  let labels = 0;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = LABEL.exec(line);
    if (m) {
      current = SECTION[m[1].toLowerCase()];
      labels += 1;
    }
    const rest = (m ? line.slice(m[0].length) : line).trim();
    if (rest) parts[current].push(rest);
  }
  if (!labels) return null;
  return {
    tags: parts.tags.join(', '),
    modifiers: parts.modifiers.join(', '),
    description: parts.description.join(' '),
  };
}

/**
 * A user's text-modifier vocabulary: every backticked term under the
 * `## Text modifiers` heading of his compact visual-direction document. Read
 * from the document rather than copied here, so his edits to it land.
 */
export function modifierVocabulary(markdown) {
  const text = String(markdown ?? '');
  const start = text.search(/^## Text modifiers\s*$/m);
  if (start < 0) return new Set();
  const rest = text.slice(start + 1);
  // The section ends at the next heading, or at its closing `Example:`
  // paragraph, which quotes native tags beside modifiers to show the split.
  const end = rest.search(/^(?:## |Example:)/m);
  const section = end < 0 ? rest : rest.slice(0, end);
  return new Set([...section.matchAll(/`([^`]+)`/g)].map((m) => normalizePhrase(m[1])).filter(Boolean));
}

/**
 * Run the pass over one positive prompt.
 *
 * @param {string} text
 * @param {object} opts
 * @param {(tag:string)=>boolean} [opts.known]   is this a real tag? null means
 *   no database, and then nothing is ever removed.
 * @param {(phrase:string, o:{context:string})=>({tag:string}|null)} [opts.resolve]
 *   the lexicon's resolver; null means the lexicon is off.
 * @param {string[]} [opts.allowed]   always valid: quality words, ratings, the
 *   model's own presets and styles.
 * @param {string[]} [opts.spared]    never touched: what the person typed.
 * @param {Set<string>} [opts.modifiers]  a user's modifier vocabulary, normalised.
 * @param {'space'|'underscore'} [opts.variant]
 * @param {string} [opts.context]     the brief, for the lexicon's context rules.
 * @returns {{text:string, labelled:boolean, replaced:string[], dropped:string[]}}
 */
export function tagPass(text, opts = {}) {
  const {
    known = null,
    resolve = null,
    allowed = [],
    spared = [],
    modifiers = new Set(),
    variant = 'underscore',
    context = '',
  } = opts;

  const allowedKeys = new Set(allowed.map(keyOf));
  const sparedKeys = new Set(spared.flatMap(items).map(keyOf));
  const replaced = [];
  const dropped = [];
  const seen = new Set();

  const isAllowed = (bare) => {
    const k = keyOf(bare);
    const low = bare.trim().toLowerCase();
    return (
      allowedKeys.has(k) ||
      sparedKeys.has(k) ||
      low.startsWith('@') ||
      CARD_PATTERNS.some((re) => re.test(low))
    );
  };

  function check(item, strict) {
    const { text: t, weight } = unweigh(item);
    const bare = t.replace(/\\([()])/g, '$1');
    const k = keyOf(bare);
    if (!k) return null;
    if (isAllowed(bare) || (known && known(bare))) return { out: item, key: k };
    if (!strict && modifiers.has(k)) return { out: item, key: k };
    const hit = resolve ? resolve(bare, { context }) : null;
    if (hit) {
      const out = spell(hit.tag, variant, weight);
      replaced.push(`${item} → ${out}`);
      return { out, key: keyOf(hit.tag), replaced: true };
    }
    if (strict && known) {
      // One of a user's own modifiers on the tag line is on the wrong line, not
      // fake: measured 13 Sep on a Fire Emblem prompt, `three-quarter view`
      // was deleted from Core tags although his document lists it. Moved.
      if (modifiers.has(k)) return { out: item, key: k, modifier: true };
      dropped.push(item);
      return null;
    }
    return { out: item, key: k };
  }

  const labelled = splitLabelled(text);
  if (labelled) {
    const tags = [];
    const moved = [];
    for (const item of items(labelled.tags)) {
      const r = check(item, true);
      if (!r) continue;
      if (r.modifier) {
        moved.push(r.out);
        continue;
      }
      if (seen.has(r.key)) continue;
      seen.add(r.key);
      tags.push(r.out);
    }
    // Modifiers as written, after any moved off the tag line. Only one that
    // repeats a tag already on the line goes — a user's rule that a modifier
    // never duplicates a native tag.
    const mods = [...moved, ...items(labelled.modifiers)].filter((m) => {
      const k = keyOf(m);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const list = [...tags, ...mods].join(', ');
    const prose = labelled.description.trim();
    return {
      text: list && prose ? `${list}, ${prose}` : list || prose,
      labelled: true,
      replaced,
      dropped,
      moved,
    };
  }

  // One list: replace only, and hand back the text untouched when nothing was.
  const out = [];
  let inProse = false;
  for (const raw of items(text)) {
    if (inProse || looksLikeProse(raw)) {
      inProse = true;
      out.push(raw);
      continue;
    }
    const r = check(raw, false);
    if (!r) continue;
    // A replacement that lands on a tag already present is a duplicate of it.
    if (r.replaced && seen.has(r.key)) continue;
    seen.add(r.key);
    out.push(r.out);
  }
  return {
    text: replaced.length ? out.join(', ') : String(text ?? ''),
    labelled: false,
    replaced,
    dropped,
    moved: [],
  };
}
