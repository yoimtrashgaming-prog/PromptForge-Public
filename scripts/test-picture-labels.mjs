// h3 REF2VA labelled mode: picture labels in, cast and bookkeeping out.
//
//   node scripts/test-picture-labels.mjs
//
// No server, no model. What this guards is the part that is code's job in
// picture labels: numbering the subjects, mapping the labels onto the roles the
// rest of the pipeline reads, Auto detect from First/Last frame, and the two
// segments written after the model has finished.

import {
  applyPictureLabels, labelledCast, labelledBrief, labelledLines, labelledSegments, keepLines, splitDescription, shotsOf, keepReferenceLook,
  describeUnits, describeMessage, twoSentences, charactersNamedIn, framedBrief,
  promptMode, LABELLED_PROMPT_MODE, poseOnly, groupLines, traitsOf,
  givenCast, keptFromLook, writtenDescription, castDescriptions, unitsToRead, castUnit, castLook, framedCastLines, CAST_TEXT_MAX,
  sceneUnit, characterCards, unnamed,
} from '../server/picture-labels.mjs';
import { usableReading } from '../server/keyframes.mjs';
import { musicOnlyWhenAsked, briefWantsMusic } from '../server/music.mjs';
import { boxesOf, whoFromBoxes, cropFor, parsePeople } from '../server/people-boxes.mjs';
import { resolveAutoMode, resolveAutoControls, formatReferences, pictureGroups } from '../server/references.mjs';

