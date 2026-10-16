// Literal parentheses versus weighting parentheses.
//
//   node scripts/test-parens.mjs
//
// No server, no model, no network. The rule under test is one distinction:
// `(chibi:2)` is emphasis syntax and survives; `(chainsaw man)` is part of a
// tag name and becomes `\(chainsaw man\)`. What separates them is whether a
// NUMBER follows the colon — which is why `nier:automata` is a name despite
// having a colon in it, and that case is asserted below.
//
// Why this is in code at all: anima.md teaches the rule, and qwen3:8b applied
// it on 1 of 3 dialect runs. server/parens.mjs has the full argument.

import { escapeLiteralParens } from '../server/parens.mjs';

let passed = 0;
const failures = [];

function check(what, ok, detail) {
  if (ok) passed += 1;
  else failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
}

const out = (s) => escapeLiteralParens(s).text;
const same = (what, s) => check(`${what} is left alone`, out(s) === s, out(s));
const becomes = (what, s, want) => check(what, out(s) === want, out(s));

// ── the reported case ────────────────────────────────────────
// Verbatim from a dialect run on 27 Aug 2026, where the model wrote the
// series bare and the generator would have read it as a weight.
becomes(
  'a bare series is escaped',
  'masterpiece, 1girl, solo, makima (chainsaw man), chainsaw man, rain',
  'masterpiece, 1girl, solo, makima \\(chainsaw man\\), chainsaw man, rain'
);
becomes(
  'so is an underscored one',
  'makima_(chainsaw_man)',
  'makima_\\(chainsaw_man\\)'
);

// ── weights survive ──────────────────────────────────────────
// The model's own author writes (chibi:2). Escaping it would turn emphasis
// into four literal characters.
same('an integer weight', '(chibi:2), 1girl');
same('a decimal weight', '(glitch:1.5), 1girl');
same('a weight with spaces', '( chibi : 2 ), 1girl');
same('a high weight', '(chibi:5), 1girl');
same('two weights', '(a:2), (b:3)');

// ── the colon is not the test; the NUMBER is ─────────────────
// `nier:automata` is a series with a colon in it. A rule that keyed on the
// colon alone would leave it unescaped and lose it.
becomes(
  'a series containing a colon is still a name',
  '2b (nier:automata), nier:automata',
  '2b \\(nier:automata\\), nier:automata'
);
becomes('a trailing colon with no number is a name', '(re:zero)', '\\(re:zero\\)');

// ── idempotent ───────────────────────────────────────────────
// It runs on whatever the model produced, and a model that already got the
// rule right must not have its output doubled into `\\(`.
same('already-escaped text', 'makima \\(chainsaw man\\)');
{
  const once = out('makima (chainsaw man)');
  check('escaping twice equals escaping once', out(once) === once, out(once));
}

// ── things it must not touch ─────────────────────────────────
same('text with no parens at all', 'masterpiece, best quality, 1girl, solo');
same('an empty string', '');
check('null does not throw', out(null) === '');
// Nested parens are left whole. `(makima \(chainsaw man\):2)` is a weighted
// tag whose own disambiguator is already handled, and taking it apart risks
// breaking a valid expression to fix nothing.
same('a weight wrapping an escaped tag', '(makima \\(chainsaw man\\):2)');
// An unbalanced paren is malformed either way. Escaping half of it would
// make it worse, so it passes through.
same('an unclosed paren', 'makima (chainsaw man');

// ── prose ────────────────────────────────────────────────────
// Anima's positive carries a prose block, and an unescaped aside in it is
// read as weighting exactly like a tag is. Escaping is right there too.
becomes(
  'a prose aside is escaped like anything else',
  'She stands by the window (the light is behind her).',
  'She stands by the window \\(the light is behind her\\).'
);

// ── what gets reported ───────────────────────────────────────
// The caller logs this, so it has to name what actually changed rather than
// just how many.
{
  const { escaped } = escapeLiteralParens('makima (chainsaw man), 2b (nier:automata), (chibi:2)');
  check('reports both literals and not the weight',
    escaped.join(' | ') === '(chainsaw man) | (nier:automata)', escaped.join(' | '));
}
{
  const { escaped } = escapeLiteralParens('(chibi:2), 1girl');
  check('reports nothing when nothing changed', escaped.length === 0, escaped.join(', '));
}

// ── report ───────────────────────────────────────────────────
if (failures.length) {
  console.log(`\n${failures.length} FAILED:`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
// Bare count: check.mjs reads what is between the parentheses and appends
// "assertions" itself.
console.log(`ALL PASSED (${passed})`);
