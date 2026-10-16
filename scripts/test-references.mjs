// The reference label classes, against the Director node's rules.
//
//   node scripts/test-references.mjs
//
// No server, no model. Every assertion here is traceable to
// docs/minimax_h3_director.md and js/minimax_h3_director.js in
// darksidewalker/ComfyUI-DaSiWa-Nodes, which is what actually consumes our
// REF2VA output, and to section 2 of
// prompts/video/h3/references/h3-reference-official.md, which is what the
// model is told.
//
// The rule: the NUMBER is the file and the ROLE is the job. The Director badges
// every image `Picture N` by slot whatever its role, so <Picture N> here must
// be the Nth image. Until 18 Sep 2026 a subject or style picture was labelled
// <Subject N> and counted apart, and on the P40 the model then wrote the robot
// AND the house as <Picture 1> — H3 got the wrong picture as its first frame.

import {
  formatReferences,
  referenceGroundingWarnings,
  pictureGroups,
  groupWarnings,
  labelFor,
  labelsFor,
  resolveAutoMode,
  resolveAutoControls,
  limitsFor,
  MODE_LIMITS,
  CLIP_SECONDS,
  LANE_LIMITS,
  STREAM_MODES,
} from '../server/references.mjs';
import { formatImageReferences } from '../server/imagerefs.mjs';
import { readingUnits, readingHash, readingMessage, readingLines, givenReading } from '../server/picture-readings.mjs';

let passed = 0;
const failures = [];

function check(what, ok, detail) {
  if (ok) passed += 1;
  else failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
}

// ── label class for a row with no kind (saved before kinds existed) ──
check('keyframe is a Picture', labelFor('keyframe') === 'Picture', labelFor('keyframe'));
check('motion is a Video', labelFor('motion') === 'Video', labelFor('motion'));
check('voice is an Audio', labelFor('voice') === 'Audio', labelFor('voice'));
// A subject or style picture is still a picture file: cited inside the
// <Subject N> the model defines, but numbered as the Director numbers it.
check('subject is a Picture', labelFor('subject') === 'Picture', labelFor('subject'));
check('style is a Picture', labelFor('style') === 'Picture', labelFor('style'));
check('an unknown role falls back to Picture', labelFor('hologram') === 'Picture', labelFor('hologram'));
check('a missing role falls back to Picture', labelFor(undefined) === 'Picture', labelFor(undefined));

// ── the kind decides the class, whatever the role ──
check('an image with any role is a Picture',
  ['keyframe', 'subject', 'style', 'motion', 'voice'].every((role) => labelsFor({ role, kind: 'image' })[0] === 'Picture'));
// A new tile's default role is `subject`; an audio clip used to arrive as <Subject N>.
check('an audio file with any role is an Audio',
  ['keyframe', 'subject', 'style', 'voice'].every((role) => labelsFor({ role, kind: 'audio' })[0] === 'Audio'));

// ── numbering ────────────────────────────────────────────────
// Pictures count through every image in order, as the Director's slots do;
// each class counts from 1 independently, as section 2 of the guide does.
{
  const { lines, images } = formatReferences([
    { role: 'subject', kind: 'image' },
    { role: 'keyframe', kind: 'image' },
    { role: 'style', kind: 'image' },
    { role: 'motion', kind: 'video' },
    { role: 'subject', kind: 'audio' },
  ]);
  const labels = lines.map((l) => /<([A-Za-z]+ \d+)>/.exec(l)?.[1]);
  check(
    'pictures number every image in slot order, whatever the role',
    labels.join(' | ') === 'Picture 1 | Picture 2 | Picture 3 | Video 1 | Audio 1',
    labels.join(' | ')
  );
  check('attached pictures carry the same numbers',
    images.map((i) => i.label).join(' ') === '<Picture 1> <Picture 2> <Picture 3>',
    images.map((i) => i.label).join(' '));
  check('no reference line is ever a <Subject N>', !lines.some((l) => /^- <Subject/.test(l)), lines.join('\n'));
}

// ── the line itself ──────────────────────────────────────────
{
  const { lines } = formatReferences([
    { role: 'subject', kind: 'image' },
    { role: 'style', kind: 'image', keep: 'the wet neon grade', drop: 'its subject entirely' },
    { role: 'keyframe', kind: 'image' },
  ]);
  check('keep and drop survive', /keep: the wet neon grade/.test(lines[1]) && /drop: its subject entirely/.test(lines[1]), lines[1]);
  // The role is the job: what the model does with that numbered file.
  check('a subject picture is cited inside a Subject it defines',
    /define a <Subject N>.*cite <Picture 1>/.test(lines[0]) && /no standalone <Picture 1> line/.test(lines[0]), lines[0]);
  check('a style picture is rendering only, cited inside a Subject',
    /rendering only/.test(lines[1]) && /citing <Picture 2>/.test(lines[1]), lines[1]);
  check('a keyframe picture gets its own line and an anchor',
    /<Picture 3> IS a frame of the video/.test(lines[2]) && /shot and moment/.test(lines[2]), lines[2]);
}

