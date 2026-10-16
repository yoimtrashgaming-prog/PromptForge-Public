// How a reference the user uploaded is named in the prompt.
//
// This existed inline in server.mjs as `<Picture ${i + 1}>` for every
// reference, which is wrong in the mode this feature exists for. The
// authority is the node that consumes our output — the DaSiWa MiniMax
// H3 Director, `docs/minimax_h3_director.md` — and it is explicit about which
// label class each kind of reference gets:
//
//   <Picture N>  ONLY concrete frame anchors: opening, key, last frame,
//                storyboard.
//   <Video N>    structural roles only: editing source, continuation,
//                pacing/cuts/rhythm.
//   <Audio N>    copied or referenced audio signals: dialogue, music,
//                ambience, voice timbre.
//   <Subject N>  visible content abstracted from references: people, objects,
//                scenes, clothing, actions.
//
// And the rule that makes the old behaviour a real defect rather than a
// cosmetic one: an image that defines style or appearance only is cited inside
// a Subject definition and gets NO Picture entry. Four of the registry's five
// roles were being labelled as frame anchors when none of them is one.
//
// This is the same tiebreak that settled the h3 timecode and Summary
// assertions on 21 Aug: where a prompt file and the tool that consumes its
// output disagree, the consumer decides what is true.
//
// Numbering follows the Director's order — "images first (Pictures), then
// videos, then audio" — and each label class counts from 1 independently, as
// the official reference guide's section 2 does.
//
// Video and audio references landed 21 Aug. Until then the upload was images
// only, so <Video N> and <Audio N> were labels nothing could ever produce:
// the roles existed in the registry, the mapping existed here, and every file
// input said `accept="image/*"`. See STREAM_MODES below for the one rule that
// shapes the whole feature.

// ── The number is the FILE, the role is the JOB (corrected 18 Sep 2026) ──
//
// Until 18 Sep this file gave a subject or style picture the label
// <Subject N> and counted it apart from the keyframes, which misread the
// sentence above: "cite it inside a Subject and don't create a Picture ENTRY"
// means no standalone line in subject_definitions, not no Picture number. The
// Director numbers every image `Picture N` by its slot, whatever its role —
// js/minimax_h3_director.js, `mediaReferenceName(type)` + the slot position,
// and its own Prefill writes `<Picture N>` for every image. The official
// guide's first example is "<Subject 1> is the young woman in <Picture 1>":
// the Picture is the file, the Subject is content the prompt defines from it.
//
// What that cost, measured on the P40 18 Sep with a subject picture (a robot)
// and a keyframe picture (a house): the model was told <Subject 1> and
// <Picture 1>, and wrote "<Subject 1> is the robot from <Picture 1>" AND
// "<Picture 1> is the keyframe … the house". In the Director Picture 1 is the
// robot and Picture 2 the house, so H3 was handed the robot as the opening
// frame and the house was never referenced. Every REF2VA run with a subject or
// style picture had its picture numbers wrong from the second image on.
//
// So the label class comes from what the file is — image, video, audio — and
// the role only decides what the model is told to do with it. <Subject N> is
// the model's to assign. Rows saved before `kind` existed are images unless
// their role says otherwise.
// A REF2VA subject or style picture no Subject definition cites. Advisory: the
// definitions are the person's to edit, so nothing is rewritten or blocked.
export function referenceGroundingWarnings(definitions, references, mode) {
  if (mode !== 'REF2VA' || !Array.isArray(references)) return [];
  const cited = new Set([...String(definitions ?? '').matchAll(/<Picture\s+(\d+)>/g)]
    .map(([, n]) => `<Picture ${Number(n)}>`));
  return formatReferences(references, mode).images
    .filter(({ ref, label }) => ['subject', 'style'].includes(ref?.role) && !cited.has(label))
    .map(({ label }) => `Enabled ${label} has no source citation in Subject definitions; its grounding may be missing. Review before using the prompt.`);
}

export const ROLE_LABEL = {
  keyframe: 'Picture',
  motion: 'Video',
  voice: 'Audio',
  subject: 'Picture',
  style: 'Picture',
};

const KIND_LABEL = { image: 'Picture', video: 'Video', audio: 'Audio' };

