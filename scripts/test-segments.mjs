// Unit tests for the segment parser. No backend, no network.
//
// The refusal contract in particular needs coverage here rather than in the
// smoke suite: a real model refuses because the content rules in
// house-rules.md fired, which is not something to provoke against a live
// backend just to test a parser branch.
//
//   node scripts/test-segments.mjs

import { parseSegments, SegmentStream, SegmentParseError } from '../server/segments.mjs';
import { cleanNegative, ensureDefaults } from '../server/negative.mjs';

let failures = 0;
const ok = (cond, label, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
};

const throws = (fn, code, label) => {
  try {
    fn();
    ok(false, label, 'did not throw');
  } catch (err) {
    ok(err instanceof SegmentParseError && err.code === code, label, `${err.code ?? err.name}`);
  }
};

const ILLUSTRIOUS = ['Positive prompt', 'Negative prompt', 'Reasoning'];
const KREA = ['Enhanced prompt', 'What changed'];

const build = (pairs) =>
  pairs.map(([l, b]) => `===SEGMENT: ${l}===\n${b}`).join('\n\n');

console.log('\nwhole-response parsing');

{
  const { segments, refused } = parseSegments(
    build([['Positive relevant', 'x']].length ? [
      ['Positive prompt', 'masterpiece, best_quality'],
      ['Negative prompt', 'worst_quality'],
      ['Reasoning', 'Because.'],
    ] : []),
    ILLUSTRIOUS
  );
  ok(segments.length === 3, 'parses a well-formed response');
  ok(refused === false, 'refused is false for normal output');
  ok(segments[0].body === 'masterpiece, best_quality', 'segment bodies are trimmed');
}

{
  // Out of contract order — the panel renders in contract order regardless.
  const { segments, outOfOrder } = parseSegments(
    build([
      ['Reasoning', 'Because.'],
      ['Positive prompt', 'a'],
      ['Negative prompt', 'b'],
    ]),
    ILLUSTRIOUS
  );
  ok(outOfOrder === true, 'out-of-order output is detected');
  ok(
    segments.map((s) => s.label).join(',') === ILLUSTRIOUS.join(','),
    'segments are reordered into contract order'
  );
}

console.log('\nthe Refused contract');

{
  // house-rules.md mandates this for policy refusals, but no model lists it
  // in its own segment set. Without the whitelist every refusal would surface
  // as a parse error instead of a refusal.
  const { segments, refused } = parseSegments(
    "===SEGMENT: Refused===\nThis request can't be built into a prompt.",
    ILLUSTRIOUS
  );
  ok(refused === true, 'Refused is accepted from a model that does not list it');
  ok(segments.length === 1 && segments[0].label === 'Refused', 'Refused stands alone');
  ok(
    segments[0].body === "This request can't be built into a prompt.",
    'the refusal body is preserved verbatim'
  );
}

{
  // A refusal satisfies the contract by itself — the other segments being
  // absent must not be reported as missing.
  const { refused } = parseSegments('===SEGMENT: Refused===\nNo.', KREA);
  ok(refused === true, 'Refused satisfies a different model contract too');
}

console.log('\nmalformed output is surfaced, not silently rendered');

throws(
  () => parseSegments('Here is your prompt: masterpiece, best_quality', ILLUSTRIOUS),
  'no_segments',
  'raw text with no delimiters is an error'
);

throws(
  () => parseSegments(build([['Positive prompt', 'a'], ['Negative prompt', 'b']]), ILLUSTRIOUS),
  'missing_segment',
  'a dropped segment is an error'
);

throws(
  () =>
    parseSegments(
      build([
        ['Positive prompt', 'a'],
        ['Negative prompt', 'b'],
        ['Reasoning', 'c'],
        ['Extra thoughts', 'd'],
      ]),
      ILLUSTRIOUS
    ),
  'unknown_segment',
  'an invented segment is an error'
);

console.log('\nstreaming parser');

{
  // Chunked mid-delimiter on purpose: a delimiter split across two network
  // frames must not be matched half-formed.
  const full = build([
    ['Positive prompt', 'masterpiece, best_quality'],
    ['Negative prompt', 'worst_quality'],
    ['Reasoning', 'Because.'],
  ]);
  const emitted = [];
  const stream = new SegmentStream(ILLUSTRIOUS, { onSegment: (s) => emitted.push(s.label) });
  for (let i = 0; i < full.length; i += 7) stream.push(full.slice(i, i + 7));
  const result = stream.end();

  ok(result.segments.length === 3, 'streaming parse yields all segments');
  ok(
    emitted.join(',') === ILLUSTRIOUS.join(','),
    'segments are emitted progressively in order',
    emitted.join(',')
  );
  ok(
    result.segments[1].body === 'worst_quality',
    'bodies survive being split across chunk boundaries'
  );
}