{
  const { lines } = formatReferences([{ role: 'subject', kind: 'audio' }]);
  check('an audio file is described as audio, not by the role picker', /voice — audio signal/.test(lines[0]), lines[0]);
}

// The base modes have no subject_definitions, retention_analysis or
// <Subject N>. Asking for them in I2VA made h3 answer every segment N/A in
// 2 of 8 runs (18 Sep 2026).
for (const mode of ['I2VA', 'FL2VA', 'L2VA']) {
  const { lines } = formatReferences([
    { role: 'keyframe', kind: 'image' }, { role: 'subject', kind: 'image' }, { role: 'style', kind: 'image' },
  ], mode);
  check(`${mode} never asks for REF2VA-only sections`,
    !lines.some((l) => /subject_definitions|retention_analysis|<Subject N>/.test(l)), lines.join('\n'));
}
{
  const { lines } = formatReferences([{ role: 'keyframe', kind: 'image' }], 'REF2VA');
  check('REF2VA still gives a keyframe its own line', /subject_definitions and retention_analysis/.test(lines[0]), lines[0]);
}

{
  const { lines } = formatReferences([{ role: 'motion' }]);
  check('a reference with no keep or drop still gets a line', lines.length === 1, String(lines.length));
  check('and still carries its label', /<Video 1>/.test(lines[0]), lines[0]);
}

check('no references produce no lines', formatReferences([]).lines.length === 0);
check('undefined references do not throw', formatReferences().lines.length === 0);

// ── lane limits ──────────────────────────────────────────────
// "Up to 9 images, 3 videos, 3 audio clips, 12 files total."
check('lane limits match the Director', LANE_LIMITS.image === 9 && LANE_LIMITS.video === 3 &&
  LANE_LIMITS.audio === 3 && LANE_LIMITS.total === 12, JSON.stringify(LANE_LIMITS));

{
  const four = [{ role: 'motion' }, { role: 'motion' }, { role: 'motion' }, { role: 'motion' }];
  const { lines, warnings } = formatReferences(four);
  check('a lane over its limit warns', warnings.some((w) => /video/.test(w)), warnings.join('; '));
  // Warning, not rejection: the prompt is still useful, the node is what
  // refuses, and dropping a reference the user attached is worse than either.
  check('and the references are still formatted', lines.length === 4, String(lines.length));
}

{
  // Pictures and Subjects share the image lane, so ten of them is over the
  // limit even though neither class alone is.
  const many = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'style' : 'keyframe' }));
  const { warnings } = formatReferences(many);
  check('Pictures and Subjects share the image lane', warnings.some((w) => /image/.test(w)), warnings.join('; '));
}

{
  const thirteen = Array.from({ length: 13 }, () => ({ role: 'subject' }));
  const { warnings } = formatReferences(thirteen);
  check('the 12-file total warns', warnings.some((w) => /12/.test(w)), warnings.join('; '));
}

check('a legal set warns about nothing',
  formatReferences([{ role: 'keyframe' }, { role: 'motion' }, { role: 'voice' }]).warnings.length === 0);

// ── video and audio lanes ──────────────────────────
//
// The rule that shapes all of this is section 2.5 of the official reference
// guide: "An ordinary reference video does not create <Audio N> merely
// because the file contains sound." The stream mode is a declaration, so the
// default must be picture-only and the audio label must be opt-in.

{
  const v = { role: "motion", kind: "video" };
  check("a video defaults to the picture stream alone",
    JSON.stringify(labelsFor(v)) === JSON.stringify(["Video"]), JSON.stringify(labelsFor(v)));
  check("...and an unknown stream mode falls back to the same",
    JSON.stringify(labelsFor({ ...v, stream: "nonsense" })) === JSON.stringify(["Video"]));
  check("video + audio emits both labels",
    JSON.stringify(labelsFor({ ...v, stream: "both" })) === JSON.stringify(["Video", "Audio"]));
  check("audio-only emits the audio label alone",
    JSON.stringify(labelsFor({ ...v, stream: "audio" })) === JSON.stringify(["Audio"]));
}