// What to do with the file, in the Director's terms, one short clause. The
// label is passed in so the instruction can name the exact tag to cite.
const ROLE_NOTE = {
  keyframe: (l) => `keyframe — ${l} IS a frame of the video: give it its own line in subject_definitions and retention_analysis, naming the shot and moment it anchors`,
  motion: (l) => `motion — ${l} gives structure only: pacing, cuts, camera`,
  voice: () => 'voice — audio signal',
  subject: (l) => `subject — define a <Subject N> from it and cite ${l} as its source; no standalone ${l} line`,
  style: (l) => `style — rendering only, not its content: define a style <Subject N> citing ${l}; no standalone ${l} line`,
};

// The base modes (T2VA, I2VA, FL2VA, L2VA) have three fields and no
// subject_definitions, retention_analysis or <Subject N> labels at all. Sending
// them ROLE_NOTE's REF2VA instructions, as 05e9f60 did for a day, asked for
// sections that do not exist: measured 18 Sep on the P40, h3 I2VA answered
// every segment "N/A" in 2 of 8 runs.
const BASE_NOTE = {
  keyframe: (l) => `keyframe — ${l} is a frame of the video; describe it where it appears`,
  subject: (l) => `subject — who or what appears, taken from ${l}`,
  style: (l) => `style — rendering only, taken from ${l}`,
};

// The Director's lane limits, PER MODE. Enforced here as warnings rather than
// rejections — the prompt is still useful past them, the node is what refuses,
// and silently dropping a reference the user attached is worse than either.
//
// Until 4 Sep 2026 there was one flat set of limits, REF2VA's, applied to every
// mode. That is the loosest of the three and it made the two strict modes
// unenforceable: the Director rejects a video in any FL2VA-family mode outright
// ("{mode} accepts only its optional image keyframes" in helper_minimax_h3_
// director.py) and rejects anything but exactly one image in Image Inpaint. A
// person could attach three videos to a T2VA prompt here, see no warning at
// all, and find out at the node.
//
// Sources, all from the Director's own documentation and helper:
//   REF2VA        "Up to 9 images, 3 videos, 3 audio clips, 12 files total."
//   FL2VA family  "max 2 images; no video/audio allowed."
//   Image Inpaint "Exactly one image reference; video and audio files are
//                 rejected (a video/audio in the timeline is a hard error)."
//
// T2VA is the zero-image case of the FL2VA family, and picking it explicitly
// is a statement that this is text-only — so it takes 0 rather than 2. Someone
// who wants a keyframe picks I2VA, or leaves it on Auto detect, which resolves
// by image count exactly as the Director's own builder does.
export const MODE_LIMITS = {
  REF2VA: { image: 9, video: 3, audio: 3, total: 12 },
  'Image Inpaint': { image: 1, video: 0, audio: 0, total: 1 },
  T2VA: { image: 0, video: 0, audio: 0, total: 0 },
  // One frame each for I2VA and L2VA, two for FL2VA: the alignment line in
  // MiniMax's guide (h3-base-official.md 2.1) names exactly that many
  // pictures. The node's "max 2" is the family's ceiling, not each mode's.
  I2VA: { image: 1, video: 0, audio: 0, total: 1 },
  FL2VA: { image: 2, video: 0, audio: 0, total: 2 },
  L2VA: { image: 1, video: 0, audio: 0, total: 1 },
};

// The loosest set, which is REF2VA's. Still exported under the old name: it is
// what a request with no mode falls back to, and falling back to the loosest
// limits means an unknown mode warns about nothing it should not.
export const LANE_LIMITS = MODE_LIMITS.REF2VA;

/** Limits for a mode, or the loosest set when the mode is absent or unknown. */
export function limitsFor(mode) {
  return MODE_LIMITS[mode] ?? LANE_LIMITS;
}

// "Reference clip length: minimum 2 seconds, maximum 15 seconds each. Combined
// visual total: <= 15 seconds. Combined audio total: <= 15 seconds." The
// Director validates these before sending data downstream; we warn, for the
// same reason the lane counts warn.
//
// A clip whose duration we could not read is not warned about. ffmpeg is
// optional on this box — see `media` in the settings payload — and a missing
// duration means "unknown", not "zero".
export const CLIP_SECONDS = { min: 2, max: 15 };
export const TOTAL_SECONDS = { visual: 15, audio: 15 };

const LANE_OF = { Picture: 'image', Subject: 'image', Video: 'video', Audio: 'audio' };

