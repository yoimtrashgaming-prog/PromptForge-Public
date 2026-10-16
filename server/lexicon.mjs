// The paraphrase lexicon: ordinary words for a picture, mapped to the danbooru
// tag that means the same thing. "beauty mark" is `mole`, "arms folded" is
// `crossed_arms`, "vue plongeante" is `from_above`.
//
// The owner's file, added 12 Sep 2026 for Anima v4. It lives in data/tags/
// beside the database it was built from, and its spec is
// archive/docs/danbooru-lexicon-integration.md.
//
// **Only the reviewed tiers by default.** The file has an entry for every one
// of the 36,553 general tags, but only 568 of them were reviewed as meanings
// (`hand_curated` and `semantic_family`). The rest are spellings and official
// aliases, which match single ordinary words — "dark" to `dark`, "old" to
// `old` — and on the spec's own cases they add `thighs` to "pants around
// thighs" and `folded` to "arms folded". That is the same noise that got
// server/candidates.mjs switched off, so those tiers are opt-in through
// `lexicon.coverage` in config/server.yaml.
//
// Two ways in, both a map read with no model in the loop:
//
//   block(brief)   the tags a brief describes, for the user message
//   lookup(query)  what a search_tags query means, for the tool result
//
// **Not the spec's final step**, "reject every unresolved token". Most of a
// good Anima prompt is not danbooru vocabulary — quality words, a user's text
// modifiers, the prose — and deleting unknowns would delete them. See
// server/positive.mjs for the measurement.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * The spec's normalisation, verbatim in behaviour: accents off, hyphens and
 * underscores to spaces, anything else that is not a letter or digit dropped.
 * So `from_above`, "from above" and "From-Above" are one key.
 */
