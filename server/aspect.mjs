// Strip an aspect ratio that leaked out of the controls and into the prompt.
//
// The aspect selector is a setting for the image generator, not text a prompt
// should contain. It reaches the model in the user turn alongside the brief,
// where it looks like everything else in that turn, and models periodically
// copy it into the output.
//
// Measured 22 Aug 2026 on qwen3:8b: brief "a girl standing in the rain at
// night" with Aspect "2:3 Portrait" produced a positive prompt ending
// `..., rain, night, 2:3_portrait`. Labelling the control line "Settings
// (context for how to write, never text to include)" helps and does not
// suffice, so this is the mechanical half - the same division the negative
// prompt already follows: rules the prompt files state get enforced in code,
// judgement stays in prompts/.
//
// Deliberately narrow. It removes the ratio the request actually asked for,
// in the spellings a model plausibly writes it in, and nothing else. It does
// not go looking for numbers that look like ratios: `16:9` is a legitimate
// thing for someone to type into a brief about a television, and this must
// never edit what the person wrote.

/**
 * Every spelling of one aspect value worth matching.
 *
 * The control's value is a label like "2:3 Portrait", and a model may write
 * any of: the whole label, the bare ratio, the orientation word alone, or the
 * label with spaces turned into underscores or hyphens by tag conversion.
 * The orientation word alone is NOT matched - "portrait" is a real thing to
 * ask for and removing it would change the picture.
 */
function spellingsOf(aspect) {
  const label = String(aspect ?? '').trim();
  if (!label) return [];
  const ratio = (label.match(/\d+\s*:\s*\d+/) ?? [])[0] ?? '';
  const out = new Set();
  const add = (v) => {
    const t = String(v ?? '').trim();
    if (t) out.add(t.toLowerCase());
  };

  add(label);
  add(label.replace(/\s+/g, '_'));
  add(label.replace(/\s+/g, '-'));
  if (ratio) {
    const tight = ratio.replace(/\s+/g, '');
    add(tight);
    // The colon does not survive tag conversion. Measured 22 Aug: "9:16 Tall"
    // came back as `..., tall, 9_16`, which the colon spellings alone missed.
    add(tight.replace(':', '_'));
    add(tight.replace(':', '-'));
    add(tight.replace(':', ' '));
    add(`${tight} aspect ratio`);
    add(`${tight}_aspect_ratio`);
    add(`aspect ratio ${tight}`);
    // "2:3 portrait" with the orientation attached, in each separator.
    const words = label.replace(/\d+\s*:\s*\d+/, '').trim();
    if (words) {
      add(`${tight} ${words}`);
      add(`${tight}_${words.replace(/\s+/g, '_')}`);
      add(`${tight}-${words.replace(/\s+/g, '-')}`);
    }
  }
  return [...out];
}

/**
 * Remove leaked aspect text from one prompt body.
 *
 * Handles both shapes the output comes in: a comma-separated tag list, where a
 * whole item is dropped, and prose, where only an exact standalone mention is
 * cut and the sentence is left otherwise alone. Prose is treated
 * conservatively on purpose - rewriting somebody's sentence to remove two
 * words is how you introduce a worse bug than the one you fixed.
 *
 * `protectedText` is anything the person supplied themselves: their custom
 * positive and their picked tags. If they typed the ratio, it stays. Their
 * input is never second-guessed, which is the same rule cleanNegative follows.
 *
 * Returns { body, removed: [] } and never throws.
 */
export function stripAspect(body, aspect, { protectedText = [] } = {}) {
  const text = String(body ?? '');
  const spellings = spellingsOf(aspect);
  if (!text.trim() || !spellings.length) return { body: text, removed: [] };

  const guarded = protectedText
    .filter(Boolean)
    .map((t) => String(t).toLowerCase())
    .join(' ');
  const isProtected = (needle) => guarded.includes(needle);

  const removed = [];

  // The orientation word on its own - "tall", "portrait", "wide". Kept when it
  // stands alone, because it is a real thing to ask a picture for and removing
  // it would change the composition. Dropped only when it sits directly beside
  // a ratio that leaked, where it is plainly the other half of the same leak:
  // "9:16 Tall" arrives as `..., tall, 9_16`.
  const orientation = String(aspect ?? '').replace(/\d+\s*:\s*\d+/, '').trim().toLowerCase();

  // Tag-list shape: comma separated, and a leaked ratio is its own item.
  if (text.includes(',')) {
    const items = text.split(',');
    const norm = (item) => item.trim().toLowerCase().replace(/^\(|[:)\d.]+\)$/g, '').trim();
    const drop = new Set();

    items.forEach((item, i) => {
      const n = norm(item);
      if (!n || !spellings.includes(n) || isProtected(n)) return;
      drop.add(i);
      // Its neighbours, but only if they are exactly the orientation word.
      for (const j of [i - 1, i + 1]) {
        if (j < 0 || j >= items.length) continue;
        if (orientation && norm(items[j]) === orientation && !isProtected(orientation)) drop.add(j);
      }
    });

    if (drop.size) {
      for (const i of drop) removed.push(items[i].trim());
      const kept = items.filter((_, i) => !drop.has(i));
      return {
        body: kept.join(',').replace(/\s*,\s*,+/g, ', ').replace(/^\s*,\s*|\s*,\s*$/g, '').trim(),
        removed,
      };
    }
  }

  // Prose shape: only an exact standalone mention, and only when it is
  // parenthetical or trailing - the cases where it is plainly metadata rather
  // than part of a sentence somebody would read aloud.
  let out = text;
  for (const spelling of spellings) {
    if (isProtected(spelling)) continue;
    const esc = spelling.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`\\s*\\((?:in\\s+)?${esc}\\)`, 'gi'),          // "(2:3 portrait)"
      new RegExp(`[,;]\\s*(?:in\\s+)?${esc}\\s*(?=[.;,]|$)`, 'gi'), // ", 2:3 portrait."
    ];
    for (const re of patterns) {
      if (re.test(out)) {
        out = out.replace(re, '');
        removed.push(spelling);
      }
    }
  }

  return { body: removed.length ? out.replace(/\s{2,}/g, ' ').trim() : text, removed };
}
