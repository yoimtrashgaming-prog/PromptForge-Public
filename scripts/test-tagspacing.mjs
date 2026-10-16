// Underscores out of a space-style model's tags, with the exceptions kept.
//
//   node scripts/test-tagspacing.mjs
//
// No server, no model.

import { spaceUnderscores } from '../server/tagspacing.mjs';

let passed = 0;
const failures = [];
function check(what, ok, detail) {
  if (ok) passed += 1;
  else failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
}
const sp = (t, p) => spaceUnderscores(t, p).text;

check('the measured habit is respelled', sp('masterpiece, best_quality, cat_ears, tank_top') === 'masterpiece, best quality, cat ears, tank top');
check('a half-and-half tag is mended', sp('sousou no_frieren, 1girl') === 'sousou no frieren, 1girl');
check('escaped parentheses keep their escapes', sp('crane_\\(machine\\)') === 'crane \\(machine\\)', sp('crane_\\(machine\\)'));
check('a weighted tag is respelled inside its weight', sp('(cat_ears:1.2)') === '(cat ears:1.2)');
check('emoticon tags keep their underscore', sp('o_o, x_x, ^_^, >_<') === 'o_o, x_x, ^_^, >_<');
check('score tags keep theirs', sp('score_9, score_8_up, 1girl') === 'score_9, score_8_up, 1girl');
check('a tag the person typed is left exactly as typed', sp('my_lora_trigger, cat_ears', ['my_lora_trigger']) === 'my_lora_trigger, cat ears');
check('prose without underscores is untouched', sp('A woman stands, smiling.') === 'A woman stands, smiling.');
check('the count is of tags changed', spaceUnderscores('red_hair, blue_eyes, solo').changed === 2);
check('nothing to do, nothing changed', spaceUnderscores('cat ears, 1girl').changed === 0);

if (failures.length) {
  console.log(`\n${failures.length} FAILED:`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log(`ALL PASSED (${passed})`);