/**
 * Which streams of a video reference are actually being referenced.
 *
 * This exists because of one sentence in the official reference guide,
 * section 2.5: *"An ordinary reference video does not create `<Audio N>`
 * merely because the file contains sound."* The audio track is a deliberate
 * declaration, not a property of the file — so a video defaults to `video`
 * and the person has to say when its sound is part of the reference.
 *
 * The same section is what allows one file to produce two labels: *"The same
 * reference video may therefore correspond to `<Video 1>` and `<Audio 2>`."*
 * They are numbered independently and the indices do not pair.
 */
export const STREAM_MODES = {
  video: { label: 'Video only', emits: ['Video'] },
  audio: { label: 'Audio only', emits: ['Audio'] },
  both: { label: 'Video + audio', emits: ['Video', 'Audio'] },
};

const DEFAULT_STREAM = 'video';

/**
 * The lane a reference occupies, for the Director's file limits.
 *
 * Counted by what the file *is*, not by the labels it produces. The limits
 * are stated in files — "9 images, 3 videos, 3 audio clips, 12 files total" —
 * so a video referenced for its audio alone is still one video file, and a
 * video + audio reference is one file occupying one video slot rather than
 * two slots in two lanes.
 *
 * `kind` is sent by the uploader. Rows saved before video and audio existed
 * do not carry it, so the role's own label class is the fallback and those
 * rows keep counting exactly as they did.
 */
function laneOf(ref, label) {
  const kind = ref?.kind;
  if (kind === 'image' || kind === 'video' || kind === 'audio') return kind;
  return LANE_OF[label];
}

/** The label class for a row with no `kind`: an image unless its role says otherwise. */
export function labelFor(role) {
  return ROLE_LABEL[role] ?? 'Picture';
}

/**
 * Clip length, for the prompt line.
 *
 * H3 output is timed — shots carry cut times in MM:SS.mmm — so how long a
 * source clip runs is information the model can actually use when it is
 * asked to edit or continue one. Written as seconds under a minute because
 * "0:06" reads like a timecode and most references are short.
 */
function formatDuration(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return null;
  if (s < 60) return `${s.toFixed(1)}s`;
  const mins = Math.floor(s / 60);
  return `${mins}m ${Math.round(s - mins * 60)}s`;
}

/**
 * Which labels a reference emits.
 *
 * Only a video-lane reference can emit two. Everything else emits the one
 * label its role maps to, and a stream mode on a still is ignored rather than
 * honoured — there is no audio track on a PNG to enable.
 */
export function labelsFor(ref) {
  // An audio file is <Audio N> and a still is <Picture N> whatever role it
  // carries — a new tile's default role is `subject`, so an audio clip used
  // to arrive as <Subject N>.
  if (ref?.kind !== 'video') return [KIND_LABEL[ref?.kind] ?? labelFor(ref?.role)];
  const mode = STREAM_MODES[ref?.stream] ? ref.stream : DEFAULT_STREAM;
  return STREAM_MODES[mode].emits;
}

// Explicit subject identity from the reference editor, not a guess from the
// brief. Model size does not establish whether two pictures depict one subject.
export function pictureGroups(references = []) {
  const byId = new Map();
  let number = 0;
  for (const ref of references) {
    if (labelsFor(ref)[0] !== 'Picture') continue;
    number += 1;
    const id = ref?.subject_group;
    if ((ref?.role ?? 'subject') !== 'subject' || typeof id !== 'string' || !id) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(number);
  }
  return [...byId.values()].filter((pictures) => pictures.length >= 2).map((pictures) => ({ pictures }));
}

const COUNT_WORD = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/** The one reference line a group gets, in the form that went 10 for 10. */
function groupLine(group, references) {
  const tags = group.pictures.map((n) => `<Picture ${n}>`);
  const count = COUNT_WORD[tags.length] ?? String(tags.length);
  const all = tags.length === 2 ? 'both' : `all ${count}`;
  const bits = [
    tags.join(', '),
    `subject — ONE subject shown in ${count} pictures: define a single <Subject N> citing ${all}; no standalone picture lines`,
  ];
  // Keep and drop notes stay attached to the picture they were written for.
  const pictures = references.filter((r) => labelsFor(r)[0] === 'Picture');
  for (const n of group.pictures) {
    const ref = pictures[n - 1];
    if (ref?.keep) bits.push(`keep (<Picture ${n}>): ${ref.keep}`);
    if (ref?.drop) bits.push(`drop (<Picture ${n}>): ${ref.drop}`);
  }
  return `- ${bits.join(' · ')}`;
}