{
  // A stream mode on a still is meaningless — there is no track to enable.
  const still = { role: "keyframe", kind: "image", stream: "both" };
  check("a stream mode on an image is ignored",
    JSON.stringify(labelsFor(still)) === JSON.stringify(["Picture"]), JSON.stringify(labelsFor(still)));
}

{
  // Section 2.5 again: the two categories are numbered independently and the
  // indices do not pair, so <Video 1> can legitimately sit beside <Audio 2>.
  const { lines } = formatReferences([
    { role: "voice", kind: "audio" },
    { role: "motion", kind: "video", stream: "both" },
  ]);
  check("independent numbering puts the standalone clip at Audio 1",
    lines[0].includes("<Audio 1>"), lines[0]);
  check("...the video at Video 1", lines[1].includes("<Video 1>"), lines[1]);
  check("...and its track at Audio 2, which does not pair with the index",
    lines[2].includes("<Audio 2>"), lines[2]);
  check("the synchronized track names the video it came from",
    lines[2].includes("<Video 1>"), lines[2]);
}

{
  // Audio-only on a video file: there is no <Video N> to point at, so the
  // line must not claim one.
  const { lines } = formatReferences([{ role: "motion", kind: "video", stream: "audio" }]);
  check("audio-only produces exactly one line", lines.length === 1, String(lines.length));
  check("...and never references a Video label that was not emitted",
    !/<Video/.test(lines[0]), lines[0]);
  check("...and says the picture is not referenced",
    /picture is not referenced/.test(lines[0]), lines[0]);
}

{
  // Lane limits count files, not labels: the Director states them as "9
  // images, 3 videos, 3 audio clips, 12 files total".
  const three = Array.from({ length: 3 }, () => ({ role: "motion", kind: "video", stream: "both" }));
  const { warnings, lines } = formatReferences(three);
  check("three video+audio files are six labels", lines.length === 6, String(lines.length));
  check("...but three files, so nothing warns", warnings.length === 0, warnings.join("; "));
}

{
  const four = Array.from({ length: 4 }, () => ({ role: "motion", kind: "video" }));
  const { warnings } = formatReferences(four);
  check("a fourth video warns", warnings.some((w) => /video/.test(w)), warnings.join("; "));
}

{
  const four = Array.from({ length: 4 }, () => ({ role: "voice", kind: "audio" }));
  check("a fourth audio clip warns",
    formatReferences(four).warnings.some((w) => /audio/.test(w)));
}

{
  // Rows saved before kind existed must keep counting exactly as they did,
  // or an old library entry starts warning about lanes it never used.
  const legacy = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "style" : "keyframe" }));
  check("a reference with no kind still counts by its label class",
    formatReferences(legacy).warnings.some((w) => /image/.test(w)));
  check("...and a legacy video role counts as one video",
    formatReferences([{ role: "motion" }]).warnings.length === 0);
}

{
  const { lines } = formatReferences([{ role: "motion", kind: "video", duration_seconds: 12.5 }]);
  check("clip length reaches the prompt", /length: 12.5s/.test(lines[0]), lines[0]);
  const long = formatReferences([{ role: "motion", kind: "video", duration_seconds: 95 }]).lines[0];
  check("...and reads as minutes past a minute", /length: 1m 35s/.test(long), long);
  const none = formatReferences([{ role: "motion", kind: "video", duration_seconds: 0 }]).lines[0];
  check("...and an unknown length says nothing at all", !/length:/.test(none), none);
}

check("every stream mode emits at least one label",
  Object.values(STREAM_MODES).every((m) => m.emits.length >= 1));
check("every emitted label is one the formatter counts",
  Object.values(STREAM_MODES).every((m) => m.emits.every((l) => ["Video", "Audio"].includes(l))));

{
  // Traits from frame tagging describe the picture. Repeating them under the
  // audio label tells the model the soundtrack looks like a handheld pan.
  const { lines } = formatReferences([
    { role: "motion", kind: "video", stream: "both", keep: "handheld pan, hard cuts", drop: "lens flare" },
  ]);
  check("the video line carries the traits", /keep: handheld pan/.test(lines[0]), lines[0]);
  check("...and the synchronized audio line does not", !/keep:/.test(lines[1]), lines[1]);
  check("...nor the drop traits", !/drop:/.test(lines[1]), lines[1]);
  check("...but still carries provenance", /<Video 1>/.test(lines[1]), lines[1]);
}

{
  // Audio-only traits are typed by hand and are about the sound, so they
  // must survive — the rule is "first label", not "never on audio".
  const { lines } = formatReferences([
    { role: "motion", kind: "video", stream: "audio", keep: "crowd noise" },
  ]);
  check("an audio-only reference keeps its traits", /keep: crowd noise/.test(lines[0]), lines[0]);
}


