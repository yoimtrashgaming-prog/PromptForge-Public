// Does illustrious.md's worked example leak its negative onto unrelated briefs?
//
//   node scripts/probe-negative-leak.mjs [baseUrl] [--runs N] [--label name]
//
// The example in illustrious.md is Fern as a steampunk mechanic, and it negates
// `mage_staff, robe` because Fern canonically wears a robe and carries a staff.
// That is correct *there* — the example's own Reasoning says why. The defect is
// that the model carries it forward as boilerplate onto briefs with nothing to
// do with robes or staves.
//
// This measures that. Three briefs where both tags are meaningless, N runs each,
// counting how many generations come back with either in the negative.
//
// The first version of this probe was written on 21 Aug, used once for the 6/12
// baseline in thread 12, and thrown away — so the next session had a number it
// could not reproduce or compare against. Hence this file. Re-measure the
// baseline WITH THIS SCRIPT before judging any candidate patch: the original
// brief wording is not recoverable and a number from a different set of briefs
// is not a control.
//
// It goes through /api/generate rather than composing the prompt itself, on
// purpose. server/negative.mjs already strips a negative tag that contradicts
// the positive, so the honest measure is what a user would actually be shown,
// after that cleanup — not what the model first emitted.
//
// Needs a server with a real backend and auth off:
//
//   PROMPTFORGE_AUTH=off PROMPTFORGE_PORT=8096 npm start
//
// 8096 on purpose: test-failures and test-auth stand their own servers up on
// 8097 and test-library on 8098, so a probe server left running on those makes
// `npm run check` fail with EADDRINUSE and nothing in the app is wrong.

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const RUNS = Math.max(1, Number(flag('--runs', 4)) || 4);
const LABEL = flag('--label', 'unlabelled');
const BASE =
  args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--runs' && args[i - 1] !== '--label') ??
  'http://127.0.0.1:8096';

// Deliberately robe-free and staff-free. One modern-realistic, one with no
// people in it at all, and one that is a mechanic — the example's occupation —
// without any of the example's fantasy baggage. The third is the interesting
// one: if the leak were really about the word "mechanic" rather than the
// example being treated as boilerplate, it would show up here and nowhere else.
const BRIEFS = [
  { id: 'ramen',   text: 'a businessman in a suit eating ramen at a counter, steam rising from the bowl' },
  { id: 'cats',    text: 'two cats asleep on a sunny windowsill, potted plants beside them' },
  { id: 'garage',  text: 'a mechanic in coveralls lying under a car on a creeper, holding a wrench' },
];

// Tags the example's positive carries that none of these three briefs justify.
// The leak is usually described as a negative-prompt problem; if these show up
// too, then what is actually happening on that brief is that the model reached
// for the example's whole answer, and no amount of guidance in the negative
// section will reach it. `1girl` and `solo` are in here because none of the
// three briefs names one woman: one is a businessman, one is two cats, one is
// an ungendered mechanic.
const ECHO = ['looking_at_viewer', 'upper_body', 'detailed_background', '1girl', 'solo'];
const echoHits = (positive) =>
  ECHO.filter((t) =>
    // Doubled backslashes on purpose: this is a template literal, so `\\s`
    // written here is what reaches the regex as `\s`. Written single, the
    // escape is swallowed, the class becomes [s,(], and every run reports a
    // clean sheet. dialect-check.mjs carries the same warning, for the same
    // reason: this project has been bitten by a mangled escape repeatedly.
    new RegExp(`(?:^|[\\s,(])${t}(?::[\\d.]+)?(?:$|[\\s,):])`).test(positive)
  );

// Tag-shaped word boundaries. Underscores are part of a tag, so `\b` alone
// would match `robe` inside `mage_robe` and also inside `wardrobe` — the first
// is a leak and the second is not, and only one of them is a real tag.
const LEAK = /(?:^|[\s,(])(?:mage_staff|robe)(?::[\d.]+)?(?:$|[\s,):])/;

