// Write docs/randomizer-categories.md from config/randomizer.json.
//
// A reference for what is in the randomizer, because the panel shows counts
// and names but never the words themselves — and the words are the thing you
// actually want to check when a roll comes out wrong.
//
//   node scripts/randomizer-doc.mjs [--out FILE]
//
// Regenerate after any import. It is derived, so never hand-edit it.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const GROUP = /\{([^{}]*)\}/g;

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outFile = outIdx >= 0 ? args[outIdx + 1] : 'docs/randomizer-categories.md';
const config = JSON.parse(readFileSync('config/randomizer.json', 'utf8'));

/**
 * Top-level slots, each as its list of options.
 *
 * Brace-depth aware, because a group can now contain a group:
 *
 *   {{red|green} scales|no scales:3}
 *
 * The innermost-only regex used here before showed that as a bare list of
 * colours, losing both the word "scales" and the one-in-four odds — the doc
 * described something the randomizer does not do. A nested group is rendered
 * inline in brackets so the structure survives into the page.
 */
function options(template) {
  const slots = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < template.length; i += 1) {
    if (template[i] === '{') {
      if (depth === 0) start = i + 1;
      depth += 1;
    } else if (template[i] === '}') {
      depth -= 1;
      if (depth === 0) slots.push(template.slice(start, i));
    }
  }
  return slots.map((body) => {
    // Inner groups become [a · b · c] so the split below cannot cut through
    // one of their pipes.
    const flat = body.replace(/\{([^{}]*)\}/g, (_, inner) =>
      `[${inner.split('|').map((o) => o.trim()).join(' · ')}]`
    );
    return flat.split('|').map((o) => o.trim()).filter(Boolean);
  });
}

/**
 * Every option a person could actually draw, nested ones included.
 *
 * An option holding a bracketed inner list is not one choice, it is as many as
 * the list holds — `[red · green · black] scales` is three ways to have
 * scales, not one. Counting it as one made Dragon read 17 against a true 40.
 */
const countOptions = (t) =>
  options(t).reduce(
    (n, slot) =>
      n +
      slot.reduce((m, opt) => {
        const inner = opt.match(/\[([^\]]*)\]/);
        return m + (inner ? inner[1].split('·').length : 1);
      }, 0),
    0
  );

const lines = [];
const L = (s = '') => lines.push(s);

const totalSubs = config.categories.reduce((n, b) => n + b.children.length, 0);
const totalOpts = config.categories.reduce(
  (n, b) => n + b.children.reduce((m, k) => m + k.templates.reduce((o, t) => o + countOptions(t), 0), 0),
  0
);

L('# Randomizer categories');
L();
L('**Generated — do not edit.** `node scripts/randomizer-doc.mjs`');
L();
L(`${config.categories.length} boxes · ${totalSubs} sub-categories · ${totalOpts.toLocaleString()} options`);
L();
L('The randomizer fills the brief box with random terms. Nothing here reaches');
L('a model on its own — you pick categories, roll, edit the result, and then');
L('generate as normal. Image models only.');
L();
L('**How a template works.** A sub-category is either a flat list, where one');
L('option is picked, or a composed template of several slots separated by');
L('commas, where one option is picked from *each* — which is what makes a');
L('creature come out coherent rather than as a loose wing. `term:3` weighs a');
L('term three times as likely. An option reading `no X`, `none` or `nothing`');
L('resolves to silence: it keeps its odds and contributes no words.');
L();

// Contents
L('## Contents');
L();
for (const box of config.categories) {
  const opts = box.children.reduce((m, k) => m + k.templates.reduce((o, t) => o + countOptions(t), 0), 0);
  const anchor = box.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  L(`- [${box.label}](#${anchor}) — ${box.children.length} sub-categories, ${opts} options`);
}
L();

// The cast selector is not a category and would be invisible otherwise.
L('Plus a **Characters** control above the grid — 1–4 women and 1–4 men, used');
L('exactly as set and never randomized. See `CAST_WOMEN` in');
L('`scripts/randomizer.py`.');
L();

for (const box of config.categories) {
  L(`## ${box.label}`);
  L();
  for (const kid of box.children) {
    const n = kid.templates.reduce((o, t) => o + countOptions(t), 0);
    L(`### ${kid.label}`);
    L();
    L(`\`${kid.id}\` — ${n} options`);
    L();
    for (const template of kid.templates) {
      const slots = options(template);
      if (slots.length === 1) {
        // Flat list: one line of comma-separated options reads better than a
        // bullet per word at this size.
        L(slots[0].join(' · '));
      } else {
        // Composed: one bullet per slot, because the slots are the structure.
        for (const slot of slots) L(`- ${slot.join(' · ')}`);
      }
      L();
    }
  }
}

mkdirSync(path.dirname(outFile), { recursive: true });
writeFileSync(outFile, lines.join('\n'), 'utf8');
console.error(`Wrote ${outFile} — ${lines.length} lines`);