/**
 * Turn the reference rows into the lines that go in the user message.
 * Returns { lines, warnings, images } — warnings name a lane over its limit,
 * and `images` is every image-lane reference paired with the label it was
 * given, in the order the lines number them.
 *
 * **`images` exists so the pictures can travel.** Until 9 Sep 2026 an h3
 * reference reached the model as these lines and nothing else: role, keep,
 * drop, length. That is a description of what a file IS in the Director's
 * pipeline, and it says nothing about what is in the photograph — the same
 * objection the owner raised about the image models on 8 Sep, one lane over.
 *
 * The caller attaches the pictures and names them by label, which is why the
 * label is returned rather than recomputed there: these counters are the only
 * thing that knows a reference is <Subject 2> and not <Picture 2>, and a
 * second implementation of that rule would be a second thing to keep in step.
 * Only the first label — a video's <Audio N> is the same file, not a picture.
 *
 * Grouping reads only explicit `subject_group` choices on reference rows.
 */
export function formatReferences(references = [], mode = null) {
  const baseMode = mode && mode !== 'REF2VA' && mode !== 'Auto detect';
  const grouped = new Map();
  if (mode === 'REF2VA') {
    for (const group of pictureGroups(references)) {
      for (const n of group.pictures) grouped.set(n, group);
    }
  }
  const counters = { Picture: 0, Video: 0, Audio: 0, Subject: 0 };
  const lanes = { image: 0, video: 0, audio: 0 };
  const seconds = { visual: 0, audio: 0 };
  const lines = [];
  const images = [];

  for (const ref of references) {
    const labels = labelsFor(ref);
    // One file, one lane slot, however many labels it produces.
    const lane = laneOf(ref, labels[0]);
    lanes[lane] += 1;

    // Clip seconds accrue to the visual budget or the audio one, and a video
    // referenced for both streams spends from both — the Director decodes the
    // same trim range twice in that case, which is why it is not double
    // counting to add it to each.
    const secs = Number(ref?.duration_seconds);
    if (Number.isFinite(secs) && secs > 0) {
      if (lane === 'audio' || labels.includes('Audio')) seconds.audio += secs;
      if (lane !== 'audio') seconds.visual += secs;
    }

    // The video line first when a reference emits both, matching the guide's
    // own worked example — "<Video 1> is the source video…" then "<Audio 2>
    // is the synchronized audio track of <Video 1>".
    const videoIndex = labels.includes('Video') ? counters.Video + 1 : null;

    for (const [n, label] of labels.entries()) {
      counters[label] += 1;
      // Traits belong to the first label a reference emits, never to both.
      // On a video + audio reference the traits came from tagging sampled
      // frames — "handheld pan, hard cuts" is a fact about the picture, and
      // repeating it under <Audio N> tells the model the soundtrack looks
      // like a handheld pan. The audio line carries provenance and length,
      // which is what the guide's own worked example does.
      const carriesTraits = n === 0;

      // The picture lane, for the caller that attaches them. Recorded under
      // the same counter that writes the line, so the label the model is told
      // to look at is the label it just read.
      if (carriesTraits && lane === 'image') {
        images.push({ ref, label: `<${label} ${counters[label]}>` });
      }

      const bits = [`<${label} ${counters[label]}>`];
      // An audio label carried by a video file describes the track, not the
      // role the file was given — "motion — structure only: pacing, cuts" is
      // false of a soundtrack. Say where it came from instead, which is what
      // the guide does when provenance would otherwise be ambiguous.
      if (label === 'Audio' && ref?.kind === 'video' && videoIndex) {
        bits.push(`synchronized audio track of <Video ${videoIndex}>`);
      } else if (label === 'Audio' && ref?.kind === 'video') {
        // Audio-only mode: the file is a video but its picture is not part of
        // the reference, so there is no <Video N> to point at. Saying so is
        // the honest version — the model would otherwise have no idea why an
        // audio asset arrived with a motion role attached.
        bits.push('audio track only; the video picture is not referenced');
      } else if (label === 'Audio') {
        // An audio file's job is the audio, whatever the role picker says.
        bits.push(ROLE_NOTE.voice());
      } else if (label === 'Picture' && grouped.has(counters.Picture)) {
        // One line for the whole group, written where its first picture
        // falls; the other members add nothing here. Their pictures are
        // still attached and numbered — only the instruction is shared.
        const group = grouped.get(counters.Picture);
        if (counters.Picture !== group.pictures[0]) continue;
        lines.push(groupLine(group, references));
        continue;
      } else if (ref?.role === 'keyframe' && (ref.frame === 'first' || ref.frame === 'last')) {
        // A frame that knows which end it is says so; the note is otherwise
        // the keyframe one, which leaves the model to guess the moment.
        const end = ref.frame === 'first' ? 'the first frame: the video opens on it exactly' : 'the last frame: the video ends on it exactly';
        bits.push(baseMode
          ? `keyframe — ${bits[0]} is ${end}`
          : `keyframe — ${bits[0]} is ${end}; give it its own line in subject_definitions and retention_analysis`);
      } else {
        const note = (baseMode && BASE_NOTE[ref?.role]) || ROLE_NOTE[ref?.role];
        bits.push(note ? note(bits[0]) : `role: ${ref?.role ?? 'UNLABELLED'}`);
      }
      const length = formatDuration(ref?.duration_seconds);
      if (length) bits.push(`length: ${length}`);
      if (carriesTraits && ref?.keep) bits.push(`keep: ${ref.keep}`);
      if (carriesTraits && ref?.drop) bits.push(`drop: ${ref.drop}`);
      lines.push(`- ${bits.join(' · ')}`);
    }
  }

  const warnings = [];
  const limits = limitsFor(mode);
  const where = mode ? `in ${mode}` : 'here';
  for (const lane of ['image', 'video', 'audio']) {
    if (lanes[lane] <= limits[lane]) continue;
    // A zero limit is a different sentence from a small one: "0 videos" reads
    // like a counting bug, and the Director's own error for it is categorical.
    warnings.push(
      limits[lane] === 0
        ? `${lanes[lane]} ${lane} references, and the Director accepts none ${where}`
        : `${lanes[lane]} ${lane} references, and the Director accepts ${limits[lane]} ${where}`
    );
  }
  if (references.length > limits.total) {
    warnings.push(`${references.length} references, and the Director accepts ${limits.total} ${where}`);
  }

  for (const ref of references) {
    const secs = Number(ref?.duration_seconds);
    if (!Number.isFinite(secs) || secs <= 0) continue;
    if (secs < CLIP_SECONDS.min) {
      warnings.push(`a ${secs.toFixed(1)}s clip, and the Director's minimum is ${CLIP_SECONDS.min}s`);
    } else if (secs > CLIP_SECONDS.max) {
      warnings.push(`a ${secs.toFixed(1)}s clip, and the Director's maximum is ${CLIP_SECONDS.max}s`);
    }
  }
  for (const [budget, total] of [['visual', seconds.visual], ['audio', seconds.audio]]) {
    if (total > TOTAL_SECONDS[budget]) {
      warnings.push(
        `${total.toFixed(1)}s of ${budget} reference, and the Director's combined limit is ${TOTAL_SECONDS[budget]}s`
      );
    }
  }

  return { lines, warnings, images };
}

