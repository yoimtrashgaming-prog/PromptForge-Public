// LoRA training captions, 17 Oct 2026: the Caption view on the LoRA tab.
//
// The vision model reads one picture and writes its caption in the style the
// dataset is for; this file is everything around that call that is a RULE
// rather than a judgement, so it is code and not prompt text:
//
//   - the trigger word goes in exactly once, where that model's own LoRAs
//     put it (triggerRule): first for tags, Anima and MOSS, last for Krea 2
//   - "Don't include" entries are taken out of tag captions after the model
//     writes them, whatever the model did with the instruction; in prose it
//     is the instruction alone, since a phrase cannot be cut from a sentence
//   - tag spelling (spaces or underscores) is made uniform per style, and an
//     unknown tag is swapped for the closest real one (closestTag)
//   - MOSS's JSON is parsed and one of its three lengths becomes the .txt
//
// The prompt files under prompts/captions/ say what a good caption looks like
// for each model. config/captions.yaml says which file and which rules apply.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const readCaptionConfig = (root) => YAML.parse(readFileSync(path.join(root, 'config', 'captions.yaml'), 'utf8'));

/** config/captions.yaml, read per call so edits show without a restart. */
export function loadCaptionStyles(root) {
  const doc = readCaptionConfig(root);
  return Array.isArray(doc?.styles) ? doc.styles : [];
}

/** The LoRA types (character, style, …) from the same file. */
export function loadLoraTypes(root) {
  const doc = readCaptionConfig(root);
  return Array.isArray(doc?.lora_types) ? doc.lora_types.filter((t) => /^[a-z0-9_-]+$/.test(String(t?.id ?? ''))) : [];
}

/**
 * The instructions for one style and LoRA type: the style's own prompt, then
 * the type's file - the model's own version when its LoRAs do that type
 * differently (prompts/captions/krea2/style.md), else the shared one
 * (prompts/captions/types/style.md). No type file means the style's prompt
 * goes alone; a missing style prompt is the caller's error to report.
 */
export function captionInstructions(root, style, type) {
  const read = (rel) => {
    try {
      return readFileSync(path.join(root, 'prompts', rel), 'utf8').trim();
    } catch {
      return '';
    }
  };
  const base = read(style.prompt);
  if (!base) return '';
  const typeText = type ? read(`captions/${style.id}/${type}.md`) || read(`captions/types/${type}.md`) : '';
  return typeText ? `${base}\n\n${typeText}` : base;
}

/** What the frontend needs: no prompt paths, no rule internals. */
export function publicStyles(styles) {
  return styles.map((s) => ({
    id: s.id,
    label: s.label,
    format: s.format,
    note: s.note,
    kind: s.kind,
    ...(s.lengths ? { lengths: s.lengths, default_length: s.default_length ?? s.lengths[0] } : {}),
  }));
}

/** The LoRA types for the frontend: id, label, and the hint under Don't include. */
export function publicLoraTypes(types) {
  return types.map((t) => ({ id: t.id, label: t.label, exclude: t.exclude ?? '' }));
}

/** Split a "Don't include" box: commas or new lines. */
export function parseExclude(text) {
  return String(text ?? '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 100);
}

// Spaces and underscores are the same tag; so are case differences.
const tagKey = (t) => t.toLowerCase().replace(/[\s_]+/g, ' ').trim();

/** One tag in the style's spelling. Score tags keep their underscore everywhere. */
function spellTag(tag, spelling) {
  const t = tag.trim().toLowerCase().replace(/\s+/g, ' ');
  if (/^score[ _]\d+(_up)?$/.test(t)) return t.replace(/ /g, '_');
  if (spelling === 'spaces') return t.replace(/_/g, ' ');
  if (spelling === 'underscores') return t.replace(/ /g, '_');
  return t;
}

/** The model's reply with any wrapper it added: code fences, a "Caption:" label, quotes. */
function unwrap(raw) {
  let s = String(raw ?? '').trim();
  s = s.replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
  s = s.replace(/^(?:caption|tags)\s*:\s*/i, '').trim();
  if (/^".*"$/s.test(s)) s = s.slice(1, -1).trim();
  return s;
}

/** Singular and plural spellings of the last word: `indoor` <-> `indoors`. */
function numberForms(tag) {
  const out = [];
  const m = /^(.*?)([a-z]+)$/.exec(tag);
  if (!m) return out;
  const [, head, w] = m;
  if (w.endsWith('ies') && w.length > 4) out.push(head + w.slice(0, -3) + 'y');
  if (/(ches|shes|sses|xes|zes)$/.test(w)) out.push(head + w.slice(0, -2));
  if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) out.push(head + w.slice(0, -1));
  if (!w.endsWith('s')) out.push(head + w + 's', head + w + 'es');
  return out;
}