export function normalizePhrase(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, ' ')
    .replace(/[-_]+/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const RANK = { hand_curated: 4, semantic_family: 3, rule_expanded: 2, catalogue_only: 1 };

/** Whole-phrase containment: "hi" is not inside "this". */
const has = (text, phrase) => ` ${text} `.includes(` ${phrase} `);

export function createLexicon(rootDir, settings = {}, tags, { warn = console.warn, log = console.log } = {}) {
  const file = path.resolve(rootDir, settings.path ?? 'data/tags/danbooru-visual-paraphrases.json');
  const tiers = new Set(settings.coverage ?? ['hand_curated', 'semantic_family']);
  const minConfidence = Number(settings.min_confidence ?? 0.85);
  const conceptMin = Number(settings.concept_min_score ?? 0.9);
  const windowTokens = Number(settings.window_tokens ?? 24);
  const maxTags = Number(settings.max_tags ?? 24);
  const blocked = new Set((settings.blocked_phrases ?? []).map(normalizePhrase).filter(Boolean));

  let index = null;
  let status = { loaded: false, reason: 'not loaded yet' };
  let attempted = false;

  // By normalised brief. A re-roll asks the same question, and the concept
  // pass is the only part of this that costs more than a map read.
  const cache = new Map();
  const CACHE_MAX = 200;

  /**
   * Read, validate and index the file.
   *
   * Every target is checked against the tag database before it is used: an
   * entry whose tag is missing, retired or not a general tag is skipped and
   * counted, never offered. The spec says throw; this app has to boot without
   * the file, so it degrades and says so in the log instead.
   */
  function load() {
    attempted = true;
    index = null;
    cache.clear();
    const rel = path.relative(rootDir, file);

    if (!existsSync(file)) {
      status = { loaded: false, reason: `no lexicon at ${rel}` };
      return status;
    }
    if (!tags?.loaded) {
      status = { loaded: false, reason: 'no tag database to check it against' };
      return status;
    }

    let raw;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      status = { loaded: false, reason: `${rel} unreadable: ${err.message}` };
      return status;
    }

    // The file's own list of phrases that must never resolve on their own.
    const ambiguous = new Set(
      (raw.ambiguous_phrases_en ?? []).map((a) => normalizePhrase(a?.phrase ?? a)).filter(Boolean)
    );

    const byFirst = new Map();
    const byPhrase = new Map();
    const rules = [];
    const rejected = [];
    let entries = 0;
    let phrases = 0;

    const push = (map, key, value) => {
      const list = map.get(key);
      if (list) list.push(value);
      else map.set(key, [value]);
    };

    function indexPhrase(original, entry, local = null) {
      const phrase = normalizePhrase(original);
      if (!phrase || ambiguous.has(phrase) || blocked.has(phrase)) return;
      const item = {
        phrase,
        tokens: phrase.split(' ').length,
        entry,
        confidence: Number(local?.confidence ?? entry.confidence),
        requires: [...(entry.requires_any ?? []), ...(local?.requires_any ?? [])]
          .map(normalizePhrase)
          .filter(Boolean),
        forbids: [...(entry.forbids_any ?? []), ...(local?.forbids_any ?? [])]
          .map(normalizePhrase)
          .filter(Boolean),
      };
      push(byPhrase, phrase, item);
      push(byFirst, phrase.split(' ')[0], item);
      phrases += 1;
    }

    for (const entry of raw.entries ?? []) {
      const reviewed = tiers.has(entry.coverage);
      // Concept rules are authored whatever tier their entry sits in, so an
      // entry carrying one is kept for its rules alone.
      const conceptual = Array.isArray(entry.concept_rules) && entry.concept_rules.length > 0;
      if (!reviewed && !conceptual) continue;

      const tag = String(entry.canonical_tag ?? '');
      const confidence = Number(entry.confidence);
      if (!(confidence >= 0 && confidence <= 1)) {
        rejected.push(`${tag}: confidence ${entry.confidence}`);
        continue;
      }
      if (!tags.exactRows(tag).some((r) => r.category === 0)) {
        rejected.push(`${tag}: not a general tag in the database`);
        continue;
      }
      if (tags.isDeprecated(tag)) {
        rejected.push(`${tag}: retired by danbooru`);
        continue;
      }

      entries += 1;
      if (reviewed) {
        for (const p of [...(entry.phrases_en ?? []), ...(entry.phrases_fr ?? [])]) indexPhrase(p, entry);
        for (const c of entry.conditional_phrases_en ?? []) indexPhrase(c.phrase, entry, c);
      }
      for (const rule of entry.concept_rules ?? []) rules.push({ tag, domain: entry.domain, rule });
    }

    // Longest phrase first, so "pants around ankles" is tried before "pants".
    for (const bucket of byFirst.values()) {
      bucket.sort(
        (a, b) =>
          b.tokens - a.tokens ||
          b.phrase.length - a.phrase.length ||
          (RANK[b.entry.coverage] ?? 0) - (RANK[a.entry.coverage] ?? 0) ||
          b.confidence - a.confidence
      );
    }

    const aliases = [];
    for (const [concept, terms] of Object.entries(raw.concept_vocabulary ?? {})) {
      for (const term of terms ?? []) {
        const phrase = normalizePhrase(term);
        if (phrase) aliases.push({ concept, phrase, tokens: phrase.split(' ') });
      }
    }
    aliases.sort((a, b) => b.tokens.length - a.tokens.length);

    if (rejected.length) {
      warn(
        `[lexicon] ${rejected.length} entr${rejected.length === 1 ? 'y' : 'ies'} skipped: ` +
          rejected.slice(0, 5).join('; ') +
          (rejected.length > 5 ? '; ...' : '')
      );
    }

    // Every tier, for the third pass. Stricter than the list the model reads,
    // so it can afford to be wider: a phrase resolves only when it is the
    // whole of what the model wrote and names exactly one tag. Official
    // aliases live in the catalogue tier, which is how `pants down` reaches
    // `pants_pull`. Targets are checked against the database when used.
    const byPhraseAll = new Map();
    let remapPhrases = 0;
    const indexAll = (original, entry, local = null) => {
      const phrase = normalizePhrase(original);
      if (!phrase || ambiguous.has(phrase) || blocked.has(phrase)) return;
      push(byPhraseAll, phrase, {
        tag: String(entry.canonical_tag ?? ''),
        confidence: Number(local?.confidence ?? entry.confidence),
        requires: [...(entry.requires_any ?? []), ...(local?.requires_any ?? [])]
          .map(normalizePhrase)
          .filter(Boolean),
        forbids: [...(entry.forbids_any ?? []), ...(local?.forbids_any ?? [])]
          .map(normalizePhrase)
          .filter(Boolean),
      });
      remapPhrases += 1;
    };
    for (const entry of raw.entries ?? []) {
      for (const p of [...(entry.phrases_en ?? []), ...(entry.phrases_fr ?? [])]) indexAll(p, entry);
      for (const c of entry.conditional_phrases_en ?? []) indexAll(c.phrase, entry, c);
    }

    index = { byFirst, byPhrase, byPhraseAll, rules, aliases };
    status = {
      loaded: true,
      entries,
      phrases,
      remap_phrases: remapPhrases,
      rules: rules.length,
      rejected: rejected.length,
      coverage: [...tiers],
    };
    return status;
  }

  const remapMin = Number(settings.remap_min_confidence ?? 0.9);
  const conceptRemap = Number(settings.concept_remap_score ?? 0.95);
  const conceptMargin = Number(settings.concept_remap_margin ?? 0.08);
  const validTargets = new Map();

  /** An active general tag in the database, asked once per tag. */
  function validTarget(tag) {
    if (!validTargets.has(tag)) {
      validTargets.set(
        tag,
        tags.exactRows(tag).some((r) => r.category === 0) && !tags.isDeprecated(tag)
      );
    }
    return validTargets.get(tag);
  }

  /**
   * The spec's post-generation resolver: what a tag the model wrote should
   * have been, or null.
   *
   * An exact phrase naming exactly one tag first — two targets is a conflict,
   * and the spec says never to pick between them by post count. Then a concept
   * rule, only at 0.95 or above and only when it leads the next by 0.08.
   * Context rules are judged against the brief, since a lone tag has none.
   */
  function resolve(token, { context = '' } = {}) {
    if (!ensure()) return null;
    const phrase = normalizePhrase(token);
    if (!phrase) return null;
    const text = [normalizePhrase(context), phrase].filter(Boolean).join(' ');

    const targets = new Set();
    for (const item of index.byPhraseAll.get(phrase) ?? []) {
      if (item.confidence < remapMin || !allows(text, item)) continue;
      targets.add(item.tag);
    }
    if (targets.size > 1) return null;
    if (targets.size === 1) {
      const [tag] = targets;
      return validTarget(tag) ? { tag, via: 'phrase' } : null;
    }

    const top = conceptual(phrase.split(' ')).filter((c) => c.confidence >= conceptRemap);
    if (!top.length) return null;
    if (top[1] && top[0].confidence - top[1].confidence < conceptMargin) return null;
    return validTarget(top[0].tag) ? { tag: top[0].tag, via: 'concept' } : null;
  }

  /** Loaded on first use: the tag database has to be open to check it against. */
  function ensure() {
    if (!attempted) {
      const s = load();
      log(
        s.loaded
          ? `[lexicon] ${s.entries} tags, ${s.phrases} phrases, ${s.rules} concept rules (${s.coverage.join(', ')})`
          : `[lexicon] not loaded: ${s.reason}`
      );
    }
    return index;
  }

  const allows = (text, item) =>
    (!item.requires.length || item.requires.some((t) => has(text, t))) &&
    !item.forbids.some((t) => has(text, t));

  /** Which concepts occur in tokens[start, end), each with the words that said it. */
  function conceptsIn(tokens, start, end) {
    const found = new Map();
    for (const alias of index.aliases) {
      if (found.has(alias.concept)) continue;
      const n = alias.tokens.length;
      for (let at = start; at + n <= end; at += 1) {
        let same = true;
        for (let k = 0; k < n; k += 1) {
          if (tokens[at + k] !== alias.tokens[k]) {
            same = false;
            break;
          }
        }
        if (same) {
          found.set(alias.concept, alias.phrase);
          break;
        }
      }
    }
    return found;
  }

  function ruleMatches(rule, present) {
    const all = rule.all ?? [];
    const any = rule.any ?? [];
    const none = rule.none ?? [];
    const minAny = rule.min_any ?? (any.length ? 1 : 0);
    if (!all.every((c) => present.has(c))) return false;
    if (any.filter((c) => present.has(c)).length < minAny) return false;
    return !none.some((c) => present.has(c));
  }

  /**
   * The spec's conceptual retrieval: meaning across a window of the brief
   * rather than an exact phrase. "she carries a parasol" is `holding_umbrella`
   * because it has a holding word and an umbrella word, not because any
   * phrase in the file says so.
   */
  function conceptual(tokens) {
    const best = new Map();
    for (let start = 0; start < tokens.length; start += 1) {
      const present = conceptsIn(tokens, start, Math.min(tokens.length, start + windowTokens));
      if (!present.size) continue;
      for (const { tag, domain, rule } of index.rules) {
        const score = Number(rule.score ?? 0);
        if (score < conceptMin || !ruleMatches(rule, present)) continue;
        const prev = best.get(tag);
        if (prev && prev.confidence >= score) continue;
        const evidence = [...(rule.all ?? []), ...(rule.any ?? [])]
          .filter((c) => present.has(c))
          .map((c) => present.get(c));
        best.set(tag, { tag, matched: evidence.join(' … '), via: 'concept', confidence: score, domain });
      }
    }
    return [...best.values()].sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Tags for what a brief describes: exact phrases first, reviewed before
   * unreviewed, then concept matches that found something the phrases did not.
   * Each tag once, with the words of the brief that produced it.
   */
  function find(brief) {
    if (!ensure()) return [];
    const text = normalizePhrase(brief);
    if (!text) return [];
    const cached = cache.get(text);
    if (cached) return cached;

    const words = text.split(' ');
    const direct = new Map();
    for (let start = 0; start < words.length; start += 1) {
      for (const item of index.byFirst.get(words[start]) ?? []) {
        if (item.confidence < minConfidence) continue;
        if (start + item.tokens > words.length) continue;
        if (words.slice(start, start + item.tokens).join(' ') !== item.phrase) continue;
        if (!allows(text, item)) continue;
        const tag = item.entry.canonical_tag;
        const prev = direct.get(tag);
        if (prev && prev.confidence >= item.confidence) continue;
        direct.set(tag, {
          tag,
          matched: item.phrase,
          via: 'phrase',
          confidence: item.confidence,
          domain: item.entry.domain,
          rank: RANK[item.entry.coverage] ?? 0,
        });
      }
    }

    const ordered = [...direct.values()]
      .sort(
        (a, b) =>
          b.rank - a.rank || b.confidence - a.confidence || b.matched.length - a.matched.length
      )
      .map(({ rank, ...hit }) => hit);
    const extra = conceptual(words).filter((c) => !direct.has(c.tag));
    const out = [...ordered, ...extra].slice(0, maxTags);

    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(text, out);
    return out;
  }

  /**
   * What a search query means, for the search_tags result. Stricter than
   * find(): the whole query has to be a phrase in the file, or satisfy a
   * concept rule on its own.
   */
  function lookup(query) {
    if (!ensure()) return [];
    const phrase = normalizePhrase(query);
    if (!phrase) return [];
    const out = new Map();
    for (const item of index.byPhrase.get(phrase) ?? []) {
      if (item.confidence < minConfidence || !allows(phrase, item)) continue;
      const tag = item.entry.canonical_tag;
      if (!out.has(tag)) out.set(tag, { tag, via: 'phrase', confidence: item.confidence });
    }
    for (const c of conceptual(phrase.split(' '))) if (!out.has(c.tag)) out.set(c.tag, c);
    return [...out.values()];
  }

  /**
   * The block for the user message, or '' when the brief matched nothing.
   *
   * Facts only — what each tag is and where in the brief it came from. How to
   * use the list is the prompt file's business, and a list that reads like an
   * instruction gets every line of it written into the prompt.
   */
  function block(brief, { variant = 'underscore' } = {}) {
    const hits = find(brief);
    if (!hits.length) return '';
    // Anima escapes parentheses in a tag; a space-style tag is Anima's.
    const spell =
      variant === 'space'
        ? (t) => t.replace(/_/g, ' ').replace(/([()])/g, '\\$1')
        : (t) => t;
    return [
      'Danbooru tags for things this brief describes, matched against a reviewed list of the ways ' +
        'people say them. Each is a real, active general tag; the words after it are what in the ' +
        'brief it matched.',
      ...hits.map((h) => `- ${spell(h.tag)} — "${h.matched}"`),
    ].join('\n');
  }

  return {
    load,
    find,
    lookup,
    resolve,
    block,
    info: () => ({ ...status }),
  };
}