/** Warn only when separate subject entries explicitly cite members of one group. */
export function groupWarnings(subjectDefinitions, references = []) {
  const text = String(subjectDefinitions ?? '');
  const starts = [...text.matchAll(/^\s*(?:[-*]\s*)?<Subject\s+\d+>/gim)];
  const entries = starts.map((match, i) => text.slice(match.index, starts[i + 1]?.index));
  const warnings = [];
  for (const { pictures } of pictureGroups(references)) {
    const wanted = new Set(pictures);
    const citations = entries.map((entry) => new Set(
      [...entry.matchAll(/<Picture\s+(\d+)>/gi)].map((m) => Number(m[1])).filter((n) => wanted.has(n))
    ));
    if (citations.filter((refs) => refs.size).length >= 2 && !citations.some((refs) => pictures.every((n) => refs.has(n)))) {
      warnings.push(`Pictures ${pictures.join(', ')} were grouped as one subject, but the draft defines them under separate Subjects. Review Subject definitions.`);
    }
  }
  return warnings;
}

/**
 * Turn h3's "Auto detect" into a concrete mode, in code.
 *
 * SKILL.md already states this as a deterministic rule — "no images → T2VA;
 * one image tagged keyframe → I2VA; two keyframes → FL2VA; subject or style
 * references present → full reference" (REF2VA, in the Director's name for it)
 * — and everything it reads is in the
 * request. So the model was being asked to compute a fact the server already
 * had, and paying for it twice: once in the reasoning, and once in the
 * ~3,700 tokens of base guide it had to carry alongside the ~5,500 of
 * reference guide because either mode was still possible.
 *
 * That is the whole cost. `reference_files_by_mode` in config/models.yaml
 * gates the official guides on the Mode control, but "Auto detect" is both
 * the default and the one entry that has to load BOTH guides. Resolving it
 * here collapses the default case from ~13,600 tokens of system prompt to
 * ~8,100 (base modes) or ~9,900 (full reference), with nothing deleted.
 *
 * Deliberately NOT in config: this is a rule with branches, not a value, and
 * the registry stays a list of facts. It reads `reference_roles` for nothing
 * — the role names are the Director's, fixed by the same document ROLE_LABEL
 * answers to, and a role this has never heard of is treated as a reference
 * (full reference) rather than as absent, because the failure that matters is
 * writing a base-mode prompt for a brief that had references in it.
 *
 * L2VA is not reachable from here and cannot be: one keyframe is a first
 * frame and a last frame in exactly the same request. Someone who wants L2VA
 * picks it. SKILL.md's own rule does not produce it either.
 *
 * @param {string|null|undefined} mode        the Mode control as sent
 * @param {Array} references                  controls.references, may be absent
 * @returns {string|null|undefined}           the mode to use downstream
 */