// --selftest: the two predicates against fixed strings, no server and no GPU.
// Both are regexes with escapes in them, and a mangled escape does not fail
// loudly — it silently reports every run clean, which reads exactly like a
// candidate patch that worked. That happened once while writing this file.
if (args.includes('--selftest')) {
  const cases = [
    ['leak: plain tag', () => LEAK.test('watermark, text, signature, mage_staff, robe')],
    ['leak: weighted', () => LEAK.test('blurry, (robe:1.2), lowres')],
    ['leak: end of list', () => LEAK.test('lowres, blurry, robe')],
    ['clean: wardrobe is not robe', () => !LEAK.test('lowres, wardrobe, blurry')],
    ['clean: mage_robe is not robe', () => !LEAK.test('lowres, mage_robe, blurry')],
    ['clean: no leak', () => !LEAK.test('worst_quality, lowres, multiple_girls')],
    [
      'echo: five of the example tags',
      () =>
        echoHits('masterpiece, 1girl, solo, coveralls, detailed_background, looking_at_viewer, upper_body')
          .length === 5,
    ],
    ['echo: none', () => echoHits('masterpiece, cat, windowsill, potted_plant').length === 0],
    ['echo: 1girl alone is not an echo', () => echoHits('masterpiece, 1girl, ramen').length === 1],
  ];
  let bad = 0;
  for (const [name, fn] of cases) {
    const ok = fn();
    if (!ok) bad += 1;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  }
  console.log(`
${cases.length - bad}/${cases.length} predicates hold
`);
  process.exit(bad ? 1 : 0);
}

async function generate(brief) {
  const res = await fetch(`${BASE}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'illustrious',
      brief,
      controls: { quality_preset: 'masterpiece', aspect_ratio: '2:3', creativity: 'balanced' },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let done = null;
  let error = null;
  for (;;) {
    const { done: fin, value } = await reader.read();
    if (fin) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (.+)$/m.exec(frame);
      const da = /^data: (.+)$/m.exec(frame);
      if (!ev || !da) continue;
      if (ev[1] === 'done') done = JSON.parse(da[1]);
      if (ev[1] === 'error') error = JSON.parse(da[1]);
    }
  }
  if (error) throw new Error(`${error.code}: ${error.message}`);
  if (!done) throw new Error('stream ended with no done event');

  const seg = {};
  for (const s of done.segments) seg[s.label] = s.body;
  return seg;
}

const status = await fetch(`${BASE}/api/status`).then((r) => r.json());
console.log(`\nlabel   : ${LABEL}`);
console.log(`backend : ${status.llm?.backend ?? '?'} — ${status.llm?.model ?? '?'}`);
console.log(`runs    : ${BRIEFS.length} briefs x ${RUNS} = ${BRIEFS.length * RUNS} generations\n`);

let leaked = 0;
let echoed = 0;
let total = 0;
const perBrief = new Map(BRIEFS.map((b) => [b.id, { leaked: 0, echoed: 0, ran: 0 }]));

for (const brief of BRIEFS) {
  for (let r = 1; r <= RUNS; r += 1) {
    let seg;
    try {
      seg = await generate(brief.text);
    } catch (err) {
      // A failed generation is not a clean run and must not be counted as a
      // pass. Reported, then excluded from the denominator.
      console.log(`  ${brief.id} #${r}: ERROR — ${err.message}`);
      continue;
    }
    const negative = seg['Negative prompt'] ?? '';
    const echo = echoHits(seg['Positive prompt'] ?? '');
    const hit = LEAK.test(negative);
    total += 1;
    perBrief.get(brief.id).ran += 1;
    if (hit) {
      leaked += 1;
      perBrief.get(brief.id).leaked += 1;
    }
    // Three or more is not coincidence: each is a real Danbooru tag a model
    // could pick on its own, but not five of them in the example's order.
    if (echo.length >= 3) {
      echoed += 1;
      perBrief.get(brief.id).echoed += 1;
    }
    const which = [
      /(?:^|[\s,(])mage_staff/.test(negative) ? 'mage_staff' : null,
      /(?:^|[\s,(])robe(?::[\d.]+)?(?:$|[\s,):])/.test(negative) ? 'robe' : null,
    ].filter(Boolean);
    console.log(
      `  ${brief.id} #${r}: ${hit ? `LEAK — ${which.join(' + ')}` : 'clean'}` +
        `${echo.length >= 3 ? `  · echoes example positive [${echo.join(', ')}]` : ''}`
    );
  }
}

console.log(`\nper brief:`);
for (const [id, t] of perBrief) {
  console.log(`  ${id.padEnd(8)} leak ${t.leaked}/${t.ran}   positive echo ${t.echoed}/${t.ran}`);
}
console.log(`\nexample-negative leak: ${leaked}/${total}`);
console.log(`example-positive echo: ${echoed}/${total}`);
// Reference points, so a future run knows what "normal" looks like now that
// the fix has shipped. The residual is one brief — see thread 13.
console.log(
  '(qwen3:8b: 16/21 before the negative-scope guidance was applied on 21 Aug,' +
    ' 8/24 after.\n Whatever remains should be the garage brief, which recites the' +
    ' worked example\n rather than carrying its negative — thread 13, a different defect.)\n'
);