/**
 * The nearest real danbooru tag to one the model wrote, owner's ask 18 Oct
 * 2026: a tag the image model never saw in training teaches it nothing, so
 * swap it for the closest one that does exist. In order, stopping at the
 * first that works:
 *
 *   1. danbooru's own rename        `smiling` -> `smile`
 *   2. the other number             `indoor` -> `indoors`
 *   3. drop words from the front    `left side ponytail` -> `side ponytail`,
 *      until a COMMON tag is left   `wooden log` -> `log`
 *
 * Step 3 keeps the head noun and loses a modifier, so it only accepts a tag
 * with at least `minPosts` posts: a rare tag that merely happens to match is
 * not "closest", it is a coincidence. Nothing found returns null, and the
 * caller keeps the original and reports it. Every swap is reported too.
 *
 * @param {string} tag  underscored
 * @param {{ postCount: (t: string) => number, aliasTarget: (t: string) => string|null, minPosts?: number }} db
 * @returns {{ tag: string, how: 'renamed'|'number'|'shortened' } | null}
 */
export function closestTag(tag, { postCount, aliasTarget, minPosts = 500 }) {
  if (postCount(tag) > 0) return null;
  const renamed = aliasTarget(tag);
  if (renamed) return { tag: renamed, how: 'renamed' };
  for (const f of numberForms(tag)) if (postCount(f) > 0) return { tag: f, how: 'number' };
  // Deliberately NOT tried: danbooru's bracketed forms. Tested on the Z440
  // 18 Oct 2026, the busiest bracket of `photo` is `photo_(medium)` - "this
  // picture IS a photograph" - when the model meant a photo in the scene. A
  // bracket is where danbooru keeps the meanings apart, so picking one by
  // post count picks a meaning by popularity.
  const words = tag.split('_');
  for (let i = 1; i < words.length; i++) {
    const rest = words.slice(i).join('_');
    for (const c of [rest, ...numberForms(rest), aliasTarget(rest)].filter(Boolean)) {
      if (postCount(c) >= minPosts) return { tag: c, how: 'shortened' };
    }
  }
  return null;
}