export function resolveAutoMode(mode, references) {
  if (mode !== 'Auto detect') return mode;

  const refs = Array.isArray(references) ? references.filter(Boolean) : [];
  if (!refs.length) return 'T2VA';

  // Counted by picture, not by role (30 Sep 2026, a user report: "auto detect
  // is only doing ref2va"). A new tile's role defaults to `subject`, and the
  // old rule sent every non-keyframe to REF2VA, so a single picture nobody
  // re-labelled never reached I2VA. The owner's rule: no picture is T2VA, one
  // is I2VA, two or more is REF2VA, and two marked as frames is FL2VA.
  //
  // Video, audio and style still force REF2VA: none of them can be said in
  // the base guide's three core fields, and a style picture is a deliberate
  // choice that it is NOT a frame, where `subject` is only the default.
  const isPicture = (r) => labelsFor(r)[0] === 'Picture';
  if (refs.some((r) => !isPicture(r) || r.role === 'motion' || r.role === 'voice' || r.role === 'style')) return 'REF2VA';
  if (refs.some((r) => r.role && !['subject', 'keyframe'].includes(r.role))) return 'REF2VA';
  // A Character or Place label is a person's explicit "this is not a
  // frame", where the old Role picker's `subject` was only the tile default.
  if (refs.some((r) => r.picture_label && r.role === 'subject')) return 'REF2VA';

  // Pictures that say which end of the video they are (a First
  // frame / Last frame). Only when every picture is one: a character beside
  // a first frame is a reference video that opens on a frame, which is REF2VA.
  const ends = refs.map((r) => (r.role === 'keyframe' ? r.frame : null));
  if (ends.every((e) => e === 'first' || e === 'last')) {
    if (refs.length === 1) return ends[0] === 'last' ? 'L2VA' : 'I2VA';
    if (refs.length === 2 && ends.includes('first') && ends.includes('last')) return 'FL2VA';
    return 'REF2VA';
  }

  if (refs.length === 1) return 'I2VA';
  if (refs.length === 2 && refs.every((r) => r.role === 'keyframe')) return 'FL2VA';
  return 'REF2VA';
}

/**
 * Auto detect for a whole request: the mode, and the pictures' roles to go
 * with it. When one picture lands in I2VA, or two in FL2VA, the Director uses
 * them as frames whatever the tile said, so the prompt has to describe them
 * as frames too — a `subject` note there would tell the model "who appears"
 * about the picture the video literally opens on.
 */
export function resolveAutoControls(controls = {}) {
  const mode = resolveAutoMode(controls.mode, controls.references);
  if (mode === controls.mode) return controls;
  const next = { ...controls, mode };
  if (['I2VA', 'FL2VA', 'L2VA'].includes(mode) && Array.isArray(controls.references)) {
    const refs = controls.references.filter(Boolean);
    // Which end each picture is: what the person said, else by mode and order.
    const guess = (i) => (mode === 'L2VA' ? 'last' : mode === 'I2VA' ? 'first' : i === 0 ? 'first' : 'last');
    let i = 0;
    // A two-picture FL2VA whose frames the person never named is first then
    // last by tile order, as the Director's own slots are.
    const named = refs.every((r) => r.frame === 'first' || r.frame === 'last');
    next.references = controls.references.map((r) => {
      if (!r) return r;
      const at = i++;
      return { ...r, role: 'keyframe', frame: named ? r.frame : guess(at) };
    });
  }
  return next;
}