{
  const stream = new SegmentStream(ILLUSTRIOUS, {});
  stream.push("===SEGMENT: Refused===\nThis request can't be built into a prompt.\n");
  const result = stream.end();
  ok(result.refused === true, 'streaming parser honours the Refused contract');
}

{
  const stream = new SegmentStream(ILLUSTRIOUS, {});
  stream.push('no delimiters at all, just prose from a confused model');
  let code = null;
  try {
    stream.end();
  } catch (err) {
    code = err.code;
  }
  ok(code === 'no_segments', 'streaming parser reports unparseable output');
}

{
  // A dropped segment was only covered for parseSegments, not for the stream —
  // and the stream is the path the app actually uses. This is not hypothetical:
  // measured on the 27B, h3 emitted five of its seven segments on 2 of 20 runs
  // of a character brief, skipping Soundscape and Music and going straight to
  // Reasoning. The whole-response parser catching it would not have helped.
  const emitted = [];
  const stream = new SegmentStream(ILLUSTRIOUS, { onSegment: (s) => emitted.push(s.label) });
  stream.push(build([['Positive prompt', 'a'], ['Reasoning', 'c']]));

  let err = null;
  try {
    stream.end();
  } catch (e) {
    err = e;
  }

  ok(err?.code === 'missing_segment', 'streaming parser catches a dropped segment', err?.code);
  ok(
    (err?.misplaced ?? []).length === 0,
    'a genuinely dropped segment is not reported as misplaced',
    JSON.stringify(err?.misplaced)
  );
  ok(
    /Negative prompt/.test(err?.message ?? ''),
    'the error names the segment that was dropped',
    err?.message
  );
  // server.mjs keeps `partial` and the panel keeps what streamed, so the
  // segments that did arrive must have been emitted before the throw.
  ok(
    emitted.join(',') === 'Positive prompt,Reasoning',
    'segments that did arrive were still emitted before the error',
    emitted.join(',')
  );
}

{
  // Measured on the 27B: h3 writes the audio content INSIDE Detailed
  // description under the base guide's own field names on roughly 10% of
  // base-mode runs, because that guide presents its three core fields as one
  // block. Telling the user the model "omitted" content it plainly wrote is a
  // misleading error and points them at the wrong fix.
  //
  // The contract still fails. Nothing is recovered or re-split — silently
  // repairing it would hide a real format problem behind output that looked
  // fine. Only the explanation changes.
  const H3ISH = ['Detailed description', 'Soundscape', 'Music', 'Reasoning'];
  const FIELDS = { Soundscape: 'overall_soundscape', Music: 'non_diegetic_music' };

  const stream = new SegmentStream(H3ISH, { fields: FIELDS });
  stream.push(
    '===SEGMENT: Detailed description===\n[Shot 1] 00:00-00:05 she works.\n' +
      'overall_soundscape: room tone and gears.\nnon_diegetic_music: sparse piano.\n'
  );
  stream.push('===SEGMENT: Reasoning===\nBecause.\n');

  let err = null;
  try {
    stream.end();
  } catch (e) {
    err = e;
  }

  ok(err?.code === 'missing_segment', 'misplaced content still fails the contract', err?.code);
  ok(
    (err?.misplaced ?? []).join(',') === 'Soundscape,Music',
    'both misplaced segments are reported structurally',
    JSON.stringify(err?.misplaced)
  );
  ok(
    /written inside "Detailed description"/.test(err?.message ?? ''),
    'the message says where the content actually went'
  );
  ok(!/omitted/.test(err?.message ?? ''), 'and does not claim the model omitted it', err?.message);

  // A description that merely discusses sound must not be mistaken for one
  // carrying the field. The match is anchored to a line prefix for that reason.
  const loose = new SegmentStream(H3ISH, { fields: FIELDS });
  loose.push(
    '===SEGMENT: Detailed description===\nShe listens to the overall_soundscape of the room.\n'
  );
  loose.push('===SEGMENT: Reasoning===\nBecause.\n');
  let err2 = null;
  try {
    loose.end();
  } catch (e) {
    err2 = e;
  }
  ok(
    (err2?.misplaced ?? []).length === 0,
    'a field name mentioned mid-sentence is not treated as a misplaced segment',
    JSON.stringify(err2?.misplaced)
  );
}


