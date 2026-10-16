// h3's Shots control: the settings line, and the count checked afterwards.
//
//   node scripts/test-shots.mjs
//
// No server, no model.

import { shotCount, shotsLine, shotsWritten, shotCountWarning, repairCutTimes, foldShotBriefs } from '../server/shots.mjs';

let passed = 0;
const failures = [];
function check(what, ok, detail) {
  if (ok) passed += 1;
  else failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
}

const ONE = '[Shot 1] A wide shot of her at the window as the rain starts.';
const TWO = `${ONE}\n\n[Shot 2] At 00:05.000, the camera cuts to her hands on the glass.`;
const desc = (body) => [{ label: 'Summary', body: 'x' }, { label: 'Detailed description', body }];

// ── what goes to the model ───────────────────────────────────
check('Auto sends nothing', shotsLine({ shots: 'Auto' }) === null);
check('FL2VA on Auto is one shot', /one continuous shot/.test(shotsLine({ mode: 'FL2VA', shots: 'Auto' }) ?? ''));
check('FL2VA with a picked number keeps it', /exactly 3 shots/.test(shotsLine({ mode: 'FL2VA', shots: '3' }) ?? ''));
check('other modes on Auto still send nothing', ['T2VA', 'I2VA', 'L2VA', 'REF2VA'].every((mode) => shotsLine({ mode, shots: 'Auto' }) === null));
check('FL2VA on Auto folds no boxes', foldShotBriefs('x', { mode: 'FL2VA', shots: 'Auto', shot_briefs: ['a'] }) === 'x');
check('no control sends nothing', shotsLine({}) === null);
check('a picked number arrives as a string and is read', shotCount({ shots: '3' }) === 3);
check('one shot says no cuts', /one continuous shot/.test(shotsLine({ shots: '1' })) && /no cuts/.test(shotsLine({ shots: '1' })));
check('three shots names the range', /\[Shot 1\] to \[Shot 3\]/.test(shotsLine({ shots: '3' })));
check('it says it overrides the detail level', /overrides/.test(shotsLine({ shots: '2' })));

// ── the per-shot boxes ───────────────────────────────────────
check('boxes join the brief as Shot N lines', foldShotBriefs('A rainy night.', { shots: '2', shot_briefs: ['She opens the door.', ' He turns. '] }) === 'A rainy night.\nShot 1: She opens the door.\nShot 2: He turns.');
check('an empty box is skipped and keeps its number', foldShotBriefs('x', { shots: '3', shot_briefs: ['a', '', 'c'] }) === 'x\nShot 1: a\nShot 3: c');
check('boxes past the picked count are dropped', foldShotBriefs('x', { shots: '1', shot_briefs: ['a', 'b'] }) === 'x\nShot 1: a');
check('Auto folds nothing', foldShotBriefs('x', { shots: 'Auto', shot_briefs: ['a'] }) === 'x');
check('boxes alone make a brief', foldShotBriefs('  ', { shots: '2', shot_briefs: ['a', 'b'] }) === 'Shot 1: a\nShot 2: b');
check('no boxes leaves the brief as it was', foldShotBriefs(' x ', {}) === 'x');

// ── the count afterwards ─────────────────────────────────────
check('counts distinct shots', shotsWritten(TWO) === 2);
check('a repeated shot number is one shot', shotsWritten(`${ONE} [Shot 1] again`) === 1);
check('one asked, one written: no warning', shotCountWarning({ shots: '1' }, desc(ONE)) === null);
const w = shotCountWarning({ shots: '1' }, desc(TWO));
check('one asked, two written: a warning that says both', /1 shot and the model wrote 2/.test(w ?? ''), w);
check('Auto never warns', shotCountWarning({ shots: 'Auto' }, desc(TWO)) === null);
check('no Detailed description, no warning', shotCountWarning({ shots: '2' }, [{ label: 'Summary', body: 'x' }]) === null);

// ── cut times that cannot play ───────────────────────────────
const cutsOf = (body) => [...body.matchAll(/\[Shot \d+\] At (\d+:\d+\.\d+)/g)].map((m) => m[1]);
const five = (times) => `[Shot 1] Wide. ${times.map((t, i) => `[Shot ${i + 2}] At ${t}, the camera cuts to shot ${i + 2}.`).join(' ')}`;
{
  // The measured failure: last cut on the final second of a 10 s clip.
  const s = desc(five(['00:01.800', '00:04.200', '00:07.600', '00:10.000']));
  const moved = repairCutTimes({ duration: '10' }, s);
  check('a cut on the final second moves halfway to the end', JSON.stringify(cutsOf(s[1].body)) === JSON.stringify(['00:01.800', '00:04.200', '00:07.600', '00:08.800']), cutsOf(s[1].body).join(' '));
  check('...and only that cut is reported', moved.length === 1 && moved[0][1] === '00:08.800', JSON.stringify(moved));
  check('...and the shot text is untouched', s[1].body.includes('the camera cuts to shot 5.'));
}
{
  const s = desc(five(['00:03.000', '00:06.000', '00:10.000', '00:12.000']));
  repairCutTimes({ duration: '10' }, s);
  check('two late cuts share the gap evenly', JSON.stringify(cutsOf(s[1].body)) === JSON.stringify(['00:03.000', '00:06.000', '00:07.300', '00:08.700']), cutsOf(s[1].body).join(' '));
}
{
  const s = desc(five(['00:02.000', '00:06.000', '00:04.000', '00:08.000']));
  repairCutTimes({ duration: '10' }, s);
  check('a cut out of order goes between its neighbours', JSON.stringify(cutsOf(s[1].body)) === JSON.stringify(['00:02.000', '00:06.000', '00:07.000', '00:08.000']), cutsOf(s[1].body).join(' '));
}
{
  const good = five(['00:02.000', '00:04.000', '00:06.000', '00:08.000']);
  const s = desc(good);
  check('good cuts are left alone', repairCutTimes({ duration: '10' }, s).length === 0 && s[1].body === good);
  const nodur = desc(five(['00:10.000']));
  check('no duration, no repair', repairCutTimes({}, nodur).length === 0);
  check('a single shot has nothing to repair', repairCutTimes({ duration: '10' }, desc(ONE)).length === 0);
  const director = desc(five(['00:12.000']));
  check('duration_seconds is read too', repairCutTimes({ duration_seconds: 15 }, director).length === 0);
}

if (failures.length) {
  console.log(`\n${failures.length} FAILED:`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log(`ALL PASSED (${passed})`);