// ── reference images on the IMAGE models ─────────────────────
//
// A different formatter and a different contract from everything above. The
// Director's label classes answer to a node that reads them; these answer to
// the image prompt files, and `<Picture 1>` on Illustrious would be citing a
// convention with no reader. See the note at the top of server/imagerefs.mjs.
//
// Added 26 Aug 2026, adapted from the French contributor's own build, which
// had this and we did not. The question it answers is the one a tag dump
// cannot: the same photograph is a character sheet, an outfit swatch or a
// lighting study depending on what the person wanted from it.
{
  const defaults = {
    image_reference_roles: {
      character: { label: 'Character', rule: 'who is in the picture' },
      outfit: { label: 'Outfit', rule: 'clothing and accessories' },
      background: { label: 'Background', rule: 'the setting' },
    },
    default_image_reference_role: 'character',
    reference_fidelity: {
      exact: { label: 'Reproduce faithfully', rule: 'Carry every listed trait through unchanged.' },
      close: { label: 'Keep most of it', rule: 'Keep the listed traits.' },
      loose: { label: 'Loose inspiration', rule: 'Echo its character; match nothing exactly.' },
    },
    default_reference_fidelity: 'close',
    max_image_references: 3,
  };
  const underscore = { tag_style: 'underscore' };
  const spaced = { tag_style: 'space' };
  const prose = {};
  const fmt = (refs, model = underscore, d = defaults) =>
    formatImageReferences(refs, d, model).lines.join('\n');

  check('no references produce no lines',
    formatImageReferences([], defaults, underscore).lines.length === 0);
  check('a non-object in the list is skipped rather than throwing',
    formatImageReferences([null, undefined, 'x'], defaults, underscore).lines.length === 0);

  // The role's own rule travels, not just its name. "Pose" alone reads as
  // "there is a person in it"; the rule is the instruction.
  {
    const out = fmt([{ role: 'background', fidelity: 'close', tags: ['sunset'] }]);
    check('the role label reaches the model', /Reference 1 — Background/.test(out), out);
    check('...along with what that role covers', /the setting/.test(out), out);
    check('...and the fidelity rule', /Keep the listed traits/.test(out), out);
  }

  // Grouped by REGISTRY order, not upload order. Two outfit references are one
  // instruction about clothing; interleaving them with a background makes the
  // model reconcile them one at a time against everything else.
  {
    const out = fmt([
      { role: 'background', fidelity: 'close', tags: ['a'] },
      { role: 'character', fidelity: 'close', tags: ['b'] },
      { role: 'outfit', fidelity: 'close', tags: ['c'] },
    ]);
    const order = [...out.matchAll(/Reference \d+ — (\w+)/g)].map((m) => m[1]);
    check('references are grouped in registry order, not upload order',
      order.join(',') === 'Character,Outfit,Background', order.join(','));
  }

  // Tag spelling is decided HERE, because this is the side that knows the
  // model. A frontend that converted first would leave no underscore to
  // convert back from.
  {
    const refs = [{ role: 'character', fidelity: 'close', tags: ['purple_hair', 't-shirt'] }];
    check('underscore models keep danbooru spelling',
      /purple_hair/.test(fmt(refs, underscore)), fmt(refs, underscore));
    check('space models get real spaces',
      /purple hair/.test(fmt(refs, spaced)), fmt(refs, spaced));
    check('prose models get spaces too, since underscores read badly in a sentence',
      /purple hair/.test(fmt(refs, prose)), fmt(refs, prose));
    // The direction is load-bearing and must never become dash: dash cannot
    // tell `t-shirt` from `long-hair`.
    check('a word-internal hyphen survives the conversion',
      /t-shirt/.test(fmt(refs, spaced)), fmt(refs, spaced));
  }

  // A recognised character is a lookup rather than a description, so it gets
  // its own line above the tags — and it is spelled for the model like
  // everything else.
  {
    const out = fmt([{ role: 'character', fidelity: 'close', character: 'fern_(sousou_no_frieren)', tags: ['elf'] }], spaced);
    check('a named character gets its own line',
      /character: fern \(sousou no frieren\)/.test(out), out);
    check('...above the picked tags, being the stronger claim',
      out.indexOf('character:') < out.indexOf('tags they picked:'), out);
  }

  // The note overrides: "only the hair" beats ten detected tags, so it is
  // stated after them.
  {
    const out = fmt([{ role: 'outfit', fidelity: 'close', note: 'only the collar', tags: ['a', 'b'] }]);
    check('a typed note reaches the model', /take from it: only the collar/.test(out), out);
    check('...after the tags it overrides', out.indexOf('take from it') > out.indexOf('tags they picked'), out);
  }

  // Unknown values fall back rather than failing. A saved library entry or a
  // client that has not reloaded will not carry these, and neither is an error.
  {
    const out = fmt([{ role: 'nonsense', fidelity: 'nonsense', tags: ['a'] }]);
    check('an unknown role falls back to the default rather than vanishing',
      /Reference 1 — Character/.test(out), out);
    check('...and an unknown fidelity falls back too',
      /Keep the listed traits/.test(out), out);
  }
  {
    const out = fmt([{ tags: ['a'] }]);
    check('a reference with no role or fidelity at all still produces a line',
      /Reference 1 —/.test(out), out);
  }


  // "Applies to": whose coat it is. In a two-character scene an outfit
  // reference is ambiguous and the model cannot resolve it on its own.
  {
    const out = fmt([{ role: "outfit", fidelity: "close", applies_to: "fern_(sousou_no_frieren)", tags: ["capelet"] }], spaced);
    check("a binding names the character it attaches to",
      // Parentheses escaped: a danbooru disambiguation suffix is a real part
      // of the tag, and unescaped this reads as a capture group that matches
      // the bare name — which passed while the binding was being dropped.
      /applies to: fern \(sousou no frieren\)/.test(out), out);
    check("...spelled for the model like every other tag",
      !/fern_/.test(out), out);
    check("...before the tags, since it changes what they are about",
      out.indexOf("applies to") < out.indexOf("tags they picked"), out);
  }
  {
    const out = fmt([{ role: "character", fidelity: "close", tags: ["a"] }]);
    check("a reference with no binding says nothing about one",
      !/applies to/.test(out), out);
  }

  // Nothing here may ask the model to look at a picture. It never sees one —
  // only tags read on this machine — and a line implying otherwise is asking
  // it to invent, which house-rules.md forbids in as many words.
  {
    const out = fmt([{ role: 'character', fidelity: 'exact', tags: ['a'] }]);
    check('no line tells the model to look at, view or describe an image',
      !/\b(look at|view|see the|describe the) (image|picture|photo)/i.test(out), out);
  }

  // Warnings, not refusals: the prompt is still useful past the ceiling, and
  // silently dropping a reference someone attached is worse than either.
  {
    const many = Array.from({ length: 5 }, () => ({ role: 'outfit', fidelity: 'close', tags: ['a'] }));
    const { lines, warnings } = formatImageReferences(many, defaults, underscore);
    check('past the ceiling every reference is still formatted',
      lines.filter((l) => l.startsWith('- Reference')).length === 5, String(lines.length));
    check('...and the ceiling is reported as a warning',
      warnings.some((w) => /ceiling/.test(w)), warnings.join(' | '));
  }

  // Two references in one role both set to "reproduce faithfully" is an
  // instruction that cannot be satisfied — two different sets of traits
  // carried through unchanged into one picture.
  {
    const { warnings } = formatImageReferences([
      { role: 'outfit', fidelity: 'exact', tags: ['a'] },
      { role: 'outfit', fidelity: 'exact', tags: ['b'] },
    ], defaults, underscore);
    check('two exact references in one role are warned about',
      warnings.some((w) => /reproduce faithfully/.test(w)), warnings.join(' | '));
    check('...and the warning names which role',
      warnings.some((w) => /Outfit/.test(w)), warnings.join(' | '));
  }
  {
    const { warnings } = formatImageReferences([
      { role: 'outfit', fidelity: 'exact', tags: ['a'] },
      { role: 'background', fidelity: 'exact', tags: ['b'] },
    ], defaults, underscore);
    check('two exact references in DIFFERENT roles are fine',
      !warnings.some((w) => /faithfully/.test(w)), warnings.join(' | '));
  }

  // The registry is what supplies the vocabulary. An empty defaults object is
  // a misconfigured boot, not a crash.
  {
    const { lines, warnings } = formatImageReferences(
      [{ role: 'character', fidelity: 'close', tags: ['a'] }], {}, underscore
    );
    check('no registry vocabulary still produces a line rather than throwing',
      lines.length > 0 && Array.isArray(warnings), lines.join('\n'));
  }
}

