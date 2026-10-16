// Escaping literal parentheses in a prompt that also uses them for weighting.
//
// `makima_(chainsaw_man)` is a Danbooru tag. `(chibi:2)` is an emphasis
// expression. Both are parentheses, and a generator that supports weighting
// reads every unescaped pair as the second thing — so the series name is
// parsed as a weight that lost its number, and it steers nothing.
//
// The fix is `makima \(chainsaw_man\)`, and it is entirely mechanical: the
// two cases are told apart by whether what follows the colon is a number.
//
// ── Why this is not left to the prompt file ───────────────────────────────
//
// It was, first. anima.md gained an "Escaping parentheses" section on 27 Aug
// 2026, and the dialect suite measured the result on qwen3:8b: **1 of 3**.
// The model wrote `makima (chainsaw man)` and `zhongli (genshin impact)` bare
// on the runs it lost.
//
// This project has already had that argument once and settled it, in the
// comment above `ensureDefaults` in server/negative.mjs: pony dropped its
// score floor on 6 of 6 runs, rewriting pony.md moved it only to 2 of 6, and
// the conclusion written down there was that a constant sitting in config is
// "a job [a small model] can only lose at". Escaping is not even a constant —
// it is a character substitution with a decidable rule. Asking a 8B to apply
// it per tag, every time, is the same mistake in a new place.
//
// So the prompt file still teaches it — a model that gets it right produces
// text this function then leaves alone — and this makes it true regardless.

/**
 * Escape every parenthesis pair that is NOT a weight expression.
 *
 * @param text  a prompt segment
 * @returns { text, escaped } — escaped is what was changed, for logging
 */
export function escapeLiteralParens(text) {
  const src = String(text ?? '');
  if (!src.includes('(')) return { text: src, escaped: [] };

  const escaped = [];
  let out = '';
  let i = 0;

  while (i < src.length) {
    const ch = src[i];

    // Already escaped, by the model or by a previous pass. Copy the pair
    // through untouched — re-escaping would produce `\\(`, which is a literal
    // backslash followed by an open paren and is worse than either state.
    if (ch === '\\' && (src[i + 1] === '(' || src[i + 1] === ')')) {
      out += src[i] + src[i + 1];
      i += 2;
      continue;
    }

    if (ch !== '(') {
      out += ch;
      i += 1;
      continue;
    }

    // Find this group's closing paren. Anything containing another `(` is
    // left alone entirely: `(makima \(chainsaw man\):2)` is a weighted tag
    // whose own disambiguator is already handled, and picking it apart here
    // risks breaking a valid expression to fix nothing.
    const close = src.indexOf(')', i + 1);
    const inner = close === -1 ? null : src.slice(i + 1, close);
    if (inner === null || inner.includes('(')) {
      out += ch;
      i += 1;
      continue;
    }

    // The one distinction that matters. `chibi:2` and `glitch:1.5` are
    // weights and stay as syntax; `chainsaw man`, `nier:automata` and
    // `overwatch` are names and become text. Note `nier:automata` has a colon
    // and is still a name — what decides it is a NUMBER after the colon.
    if (/:\s*\d+(?:\.\d+)?\s*$/.test(inner)) {
      out += src.slice(i, close + 1);
      i = close + 1;
      continue;
    }

    escaped.push(`(${inner})`);
    out += `\\(${inner}\\)`;
    i = close + 1;
  }

  return { text: out, escaped };
}