// ── negative prompt cleanup ──────────────────────────────────
//
// Not the parser — content cleanup on a parsed segment. Lives here because it
// is segment-shaped and this suite already runs in npm run check.

console.log('\ncleanNegative — a tag list must not repeat itself or fight the positive\n');

{
  // The real output that prompted this, on 21 Aug: an Illustrious prompt for
  // Fern whose negative repeated a ten-tag block verbatim and negated
  // mage_staff while the user had it in the positive.
  const negative =
    'worst_quality, low_quality, multiple_girls, mage_staff, robe, ' +
    'extra_eyes, floating_eyes, extra_mouth, floating_mouth, ' +
    'extra_eyes, floating_eyes, extra_mouth, floating_mouth';
  const positive = 'masterpiece, best_quality, fern_(sousou_no_frieren), purple_hair, mage_staff';
  const out = cleanNegative(negative, [positive]);

  ok(!out.text.includes('mage_staff'), 'a tag in the positive is removed from the negative');
  ok(out.text.includes('robe'), 'a tag only in the negative is kept');
  ok(
    (out.text.match(/extra_eyes/g) ?? []).length === 1,
    'a repeated tag survives exactly once',
    out.text
  );
  ok(out.removed.duplicates.length === 4, 'the duplicates are reported', String(out.removed.duplicates.length));
  ok(
    out.removed.contradictions.join(',') === 'mage_staff',
    'the contradiction is reported by name',
    out.removed.contradictions.join(',')
  );
  ok(out.text.startsWith('worst_quality, low_quality'), 'order and the defaults survive');
}

{
  // The comparison has to survive a weight on one side and a different tag
  // style on the other — Pony's positive says "purple hair", the negative may
  // say "purple_hair", and a user's pick can carry (tag:1.30).
  const out = cleanNegative('purple_hair, blurry', ['(purple hair:1.30), 1girl']);
  ok(!out.text.includes('purple'), 'weight syntax and tag style do not hide a contradiction', out.text);
  ok(out.text === 'blurry', 'and everything else is untouched', out.text);
}

{
  // Tags the user picked by hand are as binding as the positive segment —
  // house-rules says their intent wins.
  const out = cleanNegative('robe, blurry', ['', 'robe']);
  ok(out.text === 'blurry', 'a hand-picked tag is protected too', out.text);
}

{
  const clean = cleanNegative('worst_quality, blurry, watermark', ['1girl']);
  ok(clean.text === 'worst_quality, blurry, watermark', 'a clean negative is returned unchanged');
  ok(
    clean.removed.duplicates.length === 0 && clean.removed.contradictions.length === 0,
    'and reports nothing removed'
  );
  ok(cleanNegative('', ['1girl']).text === '', 'an empty negative stays empty');
  ok(cleanNegative('a,, b , ,', []).text === 'a, b', 'empty items are dropped');
}