// ── Auto detect, settled in code ────────────────────
// SKILL.md states the rule and the server applies it, so h3's default mode
// stops loading both official guides on every generation. The assertions that
// matter are the two ends: a mode someone picked is never rewritten, and an
// unrecognised role counts as a reference rather than as nothing.
{
  const at = (refs) => resolveAutoMode('Auto detect', refs);

  check('no references at all is T2VA', at([]) === 'T2VA', String(at([])));
  check('absent references is T2VA, not a crash',
    resolveAutoMode('Auto detect', undefined) === 'T2VA');
  check('one keyframe is I2VA', at([{ role: 'keyframe' }]) === 'I2VA', String(at([{ role: 'keyframe' }])));
  check('two keyframes is FL2VA',
    at([{ role: 'keyframe' }, { role: 'keyframe' }]) === 'FL2VA');
  check('three keyframes is REF2VA: FL2VA takes two pictures',
    at([{ role: 'keyframe' }, { role: 'keyframe' }, { role: 'keyframe' }]) === 'REF2VA');

  // Counted by picture (30 Sep 2026): a new tile defaults to subject, and
  // the old rule sent every one of those to REF2VA, so I2VA never happened.
  check('one subject picture is I2VA', at([{ role: 'subject', kind: 'image' }]) === 'I2VA');
  check('one picture with no role is I2VA', at([{ kind: 'image' }]) === 'I2VA');
  check('two subject pictures are REF2VA',
    at([{ role: 'subject', kind: 'image' }, { role: 'subject', kind: 'image' }]) === 'REF2VA');
  check('a subject plus a keyframe is REF2VA, not FL2VA',
    at([{ role: 'subject', kind: 'image' }, { role: 'keyframe', kind: 'image' }]) === 'REF2VA');

  // Video, audio and style cannot be said in the base guide's three core
  // fields, so they are full reference even alone.
  for (const role of ['style', 'motion', 'voice']) {
    check(`a ${role} reference is REF2VA`, at([{ role }]) === 'REF2VA');
  }
  check('a lone video is REF2VA', at([{ role: 'subject', kind: 'video' }]) === 'REF2VA');
  check('a lone audio clip is REF2VA', at([{ role: 'subject', kind: 'audio' }]) === 'REF2VA');

  // The pictures become frames in a base mode, because the Director uses
  // them as frames there whatever the tile said.
  const one = resolveAutoControls({ mode: 'Auto detect', references: [{ role: 'subject', kind: 'image' }] });
  check('Auto detect into I2VA relabels the picture as a keyframe',
    one.mode === 'I2VA' && one.references[0].role === 'keyframe', JSON.stringify(one));
  const many = resolveAutoControls({ mode: 'Auto detect', references: [{ role: 'subject' }, { role: 'subject' }] });
  check('Auto detect into REF2VA leaves roles alone',
    many.mode === 'REF2VA' && many.references.every((r) => r.role === 'subject'));
  const picked = { mode: 'REF2VA', references: [{ role: 'subject' }] };
  check('a picked mode is returned untouched', resolveAutoControls(picked) === picked);
  check('a keyframe plus a style is REF2VA',
    at([{ role: 'keyframe' }, { role: 'style' }]) === 'REF2VA');

  // A role the registry grew and this never heard of. Treated as a reference,
  // because the expensive mistake is writing a base-mode prompt for a brief
  // that had references in it - not carrying one guide too many.
  check('an unknown role falls to REF2VA, not to a base mode',
    at([{ role: 'hologram' }]) === 'REF2VA');

  // L2VA is unreachable from here and is meant to be: one keyframe is a first
  // frame and a last frame in identically shaped requests.
  check('one keyframe never resolves to L2VA', at([{ role: 'keyframe' }]) !== 'L2VA');

  // A mode the person chose is passed through untouched, and so is silence -
  // which prompts.get() reads as "use the base entry with every guide".
  for (const picked of ['T2VA', 'I2VA', 'FL2VA', 'L2VA', 'REF2VA']) {
    check(`${picked} is left exactly as picked`,
      resolveAutoMode(picked, [{ role: 'subject' }]) === picked);
  }
  check('no mode at all stays absent',
    resolveAutoMode(undefined, []) === undefined);
}