let passed = 0;
const failures = [];
function check(what, ok, detail) {
  if (ok) passed += 1;
  else failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
}
const eq = (what, got, want) => check(what, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const pic = (picture_label, extra = {}) => ({ kind: 'image', role: 'subject', picture_label, image: `img-${picture_label}-${Math.random()}`, ...extra });
const labelled = (references, mode = 'Auto detect') => applyPictureLabels({ picture_labels: true, mode, references });

// ── the labels become roles ──────────────────────────────────
{
  const c = labelled([pic('character-1'), pic('place'), pic('character-1'), pic('style'), pic('first-frame')]);
  const r = c.references;
  eq('a character is a grouped subject', [r[0].role, r[0].subject_group], ['subject', 'label-character-1']);
  eq('the place is its own group', [r[1].role, r[1].subject_group], ['subject', 'label-place']);
  eq('a style is style, ungrouped', [r[3].role, r[3].subject_group], ['style', undefined]);
  eq('a first frame is a keyframe that knows it', [r[4].role, r[4].frame], ['keyframe', 'first']);
  eq('two pictures of Character 1 are one group', pictureGroups(r), [{ pictures: [1, 3] }]);
  const audio = { kind: 'audio', role: 'voice' };
  eq('audio is left alone', labelled([audio]).references[0], audio);
  const off = { mode: 'REF2VA', references: [pic('place')] };
  check('nothing changes without picture labels', applyPictureLabels(off) === off);
  eq('an unknown label falls back to Character 1', labelled([pic('dragon')]).references[0].subject_group, 'label-character-1');
  // A tab opened before 2 Oct 2026 still sends the old names.
  const old = applyPictureLabels({ easy_mode: true, mode: 'REF2VA', references: [{ kind: 'image', role: 'subject', easy_role: 'place', image: 'x' }] });
  eq('the old easy_mode / easy_role names still work', old.references[0].subject_group, 'label-place');
}

// ── Auto detect from the labels ──────────────────────────────
{
  const at = (labels) => resolveAutoMode('Auto detect', labelled(labels.map((l) => pic(l))).references);
  eq('one First frame is I2VA', at(['first-frame']), 'I2VA');
  eq('one Last frame is L2VA', at(['last-frame']), 'L2VA');
  eq('First and Last frame is FL2VA', at(['last-frame', 'first-frame']), 'FL2VA');
  eq('two First frames is REF2VA', at(['first-frame', 'first-frame']), 'REF2VA');
  eq('a character and a first frame is REF2VA', at(['character-1', 'first-frame']), 'REF2VA');
  eq('one character alone is REF2VA: the person said it is not a frame', at(['character-1']), 'REF2VA');
  eq('two characters is REF2VA', at(['character-1', 'character-2']), 'REF2VA');
  eq('a place alone is REF2VA', at(['place']), 'REF2VA');
  eq('a style alone is REF2VA', at(['style']), 'REF2VA');

  const fl = resolveAutoControls(labelled([pic('last-frame'), pic('first-frame')]));
  eq('FL2VA keeps the frames the person named', fl.references.map((r) => r.frame), ['last', 'first']);
  const { lines } = formatReferences(fl.references, fl.mode);
  check('a named last frame says so in a base mode', lines[0].includes('the last frame'), lines[0]);
  const plain = resolveAutoControls({ mode: 'Auto detect', references: [{ kind: 'image', role: 'subject' }, { kind: 'image', role: 'keyframe' }] });
  eq('normal mode two-picture rule is unchanged', plain.mode, 'REF2VA');
  const l2 = resolveAutoControls(labelled([pic('last-frame')]));
  eq('L2VA marks its picture the last frame', [l2.mode, l2.references[0].frame], ['L2VA', 'last']);
}

// ── prompt mode ──────────────────────────────────────────────
eq('labelled REF2VA composes under its own key', promptMode({ picture_labels: true, mode: 'REF2VA' }), LABELLED_PROMPT_MODE);
eq('labels in a base mode is that base mode', promptMode({ picture_labels: true, mode: 'I2VA' }), 'I2VA');
eq('normal REF2VA is REF2VA', promptMode({ mode: 'REF2VA' }), 'REF2VA');

// ── the cast ─────────────────────────────────────────────────
const refs = labelled([pic('character-2'), pic('place'), pic('character-1', { keep: 'tired' }), pic('character-2'), pic('first-frame')], 'REF2VA').references;
const cast = labelledCast(refs);
eq('characters first by number, then the place',
  cast.subjects.map((s) => [s.tag, s.name, s.pictures]),
  [['<Subject 1>', 'Character 1', [3]], ['<Subject 2>', 'Character 2', [1, 4]], ['<Subject 3>', 'the place', [2]]]);
eq('frames are listed apart', cast.frames.map((f) => [f.picture, f.which]), [[5, 'first']]);
eq('the brief names become tags',
  labelledBrief('Character 1 pours tea for character 2 while Character 3 waits', cast),
  '<Subject 1> pours tea for <Subject 2> while Character 3 waits');
eq('the place becomes its tag',
  labelledBrief('Character 1 sits in the place. The Scenery is dark.', cast),
  '<Subject 1> sits in <Subject 3>. <Subject 3> is dark.');
eq('a bare "place" is ordinary English',
  labelledBrief('It takes place at night, in place of the party.', cast),
  'It takes place at night, in place of the party.');
eq('picture numbers become picture tags, only the ones that exist',
  labelledBrief('Character 2 in the outfit from picture 4, posed like pic 1, not image 9.', cast),
  '<Subject 2> in the outfit from <Picture 4>, posed like <Picture 1>, not image 9.');
eq('a tag already written is left alone', labelledBrief('<Picture 2> and <Subject 1>', cast), '<Picture 2> and <Subject 1>');
eq('no place picture, no place swap',
  labelledBrief('Character 1 in the place', labelledCast(labelled([pic('character-1')], 'REF2VA').references)),
  '<Subject 1> in the place');

{
  const lines = labelledLines(cast).join('\n');
  check('the cast names Character 2 and both its pictures', lines.includes('<Subject 2> is "Character 2" in the brief, a character, shown in <Picture 1> and <Picture 4>'), lines);
  check('keep traits ride on the cast line', lines.includes('keep: tired'), lines);
  check('the place line says others are part of it', lines.includes('anyone else in it is part of the place'), lines);
  check('the first frame has its line', lines.includes('<Picture 5> is the first frame'), lines);
  check('the writer is told not to describe looks', lines.includes('never describe how anyone or anything looks'), lines);
}

// ── after the model wrote ────────────────────────────────────
eq('shots split by number', [...shotsOf('Style.\n\n[Shot 1] a <Subject 1>.\n[Shot 2] b.')].map(([n]) => n), [1, 2]);

{
  const model = { segments: ['Subject definitions', 'Summary', 'Retention analysis', 'Detailed description', 'Soundscape', 'Music', 'Reasoning'] };
  const written = labelledSegments(model, cast, [
    { label: 'Subject definitions', body: '<Subject 1>: tired, slow blinks\n<Subject 2>: stiff and formal' },
    { label: 'Summary', body: 'S.' },
    { label: 'Detailed description', body: 'Style.\n\n[Shot 1] <Subject 3>, <Subject 1> sits.\n\n[Shot 2] At 00:03.000, <Subject 1> pours.\n\n[Shot 3] At 00:06.000, <Subject 1> looks up.' },
    { label: 'Soundscape', body: 'Rain.' },
    { label: 'Music', body: 'Koto.' },
  ]);
  const by = new Map(written.segments.map((s) => [s.label, s.body]));
  eq('segments come back in registry order', written.segments.map((s) => s.label),
    ['Subject definitions', 'Summary', 'Retention analysis', 'Detailed description', 'Soundscape', 'Music']);
  const defs = by.get('Subject definitions');
  check('Character 1 is defined from its label and note, acting left to the shots',
    defs.startsWith('<Subject 1> is the character in <Picture 3>. From <Picture 3>, keep: tired.') && !defs.includes('slow blinks'), defs);
  check('a character with nothing typed keeps everything', defs.includes('<Subject 2> is the character in <Picture 1> and <Picture 4>; keep their appearance exactly as the pictures show.'), defs);
  check('Character 2 cites both its pictures', defs.includes('<Subject 2> is the character in <Picture 1> and <Picture 4>;'), defs);
  check('the place is defined', defs.includes('<Subject 3> is the place in <Picture 2>, where the video happens; keep it as the picture shows.'), defs);
  check('the first frame is defined', defs.includes('<Picture 5> is the first frame of [Shot 1].'), defs);
  const ret = by.get('Retention analysis');
  check('Character 1 spans the shots that cite it', ret.includes('<Subject 1> (appears in [Shot 1]-[Shot 3]):'), ret);
  // 5 Oct 2026: typed keep traits were left out of retention, so H3 never saw them.
  check('typed keep traits reach retention as partially_preserved', ret.includes('<Subject 1> (appears in [Shot 1]-[Shot 3]): partially_preserved — from <Picture 3>, keep: tired.'), ret);
  check('nothing typed stays fully_preserved', ret.includes('<Subject 2> (appears in [Shot 1]-[Shot 3]): fully_preserved'), ret);
  check('the place spans every shot', ret.includes('<Subject 3> (appears in [Shot 1]-[Shot 3])'), ret);
  check('the frame names its shot', ret.includes('<Picture 5> ([Shot 1] first frame)'), ret);
  eq('Character 2 never in a shot is warned about', written.warnings.length, 1);
  check('the warning names Character 2', written.warnings[0]?.includes('Character 2'), written.warnings[0]);
}

{
  // The model wrote no acting line: the definition still stands.
  const model = { segments: ['Subject definitions', 'Retention analysis', 'Detailed description'] };
  const out = labelledSegments(model, labelledCast(labelled([pic('character-1')], 'REF2VA').references), [
    { label: 'Detailed description', body: 'No shots here.' },
  ]);
  eq('no acting line leaves the label sentence',
    out.segments[0].body, '<Subject 1> is the character in <Picture 1>; keep their appearance exactly as the pictures show.');
  check('no shots means every shot', out.segments[1].body.includes('(appears in every shot)'), out.segments[1].body);
}

// ── typed keep / drop (5 Oct 2026) ───────────────────────────
{
  // The reported case: a first frame, and a side-profile picture of the
  // character that is only there for the haircut.
  const model = { segments: ['Subject definitions', 'Retention analysis', 'Detailed description'] };
  const cast = labelledCast(labelled([pic('first-frame'), pic('character-1', { keep: 'Her side profile for her haircut, a braided bun' })], 'REF2VA').references);
  const out = labelledSegments(model, cast, [{ label: 'Detailed description', body: '[Shot 1] <Subject 1> turns.\n\n[Shot 2] At 00:03.000, <Subject 1> walks.' }]);
  const [defs, ret] = [out.segments[0].body, out.segments[1].body];
  check('the typed keep is in Subject definitions', defs.includes('<Subject 1> is the character in <Picture 2>. From <Picture 2>, keep: Her side profile for her haircut, a braided bun.'), defs);
  check('...and in Retention analysis', ret.includes('<Subject 1> (appears in [Shot 1]-[Shot 2]): partially_preserved — from <Picture 2>, keep: Her side profile for her haircut, a braided bun.'), ret);
  check('the untouched first frame is unchanged', ret.includes('<Picture 1> ([Shot 1] first frame): fully_preserved'), ret);

  const both = labelledCast(labelled([pic('character-1', { keep: 'the red scarf.', drop: 'the hat' }), pic('character-1')], 'REF2VA').references);
  const r2 = labelledSegments(model, both, []).segments[1].body;
  check('keep and drop both go, trailing full stop trimmed', r2.includes('partially_preserved — from <Picture 1>, keep: the red scarf; from <Picture 1>, leave out: the hat.'), r2);

  const frame = labelledCast(labelled([pic('first-frame', { keep: 'the lighting' }), pic('character-1')], 'REF2VA').references);
  const r3 = labelledSegments(model, frame, []);
  check('a frame with a typed keep is partially_preserved', r3.segments[1].body.includes('<Picture 1> ([Shot 1] first frame): partially_preserved — from <Picture 1>, keep: the lighting.'), r3.segments[1].body);

  // A group picture before the character's own: each note names the picture it was typed on.
  const grouped = labelledCast(labelled([pic('group-12', { keep: 'standing close' }), pic('character-1', { keep: 'the braid' })], 'REF2VA').references);
  const r4 = labelledSegments(model, grouped, []).segments[1].body;
  check('notes keep their own picture numbers', r4.includes('from <Picture 2>, keep: the braid') && r4.includes('from <Picture 1>, keep: standing close'), r4);
}

// ── the writer's reading of typed notes (5 Oct 2026) ─────────
{
  // The reported case: notes typed as instructions, pasted as typed read
  // "keep: Keep the character, background and first frame".
  const model = { segments: ['Subject definitions', 'Retention analysis', 'Detailed description'] };
  const cast = labelledCast(labelled([
    pic('first-frame', { keep: 'Keep the character, background and first frame.' }),
    pic('character-1', { keep: 'Reference for her haircut' }),
  ], 'REF2VA').references);
  const lines = labelledLines(cast).join('\n');
  check('a frame\'s note reaches the writer', lines.includes('<Picture 1> is the first frame: [Shot 1] opens on it exactly · keep: Keep the character, background and first frame'), lines);

  eq('keep lines by tag', [...keepLines('<Subject 1>: shy.\nKeep <Subject 1>: the haircut from <Picture 2>.\n- keep <Picture 1> — the opening composition and the background\nKeep <Subject 2>:\nnoise')],
    [['<Subject 1>', 'the haircut from <Picture 2>'], ['<Picture 1>', 'the opening composition and the background']]);

  const written = labelledSegments(model, cast, [
    { label: 'Subject definitions', body: '<Subject 1>: shy and clumsy.\nKeep <Subject 1>: the haircut from <Picture 2>, her face and outfit from <Picture 1>\nKeep <Picture 1>: the opening composition, the character and the background' },
    { label: 'Detailed description', body: '[Shot 1] <Subject 1> dances.' },
  ]);
  const [defs, ret] = [written.segments[0].body, written.segments[1].body];
  check('the writer\'s reading replaces the typed note in definitions',
    defs.includes('<Subject 1> is the character in <Picture 2>. The haircut from <Picture 2>, her face and outfit from <Picture 1>.') && !defs.includes('shy and clumsy'), defs);
  check('...and in retention', ret.includes('<Subject 1> (appears in [Shot 1]): partially_preserved — the haircut from <Picture 2>, her face and outfit from <Picture 1>.'), ret);
  check('a frame takes its reading too', ret.includes('<Picture 1> ([Shot 1] first frame): partially_preserved — the opening composition, the character and the background.'), ret);
  check('no raw instruction left', !/keep: (Keep|Reference)/.test(defs + ret), defs + ret);

  const none = labelledSegments(model, cast, [{ label: 'Subject definitions', body: '<Subject 1>: shy.' }]);
  check('no keep line falls back to the typed note', none.segments[1].body.includes('partially_preserved — from <Picture 2>, keep: Reference for her haircut.'), none.segments[1].body);

  const plain = labelledCast(labelled([pic('character-1')], 'REF2VA').references);
  const invented = labelledSegments(model, plain, [{ label: 'Subject definitions', body: 'Keep <Subject 1>: only the hat from <Picture 1>' }]);
  check('a keep line where nothing was typed is ignored', invented.segments[1].body.includes('fully_preserved') && !invented.segments[1].body.includes('hat'), invented.segments[1].body);
}

// ── descriptions in retention (5 Oct 2026, the Forge's structure) ──
{
  const model = { segments: ['Subject definitions', 'Retention analysis', 'Detailed description'] };
  const withImg = (label, extra = {}) => pic(label, { image: `data:image/png;base64,${label}`, ...extra });
  const cast = labelledCast(labelled([withImg('first-frame'), withImg('character-1', { keep: 'Reference for her haircut' }), withImg('place'), withImg('character-1')], 'REF2VA').references);
  const units = describeUnits(cast);
  eq('one unit per subject and per frame, a character\'s pictures together',
    units.map((u) => [u.tag, u.kind, u.labels]),
    [['<Subject 1>', 'character', ['<Picture 2>', '<Picture 4>']], ['<Subject 2>', 'place', ['<Picture 3>']], ['<Picture 1>', 'frame', ['<Picture 1>']]]);
  check('units carry their kind in the role, apart from full readings', units.every((u) => u.role.startsWith('describe-')));
  const msg = describeMessage(units[0]);
  check('the reader is told what it is, what to keep, and the length', msg.includes('a character') && msg.includes('From the first picture, take only: Reference for her haircut.') && msg.includes('One or two sentences.'), msg);
  eq('no image, no unit', describeUnits(labelledCast(labelled([pic('character-1', { image: undefined })], 'REF2VA').references)), []);

  eq('two sentences kept', twoSentences('Brown hair in a braided bun. Green cardigan over a white blouse. Holding a cup.'), 'Brown hair in a braided bun. Green cardigan over a white blouse.');
  eq('a missing full stop is added', twoSentences('A snowy square'), 'A snowy square.');
  // The Q4_K_P reading of 12 Oct 2026, word for word.
  eq('a "Final Answer:" repeat is said once',
    twoSentences('A young woman with shoulder-length auburn hair and amber eyes, wearing a dark top with silver metallic shoulder armor. Final Answer: A young woman with shoulder-length auburn hair and amber eyes, wearing a dark top with silver metallic shoulder armor.'),
    'A young woman with shoulder-length auburn hair and amber eyes, wearing a dark top with silver metallic shoulder armor.');
  eq('...and the label alone goes too', twoSentences('Final answer: Short blue hair. Yellow eyes.'), 'Short blue hair. Yellow eyes.');
  eq('nothing stays nothing', twoSentences(''), '');

  // The official guide's shape (6 Oct 2026): the look in the definition, the
  // reader's Kept list in Retention.
  const descriptions = new Map([
    ['<Subject 1>', 'A young woman with brown hair in a braided bun. She wears a green cardigan over a white blouse. She carries a cup.\nKept: her braided brown bun, green cardigan and white blouse'],
    ['<Picture 1>', 'A girl in a winter coat holds pom-poms in a snowy medieval square.\nKept: the girl centred in the square, her winter coat and the snow'],
    ['<Subject 2>', 'A snowy medieval square at dusk.'],
  ]);
  const written = labelledSegments(model, cast, [{ label: 'Detailed description', body: '[Shot 1] <Subject 1> dances in <Subject 2>.' }], descriptions);
  const [defs, ret] = [written.segments[0].body, written.segments[1].body];
  check('the look is in the definition, at most two sentences, then the note',
    defs.includes('<Subject 1> is the character in <Picture 2> and <Picture 4>. A young woman with brown hair in a braided bun. She wears a green cardigan over a white blouse. From <Picture 2>, keep: Reference for her haircut.') && !defs.includes('carries a cup') && !defs.includes('Kept:'), defs);
  check('a frame is described in its definition', defs.includes('<Picture 1> is the first frame of [Shot 1]. A girl in a winter coat'), defs);
  check('the frame\'s Kept list is its retention', ret.includes('<Picture 1> ([Shot 1] first frame): fully_preserved — the girl centred in the square, her winter coat and the snow are retained.'), ret);
  check('a typed note still wins retention', ret.includes('<Subject 1> (appears in [Shot 1]): partially_preserved — from <Picture 2>, keep: Reference for her haircut.'), ret);
  check('no Kept line, stock wording', ret.includes('<Subject 2> (appears in [Shot 1]): fully_preserved — its layout, landmarks, light and time of day are retained.'), ret);
  check('retention no longer repeats the look', !ret.includes('As the pictures show'), ret);
  eq('the Kept line is split off', splitDescription('A red door.\n**Kept:** the red door, brass knocker.'), { look: 'A red door.', kept: 'the red door, brass knocker' });
  // The writer is handed what the reader saw (6 Oct 2026).
  const handed = labelledLines(cast, descriptions).join('\n');
  check('the writer gets each look, without the Kept list',
    handed.includes('looks: A young woman with brown hair in a braided bun. She wears a green cardigan over a white blouse.')
    && handed.includes('<Picture 1> is the first frame: [Shot 1] opens on it exactly · looks: A girl in a winter coat') && !handed.includes('Kept:'), handed);
  check('...and is told to use it, not to avoid looks', handed.includes('"looks:" is what was seen') && !handed.includes('never describe how'), handed);
  check('no readings, the old rule stands', labelledLines(cast).join('\n').includes('never describe how anyone or anything looks'));
  eq('no Kept line, no list', splitDescription('A red door. A brass knocker. A step.'), { look: 'A red door. A brass knocker.', kept: '' });
}

// ── a frame's note names who is in it (5 Oct 2026) ───────────
{
  eq('character numbers in a note', [
    charactersNamedIn('Keep character 1, the background and first frame.'),
    charactersNamedIn('Char 2 waving'),
    charactersNamedIn('characters 1 and 3 by the door'),
    charactersNamedIn('Character #4'),
    charactersNamedIn('keep the character and the background'),
    // Past four since 12 Oct 2026, to a cap of 70: seventy-one is nobody.
    charactersNamedIn('character 5'),
    charactersNamedIn('character 71'),
    charactersNamedIn(null),
  ], [[1], [2], [1, 3], [4], [], [5], [], []]);

  const model = { segments: ['Subject definitions', 'Retention analysis', 'Detailed description'] };
  const cast = labelledCast(labelled([
    pic('first-frame', { keep: 'Keep character 1, the background and first frame.' }),
    pic('character-1', { keep: 'Reference for her haircut' }),
  ], 'REF2VA').references);
  eq('the frame puts Character 1 in it', cast.subjects[0].inFrames, [{ picture: 1, which: 'first' }]);
  const lines = labelledLines(cast).join('\n');
  check('the writer\'s cast line says so', lines.includes('<Subject 1> is "Character 1" in the brief, a character, shown in <Picture 2>, and in the first frame <Picture 1>'), lines);
  const out = labelledSegments(model, cast, [{ label: 'Detailed description', body: '[Shot 1] <Subject 1> dances.' }]);
  const [defs, ret] = [out.segments[0].body, out.segments[1].body];
  check('the definition says it', defs.startsWith('<Subject 1> is the character in <Picture 2>, and in the first frame <Picture 1>.'), defs);
  check('retention keeps one line for her', ret.split('\n').filter((l) => l.startsWith('<Subject 1>')).length === 1, ret);

  const onlyFramed = labelledCast(labelled([pic('last-frame', { keep: 'character 2 waving goodbye' }), pic('character-1')], 'REF2VA').references);
  eq('a character named only in a frame is still a subject', onlyFramed.subjects.map((s) => [s.tag, s.name, s.pictures, s.inFrames]),
    [['<Subject 1>', 'Character 1', [2], []], ['<Subject 2>', 'Character 2', [], [{ picture: 1, which: 'last' }]]]);
  const plain = labelledCast(labelled([pic('first-frame', { keep: 'keep the lighting' }), pic('character-1')], 'REF2VA').references);
  eq('a frame naming nobody links nobody', plain.subjects[0].inFrames, []);

  // Her description is read from the frame too, or a haircut-only picture
  // describes the hair and never the outfit she wears in the video.
  const units = describeUnits(cast);
  const her = units.find((u) => u.tag === '<Subject 1>');
  eq('a framed character is read from the frame first, then her own picture', [her.labels, her.frames, her.role], [['<Picture 1>', '<Picture 2>'], 1, 'describe-character-framed']);
  const msg = describeMessage(her);
  check('the reader is told the frame is how she looks, the reference is for the hair',
    msg.includes('The first picture is a frame of the video') && msg.includes('reference for: Reference for her haircut') && msg.includes('Describe the whole character'), msg);
  check('the frame\'s own note is not passed as her keep', !msg.includes('Keep character 1'), msg);
  check('the frame is still described on its own too', units.some((u) => u.tag === '<Picture 1>' && u.kind === 'frame'));
}

// ── "Who's in it" buttons (6 Oct 2026) ───────────────────────
{
  const any = labelledCast(labelled([pic('group-14'), pic('group-321')], 'REF2VA').references);
  const by = Object.fromEntries(any.subjects.map((s) => [s.name, s.placements]));
  eq('any left-to-right order is accepted, not only the listed seven', [by['Character 1'], by['Character 3']],
    [[{ picture: 1, position: 'left' }, { picture: 2, position: 'right' }], [{ picture: 2, position: 'left' }]]);
  const four = labelledCast(labelled([pic('group-4321')], 'REF2VA').references);
  eq('four in a row have four places', four.subjects.map((s) => s.placements[0].position), ['far right', 'middle right', 'middle left', 'far left']);
  eq('a repeated number is not a group', labelled([pic('group-11')], 'REF2VA').references[0].subject_group, 'label-character-1');

  const framed = labelledCast(labelled([pic('first-frame', { who: [1, 2] }), pic('character-1')], 'REF2VA').references);
  eq('a frame\'s buttons put those characters in it', framed.subjects.map((s) => [s.name, s.inFrames]),
    [['Character 1', [{ picture: 1, which: 'first', position: 'left' }]], ['Character 2', [{ picture: 1, which: 'first', position: 'right' }]]]);
  const both = labelledCast(labelled([pic('last-frame', { who: [1], keep: 'character 1 waving' }), pic('character-1')], 'REF2VA').references);
  eq('buttons and an old note naming the same character link it once', both.subjects[0].inFrames, [{ picture: 1, which: 'last' }]);

  // Two in a frame: tap order is left to right, as on a character picture.
  const pair = labelledCast(labelled([
    pic('first-frame', { who: [2, 1], image: 'data:f' }),
    pic('character-1', { image: 'data:a' }),
    pic('character-2', { image: 'data:b' }),
  ], 'REF2VA').references);
  eq('each knows where it stands in the frame', pair.subjects.map((s) => s.inFrames[0].position), ['right', 'left']);
  const pairLines = labelledLines(pair).join('\n');
  check('the cast line says left and right', pairLines.includes('<Subject 1> is "Character 1" in the brief, a character, shown in <Picture 2>, and on the right in the first frame <Picture 1>')
    && pairLines.includes('<Subject 2> is "Character 2" in the brief, a character, shown in <Picture 3>, and on the left in the first frame <Picture 1>'), pairLines);
  const pairDefs = labelledSegments({ segments: ['Subject definitions', 'Detailed description'] }, pair, [{ label: 'Detailed description', body: '[Shot 1] <Subject 1> and <Subject 2>.' }]).segments[0].body;
  check('the definition says which side', pairDefs.includes('<Subject 2> is the character in <Picture 3>, and on the left in the first frame <Picture 1>'), pairDefs);
  const pairUnits = describeUnits(pair);
  const m2 = describeMessage(pairUnits.find((u) => u.tag === '<Subject 2>'));
  check('the describer is told which person in the frame', m2.includes('the character on the left in it is the one to describe') && m2.includes('Describe ONLY that one person'), m2);

  // Top to bottom, when picked: the same taps, read downwards.
  const stacked = labelledCast(labelled([pic('group-12', { who_axis: 'y' }), pic('first-frame', { who: [2, 1, 3], who_axis: 'y' })], 'REF2VA').references);
  eq('a stacked picture says top and bottom', stacked.subjects.map((s) => s.placements[0]?.position ?? null), ['top', 'bottom', null]);
  eq('...and so does a stacked frame', stacked.subjects.map((s) => s.inFrames[0].position), ['middle', 'top', 'bottom']);
  const stackedLines = labelledLines(stacked).join('\n');
  check('the wording reads at the top / at the bottom / in the middle',
    stackedLines.includes('shown at the top in <Picture 1> and in the middle in the first frame <Picture 2>')
    && stackedLines.includes('shown at the bottom in <Picture 1> and at the top in the first frame <Picture 2>'), stackedLines);
  eq('an old group label still means left to right', labelledCast(labelled([pic('group-12')], 'REF2VA').references).subjects[0].placements[0].position, 'left');

  // The brief is read with the picture (7 Oct 2026).
  const bu = describeUnits(labelledCast(labelled([pic('character-1', { image: 'a' }), pic('character-2', { image: 'b' })], 'REF2VA').references));
  const bm = describeMessage(bu.find((u) => u.tag === '<Subject 2>'), 'Character 2 has orange hair and blue eyes.');
  check('the describer gets the brief and who this is in it', bm.includes('orange hair and blue eyes') && bm.includes('where this is "Character 2"') && bm.includes('leave the changed traits out of Kept'), bm);
  check('...and no brief, no brief lines', !describeMessage(bu[0]).includes('brief'), describeMessage(bu[0]));

  // From the buttons, the order is optional (7 Oct 2026): no order, no positions.
  const tapped12 = (extra = {}) => pic('group-12', { picture_kinds: ['character'], who: [1, 2], image: 'b', ...extra });
  const loose = labelledCast(labelled([tapped12()], 'REF2VA').references);
  eq('no order picked, nobody is placed', loose.subjects.map((s) => s.placements[0].position ?? null), [null, null]);
  const looseLines = labelledLines(loose).join('\n');
  check('...and the lines just say who is in it', looseLines.includes('a character, shown in <Picture 1>') && !/left|right|undefined/.test(looseLines), looseLines);
  // ...but the picture is read once as a group (12 Oct 2026, a user: "doesn't
  // even look like it saw the image"): nobody alone, everyone together.
  const lu = describeUnits(loose);
  eq('...and the describer does not guess which one: one reading of everyone', lu.map((u) => [u.tag, u.kind, u.people]), [['<Picture 1> people', 'group', 2]]);
  const gmsg = describeMessage(lu[0], 'Character 1 and Character 2 kiss.');
  check('...asked for a numbered line each, left to right, saying who they are', gmsg.includes('It shows 2 characters. Describe each of them in turn, left to right, one line each') && gmsg.includes('"1:" for the one furthest left') && gmsg.includes('starts with who they are') && !gmsg.includes('This shows'), gmsg);
  check('...with room for both', lu[0].maxTokens > 240, String(lu[0].maxTokens));
  // A reading as the reader writes it, numbered: each character gets their own
  // line, the k-th tapped the k-th from the left ("it repeated the same thing
  // twice", a user, 12 Oct 2026).
  const groupRead = new Map([['<Picture 1> people', '1: A young woman with wavy teal hair and purple eyes wears a white and gold jacket.\n2: A young man with short dark brown hair and blue eyes wears a dark blue coat.\nKept: her teal hair and white jacket, his dark hair and blue coat']]);
  const gOut = labelledSegments({ segments: ['Subject definitions', 'Retention analysis', 'Detailed description'] }, loose,
    [{ label: 'Detailed description', body: '[Shot 1] <Subject 1> and <Subject 2> kiss.' }], groupRead);
  const gDefs = gOut.segments.find((s) => s.label === 'Subject definitions').body;
  check('each character gets their own line, by place',
    gDefs.includes('<Subject 1> is the character on the left in <Picture 1>. A young woman with wavy teal hair and purple eyes wears a white and gold jacket.')
    && gDefs.includes('<Subject 2> is the character on the right in <Picture 1>. A young man with short dark brown hair and blue eyes wears a dark blue coat.'), gDefs);
  check('...and nobody\'s line is said twice', gDefs.split('teal hair').length === 2 && gDefs.split('blue coat').length === 2, gDefs);
  check('...not the blind "keep their appearance" line', !gDefs.includes('keep their appearance exactly'), gDefs);
  // Retention names each one's own traits, the guide's shape (a user, 12 Oct 2026).
  const gRet = gOut.segments.find((s) => s.label === 'Retention analysis').body;
  check('Retention lists each character\'s own traits',
    gRet.includes('<Subject 1> (appears in [Shot 1]): fully_preserved — wavy teal hair and purple eyes, a white and gold jacket are retained.')
    && gRet.includes('<Subject 2> (appears in [Shot 1]): fully_preserved — short dark brown hair and blue eyes, a dark blue coat are retained.'), gRet);
  // r4's lines on the user's picture, word for word.
  eq('traits from a reader\'s line', traitsOf('A young man with short dark hair and brown eyes wears a white collared shirt, a blue tie, and dark trousers.'),
    'short dark hair and brown eyes, a white collared shirt, a blue tie and dark trousers');
  eq('...and a woman\'s', traitsOf('A woman with long purple hair tied in a high ponytail and blue eyes wears a white collared shirt, a blue tie, a blue skirt, and black stockings.'),
    'long purple hair tied in a high ponytail and blue eyes, a white collared shirt, a blue tie, a blue skirt and black stockings');
  // A shot that says "their faces" and names nobody is both of them.
  const two = labelledSegments({ segments: ['Retention analysis', 'Detailed description'] }, loose,
    [{ label: 'Detailed description', body: '[Shot 1] <Subject 1> and <Subject 2> lean in. [Shot 2] At 00:04.000, a close-up of their faces as they kiss.' }], groupRead)
    .segments.find((s) => s.label === 'Retention analysis').body;
  check('...and a shot naming nobody counts for both', two.includes('<Subject 1> (appears in [Shot 1]-[Shot 2])') && two.includes('<Subject 2> (appears in [Shot 1]-[Shot 2])'), two);
  check('...the writer gets each their own', labelledLines(loose, groupRead).join('\n').includes('the one on the right in <Picture 1> · looks: A young man with short dark brown hair'), labelledLines(loose, groupRead).join('\n'));
  // A reader that did not number its lines: the reading once, never twice.
  const loose2 = new Map([['<Picture 1> people', 'A woman with teal hair stands beside a man in a blue coat.']]);
  const lDefs = labelledSegments({ segments: ['Subject definitions'] }, loose, [], loose2).segments.find((s) => s.label === 'Subject definitions').body;
  check('unnumbered, it is said once for both', lDefs.split('teal hair').length === 2
    && lDefs.includes('<Subject 1> and <Subject 2> are the characters in <Picture 1>.') && lDefs.includes('<Subject 2> is one of the characters in <Picture 1>, described with <Subject 1>.'), lDefs);
  eq('numbered lines are found however they are marked', groupLines('**1:** A woman.\nCharacter 2 - A man.\n3) A child.', 3), ['A woman.', 'A man.', 'A child.']);
  eq('...and a missing one means not split', groupLines('1: A woman.', 2), null);
  eq('left to right when picked', labelledCast(labelled([tapped12({ who_axis: 'x' })], 'REF2VA').references).subjects.map((s) => s.placements[0].position), ['left', 'right']);

  // A few words per character (12 Oct 2026): a four-girl band picture read by
  // position gave the far-left bassist the guitarist's red hair.
  const band = (extra = {}) => labelledCast(labelled([pic('group-1234', {
    picture_kinds: ['character'], who: [1, 2, 3, 4], image: 'band',
    who_hints: { 1: 'blue hair, bass', 2: 'red hair, guitar', 3: 'blonde hair, drums', 4: '  pink "tracksuit"  ' },
    ...extra,
  })], 'REF2VA').references);
  const hinted = band();
  eq('a hint places a character with no order picked', hinted.subjects.map((s) => s.placements[0].hint),
    ['blue hair, bass', 'red hair, guitar', 'blonde hair, drums', 'pink tracksuit']);
  const hu = describeUnits(hinted);
  eq('...so each one is read', hu.map((u) => u.tag), ['<Subject 1>', '<Subject 2>', '<Subject 3>', '<Subject 4>']);
  const hm = describeMessage(hu[1]);
  check('...told to find them by the hint, and not the others', hm.includes('Describe ONLY the one the person describes as "red hair, guitar"')
    && hm.includes('not the one the person describes as "blue hair, bass"') && !hm.includes('middle left'), hm);
  check('...each read on its own, not from another\'s cache entry', new Set(hu.map((u) => u.role)).size === 4, hu.map((u) => u.role).join(' | '));
  check('the hint is in the Subject definitions line', labelledLines(hinted).join('\n').includes('in <Picture 1> (red hair, guitar)'), labelledLines(hinted).join('\n'));
  check('the hint wins over a position picked as well', describeMessage(describeUnits(band({ who_axis: 'y' }))[0]).includes('describes as "blue hair, bass"'));
  eq('a blank hint is no hint', band({ who_hints: { 1: '  ', 2: 'red hair' } }).subjects.map((s) => s.placements[0].hint ?? null), [null, 'red hair', null, null]);

  // Pose (12 Oct 2026): a subject that lends only a stance, as MiniMax's guide
  // lists "poses" under <Subject N>, transferred onto whoever takes it.
  {
    const poseRefs = labelled([
      pic('character-1', { picture_kinds: ['character'], who: [1], image: 'her' }),
      pic('place', { picture_kinds: ['place'], image: 'room' }),
      pic('pose', { picture_kinds: ['pose', 'character'], who: [1], image: 'stance', keep: 'the raised fist' }),
    ], 'REF2VA').references;
    eq('a pose stands alone and is role pose', [poseRefs[2].picture_kinds, poseRefs[2].role, poseRefs[2].subject_group], [['pose'], 'pose', undefined]);
    eq('Auto detect sends a pose to REF2VA', resolveAutoMode('Auto detect', labelled([pic('pose', { picture_kinds: ['pose'], image: 'p' })]).references), 'REF2VA');
    const pc = labelledCast(poseRefs);
    eq('the pose is its own subject, after the place', pc.subjects.map((s) => `${s.tag}:${s.kind}`), ['<Subject 1>:character', '<Subject 2>:place', '<Subject 3>:pose']);
    eq('...nobody in the pose picture becomes a character', pc.subjects.filter((s) => s.kind === 'character').length, 1);
    eq('"the pose" in the brief is its subject', labelledBrief('Character 1 strikes the pose in the place.', pc), '<Subject 1> strikes <Subject 3> in <Subject 2>.');
    const poseLine = labelledLines(pc).find((l) => l.includes('<Subject 3>'));
    check('the writer is told it is only a stance, and who takes it', /a pose, from <Picture 3>: only the stance/.test(poseLine) && poseLine.includes('<Subject 1> takes this pose'), poseLine);
    const pu = describeUnits(pc).find((u) => u.tag === '<Subject 3>');
    const pmsg = describeMessage(pu, 'Character 1 strikes the pose.');
    check('the reader is asked for the pose only', pmsg.includes('This shows a pose.') && pmsg.includes('Describe only the pose')
      && pmsg.includes('Never their hair, eyes, face, skin, body, clothes, colours or the background') && !pmsg.includes('posing together'), pmsg);
    // The code filter behind the instruction (12 Oct 2026), on r4's real readings.
    eq('a pose reading loses the looks clause, keeps the stance',
      poseOnly('The one on the left stands with her back to the viewer, arms crossed tightly over her chest, while the one on the right stands facing away from her, his body turned slightly to the side. They are positioned back to back, with the woman\'s long lavender braid hanging down her back and the man\'s silver hair styled in a short cut.'),
      'The one on the left stands with her back to the viewer, arms crossed tightly over her chest, while the one on the right stands facing away from her, his body turned slightly to the side. They are positioned back to back.');
    eq('...a trailing "while her long hair" goes, the facing stays',
      poseOnly('The one on the left stands with her arms crossed over her chest, facing slightly toward the viewer while her long hair flows down her back.'),
      'The one on the left stands with her arms crossed over her chest, facing slightly toward the viewer.');
    eq('...and a sentence that is all looks goes whole, its "with" clause with it',
      poseOnly('Two figures stand back to back in a dark space, facing away from each other. The figure on the left has long lavender hair in a thick braid and stands with arms crossed over the chest, while the figure on the right has short silver hair and stands with one arm relaxed at their side.'),
      'Two figures stand back to back in a dark space, facing away from each other.');
    eq('..."eyes closed" is a pose, "blue eyes" is not',
      poseOnly('The one on the right stands beside her, turned to the side with his head tilted down and eyes closed. She looks up with wide blue eyes.'),
      'The one on the right stands beside her, turned to the side with his head tilted down and eyes closed. She looks up.');
    eq('...a clean reading is untouched', poseOnly('The one on the right stands back to back, turned away from the camera with his head angled down.'),
      'The one on the right stands back to back, turned away from the camera with his head angled down.');
    const leaky = new Map([['<Subject 3>', 'Feet apart while her red hair whips sideways, right fist raised.\nKept: wide stance, red hair, raised right fist']]);
    const leakOut = labelledSegments({ segments: ['Subject definitions', 'Retention analysis', 'Detailed description'] }, pc,
      [{ label: 'Detailed description', body: '[Shot 1] <Subject 1> raises her fist.' }], leaky);
    const leakText = leakOut.segments.map((s) => s.body).join('\n');
    check('...in the Subject definitions and Retention, not just the helper', !/red hair/.test(leakText) && leakText.includes('wide stance, raised right fist applied to <Subject 1>'), leakText);
    check('...and in the writer\'s cast line', !labelledLines(pc, leaky).join('\n').includes('red hair'), labelledLines(pc, leaky).join('\n'));
    const pair = labelledCast(labelled([pic('pose', { picture_kinds: ['pose'], who: [1, 2], image: 'pair' })], 'REF2VA').references);
    const pairMsg = describeMessage(describeUnits(pair)[0]);
    check('two who take it: each one by place, never by looks', pairMsg.includes('It shows 2 people posing together') && pairMsg.includes('"the one on the left"'), pairMsg);
    const desc = new Map([['<Subject 3>', 'Feet apart, right fist raised above the head, facing the camera.\nKept: the raised right fist and wide stance']]);
    const out = labelledSegments({ segments: ['Subject definitions', 'Summary', 'Retention analysis', 'Detailed description'] }, pc,
      [{ label: 'Detailed description', body: '[Shot 1] <Subject 1> raises her fist in <Subject 2>.' }], desc);
    const defs = out.segments.find((s) => s.label === 'Subject definitions').body;
    const ret = out.segments.find((s) => s.label === 'Retention analysis').body;
    check('its definition says what it lends, to whom, and what it does not',
      defs.includes('<Subject 3> is the pose in <Picture 3>: only its stance, limb positions and gesture, taken by <Subject 1>, not the identity, clothing or background of <Picture 3>. Feet apart'), defs);
    check('...and Retention transfers it, where the taker appears',
      ret.includes('<Subject 3> (appears in [Shot 1]): transferred — the raised right fist and wide stance applied to <Subject 1>'), ret);
    const untaken = labelledCast(labelled([pic('pose', { picture_kinds: ['pose'], image: 'p' })], 'REF2VA').references);
    check('a pose nobody was tapped for leaves it to the brief', labelledLines(untaken).some((l) => l.includes('Whoever the brief says takes this pose')), labelledLines(untaken).join('\n'));
  }

  // Up to seventy characters (12 Oct 2026, the owner's final cap).
  const many = labelledCast(labelled([pic('character-1', { picture_kinds: ['character'], who: [1, 7, 10, 11, 69, 70, 71], image: 'big' })], 'REF2VA').references);
  eq('characters up to seventy, none past it', many.subjects.filter((s) => s.kind === 'character').map((s) => s.name),
    ['Character 1', 'Character 7', 'Character 10', 'Character 11', 'Character 69', 'Character 70']);
  eq('a frame note can name character 10 and 45', charactersNamedIn('Keep character 10, char 7 and character 45'), [7, 10, 45]);
  eq('"Character 23" in a brief is its subject', labelledBrief('Character 23 waves.', labelledCast(labelled([pic('character-1', { picture_kinds: ['character'], who: [23], image: 'x' })], 'REF2VA').references)), '<Subject 1> waves.');

  // Front to back: a piggyback, him in front and her behind.
  const piggy = labelledCast(labelled([pic('group-21', { who_axis: 'z' }), pic('first-frame', { who: [2, 1], who_axis: 'z' })], 'REF2VA').references);
  const piggyLines = labelledLines(piggy).join('\n');
  check('front to back reads in front / behind',
    piggyLines.includes('<Subject 1> is "Character 1" in the brief, a character, shown behind in <Picture 1> and behind in the first frame <Picture 2>')
    && piggyLines.includes('<Subject 2> is "Character 2" in the brief, a character, shown in front in <Picture 1> and in front in the first frame <Picture 2>'), piggyLines);
  const pm = describeMessage(describeUnits(labelledCast(labelled([pic('character-1', { image: 'a' }), pic('group-21', { who_axis: 'z', image: 'g' })], 'REF2VA').references)).find((u) => u.tag === '<Subject 1>'));
  check('the describer is told the one behind', pm.includes('Describe ONLY the one behind, further from the camera than the other, not the one in front, nearest the camera.'), pm);
  eq('three deep has a middle row', labelledCast(labelled([pic('group-123', { who_axis: 'z' })], 'REF2VA').references).subjects.map((s) => s.placements[0].position), ['front', 'middle row', 'back']);

  // Two people in one picture must not share a cache entry (the piggyback
  // test gave both the girl's description, 6 Oct 2026).
  const pg = describeUnits(labelledCast(labelled([pic('group-21', { who_axis: 'z', image: 'p' })], 'REF2VA').references));
  check('two people in one picture are two different reads', pg.length === 2 && pg[0].role !== pg[1].role, JSON.stringify(pg.map((u) => u.role)));
  const tf = describeUnits(labelledCast(labelled([pic('first-frame', { who: [1, 2], who_axis: 'z', image: 'f' })], 'REF2VA').references)).filter((u) => u.kind === 'character');
  check('...in a frame too', tf.length === 2 && tf[0].role !== tf[1].role, JSON.stringify(tf.map((u) => u.role)));

  // Frame modes have no Subject definitions: the brief carries who is who.
  const fb = labelledCast(labelled([pic('first-frame', { who: [1, 2], who_axis: 'z' })], 'I2VA').references);
  eq('in a frame mode, names become who the frame says they are',
    framedBrief('Character 2 leans in and whispers to Character 1, and character 3 waits.', fb),
    'the character behind in the first frame leans in and whispers to the character in front in the first frame, and character 3 waits.');
  eq('one person in the frame has no side to name',
    framedBrief('Character 1 waves.', labelledCast(labelled([pic('first-frame', { who: [1] })], 'I2VA').references)),
    'the character in the first frame waves.');
  eq('nobody placed, the brief is left alone', framedBrief('Character 1 waves.', labelledCast(labelled([pic('first-frame')], 'I2VA').references)), 'Character 1 waves.');

  // A frame-mode picture marked Character is still a frame (9 Oct 2026).
  const charFrame = labelled([pic('character-1', { picture_kinds: ['character', 'last-frame'], who: [1] })], 'L2VA').references[0];
  eq('a character picture in L2VA goes as the last frame', [charFrame.role, charFrame.frame, charFrame.subject_group], ['keyframe', 'last', undefined]);
  eq('...and the brief names it as the frame',
    framedBrief('Character 1 waves.', labelledCast(labelled([pic('character-1', { picture_kinds: ['character', 'last-frame'], who: [1] })], 'L2VA').references)),
    'the character in the last frame waves.');
  const twoInFrame = labelledCast(labelled([pic('group-12', { picture_kinds: ['character', 'place', 'first-frame'], who: [1, 2], who_axis: 'x' })], 'I2VA').references);
  eq('two characters in an I2VA frame keep their sides',
    framedBrief('Character 2 hugs Character 1.', twoInFrame), 'the character on the right in the first frame hugs the character on the left in the first frame.');
  const ref2va = labelled([pic('character-1', { picture_kinds: ['character', 'first-frame'], who: [1] })], 'REF2VA').references[0];
  eq('REF2VA keeps a character frame a subject', [ref2va.role, ref2va.frame], ['subject', 'first']);

  // A character picture with two people: the describer is told which one.
  const grp = labelledCast(labelled([pic('character-1', { image: 'data:a' }), pic('group-21', { image: 'data:g' })], 'REF2VA').references);
  const gu = describeUnits(grp).find((u) => u.tag === '<Subject 1>');
  const gm = describeMessage(gu);
  check('in a picture of several, the describer is told which one', gm.includes('The second picture shows 2 people. Describe ONLY the one on the right, not the one on the left.'), gm);
}

// ── a picture with several characters in it ──────────────────
{
  const refs = labelled([pic('character-1'), pic('group-21'), pic('place'), pic('group-123')], 'REF2VA').references;
  check('a group picture is a subject with no subject group', refs[1].role === 'subject' && refs[1].subject_group === undefined);
  const cast = labelledCast(refs);
  const by = Object.fromEntries(cast.subjects.map((s) => [s.name, s]));
  eq('Character 1 has its own picture and two placements', [by['Character 1'].pictures, by['Character 1'].placements],
    [[1], [{ picture: 2, position: 'right' }, { picture: 4, position: 'left' }]]);
  eq('Character 3 exists from a group picture alone', [by['Character 3'].tag, by['Character 3'].pictures, by['Character 3'].placements],
    ['<Subject 3>', [], [{ picture: 4, position: 'right' }]]);
  eq('the middle of three is the middle', by['Character 2'].placements, [{ picture: 2, position: 'left' }, { picture: 4, position: 'middle' }]);
  eq('the place still comes after the characters', by['the place'].tag, '<Subject 4>');
  const lines = labelledLines(cast).join('\n');
  check('the cast line says own picture, then where in the group', lines.includes('<Subject 1> is "Character 1" in the brief, a character, shown in <Picture 1>, and on the right in <Picture 2> and on the left in <Picture 4>'), lines);
  check('a group-only character is placed', lines.includes('<Subject 3> is "Character 3" in the brief, a character, shown on the right in <Picture 4>'), lines);
  const out = labelledSegments({ segments: ['Subject definitions', 'Detailed description'] }, cast, [
    { label: 'Detailed description', body: '[Shot 1] <Subject 1>, <Subject 2> and <Subject 3> in <Subject 4>.' },
  ]);
  check('the definition places Character 2', out.segments[0].body.includes('<Subject 2> is the character on the left in <Picture 2> and in the middle in <Picture 4>;'), out.segments[0].body);
  eq('Character 2 reaches the brief through a group picture', labelledBrief('Character 2 waves', cast), '<Subject 2> waves');
  check('a group picture is REF2VA under Auto detect', resolveAutoMode('Auto detect', labelled([pic('group-12')]).references) === 'REF2VA');
}

// ── one picture: two characters and the place behind them ─────
{
  const refs = labelled([pic('group-12', { also_place: true, keep: 'their outfits', image: 'data:g' })], 'REF2VA').references;
  const cast = labelledCast(refs);
  eq('characters and the place from one picture', cast.subjects.map((s) => [s.tag, s.kind, s.pictures]),
    [['<Subject 1>', 'character', []], ['<Subject 2>', 'character', []], ['<Subject 3>', 'place', [1]]]);
  const out = labelledSegments({ segments: ['Subject definitions', 'Retention analysis', 'Detailed description'] }, cast, [
    { label: 'Detailed description', body: '[Shot 1] <Subject 1> and <Subject 2> talk.\n[Shot 2] <Subject 2> leaves.' },
  ]);
  const ret = out.segments.find((s) => s.label === 'Retention analysis').body;
  check('the place is held in every shot, whole', ret.includes('<Subject 3> (appears in [Shot 1]-[Shot 2]): fully_preserved — its layout'), ret);
  check('the note stays with the people', ret.includes('<Subject 1> (appears in [Shot 1]): partially_preserved') && !/<Subject 3>[^\n]*outfits/.test(ret), ret);
  const pu = describeUnits(cast).find((u) => u.kind === 'place');
  const pmsg = describeMessage(pu);
  check('the place describer leaves the people out', pmsg.includes('Leave out the people in it') && !pmsg.includes('outfits'), pmsg);
  eq('without the toggle there is no place', labelledCast(labelled([pic('group-12')], 'REF2VA').references).subjects.map((s) => s.kind), ['character', 'character']);
  eq('also_place on a plain place picture adds nothing twice', labelledCast(labelled([pic('place', { also_place: true })], 'REF2VA').references).subjects[0].pictures, [1]);
}

// ── any mix of kinds on one picture (6 Oct 2026) ─────────────
{
  const kinds = (k, extra = {}) => pic(k[0] === 'character' ? 'character-1' : k[0], { picture_kinds: k, ...extra });
  const mixed = labelledCast(labelled([
    kinds(['character', 'place', 'style'], { who: [2, 1], who_axis: 'x', keep: 'their outfits' }),
    kinds(['place', 'first-frame']),
  ], 'REF2VA').references);
  eq('characters, place and style from one picture, place and frame from another',
    mixed.subjects.map((s) => [s.name, s.pictures, (s.placements ?? []).map((p) => p.position)]),
    [['Character 1', [], ['right']], ['Character 2', [], ['left']], ['the place', [1, 2], []], ['the style', [1], []]]);
  eq('the second picture is also the first frame', mixed.frames.map((f) => [f.picture, f.which]), [[2, 'first']]);
  check('the note stays with the people, not the style', mixed.subjects[3].refs.every((r) => !r.keep), JSON.stringify(mixed.subjects[3].refs));

  const selfFrame = labelledCast(labelled([kinds(['character', 'first-frame'], { who: [1] })], 'REF2VA').references);
  eq('a character who is the first frame is not placed in it twice', [selfFrame.subjects[0].pictures, selfFrame.subjects[0].inFrames, selfFrame.frames.length], [[1], [], 1]);

  const frameWho = labelledCast(labelled([kinds(['first-frame', 'place'], { who: [1, 2], who_axis: 'x' })], 'REF2VA').references);
  eq('a frame that is also the place still places its people', frameWho.subjects.filter((s) => s.kind === 'character').map((s) => s.inFrames[0].position), ['left', 'right']);

  const roles = labelled([kinds(['character', 'first-frame'], { who: [1] }), kinds(['style']), kinds(['first-frame', 'last-frame'])], 'REF2VA').references;
  eq('the role is the first kind; nothing but frames is a keyframe', roles.map((r) => [r.role, r.frame ?? null]), [['subject', 'first'], ['style', null], ['keyframe', 'first']]);
  eq('kinds come back in a fixed order', labelled([pic('place', { picture_kinds: ['last-frame', 'place', 'bogus'] })], 'REF2VA').references[0].picture_kinds, ['place', 'last-frame']);
  check('a mixed picture is REF2VA under Auto detect', resolveAutoMode('Auto detect', labelled([kinds(['character', 'first-frame'], { who: [1] })]).references) === 'REF2VA');
}

// ── <Picture N> only for a frame (6 Oct 2026) ────────────────
{
  const model = { segments: ['Subject definitions', 'Summary', 'Retention analysis', 'Detailed description', 'Soundscape'] };
  // The 9B's own Shot 1 from the run that found it: sheets as Characters 1
  // and 2, the dining hall as the place.
  const cast = labelledCast(labelled([pic('character-1'), pic('character-2'), pic('place')], 'REF2VA').references);
  const shot1 = '[Shot 1] The shot begins from <Picture 3>, establishing the grand dining hall. <Subject 1> sits on the left side of the frame, her silver braids resting on her shoulders, while <Subject 2> is seated opposite her on the right.';
  const out = labelledSegments(model, cast, [
    { label: 'Summary', body: '[reference generation] <Subject 1> and <Subject 2> drink tea in <Picture 3>.' },
    { label: 'Detailed description', body: `Keeps the look of the reference pictures.\n\n${shot1}` },
    { label: 'Soundscape', body: 'The clink of cups from <Picture 1>.' },
  ]);
  const by = new Map(out.segments.map((s) => [s.label, s.body]));
  check('the place picture becomes the place', by.get('Detailed description').includes('The shot begins from <Subject 3>, establishing the grand dining hall.') && !by.get('Detailed description').includes('<Picture 3>'), by.get('Detailed description'));
  check('...in every segment the model wrote', by.get('Summary').includes('drink tea in <Subject 3>') && by.get('Soundscape').includes('from <Subject 1>'), `${by.get('Summary')} | ${by.get('Soundscape')}`);
  check('the code-written definitions still cite pictures', by.get('Subject definitions').includes('<Subject 3> is the place in <Picture 3>'), by.get('Subject definitions'));
  check('each swap is reported', out.warnings.some((w) => w.includes('<Picture 3>') && w.includes('<Subject 3>')) && out.warnings.some((w) => w.includes('<Picture 1>') && w.includes('<Subject 1>')), JSON.stringify(out.warnings));

  const framed = labelledCast(labelled([pic('first-frame'), pic('character-1')], 'REF2VA').references);
  const kept = labelledSegments(model, framed, [{ label: 'Detailed description', body: '[Shot 1] The shot begins from <Picture 1>. <Picture 2> waves.' }]);
  const kd = kept.segments.find((s) => s.label === 'Detailed description').body;
  check('a real first frame stays a picture, a character picture does not', kd.includes('begins from <Picture 1>') && kd.includes('<Subject 1> waves'), kd);

  const group = labelledCast(labelled([pic('group-12', { picture_kinds: ['character', 'place'], who: [1, 2] })], 'REF2VA').references);
  const g = labelledSegments(model, group, [{ label: 'Detailed description', body: '[Shot 1] Opens on <Picture 1>.' }]);
  check('a picture of several subjects is left and warned about',
    g.segments.find((s) => s.label === 'Detailed description').body.includes('Opens on <Picture 1>.') && g.warnings.some((w) => w.includes('more than one subject')), JSON.stringify(g));

  const past = labelledSegments(model, cast, [{ label: 'Detailed description', body: '[Shot 1] From <Picture 9>.' }]);
  check('a picture number past the last is not touched', past.segments.find((s) => s.label === 'Detailed description').body.includes('<Picture 9>') && past.warnings.every((w) => !w.includes('Picture 9')), JSON.stringify(past));
}

// ── the style line never guesses a medium ────────────────────
{
  const shots = '[Shot 1] <Subject 1> reads.';
  const guessed = `Live-action, cinematic, warm interior light.\n\n${shots}`;
  eq('a guessed medium goes, the light stays', keepReferenceLook(guessed, 'Character 1 reads'), `Keeps the look of the reference pictures, warm interior light.\n\n${shots}`);
  eq('the Q6 case: lighting survives the guess',
    keepReferenceLook(`Cinematic 2D animation, soft twilight lighting with warm lantern glow and cool blue dusk tones.\n\n${shots}`, 'x'),
    `Keeps the look of the reference pictures, soft twilight lighting with warm lantern glow and cool blue dusk tones.\n\n${shots}`);
  eq('the opener is not doubled', keepReferenceLook(`Keeps the look of the reference pictures, anime, golden light.\n\n${shots}`, 'x'),
    `Keeps the look of the reference pictures, golden light.\n\n${shots}`);
  eq('nothing but guesses, the bare line', keepReferenceLook(`Anime, cinematic.\n\n${shots}`, 'x'), `Keeps the look of the reference pictures.\n\n${shots}`);
  eq('a medium the brief asked for stays', keepReferenceLook(guessed, 'live-action, cinematic: Character 1 reads'), guessed);
  const fine = `Keeps the look of the reference pictures, warm indoor light.\n\n${shots}`;
  eq('a line with no medium stays', keepReferenceLook(fine, 'Character 1 reads'), fine);
  eq('words inside a shot are not the style line', keepReferenceLook('[Shot 1] An animated wave.', 'x'), '[Shot 1] An animated wave.');
}

// ── music only when asked (h3, every mode, labelled or not) ──────
{
  const h3 = { music_only_when_asked: true };
  const segs = () => [{ label: 'Music', body: 'Soft piano notes at a slow tempo.' }];
  let s = segs();
  check('no music in the brief makes Music N/A', musicOnlyWhenAsked(h3, 'She reads on the bed.', s) && s[0].body === 'N/A', s[0].body);
  s = segs();
  check('a brief asking for piano keeps the score', !musicOnlyWhenAsked(h3, 'Soft piano music plays.', s) && s[0].body.startsWith('Soft piano'), s[0].body);
  s = segs();
  check('"soundtrack" counts as asking', !musicOnlyWhenAsked(h3, 'An 80s synth soundtrack.', s));
  s = segs();
  check('a model without the flag is left alone', !musicOnlyWhenAsked({}, 'She reads.', s) && s[0].body.startsWith('Soft'));
  s = [{ label: 'Music', body: 'non_diegetic_music: N/A' }];
  check('an N/A already written is left as written', !musicOnlyWhenAsked(h3, 'She reads.', s) && s[0].body === 'non_diegetic_music: N/A');
  check('"takes place" is not music', !briefWantsMusic('It takes place at night.'));
}

// ── people boxes (13 Oct 2026) ───────────────────────────────────
{
  const boxed = (boxes, extra = {}) => ({ kind: 'image', role: 'subject', picture_label: 'character-1', picture_kinds: ['character'], image: 'data:image/png;base64,AA', boxes, ...extra });
  const castOf = (refs) => labelledCast(applyPictureLabels({ mode: 'REF2VA', picture_labels: true, references: refs }).references);
  // The five-girl band, r4's boxes, numbered out of order on purpose.
  const band = [[0.089, 0.092, 0.299, 0.949], [0.27, 0.088, 0.484, 0.949], [0.43, 0.118, 0.612, 0.95], [0.588, 0.13, 0.789, 0.949], [0.746, 0.135, 0.994, 0.95]];
  const five = boxed(band.map((box, i) => ({ n: [3, 1, 5, 2, 4][i], box })));
  eq('boxes say who is in it, left to right', whoFromBoxes(boxesOf(five)), [3, 1, 5, 2, 4]);
  const cast = castOf([five]);
  eq('everyone boxed is a character', cast.subjects.map((s) => s.number), [1, 2, 3, 4, 5]);
  const units = describeUnits(cast);
  check('five people with boxes are five readings, no group reading', units.length === 5 && !units.some((u) => u.kind === 'group'), units.map((u) => u.tag).join(','));
  eq('each is read from their own box', units.find((u) => u.tag === cast.subjects.find((s) => s.number === 1).tag).crops, [band[1]]);
  eq('boxes give positions past four', cast.subjects.map((s) => s.placements[0].position),
    ['second from the left', 'fourth from the left', 'furthest left', 'furthest right', 'third from the left']);
  // Five boxed in an I2VA frame: "Character 5" was left bare and the writer
  // gave the high-five to the wrong girl (13 Oct 2026).
  const band5 = labelledCast(applyPictureLabels({ mode: 'I2VA', picture_labels: true, references: [
    { kind: 'image', role: 'keyframe', picture_label: 'first-frame', picture_kinds: ['first-frame'], image: 'data:image/png;base64,AA', boxes: band.map((box, i) => ({ n: i + 1, box })) },
  ] }).references);
  eq('five in a frame are all named by place', framedBrief('Character 2 and Character 5 high-five.', band5),
    'the character second from the left in the first frame and the character furthest right in the first frame high-five.');
  const msg = describeMessage(units[0], 'They bow.');
  check('a crop is said to be a cut-out of one person', /cut from a picture of several people, around this one person/.test(msg), msg);
  check('a crop gets no "Describe ONLY the one on the left"', !/Describe ONLY the one/.test(msg), msg);
  check('two boxed people are two cache entries', new Set(units.map((u) => u.role)).size === 5);

  // A hint on a boxed person reaches the reader with their crop (13 Oct 2026).
  const hinted = describeUnits(castOf([{ ...five, who_hints: { 2: 'red twin tails' } }]));
  const two2 = hinted.find((u) => u.name === 'Character 2');
  check('a boxed person\'s hint is told with their crop', /describes them as "red twin tails"/.test(describeMessage(two2)), describeMessage(two2));
  check('...and a changed hint is a fresh reading', two2.role !== units.find((u) => u.name === 'Character 2').role);
  check('...and nobody else gets it', !hinted.filter((u) => u !== two2).some((u) => /red twin tails/.test(describeMessage(u))));

  // Frame modes (13 Oct 2026): two people boxed in an I2VA first frame.
  const frameCast = (kinds, extra = {}) => labelledCast(applyPictureLabels({ mode: 'I2VA', picture_labels: true, references: [
    { kind: 'image', role: 'keyframe', picture_label: 'first-frame', picture_kinds: kinds, image: 'data:image/png;base64,AA',
      boxes: [{ n: 2, box: [0.55, 0.1, 0.95, 1] }, { n: 1, box: [0.05, 0.1, 0.45, 1] }], ...extra },
  ] }).references);
  const fc = frameCast(['first-frame'], { who_hints: { 1: 'blue jacket' } });
  eq('frame boxes put each character in the frame, by side', fc.subjects.map((s) => [s.number, s.inFrames[0]?.position]), [[1, 'left'], [2, 'right']]);
  const fu = describeUnits(fc).filter((u) => u.kind === 'character');
  eq('each is read from their box in the frame', fu.map((u) => u.crops[0]), [[0.05, 0.1, 0.45, 1], [0.55, 0.1, 0.95, 1]]);
  const fm = describeMessage(fu[0]);
  check('a frame cut to one person says so', /frame of the video, cut around the one person to describe/.test(fm) && !/the character on the left in it/.test(fm), fm);
  check('...with that person\'s hint', /describes them as "blue jacket"/.test(fm) && !/blue jacket/.test(describeMessage(fu[1])), fm);
  check('the brief names them by the frame', framedBrief('Character 2 hugs Character 1.', fc) === 'the character on the right in the first frame hugs the character on the left in the first frame.', framedBrief('Character 2 hugs Character 1.', fc));
  const fcc = describeUnits(frameCast(['character', 'first-frame'])).filter((u) => u.kind === 'character');
  check('a frame marked Character is read from the boxes too', fcc.length === 2 && fcc.every((u) => u.crops.some(Boolean)), JSON.stringify(fcc.map((u) => u.crops)));

  // Two side by side: positions from the boxes, crops for both.
  const two = castOf([boxed([{ n: 2, box: [0.55, 0.1, 0.95, 1] }, { n: 1, box: [0.05, 0.1, 0.45, 1] }])]);
  eq('two boxes: left and right by where they sit', two.subjects.map((s) => [s.number, s.placements[0].position]), [[1, 'left'], [2, 'right']]);

  // The piggyback: boxes overlap too much to read either one alone.
  const piggy = [{ n: 1, box: [0.233, 0.09, 0.573, 1] }, { n: 2, box: [0.324, 0.027, 0.719, 0.834] }];
  eq('heavily overlapping boxes are not cropped', [cropFor(piggy, 1), cropFor(piggy, 2)], [null, null]);
  const pig = describeUnits(castOf([boxed(piggy)]));
  check('...and are read whole, by position', pig.every((u) => !u.crops.some(Boolean)) && /Describe ONLY the one on the (left|right)/.test(describeMessage(pig[0])), describeMessage(pig[0]));

  // One person boxed in their own picture: read from the crop.
  const solo = describeUnits(castOf([boxed([{ n: 1, box: [0.2, 0.1, 0.6, 0.9] }])]));
  eq('a single box crops a picture of one', solo[0].crops, [[0.2, 0.1, 0.6, 0.9]]);

  // Bad boxes are dropped, duplicates of a number too.
  eq('boxes are checked', boxesOf({ boxes: [{ n: 1, box: [0.5, 0.5, 0.2, 0.2] }, { n: 1, box: [0, 0, 1, 1] }, { n: 0, box: [0, 0, 1, 1] }, { n: 2, box: [0.1, 0.1, 0.105, 0.9] }, { n: 3, box: [0, 0, 'x', 1] }] }), [{ n: 1, box: [0.2, 0.2, 0.5, 0.5] }]);
  check('no boxes: the tapped numbers still work', whoFromBoxes(boxesOf({})).length === 0 && castOf([{ ...boxed(undefined), who: [1, 2], who_axis: 'x' }]).subjects.length === 2);

  // The model's answer, read leniently.
  const r4 = '[{"label": "person", "bbox_2d": [89, 93, 294, 947]}, {"label": "person", "bbox_2d": [747, 134, 992, 947)}]';
  eq('a stray ")" in r4\'s JSON still reads', parsePeople(r4).map((p) => p.box.map((v) => Number(v.toFixed(3)))), [[0.089, 0.093, 0.294, 0.947], [0.747, 0.134, 0.992, 0.947]]);
  eq('pixel boxes are scaled to the picture', parsePeople('[{"label": "a", "bbox_2d": [0, 0, 1216, 832]}]', { width: 1216, height: 832 })[0].box, [0, 0, 1, 1]);
  eq('people come back left to right', parsePeople('[{"label": "r", "bbox_2d": [600, 0, 900, 900]}, {"label": "l", "bbox_2d": [100, 0, 400, 900]}]').map((p) => p.label), ['l', 'r']);
  eq('no boxes in the answer, none back', parsePeople('I cannot see anyone.'), []);
}

// ── the Cast list: a card per character, used as written (13 Oct 2026) ──
{
  const two = labelledCast(applyPictureLabels({ mode: 'REF2VA', picture_labels: true, references: [
    { kind: 'image', role: 'subject', picture_kinds: ['character'], image: 'data:image/png;base64,AA',
      boxes: [{ n: 2, box: [0.55, 0.1, 0.95, 1] }, { n: 1, box: [0.05, 0.1, 0.45, 1] }] },
    { kind: 'image', role: 'subject', picture_kinds: ['place'], image: 'data:image/png;base64,BB' },
  ] }).references);
  const given = givenCast({ cast: { 1: '  A young woman with long green hair and green eyes.  She wears a red dress. ', 9: 'not in it', x: 'bad', 3: '   ' } });
  eq('cards: numbers kept, spaces tidied, empty ones dropped', [...given.keys()], [1, 9]);
  check('a card is capped at 600 characters', givenCast({ cast: { 1: 'a'.repeat(900) } }).get(1).length === CAST_TEXT_MAX);
  eq('kept list made from a card, sentence by sentence', keptFromLook(given.get(1)), 'long green hair and green eyes, a red dress');
  const long = 'A girl with short black hair. She has violet eyes. She wears a sailor uniform. A red ribbon sits at her collar. White socks and loafers.';
  check('a card is never cut to two sentences', writtenDescription(long).look === long);
  const written = castDescriptions(two, given);
  eq('only characters in the cast take a card', [...written.keys()], ['<Subject 1>']);
  const units = describeUnits(two);
  const left = unitsToRead(units, two, given);
  check('a character with a card is not read', !left.some((u) => u.tag === '<Subject 1>') && left.some((u) => u.tag === '<Subject 2>'), left.map((u) => u.tag).join(','));
  check('...the place still is', left.some((u) => u.kind === 'place'));
  const descriptions = new Map([...written, ['<Subject 2>', 'A tall man in a black coat.\nKept: black coat'], ['<Subject 3>', 'A pier at dusk.\nKept: the pier']]);
  const segs = labelledSegments({ segments: ['Subject definitions', 'Retention analysis', 'Detailed description'] }, two,
    [{ label: 'Detailed description', body: '[Shot 1] <Subject 1> and <Subject 2> walk on <Subject 3>.' }], descriptions).segments;
  const defs = segs.find((x) => x.label === 'Subject definitions').body;
  const keep = segs.find((x) => x.label === 'Retention analysis').body;
  check('Subject definitions carry the card as written', defs.includes('<Subject 1> is the character on the left in <Picture 1>. A young woman with long green hair and green eyes. She wears a red dress.'), defs);
  check("Retention keeps what the card says, the brief's changes aside", keep.includes('<Subject 1> (appears in [Shot 1]): fully_preserved — long green hair and green eyes, a red dress are retained, except traits the detailed description explicitly changes.'), keep);
  check('...a read character keeps the plain wording', keep.includes('fully_preserved — black coat are retained.'), keep);
  check("a carded definition says the description's changes win", defs.includes('She wears a red dress. Reference appearance only: explicit changes in the detailed description override conflicting traits above'), defs);
  check('...a read one does not', !/Subject 2>[^\n]*Reference appearance only/.test(defs), defs);
  check("a read character keeps the reader's Kept line", keep.includes('fully_preserved — black coat are retained'), keep);
  const lines = labelledLines(two, descriptions).join('\n');
  check('the writer is told the card', lines.includes('looks: A young woman with long green hair and green eyes. She wears a red dress.'), lines);
  check('with a card, the writer is told the brief wins where they differ', lines.includes('Never contradict it, except: where the brief explicitly changes a trait'), lines);
  check('...without one, the old rule stands', labelledLines(two, new Map([['<Subject 2>', 'A tall man.']])).join('\n').includes('as described. Never contradict it.'));
  // A typed "Use it for" still makes it partial, as before.
  const typed = labelledCast(applyPictureLabels({ mode: 'REF2VA', picture_labels: true, references: [
    { kind: 'image', role: 'subject', picture_kinds: ['character'], who: [1], keep: 'just her haircut', image: 'data:image/png;base64,AA' },
  ] }).references);
  const tk = labelledSegments({ segments: ['Retention analysis'] }, typed, [{ label: 'Detailed description', body: '[Shot 1] <Subject 1> waves.' }], castDescriptions(typed, given)).segments[0].body;
  check('"Use it for" still makes a carded character partial', /partially_preserved — from <Picture 1>, keep: just her haircut/.test(tk), tk);

  // One character read for a card: their own unit, or their line of a group reading.
  const found = castUnit(two, units, 2);
  check("a card reads the character's own unit", found?.unit.tag === '<Subject 2>' && found.index === null);
  eq('a card takes the look, not the Kept line', castLook('A tall man in a black coat.\nKept: black coat', found), 'A tall man in a black coat.');
  const group = labelledCast(applyPictureLabels({ mode: 'REF2VA', picture_labels: true, references: [
    { kind: 'image', role: 'subject', picture_kinds: ['character'], who: [1, 2], image: 'data:image/png;base64,AA' },
  ] }).references);
  const gu = describeUnits(group);
  const g2 = castUnit(group, gu, 2);
  check('nobody placed: the card reads the group picture', g2?.unit.kind === 'group' && g2.index === 1, JSON.stringify(g2 && { kind: g2.unit.kind, index: g2.index }));
  eq('...and takes their own line of it', castLook('1: A girl with red hair.\n2: A boy in a cap.\nKept: x', g2), 'A boy in a cap.');
  check('a group whose people all have cards is not read', !unitsToRead(gu, group, new Map([[1, 'a'], [2, 'b']])).length);
  check('...one card short, it is', unitsToRead(gu, group, new Map([[1, 'a']])).length === 1);
  check('no picture of them, no card read', castUnit(group, gu, 5) === null);

  // Frame modes: the cards reach the writer beside where each one stands.
  const frame = labelledCast(applyPictureLabels({ mode: 'I2VA', picture_labels: true, references: [
    { kind: 'image', role: 'keyframe', picture_kinds: ['first-frame'], image: 'data:image/png;base64,AA',
      boxes: [{ n: 2, box: [0.55, 0.1, 0.95, 1] }, { n: 1, box: [0.05, 0.1, 0.45, 1] }] },
  ] }).references);
  const fl = framedCastLines(frame, new Map([[2, 'A tall man in a black coat']]));
  eq('a frame mode tells the writer the card, by place', fl.slice(2), ['- The character on the right in the first frame: A tall man in a black coat.']);
  check('...and that the brief wins where they differ', fl[1].includes('the brief wins for that trait'), fl[1]);
  eq('no cards, no cast block', framedCastLines(frame, new Map()), []);

  // A note on one of a character's pictures is about that picture only.
  const across = labelledCast(applyPictureLabels({ mode: 'REF2VA', picture_labels: true, references: [
    { kind: 'image', role: 'subject', picture_kinds: ['character'], who: [1], image: 'data:image/png;base64,AA' },
    { kind: 'image', role: 'subject', picture_kinds: ['character'], who: [1], keep: 'her face', image: 'data:image/png;base64,BB' },
  ] }).references);
  const am = describeMessage(describeUnits(across)[0]);
  check('a note on one picture is said for that picture', /From the second picture, take only: her face\./.test(am) && /Take everything else from the other pictures/.test(am) && !/The person wants to keep/.test(am), am);
  const same = labelledCast(applyPictureLabels({ mode: 'REF2VA', picture_labels: true, references: [
    { kind: 'image', role: 'subject', picture_kinds: ['character'], who: [1], keep: 'her hair', image: 'data:image/png;base64,AA' },
    { kind: 'image', role: 'subject', picture_kinds: ['character'], who: [1], keep: 'her hair', image: 'data:image/png;base64,BB' },
  ] }).references);
  check('...the same note on every picture is said once, as before', /The person wants to keep: her hair\./.test(describeMessage(describeUnits(same)[0])));

  // What the reader leaks around its answer.
  eq('a leaked </think> is cut off', usableReading('Let me look.</think>\nA girl with red hair.'), 'A girl with red hair.');
  eq('a whole think block is cut off', usableReading('<think>hmm</think>A girl.'), 'A girl.');
  eq('a trailing UNAVAILABLE still goes', usableReading('A girl.\nUNAVAILABLE'), 'A girl.');
}

// ── scene cards: the place, the style and each pose (14 Oct 2026) ──
{
  const img = (kinds, extra = {}) => ({ kind: 'image', role: 'subject', picture_kinds: kinds, image: `data:image/png;base64,${Math.random()}`, ...extra });
  const scene = labelledCast(applyPictureLabels({ mode: 'REF2VA', picture_labels: true, references: [
    img(['character', 'place'], { who: [1] }),
    img(['style']),
    img(['pose'], { who: [1] }),
    img(['character'], { who: [2] }),
    img(['pose'], { who: [2] }),
  ] }).references);
  const given = givenCast({ cast: {
    1: 'Character 1 is a young woman with red hair.',
    place: 'A grand, sunlit dining hall with tall arched windows.',
    style: 'Soft cel-shaded anime, clean linework.',
    'pose@3': 'Standing with arms crossed, head tilted left. The one has long blonde hair.',
    'pose@9': 'not a picture here', 'pose@0': 'bad', places: 'bad',
  } });
  eq('scene keys are kept beside the numbers', [...given.keys()], [1, 'place', 'style', 'pose@3', 'pose@9']);
  eq('characterCards keeps the numbers only', [...characterCards(given).keys()], [1]);
  const tagOf = (kind, picture) => scene.subjects.find((s) => s.kind === kind && (picture == null || s.pictures[0] === picture)).tag;
  const written = castDescriptions(scene, given);
  check('the place, the style and the carded pose take their cards', written.has(tagOf('place')) && written.has(tagOf('style')) && written.has(tagOf('pose', 3)) && !written.has(tagOf('pose', 5)),
    [...written.keys()].join(','));
  eq('a pose card keeps only the stance', written.get(tagOf('pose', 3)).look, 'Standing with arms crossed, head tilted left.');
  eq('a place card has no kept list', written.get(tagOf('place')).kept, '');
  const units = describeUnits(scene);
  const left = unitsToRead(units, scene, given).map((u) => u.tag);
  check('carded place, style and pose are not read', !left.includes(tagOf('place')) && !left.includes(tagOf('style')) && !left.includes(tagOf('pose', 3)), left.join(','));
  check('...the uncarded pose and Character 2 still are', left.includes(tagOf('pose', 5)) && left.includes(scene.subjects.find((s) => s.number === 2).tag), left.join(','));

  // At Generate: the card is the definition, and Retention keeps the stock wording.
  const segs = labelledSegments({ segments: ['Subject definitions', 'Retention analysis', 'Detailed description'] }, scene,
    [{ label: 'Detailed description', body: '[Shot 1] <Subject 1> and <Subject 2> walk.' }], written).segments;
  const defs = segs.find((x) => x.label === 'Subject definitions').body;
  const keep = segs.find((x) => x.label === 'Retention analysis').body;
  check('the place card is its definition, as written', defs.includes(`${tagOf('place')} is the place in <Picture 1>, where the video happens. A grand, sunlit dining hall with tall arched windows.`), defs);
  check('the style card is its definition', defs.includes('Soft cel-shaded anime, clean linework.'), defs);
  check('the pose card is the stance', defs.includes('Standing with arms crossed, head tilted left.') && !defs.includes('blonde'), defs);
  check('place Retention keeps the stock wording', keep.includes(`${tagOf('place')} (appears in [Shot 1]): fully_preserved — its layout, landmarks, light and time of day are retained.`), keep);
  check('style Retention keeps the stock wording', keep.includes('fully_preserved — its rendering is retained throughout.'), keep);
  check('no garbled kept list from a place card', !/dining hall[^\n]*are retained/.test(keep), keep);
  const lines = labelledLines(scene, written).join('\n');
  check('the writer is told the place card', lines.includes('looks: A grand, sunlit dining hall with tall arched windows.'), lines);
  check('...and the pose card', lines.includes('pose: Standing with arms crossed, head tilted left.'), lines);

  // Reading a scene card.
  const place = sceneUnit(scene, units, 'place');
  check('sceneUnit finds the place', place?.unit.tag === tagOf('place') && place.kind === 'place');
  check('sceneUnit finds a pose by its picture', sceneUnit(scene, units, 'pose@5')?.unit.tag === tagOf('pose', 5));
  check('no such pose, no unit', sceneUnit(scene, units, 'pose@2') === null && sceneUnit(scene, units, 'nonsense') === null);
  const pm = describeMessage(place.unit);
  check('a place behind the characters is read as the setting only', /Leave out the people in it/.test(pm), pm);
  const plainPlace = labelledCast(applyPictureLabels({ mode: 'REF2VA', picture_labels: true, references: [img(['place'])] }).references);
  check('...a place on its own is not told that', !/Leave out the people/.test(describeMessage(describeUnits(plainPlace)[0])));
  eq('a place card is the two sentences, never renamed', castLook('The character is a hall. Second. Third.\nKept: x', place), 'The character is a hall. Second.');
  eq('a pose card read is cut to the stance', castLook('She stands with arms crossed. Her long red hair falls loose. Head tilted left.\nKept: x', sceneUnit(scene, units, 'pose@3')),
    'She stands with arms crossed. Head tilted left.');

  // Fix 1: a character card never opens with their name or place.
  eq('"Character 2 is" goes', unnamed('Character 2 is a young woman with red hair.'), 'A young woman with red hair.');
  eq('"The character on the left has" goes', unnamed('The character on the left has long blue hair.'), 'A character with long blue hair.');
  eq('a card that opens well is left alone', unnamed('A girl with a characterful grin.'), 'A girl with a characterful grin.');
  const c2 = castUnit(scene, units, 2);
  eq('castLook unnames a character read', castLook('Character 2 is a tall man in a coat.\nKept: coat', c2), 'A tall man in a coat.');

  // Fix 3: "and wears".
  eq('traitsOf drops an "and" before wears', traitsOf('A girl with blue eyes, and wears a white dress.'), 'blue eyes, a white dress');
}

if (failures.length) {
  console.log(`\n${failures.length} FAILED:`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log(`ALL PASSED (${passed})`);