// Tags danbooru has never heard of are NOTED AND KEPT, as of 30 Aug 2026.
//
// They used to be deleted, on the evidence that an 8B run invented ten
// floating_* body-part tags absent from all 181,714 rows. The owner's call
// reversed it: `tags.sqlite` is a snapshot of danbooru's labels, not of what
// the community checkpoint someone is actually running understands, and the
// 8B that produced that evidence is not a model anyone generates with.
//
// Deleting was also the only option that loses the intent — a dropped
// `bare_feet` left a real prompt excluding bare feet nowhere at all, with the
// live tag `barefoot` sitting one step away. The report survives because a
// model inventing vocabulary in bulk is still worth seeing in a log.
{
  const REAL = new Set(['bad_anatomy', 'extra_arms', 'extra_mouth', 'blurry', 'robe']);
  const known = (t) => REAL.has(t.replace(/ /g, '_'));
  const negative = 'bad_anatomy, extra_arms, floating_arms, extra_mouth, floating_mouth, blurry';

  const out = cleanNegative(negative, [], { known });
  ok(out.text === negative, 'unknown tags are kept, not dropped', out.text);
  ok(
    out.noted.unknown.join(', ') === 'floating_arms, floating_mouth',
    'and are still reported by name',
    out.noted.unknown.join(', ')
  );
  ok(
    out.removed.unknown === undefined,
    'and no longer appear as removals',
    JSON.stringify(out.removed)
  );

  // `protected` no longer decides what survives — nothing is dropped now — but
  // it still decides what gets REPORTED. extra_fingers and fewer_fingers are
  // genuinely absent from danbooru (SD convention, not booru vocabulary), and
  // a log line calling the owner's own config invented every single generation
  // would be noise that teaches people to ignore the line.
  const spared = cleanNegative('extra_fingers, floating_mouth', [], {
    known,
    protected: ['worst_quality, extra_fingers, fewer_fingers'],
  });
  ok(
    spared.text === 'extra_fingers, floating_mouth',
    'everything survives, config and invention alike',
    spared.text
  );
  ok(
    spared.noted.unknown.join(',') === 'floating_mouth',
    'but only the invented one is reported',
    spared.noted.unknown.join(',')
  );

  // What the user typed is as exempt from the report as config is.
  const typed = cleanNegative('my_house_tag, floating_mouth', [], {
    known,
    protected: ['', 'my_house_tag'],
  });
  ok(typed.text === 'my_house_tag, floating_mouth', 'a tag the user typed survives too', typed.text);
  ok(
    typed.noted.unknown.join(',') === 'floating_mouth',
    'and is not reported as invented',
    typed.noted.unknown.join(',')
  );

  // No tag database, or a prose model: the check must not run at all.
  const skipped = cleanNegative(negative, []);
  ok(skipped.text === negative, 'with no known() everything survives');
  ok(skipped.noted.unknown.length === 0, 'and nothing is reported unknown');
}

// ── ensureDefaults — putting back what the model forgot ──────────────────────
//
// The other half of cleanNegative. Measured case: the P40's 9B dropped
// score_6/5/4 from every Pony negative, and fixing pony.md's wording only
// moved that from 0/6 to 2/6. See server/negative.mjs.

console.log('\nensureDefaults — the registry floor, restored\n');

{
  const out = ensureDefaults('worst quality, blurry', 'score_6, score_5, score_4, worst quality', [
    'score_9, score_8_up, 1girl, solo',
  ]);
  ok(out.added.join(', ') === 'score_6, score_5, score_4', 'adds the score negatives the model omitted');
  ok((out.text.match(/worst quality/g) ?? []).length === 1, 'does not duplicate one already present');
  ok(out.text.startsWith('score_6, score_5, score_4'), 'puts the defaults first');
  ok(out.text.includes('blurry'), 'keeps what the model did write');
}

{
  // The repair must not undo cleanNegative's repair. A user who prompts FOR a
  // tag that happens to sit in negative_defaults wins.
  const out = ensureDefaults('blurry', 'robe, worst quality', ['1girl, robe']);
  ok(!out.text.includes('robe'), 'never re-adds a default the positive asked for');
  ok(out.text.includes('worst quality'), '...but still adds the others');
}

{
  const out = ensureDefaults('score_6, score_5, score_4', 'score_6, score_5, score_4', ['1girl']);
  ok(out.added.length === 0, 'adds nothing when the model got it right');
  ok(out.text === 'score_6, score_5, score_4', '...and leaves the text alone');
}

{
  // Spelling must not defeat it: the positive can carry a weight and the two
  // halves of a prompt can use different tag styles.
  const out = ensureDefaults('blurry', 'long_hair', ['(long hair:1.30), 1girl']);
  ok(out.added.length === 0, 'matches across tag style and weight syntax');
}

{
  const out = ensureDefaults('blurry', '', ['1girl']);
  ok(out.text === 'blurry' && out.added.length === 0, 'a model with no negative_defaults is left untouched');
}

{
  // A segment headed with its official field name is the segment, not an
  // unknown one: the h3 4B wrote `non_diegetic_music` for Music.
  const text = '===SEGMENT: Detailed description===\nShots.\n\n===SEGMENT: non_diegetic_music===\nN/A';
  const aliases = { non_diegetic_music: 'Music' };
  const { segments } = parseSegments(text, ['Detailed description', 'Music'], { aliases });
  ok(segments[1]?.label === 'Music' && segments[1]?.body === 'N/A', 'a field-name heading is read as its segment');
  let threw = false;
  try { parseSegments(text, ['Detailed description', 'Music']); } catch { threw = true; }
  ok(threw, 'without the alias the same text is still rejected');
}

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
