// Underscores out of the tags of a model that wants spaces.
//
// 3 Oct 2026, the owner: on Illustrious, underscores "have more or less been
// trained out of the model". Switching its tag_style to "space" fixed what the
// app puts in (character traits, ladders, candidates), but the model still
// wrote `best_quality, cat_ears` from habit - and once `sousou no_frieren`,
// half each. A spelling rule is code's job, not the prompt's.
//
// Left alone:
//   - emoticon tags spelled with an underscore: `o_o`, `x_x`, `^_^`;
//   - score tags (`score_7`, `score_8_up`), which keep their underscore on the
//     models that use them;
//   - any tag the person typed themselves, exactly as typed.

const BETWEEN = /(?<=[\p{L}\p{N})\\])_(?=[\p{L}\p{N}(\\])/gu;
// A face, not a phrase: one character (or none) either side of the underscore.
const EMOTICON = /^\(?[^\p{L}\p{N}]?[\p{L}\p{N}]?_[\p{L}\p{N}]?[^\p{L}\p{N}]?\)?$/u;
const SCORE = /^\(?score_\d/i;

const tagsOf = (text) => String(text ?? '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);

/**
 * `text` with underscores between words turned into spaces, tag by tag.
 * Returns { text, changed } where changed counts the tags respelled.
 */
export function spaceUnderscores(text, protectedTexts = []) {
  const kept = new Set(protectedTexts.flatMap(tagsOf));
  let changed = 0;
  const out = String(text ?? '').split(',').map((piece) => {
    const tag = piece.trim();
    if (!tag.includes('_') || kept.has(tag.toLowerCase()) || SCORE.test(tag) || EMOTICON.test(tag)) return piece;
    const spaced = piece.replace(BETWEEN, ' ');
    if (spaced !== piece) changed += 1;
    return spaced;
  });
  return { text: out.join(','), changed };
}