// ── per-mode reference limits ───────────────────────────────
// One flat set of limits, REF2VA's, was applied to every mode until 4 Sep
// 2026. REF2VA's are the loosest of the three, so the two strict modes warned
// about nothing: three videos on a T2VA prompt passed silently here and were
// a hard error at the node ("{mode} accepts only its optional image
// keyframes").
{
  const img = (n) => Array.from({ length: n }, () => ({ role: 'keyframe', kind: 'image' }));
  const vid = (n) => Array.from({ length: n }, () => ({ role: 'motion', kind: 'video' }));
  const warn = (refs, mode) => formatReferences(refs, mode).warnings;

  // The Director rejects any video or audio in the FL2VA family outright.
  for (const mode of ['T2VA', 'I2VA', 'FL2VA', 'L2VA']) {
    check(`${mode} warns about a video the Director will reject`,
      warn(vid(1), mode).some((w) => /video/.test(w)), warn(vid(1), mode).join(' | '));
  }

  // ...and it takes at most two images there, against REF2VA's nine.
  check('three images warn in a base mode',
    warn(img(3), 'I2VA').some((w) => /image/.test(w)), warn(img(3), 'I2VA').join(' | '));
  check('three images do NOT warn in REF2VA',
    warn(img(3), 'REF2VA').length === 0, warn(img(3), 'REF2VA').join(' | '));
  check('two images are fine in a base mode',
    warn(img(2), 'FL2VA').length === 0, warn(img(2), 'FL2VA').join(' | '));

  // Picking T2VA explicitly is a statement that this is text-only. A zero
  // limit gets its own sentence: "accepts 0 images" reads like a counting bug.
  check('one image warns in T2VA, which is the text-only mode',
    warn(img(1), 'T2VA').some((w) => /accepts none/.test(w)), warn(img(1), 'T2VA').join(' | '));

  check('Image Inpaint takes exactly one image',
    warn(img(1), 'Image Inpaint').length === 0 && warn(img(2), 'Image Inpaint').length > 0);

  // No mode, or one nothing recognises, falls back to the LOOSEST limits, so
  // an unknown mode warns about nothing it should not.
  check('an absent mode uses the loosest limits', limitsFor(null) === LANE_LIMITS);
  check('an unknown mode uses the loosest limits', limitsFor('T2VAA') === LANE_LIMITS);
  check('the loosest limits are REF2VA\'s', limitsFor(null) === MODE_LIMITS.REF2VA);

  // Clip length. "minimum 2 seconds, maximum 15 seconds each."
  const clip = (secs) => [{ role: 'motion', kind: 'video', duration_seconds: secs }];
  check('a clip under the minimum warns',
    warn(clip(1.2), 'REF2VA').some((w) => new RegExp(`${CLIP_SECONDS.min}s`).test(w)));
  check('a clip over the maximum warns',
    warn(clip(22), 'REF2VA').some((w) => new RegExp(`${CLIP_SECONDS.max}s`).test(w)));
  check('a clip inside the band does not warn about its length',
    !warn(clip(8), 'REF2VA').some((w) => /clip/.test(w)), warn(clip(8), 'REF2VA').join(' | '));

  // ffmpeg is optional on this box, so an unreadable duration means "unknown",
  // not "zero". Warning about it would fire on every upload on a box without
  // ffmpeg, which is the state the media panel exists to report.
  check('a clip with no readable duration is not warned about',
    !warn([{ role: 'motion', kind: 'video' }], 'REF2VA').some((w) => /clip/.test(w)));

  // "Combined visual total: <= 15 seconds."
  const three = [
    { role: 'motion', kind: 'video', duration_seconds: 7 },
    { role: 'motion', kind: 'video', duration_seconds: 7 },
    { role: 'motion', kind: 'video', duration_seconds: 7 },
  ];
  check('the combined visual budget warns past 15s',
    warn(three, 'REF2VA').some((w) => /combined limit/.test(w)), warn(three, 'REF2VA').join(' | '));
}