function finishTags(style, raw, { trigger, exclude, resolve, rule = {} }) {
  const spelling = style.tag_spelling ?? 'spaces';
  // Unknown tags swapped for the closest real one when the server has the tag
  // database (closestTag above). The style's own non-danbooru tags (Anima's
  // `safe`) and @artists are never looked up.
  const meta = new Set((style.meta_tags ?? []).map(tagKey));
  const replaced = [];
  const live = (t) => {
    if (!resolve || t.startsWith('@') || meta.has(tagKey(t))) return t;
    const hit = resolve(t.replace(/ /g, '_'));
    if (!hit) return t;
    const to = spellTag(hit.tag, spelling);
    replaced.push({ from: t, to, how: hit.how });
    return to;
  };
  const drop = (style.drop_tags ?? []).map((p) => new RegExp(`^(?:${p})$`, 'i'));
  const excluded = new Set(exclude.map(tagKey));
  const seen = new Set();
  const kept = [];
  const dropped = [];
  for (const piece of unwrap(raw).split(/[,\n]/)) {
    // `2b \(nier:automata\)` is ComfyUI's escaping for a prompt; a training
    // caption is read as plain text, so the brackets go in bare.
    const t = piece.replace(/^[-*•\s]+/, '').replace(/\\([()])/g, '$1').trim();
    if (!t) continue;
    // Visible text copied into the tag line ("promptforge" in quotes, seen on
    // the Z440 18 Oct 2026) is not a tag; the prose carries the quote.
    if (/^["'“‘]/.test(t)) {
      dropped.push(t);
      continue;
    }
    const spelled = t.startsWith('@') ? t.toLowerCase().replace(/_/g, ' ') : live(spellTag(t, spelling));
    const key = tagKey(spelled);
    if (seen.has(key)) continue;
    seen.add(key);
    if (excluded.has(key) || drop.some((re) => re.test(spelled))) {
      dropped.push(spelled);
      continue;
    }
    kept.push(spelled);
  }
  let trig = String(trigger ?? '').trim();
  if (trig && rule.at && !trig.startsWith('@')) trig = `@${trig}`;
  const body = trig ? kept.filter((t) => tagKey(t.replace(/^@/, '')) !== tagKey(trig.replace(/^@/, ''))) : kept;
  return { caption: [trig, ...body].filter(Boolean).join(', '), dropped, tags: body, replaced, trigger: trig };
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Where the trigger word goes and what joins it, per style and LoRA type,
 * from config/captions.yaml. Each model's own makers do this differently,
 * and it is a rule, so it is code:
 *
 *   Anima's makers   `@greg rutkowski. <prose>`   in front, a full stop, and
 *                    the @ an artist-style trigger needs on Anima
 *   Krea 2 trainer   `<prose>, monochrome ink wash style`   at the end
 *                    after a comma for a style; after a space for a subject
 *
 * Default: in front, then a comma.
 */
export function triggerRule(style, type = 'character') {
  const base = { position: 'start', join: ', ', strip_period: false, at: false, ...(style.trigger ?? {}) };
  return { ...base, ...(style.trigger_by_type?.[type] ?? {}) };
}

/** Prose: one paragraph, the trigger word placed by the style's rule. */
function finishProse(raw, { trigger, rule = { position: 'start', join: ', ' } }) {
  let text = unwrap(raw).replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  let trig = String(trigger ?? '').trim();
  if (trig && rule.at && !trig.startsWith('@')) trig = `@${trig}`;
  if (trig) {
    // Drop a copy the model wrote anyway, then put ours in. Only a copy that
    // stands apart - first and followed by punctuation, or last after a comma
    // or full stop - so a trigger that is an ordinary word (`girl`) never
    // takes the last word off "...beside a girl."
    const bare = escRe(trig.replace(/^@/, ''));
    text = text
      .replace(new RegExp(`^@?${bare}\\s*[,.:;-]\\s*`, 'i'), '')
      .replace(new RegExp(`\\s*[,.]\\s*@?${bare}\\s*\\.?$`, 'i'), (m) => (m.trimStart().startsWith('.') ? '.' : ''))
      .trim();
    if (rule.position === 'end') {
      const body = rule.strip_period ? text.replace(/[.\s]+$/, '') : text;
      text = `${body}${rule.join}${trig}`;
    } else {
      text = `${trig}${rule.join}${text}`;
    }
  }
  return { caption: text, dropped: [], trigger: trig };
}

/** MOSS's recaptioner shape: { caption: { long, medium, short }, watermark, borders }. */
function finishMoss(style, raw, { trigger, length }) {
  const s = unwrap(raw);
  const json = s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1);
  let doc;
  try {
    doc = JSON.parse(json);
  } catch {
    const err = new Error('The model did not return the JSON MOSS captions need. Try again, or pick another model.');
    err.code = 'unparseable';
    throw err;
  }
  const caps = doc?.caption ?? {};
  const lengths = style.lengths ?? ['long', 'medium', 'short'];
  const captions = {};
  for (const l of lengths) captions[l] = finishProse(caps[l] ?? '', { trigger }).caption;
  const pick = lengths.includes(length) ? length : style.default_length ?? lengths[0];
  if (!captions[pick] || captions[pick] === String(trigger ?? '').trim()) {
    const err = new Error(`The model's JSON had no ${pick} caption.`);
    err.code = 'unparseable';
    throw err;
  }
  const watermark = Array.isArray(doc?.watermark) ? doc.watermark.filter(Boolean) : [];
  return { caption: captions[pick], captions, length: pick, watermark: watermark.length > 0, dropped: [] };
}

/**
 * Turn the model's reply into the caption that goes in the .txt.
 * Throws an Error with code 'unparseable' when there is nothing usable.
 */
export function finishCaption(style, raw, { trigger = '', exclude = [], length, resolve = null, type = 'character' } = {}) {
  let out;
  const rule = triggerRule(style, type);
  if (style.kind === 'tags') out = finishTags(style, raw, { trigger, exclude, resolve, rule });
  else if (style.kind === 'mixed') {
    // Tags, then prose (Anima): the model writes them as two blocks, and they
    // go out as ONE line, tags then sentences, the shape this app's own Anima
    // prompter writes - so a LoRA trains on what it will later be prompted
    // with. The tag half gets every tag rule; the prose is kept as written.
    const s = unwrap(raw);
    // The blank line, or failing that the first piece that reads as a
    // sentence: tags are lowercase, prose starts with a capital and runs to
    // three words or more. Without this, a reply that ran the two together
    // would have its sentences chopped into fake tags at every comma.
    let cut = s.search(/\n\s*\n/);
    if (cut === -1) {
      const m = /(?:^|[,\n])\s*(?=[A-Z][^,\n]*?\s\S+\s\S+)/.exec(s);
      if (m) cut = m.index;
    }
    const tagPart = cut === -1 ? s : s.slice(0, cut);
    const prosePart = cut === -1 ? '' : s.slice(cut).replace(/^[,\s]+/, '').trim();
    const t = finishTags(style, tagPart, { trigger, exclude, resolve, rule });
    const prose = prosePart ? finishProse(prosePart, {}).caption : '';
    out = { ...t, caption: [t.caption, prose].filter(Boolean).join(', ') };
  }
  else if (style.kind === 'moss') out = finishMoss(style, raw, { trigger, length });
  else out = finishProse(raw, { trigger, rule });
  const trig = out.trigger ?? String(trigger ?? '').trim();
  const bare = trig ? out.caption.replace(trig, '').replace(/^[\s,.]+|[\s,.]+$/g, '') : out.caption.trim();
  if (!bare) {
    const err = new Error('The model returned no caption.');
    err.code = 'unparseable';
    throw err;
  }
  return out;
}

/**
 * The user turn: the LoRA type, what the tagger saw, what to leave out, then
 * the ask. `typeLabel` is the type's label from config ("Character"); the
 * type's instructions themselves are in the system prompt.
 */
export function captionRequest(style, { tags = [], exclude = [], trigger = '', typeLabel = '' } = {}) {
  const parts = [];
  if (typeLabel) parts.push(`This dataset is for a LoRA of this kind: ${typeLabel}.`);
  if (tags.length) parts.push(`A tagger found these tags (it can be wrong, and it misses things):\n${tags.join(', ')}`);
  if (exclude.length) {
    parts.push(
      `Leave these out of the caption entirely. The LoRA learns them from the trigger word, ` +
      `so naming them would teach it the wrong thing:\n${exclude.join(', ')}`
    );
  }
  if (trigger) parts.push(`The trigger word is "${trigger}". It is added to the caption for you; do not write it.`);
  parts.push(style.kind === 'moss' ? 'Caption this picture. Reply with the JSON object only.' : 'Caption this picture.');
  return parts.join('\n\n');
}