// ── explicit same-subject groups ─────────────────────────────
{
  const subject = (group = '') => ({ kind: 'image', role: 'subject', subject_group: group });
  const refs = [subject('A'), subject(), subject('A'), subject('B'), subject('B')];
  const groups = pictureGroups(refs).map((g) => g.pictures);
  check('only explicit group IDs combine subject pictures', JSON.stringify(groups) === '[[1,3],[4,5]]');
  const { lines, images } = formatReferences(refs, 'REF2VA');
  check('each selected group gets one line', lines.length === 3 && lines[0].includes('<Picture 1>, <Picture 3>') && lines[2].includes('<Picture 4>, <Picture 5>'));
  check('ungrouped picture stays independent', lines[1].includes('<Picture 2>'));
  check('all pictures remain attached in order', images.map((i) => i.label).join() === '<Picture 1>,<Picture 2>,<Picture 3>,<Picture 4>,<Picture 5>');
  check('brief alone never silently merges unrelated characters',
    formatReferences([subject(), subject()], 'REF2VA').lines.length === 2);
  check('one-member group remains separate', formatReferences([subject('A'), subject()], 'REF2VA').lines.length === 2);
  check('keyframe cannot join a subject group',
    pictureGroups([subject('A'), { kind: 'image', role: 'keyframe', subject_group: 'A' }]).length === 0);
  check('style cannot join a subject group',
    pictureGroups([subject('A'), { kind: 'image', role: 'style', subject_group: 'A' }]).length === 0);
  check('base modes never group', formatReferences([subject('A'), subject('A')], 'I2VA').lines.length === 2);
  const split = '<Subject 1> Rin from <Picture 1>.\n<Subject 2> Rin from <Picture 3>.';
  check('warn only on explicit split subject definitions', groupWarnings(split, refs).length === 1);
  check('no warning for one subject citing the whole group',
    groupWarnings('<Subject 1> Rin from <Picture 1> and <Picture 3>.', refs).length === 0);
  check('no warning when provenance is absent', groupWarnings('<Subject 1> Rin.', refs).length === 0);
}

// ── h3 per-picture readings ──────────────────────────────────
{
  const pic = (image, group = '', extra = {}) => ({ kind: 'image', role: 'subject', image, ...(group ? { subject_group: group } : {}), ...extra });
  const refs = [pic('a', 'A'), pic('b'), pic('c', 'A'), pic('d'), { kind: 'video', role: 'motion' }];
  const units = readingUnits(refs, 'REF2VA');
  check('a group is one reading, other pictures one each, in Director order',
    JSON.stringify(units.map((u) => u.labels)) === JSON.stringify([['<Picture 1>', '<Picture 3>'], ['<Picture 2>'], ['<Picture 4>']]),
    JSON.stringify(units.map((u) => u.labels)));
  check('a picture with no image is not read', readingUnits([pic(''), pic('x')], 'REF2VA').length === 1);
  check('the group message says it is one subject', /same subject/.test(readingMessage(units[0])));
  check('keep and drop reach the reader', /keep: red coat/.test(readingMessage({ role: 'subject', refs: [{ keep: 'red coat' }] })));
  check('the brief does not change the cache key', readingHash(units[1]) === readingHash({ ...units[1] }));
  check('a new keep note is a new reading', readingHash({ role: 'subject', refs: [{ image: 'b' }] }) !== readingHash({ role: 'subject', refs: [{ image: 'b', keep: 'x' }] }));
  const lines = readingLines(units, new Map([['<Picture 1>, <Picture 3>', 'A girl.'], ['<Picture 2>', 'UNAVAILABLE']]));
  check('readings go under their labels, unusable ones dropped',
    lines.includes('<Picture 1>, <Picture 3>: A girl.') && !lines.some((l) => l.startsWith('<Picture 2>')), lines.join(' | '));
  check('no readings, no lines', readingLines(units, new Map()).length === 0);

  // Descriptions the page already holds stand in for a scan.
  check('a described picture is not scanned again', givenReading({ refs: [{ reading: ' A girl. ' }] }) === 'A girl.');
  check('an undescribed picture is scanned', givenReading({ refs: [{}] }) === null);
  check('a group counts only when every picture carries the same description',
    givenReading({ refs: [{ reading: 'A girl.' }, { reading: 'A girl.' }] }) === 'A girl.' &&
    givenReading({ refs: [{ reading: 'A girl.' }, {}] }) === null &&
    givenReading({ refs: [{ reading: 'A girl.' }, { reading: 'Another.' }] }) === null);
  check('the description does not change the cache key',
    readingHash({ role: 'subject', refs: [{ image: 'b' }] }) === readingHash({ role: 'subject', refs: [{ image: 'b', reading: 'x' }] }));
}

// A REF2VA subject or style picture no Subject definition cites is flagged.
{
  const refs = [{ kind: 'image', role: 'subject' }, { kind: 'image', role: 'style' }, { kind: 'image', role: 'keyframe' }];
  check('uncited subject/style images warn, but keyframes are not misclassified', referenceGroundingWarnings('<Subject 1> a green triangle.', refs, 'REF2VA').length === 2);
  check('current source citations suppress the warning', referenceGroundingWarnings('<Subject 1> from <Picture 1>. <Subject 2> from <Picture 2>.', refs, 'REF2VA').length === 0);
  check('normalized native picture numbering is recognized', referenceGroundingWarnings('<Subject 1> from <Picture 01>. <Subject 2> from <Picture 2>.', refs, 'REF2VA').length === 0);
  check('no REF2VA warning leaks into base modes', referenceGroundingWarnings('', refs, 'I2VA').length === 0);
  check('missing references create no warnings', referenceGroundingWarnings('', undefined, 'REF2VA').length === 0);
}

// ── report ───────────────────────────────────────────────────
if (failures.length) {
  console.log(`
${failures.length} FAILED:`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
// Bare count: check.mjs reads what is between the parentheses and appends
// "assertions" itself.
console.log(`ALL PASSED (${passed})`);
