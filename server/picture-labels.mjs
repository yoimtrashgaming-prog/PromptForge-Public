// h3 REF2VA picture labels: the person says what each picture is, code does the rest.
//
// 30 Sep 2026, the owner's idea: "select this is character 1, this is
// character 2, this image is the scenery, and have it script the grouping".
// The five-picture test that day showed what small models get wrong in
// REF2VA, and none of it is writing: they turn the man in the corner into a
// subject, write the background as a stray <Picture 2> line, and merge or
// split characters across pictures. All of that lives in Subject definitions
// and Retention analysis, and both are bookkeeping once a person has said
// which picture is which.
//
// So with picture labels:
//   - each picture carries a `picture_label`: Character 1-4, Place, Style, First
//     frame or Last frame;
//   - code numbers the subjects, writes Subject definitions from the labels,
//     and writes Retention analysis from the shots the model wrote;
//   - the model writes Summary, the shots (acting included, from the brief),
//     Soundscape and Music, plus a Keep line for any typed note. Never
//     appearance: that comes from a reader that sees each subject's pictures.
//
// Nothing is scanned and no picture goes to the writer (owner's call, 1 Oct
// 2026: the labels replace the scan). H3 sees the pictures in the Director,
// so the prompt only has to say who is in which picture.
//
// The older role + group path is untouched. Nothing here runs unless
// `controls.picture_labels`. Until 2 Oct 2026 these names said "easy"
// (`easy_mode`, `easy_role`); a browser tab opened before then still sends
// those, so both are read.

import { labelsFor } from './references.mjs';
import { boxesOf, whoFromBoxes, cropFor, boxKey } from './people-boxes.mjs';

/** The choices, in the order the picker shows them. */
export const PICTURE_LABELS = [
  { key: 'character-1', label: 'Character 1' },
  { key: 'character-2', label: 'Character 2' },
  { key: 'character-3', label: 'Character 3' },
  { key: 'character-4', label: 'Character 4' },
  { key: 'place', label: 'Place' },
  { key: 'style', label: 'Style' },
  { key: 'first-frame', label: 'First frame' },
  { key: 'last-frame', label: 'Last frame' },
  { key: 'pose', label: 'Pose' },
  // A picture with several characters in it. The writer never sees it, so
  // position is what tells them apart: digits are the characters, left to
  // right. H3 sees the picture and is told who stands where.
  { key: 'group-12', label: 'Characters 1 + 2 (1 on the left)' },
  { key: 'group-21', label: 'Characters 2 + 1 (2 on the left)' },
  { key: 'group-13', label: 'Characters 1 + 3 (1 on the left)' },
  { key: 'group-31', label: 'Characters 3 + 1 (3 on the left)' },
  { key: 'group-23', label: 'Characters 2 + 3 (2 on the left)' },
  { key: 'group-32', label: 'Characters 3 + 2 (3 on the left)' },
  { key: 'group-123', label: 'Characters 1 + 2 + 3 (left to right)' },
];
const KNOWN = new Set(PICTURE_LABELS.map((r) => r.key));
// Since 6 Oct 2026 the page picks who is in a picture with number buttons,
// tapped left to right, so any order of two to four different characters
// can arrive, not only the seven listed above.
const isGroup = (label) => /^group-[1-4]{2,4}$/.test(label) && new Set(label.slice(6)).size === label.length - 6;
const POSITIONS = { 2: ['left', 'right'], 3: ['left', 'middle', 'right'], 4: ['far left', 'middle left', 'middle right', 'far right'] };
// The same taps read top to bottom, when the person picks that order: one on
// a balcony above another, or a shot from overhead (6 Oct 2026).
const POSITIONS_Y = { 2: ['top', 'bottom'], 3: ['top', 'middle', 'bottom'], 4: ['very top', 'upper middle', 'lower middle', 'very bottom'] };
// Front to back: one carrying another piggyback, someone looking over a
// shoulder. The first tapped is the one nearest the camera.
const POSITIONS_Z = { 2: ['front', 'back'], 3: ['front', 'middle row', 'back'], 4: ['front', 'second row', 'third row', 'back'] };
// Since 7 Oct 2026 the order is optional: with none picked the numbers say
// who is in the picture and nothing about where, so no position is given.
const AXES = { x: POSITIONS, y: POSITIONS_Y, z: POSITIONS_Z };
// Past four, only boxes can say where each one stands: "furthest left",
// "second from the left" ... "furthest right". Taps stop at four, as before.
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const boxedPlaces = (count) => Array.from({ length: count }, (_, i) => (i === 0 ? 'furthest left'
  : i === count - 1 ? 'furthest right' : `${ORDINALS[i] ?? `number ${i + 1}`} from the left`));
// People boxes order a picture left to right by where they sit (13 Oct 2026),
// and go on past four: five boxed people in an I2VA frame kept a bare
// "Character 5", and the writer gave the high-five to the wrong girl.
const placesFor = (count, ref) => (boxesOf(ref).length
  ? (count > 4 ? boxedPlaces(count) : POSITIONS[count] ?? [])
  : AXES[ref?.who_axis]?.[count] ?? []);
/** "on the left", "in the middle", "at the top", "in front", "behind". */
export const placeWord = (position) => {
  if (position === 'front') return 'in front';
  if (position === 'back') return 'behind';
  // "furthest left", "second from the left": already a place on their own.
  if (/^furthest |from the left$/.test(position)) return position;
  if (/row$/.test(position)) return `in the ${position}`;
  return `${/middle/.test(position) ? 'in' : /top|bottom/.test(position) ? 'at' : 'on'} the ${position}`;
};
export const DEFAULT_PICTURE_LABEL = 'character-1';

/** The prompt-composition key for a labelled REF2VA run; the plain mode otherwise. */
export const LABELLED_PROMPT_MODE = 'REF2VA labelled';
const FRAME_MODES = new Set(['I2VA', 'FL2VA', 'L2VA']);

const isPicture = (ref) => ref && labelsFor(ref)[0] === 'Picture';
const labelOf = (ref) => {
  const label = ref?.picture_label ?? ref?.easy_role;
  return KNOWN.has(label) || isGroup(label ?? '') ? label : DEFAULT_PICTURE_LABEL;
};

/** True when this request labels its pictures. */
export function usesLabels(controls) {
  return Boolean(controls?.picture_labels ?? controls?.easy_mode);
}

/** The mode the system prompt and segment contract are looked up under. */
export function promptMode(controls = {}) {
  return usesLabels(controls) && controls.mode === 'REF2VA' ? LABELLED_PROMPT_MODE : controls.mode;
}

// Since 6 Oct 2026 a picture can be several kinds at once ("This picture is"
// became buttons): Characters 1 + 2 and the place behind them, a character
// who is also the first frame, a place drawn in the style wanted. The page
// sends them as `picture_kinds`, with the people as `who`. `picture_label`
// still arrives as the first of them, for a tab opened before; `also_place`
// was the first try at this and was sent for a few hours.
// Pose (12 Oct 2026, the owner's call): a picture that lends only a stance -
// where the arms and legs are, the gesture, which way they face - and not who
// is in it, what they wear or the background. MiniMax's REF2VA guide (2.1)
// lists "styles, actions, expressions, or poses" as <Subject N> content, so a
// pose is a subject like the place, transferred onto whoever takes it. It
// stands alone: a pose picture is nothing else. Its number buttons say who
// takes the pose, not who is in the picture.
const KINDS = ['character', 'place', 'style', 'first-frame', 'last-frame', 'pose'];

/** What a picture is, as a list of kinds in KINDS order. */
export function kindsOf(ref) {
  const label = labelOf(ref);
  const given = Array.isArray(ref?.picture_kinds) ? ref.picture_kinds.filter((k) => KINDS.includes(k)) : [];
  const kinds = new Set(given.length ? given
    : [label.startsWith('character-') || label.startsWith('group-') ? 'character' : label]);
  if (kinds.has('pose')) return ['pose'];
  if (ref?.also_place && kinds.has('character')) kinds.add('place');
  return KINDS.filter((k) => kinds.has(k));
}

/**
 * The person's few words for one character in a picture of several - "red
 * hair, guitar" - or null. Position alone did not tell a 4B reader who was
 * who: in a four-girl band picture read left to right, the far-left bassist
 * came back with the guitarist's red hair and the drummer as the girl in pink
 * (12 Oct 2026, a user's report). A description it can match does.
 */
const HINT_MAX = 80;
function hintOf(ref, num) {
  const raw = ref?.who_hints?.[num] ?? ref?.who_hints?.[String(num)];
  const hint = String(raw ?? '').replace(/["\s]+/g, ' ').trim().slice(0, HINT_MAX);
  return hint || null;
}

/**
 * How many characters the Who's in it buttons can number. Four until 12 Oct
 * 2026; a ten-character animation asked for more, and then the owner asked
 * for it to keep going, to a final cap of 70 (the page shows six and grows one
 * at a time). Positions still stop at four - past that, a short hint per
 * character says who is who (see hintOf).
 */
export const MAX_CHARACTERS = 70;

/** Who is in a picture, in tap order: its buttons, or the old label's digits. */
function tappedOf(ref) {
  // Boxes say who is in the picture, left to right by where they sit.
  const boxes = boxesOf(ref, MAX_CHARACTERS);
  if (boxes.length) return whoFromBoxes(boxes);
  const label = labelOf(ref);
  const fromLabel = label.startsWith('character-') ? [Number(label.slice(10))]
    : label.startsWith('group-') ? [...label.slice(6)].map(Number) : [];
  const given = Array.isArray(ref?.who) ? ref.who.map(Number) : [];
  const nums = Array.isArray(ref?.picture_kinds) || !fromLabel.length ? given : fromLabel;
  return [...new Set(nums.filter((n) => n >= 1 && n <= MAX_CHARACTERS))];
}

/**
 * Turn the picture labels into the roles the rest of the pipeline already reads:
 * a character's pictures share a subject group (so they are scanned together
 * and cited as one), the place is one group, a style is `style`, and a frame
 * is a `keyframe` that knows which end of the video it is. Video and audio
 * keep the role the person gave them. A picture of several kinds takes the
 * role of its first: it is a keyframe only when it is nothing but frames.
 */
export function applyPictureLabels(controls = {}) {
  if (!usesLabels(controls) || !Array.isArray(controls.references)) return controls;
  const references = controls.references.map((ref) => {
    if (!isPicture(ref)) return ref;
    const label = labelOf(ref);
    const kinds = kindsOf(ref);
    const { subject_group: _drop, frame: _frame, who_axis: _axis, ...rest } = ref;
    // A group label from before the buttons ("group-12") always meant left to
    // right; from the buttons, no order picked means no positions.
    const axis = ref.who_axis in AXES ? ref.who_axis : Array.isArray(ref.picture_kinds) ? null : 'x';
    // Kinds and people normalised together: with picture_kinds set, who is read from `who`.
    const base = { ...rest, picture_label: label, picture_kinds: kinds, who: tappedOf(ref), ...(axis ? { who_axis: axis } : {}) };
    const frame = kinds.includes('first-frame') ? 'first' : kinds.includes('last-frame') ? 'last' : null;
    // In a frame mode the Director takes every picture as a frame, so a
    // character or place picture there is still described as one (9 Oct 2026).
    if (frame && FRAME_MODES.has(controls.mode)) return { ...base, role: 'keyframe', frame };
    const framed = frame && kinds[0] !== 'first-frame' && kinds[0] !== 'last-frame' ? { frame } : {};
    // Its own subject, one per pose picture; `who` says who takes it.
    if (kinds[0] === 'pose') return { ...base, role: 'pose' };
    if (kinds[0] === 'character') {
      const who = tappedOf(ref);
      // Several subjects in one picture: no group, it belongs to each of them.
      const group = who.length === 1 && kinds.length === 1 ? { subject_group: `label-character-${who[0]}` } : {};
      return { ...base, role: 'subject', ...group, ...framed };
    }
    if (kinds[0] === 'place') return { ...base, role: 'subject', ...(kinds.length === 1 ? { subject_group: 'label-place' } : {}), ...framed };
    if (kinds[0] === 'style') return { ...base, role: 'style', ...framed };
    return { ...base, role: 'keyframe', frame };
  });
  return { ...controls, references };
}

/**
 * Who is in the video, numbered: characters first by their number, then the
 * place, then the style. Frames are not subjects; they are listed apart.
 *
 * Returns { subjects: [{ tag, kind, name, pictures, placements, refs, refPictures }], frames: [{ picture, which, ref }] }.
 * `refPictures[i]` is the picture number `refs[i]` came from.
 * A character's `pictures` are its own; `placements` are group pictures it
 * shares, each with the position it stands in: [{ picture, position }].
 * Picture numbers count images only, in order, as formatReferences does.
 */
export function labelledCast(references = []) {
  const chars = new Map();
  const place = { pictures: [], refs: [], refPictures: [] };
  const style = { pictures: [], refs: [], refPictures: [] };
  const frames = [];
  const poses = [];
  const char = (num) => {
    if (!chars.has(num)) chars.set(num, { pictures: [], placements: [], refs: [], refPictures: [], inFrames: [] });
    return chars.get(num);
  };
  let n = 0;
  for (const ref of references) {
    if (!isPicture(ref)) continue;
    n += 1;
    const kinds = kindsOf(ref);
    const tapped = tappedOf(ref);
    if (kinds[0] === 'pose') {
      // Who takes the pose, not who is in the picture: nobody in it is a subject.
      poses.push({ pictures: [n], refs: [ref], refPictures: [n], takers: tapped });
      continue;
    }
    // The "Use it for" note belongs to the first kind: on Characters 1 + 2
    // and the place, it is about the people, so the place takes the whole
    // background and none of the note.
    const plain = { ...ref, keep: null, drop: null };
    const own = (kind) => (kinds[0] === kind ? ref : plain);
    if (kinds.includes('character')) {
      if (tapped.length === 1) {
        const entry = char(tapped[0]);
        entry.pictures.push(n);
        entry.refs.push(ref);
        entry.refPictures.push(n);
      } else {
        const boxes = boxesOf(ref, MAX_CHARACTERS);
        tapped.forEach((num, i) => {
          const entry = char(num);
          const position = placesFor(tapped.length, ref)[i];
          const hint = hintOf(ref, num);
          // Their own box, read alone, places them past the four positions too.
          const crop = cropFor(boxes, num);
          entry.placements.push({ picture: n, ...(position ? { position } : {}), ...(hint ? { hint } : {}), ...(crop ? { crop } : {}) });
          entry.refs.push(ref);
          entry.refPictures.push(n);
        });
      }
    }
    if (kinds.includes('place')) {
      place.pictures.push(n);
      place.refs.push(own('place'));
      place.refPictures.push(n);
    }
    if (kinds.includes('style')) {
      style.pictures.push(n);
      style.refs.push(own('style'));
      style.refPictures.push(n);
    }
    for (const which of ['first', 'last']) {
      if (!kinds.includes(`${which}-frame`)) continue;
      // A character picture that is also a frame already names its people as
      // that picture; they are not placed in the frame a second time.
      frames.push({ picture: n, which, ref: own(`${which}-frame`), who: kinds.includes('character') ? [] : tapped });
    }
  }
  // Who is in a frame, from its Traits to keep: "Keep character 1, the
  // background and first frame" puts Character 1 in that frame (5 Oct 2026,
  // the owner's idea: no extra labels, just say it). Without this the writer
  // had to read it out of the brief, and did 1 time in 3.
  // Since 6 Oct the frame's "Who's in it" buttons say it directly (`who`);
  // the note is still read, for a tab opened before that.
  // The buttons are tapped left to right, so with two or more in a frame each
  // one's place is known, as on a character picture with several people.
  for (const f of frames) {
    const tapped = f.who;
    const places = placesFor(tapped.length, f.ref);
    const who = new Map(tapped.map((num, i) => [num, places[i] ?? null]));
    for (const num of charactersNamedIn(f.ref?.keep)) if (!who.has(num)) who.set(num, null);
    for (const [num, position] of who) {
      // The person's few words for them in this frame, as on a REF2VA picture.
      const hint = tapped.length > 1 ? hintOf(f.ref, num) : null;
      char(num).inFrames.push({ picture: f.picture, which: f.which, ...(position ? { position } : {}), ...(hint ? { hint } : {}) });
    }
  }
  const subjects = [];
  for (const num of [...chars.keys()].sort((a, b) => a - b)) {
    subjects.push({ kind: 'character', name: `Character ${num}`, number: num, ...chars.get(num) });
  }
  if (place.pictures.length) subjects.push({ kind: 'place', name: 'the place', ...place });
  // "the pose" in the brief only when there is one; with several, "picture 3".
  for (const p of poses) subjects.push({ kind: 'pose', name: poses.length === 1 ? 'the pose' : null, ...p });
  if (style.pictures.length) subjects.push({ kind: 'style', name: 'the style', ...style });
  subjects.forEach((s, i) => { s.tag = `<Subject ${i + 1}>`; });
  return { subjects, frames };
}

const joinAnd = (items) => (items.length <= 2 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const pictureList = (pictures) => joinAnd(pictures.map((p) => `<Picture ${p}>`));

/** Where a subject is shown: "in <Picture 1>, and on the left in <Picture 3>". */
function shownIn(s) {
  const own = s.pictures.length ? `in ${pictureList(s.pictures)}` : '';
  const shared = joinAnd((s.placements ?? []).map((p) =>
    `${p.position ? `${placeWord(p.position)} ` : ''}in <Picture ${p.picture}>${p.hint ? ` (${p.hint})` : ''}`));
  const framed = joinAnd((s.inFrames ?? []).map((f) => `${whereIn(f)} the ${f.which} frame <Picture ${f.picture}>`));
  const rest = joinAnd([shared, framed].filter(Boolean));
  return own && rest ? `${own}, and ${rest}` : own || rest;
}

/**
 * Where to look, for the describer. Front and back are spelt out by the
 * camera: in a piggyback the one carried is higher in the frame, and asked
 * for "the one in front" the reader described her, not him (6 Oct 2026).
 */
const describeWhere = (position) =>
  position === 'front' ? 'in front, nearest the camera'
    : position === 'back' ? 'behind, further from the camera than the other'
      : placeWord(position);

/** "in" for one person in a frame, "on the left in" when several stand in it. */
function whereIn(f) {
  if (!f.position) return 'in';
  return `${placeWord(f.position)} in`;
}

/**
 * The brief for a frame mode (I2VA, FL2VA, L2VA) with picture labels:
 * "Character 1" becomes who the frame's buttons say that is — "the character
 * in front in the first frame". Those modes have no Subject definitions, so
 * without this the names reached the writer as bare words and it guessed
 * which person was which (6 Oct 2026). Names the frames do not place are
 * left as written.
 */
export function framedBrief(brief, cast) {
  const phrase = framePhrases(cast);
  if (!phrase.size) return String(brief ?? '');
  return String(brief ?? '').replace(/\b(?:character|char)\s*#?\s*(\d{1,2})\b/gi, (m, d) => phrase.get(Number(d)) ?? m);
}

/** Character number -> "the character on the left in the first frame", for the characters a frame places. */
function framePhrases(cast) {
  const phrase = new Map();
  for (const s of cast.subjects) {
    // A frame that is also a Character picture names its people as that
    // picture rather than in inFrames: find the frame by its picture number.
    const own = [...s.pictures, ...(s.placements ?? []).map((p) => p.picture)];
    const fromPicture = () => {
      const fr = cast.frames.find((x) => own.includes(x.picture));
      if (!fr) return null;
      const position = (s.placements ?? []).find((p) => p.picture === fr.picture)?.position;
      return { which: fr.which, ...(position ? { position } : {}) };
    };
    const f = (s.inFrames ?? [])[0] ?? fromPicture();
    if (!f || s.kind !== 'character') continue;
    phrase.set(s.number, `the character ${f.position ? `${placeWord(f.position)} ` : ''}in the ${f.which} frame`);
  }
  return phrase;
}

// ── the Cast list: one description per character, written on the page ────
//
// 13 Oct 2026, the owner's idea. The page keeps a card per character with a
// description the reader fills from their pictures (their people box, where
// they have one) and the person can edit: "green eyes, not blue". That text
// IS the character's look from then on. In REF2VA it goes into Subject
// definitions as written, and Retention's kept list is made from it, so
// fixing the card fixes what the video model is told. A character with an
// empty card is read at Generate, as before.

/**
 * What the writer is told about a card against the brief. A card is read
 * once, with the brief as it was then, and not again when the brief
 * changes; one edited by hand never is. Without this, "never contradict
 * it" kept the card's blue dress after the brief said red. Ported from the
 * H3 Forge (Dark, 14 Oct 2026). Costs no reads.
 */
export const CARD_PRIORITY = 'where the brief explicitly changes a trait (an outfit, hair, the setting, the style or the pose), the brief wins for that trait and every other trait stays as written. Never combine a replaced trait with its replacement.';

/** How long a card's text may be. Not cut by sentences: the person wrote it. */
export const CAST_TEXT_MAX = 600;

/** A scene card's key: "place", "style", or "pose@3" for the pose in <Picture 3>. */
export const SCENE_KEY = /^(?:place|style|pose@([1-9]\d?))$/;

/**
 * The cards the page sent: Map(character number -> text), and since 14 Oct
 * 2026 the scene's cards too, under "place", "style" and "pose@N" (the
 * owner's call: one revamp of how the model sees and describes the
 * pictures, built in the H3 Forge first). Empty cards are not cards.
 */
export function givenCast(controls = {}) {
  const out = new Map();
  const given = controls?.cast;
  if (!given || typeof given !== 'object') return out;
  for (const [k, v] of Object.entries(given)) {
    const text = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, CAST_TEXT_MAX);
    if (!text) continue;
    if (SCENE_KEY.test(k)) {
      out.set(k, text);
      continue;
    }
    const n = Number(k);
    if (Number.isInteger(n) && n >= 1 && n <= MAX_CHARACTERS) out.set(n, text);
  }
  return out;
}

/** Only the characters' cards: Map(number -> text). */
export function characterCards(given = new Map()) {
  return new Map([...given].filter(([k]) => typeof k === 'number'));
}

/** The card key a scene subject goes by: "place", "style", "pose@N"; null for a character. */
export function sceneKeyOf(s) {
  if (s.kind === 'place' || s.kind === 'style') return s.kind;
  if (s.kind === 'pose') return `pose@${s.pictures[0]}`;
  return null;
}

/**
 * A card's text as a kept list for Retention: "A young woman with long green
 * hair. She wears a red dress." -> "long green hair, a red dress". Each
 * sentence the way traitsOf does one, with a leading "She"/"He" dropped.
 */
export function keptFromLook(text) {
  const sentences = String(text ?? '').match(/[^.!?]+[.!?]*/g) ?? [];
  const parts = sentences
    .map((s) => traitsOf(s).replace(/^(?:she|he|they|it)\b[\s,]*(?:(?:also\s+)?(?:has|have|is|are)\b\s*)?/i, '').replace(/^[,\s]+|[.!\s]+$/g, ''))
    .filter(Boolean);
  return parts.join(', ');
}

/** A card's text as a description entry: used as written, never cut to two sentences. */
export function writtenDescription(text) {
  const look = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, CAST_TEXT_MAX);
  return { look: /[.!?]["')\]]*$/.test(look) ? look : `${look}.`, kept: keptFromLook(look), written: true };
}

/**
 * The cards that belong to this cast: Map(subject tag -> description entry).
 * A character's Retention kept list is made from their card. A place or
 * style card is prose about a whole picture, and made into a kept list it
 * read "A grand, sunlit dining hall … are retained" (the Forge, 14 Oct 2026),
 * so it keeps the stock wording. A pose card keeps only the stance.
 */
export function castDescriptions(cast, given = new Map()) {
  const out = new Map();
  for (const s of cast.subjects) {
    if (s.kind === 'character') {
      if (given.has(s.number)) out.set(s.tag, writtenDescription(given.get(s.number)));
      continue;
    }
    const text = given.get(sceneKeyOf(s));
    const look = text && (s.kind === 'pose' ? poseOnly(text) : text);
    if (look) out.set(s.tag, { ...writtenDescription(look), kept: '' });
  }
  return out;
}

/**
 * The describe units still to read once the cards are in: a character with a
 * card is never read, and a group picture whose people all have one is not
 * read either.
 */
export function unitsToRead(units, cast, given = new Map()) {
  const written = castDescriptions(cast, given);
  return units.filter((u) => (u.kind === 'group'
    ? !(u.members ?? []).length || !(u.members ?? []).every((n) => given.has(n))
    : !written.has(u.tag)));
}

/**
 * The unit the reader reads one character from, for a card: their own unit,
 * or a group picture they share with nobody placed, with their place in it.
 * { unit, index } with index set for a group; null when no picture shows them.
 */
export function castUnit(cast, units, number) {
  const s = cast.subjects.find((x) => x.kind === 'character' && x.number === number);
  if (!s) return null;
  const own = units.find((u) => u.tag === s.tag);
  if (own) return { unit: own, index: null };
  const g = groupOf(cast, s);
  const unit = g && units.find((u) => u.tag === groupTag(g.picture));
  return unit ? { unit, index: g.members.indexOf(s), people: g.members.length } : null;
}

/**
 * The unit the reader reads for the place, the style or the pose in a
 * picture ("pose@3"), for a scene card; null when the pictures have no such
 * thing or it has no image. { unit, index: null, kind }.
 */
export function sceneUnit(cast, units, key) {
  if (!SCENE_KEY.test(String(key ?? ''))) return null;
  const s = cast.subjects.find((x) => sceneKeyOf(x) === key);
  const unit = s && units.find((u) => u.tag === s.tag);
  return unit ? { unit, index: null, kind: s.kind } : null;
}

/**
 * One card out of what the reader said: a character's line of a group
 * reading, a pose's stance only, or the two sentences. A character card
 * never opens with their name or place (unnamed).
 */
export function castLook(text, found) {
  if (found?.index != null) return unnamed(groupLines(text, found.people)?.[found.index] ?? '');
  if (found?.kind === 'pose') return poseOnly(splitDescription(text, 4).look);
  const look = splitDescription(text).look;
  return found?.kind === 'place' || found?.kind === 'style' ? look : unnamed(look);
}

// "Character 2 is a young woman with…", "The character on the left has…":
// the brief names them, and r4 opens with the name (the Forge, 14 Oct 2026).
// The card goes into the prompt as written, and H3 cannot place "Character
// 2", so the opening is said the way the reader is asked to write it.
const NAMED = /^\s*(?:the\s+)?character(?:\s+\d+|\s+(?:on|in|at)\s+the\s+[\w -]+?)?\s+(is|has)\s+/i;

/** A character card without the name or position it opens with. */
export function unnamed(look) {
  const t = String(look ?? '');
  const m = t.match(NAMED);
  if (!m) return t;
  const rest = t.slice(m[0].length);
  return m[1].toLowerCase() === 'is' ? cap(rest) : `A character with ${rest}`;
}

/**
 * The cards, for the writer in a frame mode (I2VA, FL2VA, L2VA). Those modes
 * have no Subject definitions, and the brief's "Character 1" has already been
 * turned into where they stand (framedBrief), so the look is said beside that.
 */
export function framedCastLines(cast, given = new Map()) {
  const phrase = framePhrases(cast);
  const lines = [];
  for (const s of cast.subjects) {
    if (s.kind !== 'character' || !given.has(s.number)) continue;
    const who = phrase.get(s.number);
    // Where they stand only, never "Character 2": the brief no longer says it,
    // and given both, the writer put "(Character 2)" into the prompt, which H3
    // cannot place (13 Oct 2026).
    lines.push(`- ${who ? cap(who) : s.name}: ${writtenDescription(given.get(s.number)).look}`);
  }
  if (!lines.length) return [];
  return ['', `Cast, as the person describes them. Keep everyone looking like this in every shot, and never contradict it, except: ${CARD_PRIORITY}`, ...lines];
}

/** Character numbers a frame's note names: "character 1", "Char 2", "characters 1 and 3". */
export function charactersNamedIn(text = '') {
  const out = new Set();
  for (const m of String(text ?? '').matchAll(/\bchar(?:acter)?s?\s*#?\s*(\d{1,2}(?:\s*(?:,|&|\+|and)\s*\d{1,2})*)\b/gi)) {
    for (const d of m[1].match(/\d{1,2}/g)) if (Number(d) >= 1 && Number(d) <= MAX_CHARACTERS) out.add(Number(d));
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * The brief's names become the tags the model must cite: "Character 2" ->
 * <Subject 2>, "the place" -> the place's subject, "picture 3" -> <Picture 3>.
 * Only what the cast actually has; "Character 3" with no Character 3 picture,
 * or "picture 9" past the last picture, is left as the person wrote it.
 */
export function labelledBrief(brief = '', cast) {
  const byNumber = new Map(cast.subjects.filter((s) => s.kind === 'character').map((s) => [s.number, s.tag]));
  const place = cast.subjects.find((s) => s.kind === 'place')?.tag;
  const lastPicture = Math.max(0, ...cast.subjects.flatMap((s) => [...s.pictures, ...(s.placements ?? []).map((p) => p.picture)]),
    ...cast.frames.map((f) => f.picture));
  let text = String(brief).replace(/\b(?:character|char)\s*#?\s*(\d{1,2})\b/gi, (m, d) => byNumber.get(Number(d)) ?? m);
  // "the place" only, never a bare "place": "takes place" and "in place of"
  // are ordinary English.
  if (place) text = text.replace(/\bthe (?:place|scenery|location)\b/gi, place);
  // "the pose", like "the place", when there is exactly one.
  const pose = cast.subjects.find((s) => s.kind === 'pose' && s.name === 'the pose')?.tag;
  if (pose) text = text.replace(/\bthe pose\b/gi, pose);
  return text.replace(/(?<!<)\b(?:picture|pic|image)\s*#?\s*(\d+)\b(?!>)/gi,
    (m, d) => (Number(d) >= 1 && Number(d) <= lastPicture ? `<Picture ${Number(d)}>` : m));
}

/**
 * What the person typed in Traits to keep / Traits to drop, per picture, as
 * one clause: "from <Picture 2>, keep: a braided bun; from <Picture 3>,
 * leave out: the hat". Empty when nothing was typed.
 *
 * Only typed text arrives here: a tagger-filled Traits to keep is left out
 * in the browser before the request is sent (1 Oct 2026). Until 5 Oct 2026
 * typed text went only to the writer's cast line, so the Subject definitions
 * and Retention analysis that code writes, which H3 actually follows, never
 * carried it: a user typed "her side profile for her haircut, a braided bun"
 * and got fully_preserved with no mention of either.
 */
function typedNotes(pairs) {
  const clean = (v) => String(v ?? '').trim().replace(/[.;,\s]+$/, '');
  const parts = [];
  for (const { picture, ref } of pairs) {
    const keep = clean(ref?.keep);
    const drop = clean(ref?.drop);
    if (keep) parts.push(`from <Picture ${picture}>, keep: ${keep}`);
    if (drop) parts.push(`from <Picture ${picture}>, leave out: ${drop}`);
  }
  return [...new Set(parts)].join('; ');
}

/** A subject's pictures paired with the reference each came from. */
function picturesWithRefs(s) {
  return s.refs.map((ref, i) => ({ picture: s.refPictures?.[i], ref })).filter((p) => p.picture);
}

// ── descriptions: two sentences per subject or frame (5 Oct 2026) ─────────

const DESCRIBE_KIND = { character: 'a character', place: 'the place', style: 'a style', pose: 'a pose', frame: 'a frame of the video' };

/**
 * What to describe: one unit per subject (all its pictures together) and per
 * frame, only where the pictures carry an image. Shaped like readingUnits so
 * the same reader runs them; `role` carries the kind, which also keeps these
 * apart from full readings in the picture cache.
 */
export function describeUnits(cast) {
  const units = [];
  const add = (tag, kind, pairs, framed = []) => {
    const withImage = pairs.filter((p) => p.ref?.image);
    const frames = framed.filter((p) => p.ref?.image);
    if (!withImage.length && !frames.length) return;
    units.push({
      tag,
      kind,
      // What the brief calls it: "Character 2", "the place".
      name: cast.subjects.find((s) => s.tag === tag)?.name ?? null,
      // A character seen in a frame is read with that frame: a different job,
      // so a different cache entry.
      role: `describe-${kind}${frames.length ? '-framed' : ''}`,
      labels: [...frames, ...withImage].map((p) => `<Picture ${p.picture}>`),
      refs: [...frames, ...withImage].map((p) => p.ref),
      frames: frames.length,
      // The box each picture is read from, or null for the whole picture.
      // The server cuts the crops just before the read (people-boxes.mjs).
      crops: [...frames.map((p) => p.crop ?? null), ...withImage.map((p) => p.crop ?? null)],
      // A frame's hint for this character, for a frame read from their crop.
      frameHints: frames.map((p) => p.hint ?? null),
    });
  };
  for (const s of cast.subjects) {
    // A character the person put in a frame ("Keep character 1, …" on the
    // frame's note) is read from that frame as well. Read from its own
    // pictures alone, a picture there only for the haircut described the
    // hair and nothing else, and the outfit she wears in the video was never
    // said (5 Oct 2026).
    // A frame with people boxes is read from this character's box in it
    // (I2VA, FL2VA and L2VA, 13 Oct 2026).
    const framed = (s.inFrames ?? []).map((f) => {
      const ref = cast.frames.find((x) => x.picture === f.picture)?.ref;
      return { picture: f.picture, ref, crop: s.kind === 'character' ? cropFor(boxesOf(ref, MAX_CHARACTERS), s.number) : null, hint: f.hint ?? null };
    });
    // A picture of several people with no order picked cannot say which one
    // this is, so it is not read for them: it would describe the others too.
    // A hint the person gave places them as well as a position does.
    // Their own box places them too: it is read alone.
    const unplaced = new Set((s.placements ?? []).filter((p) => !p.position && !p.hint && !p.crop).map((p) => p.picture));
    // A character with a box of their own in a picture is read from the crop.
    const own = picturesWithRefs(s).filter((p) => !unplaced.has(p.picture))
      .map((p) => (s.kind === 'character' ? { ...p, crop: cropFor(boxesOf(p.ref, MAX_CHARACTERS), s.number) } : p));
    add(s.tag, s.kind, own, framed);
    // Which of several people in a picture is this one: in a frame, and in a
    // picture of several characters side by side.
    const unit = units.at(-1);
    if (unit?.tag === s.tag && s.kind === 'pose') unit.takers = (s.takers ?? []).length;
    if (unit?.tag === s.tag) {
      if (unit.frames) unit.framePosition = (s.inFrames ?? []).find((f) => f.position)?.position ?? null;
      const placeOf = new Map((s.placements ?? []).map((p) => [`<Picture ${p.picture}>`, p]));
      // Everyone else's place or hint in each picture, so the describer can be told whom NOT to describe.
      const othersIn = (n) => cast.subjects
        .filter((o) => o !== s)
        .flatMap((o) => (o.placements ?? []).filter((x) => x.picture === n && (x.position || x.hint)))
        .map((x) => ({ position: x.position ?? null, hint: x.hint ?? null }));
      unit.placements = unit.labels
        .map((label, i) => {
          const p = placeOf.get(label);
          // A cropped picture shows this one person, so no "the one on the left".
          return i >= (unit.frames ?? 0) && p && !unit.crops[i]
            ? { index: i + 1, position: p.position ?? null, hint: p.hint ?? null, others: othersIn(Number(label.match(/\d+/)[0])) }
            : null;
        })
        .filter(Boolean);
      // The person's few words for someone read from a crop: the crop shows
      // them, and the hint says what to look for when a neighbour shows too.
      unit.cropHints = unit.crops.map((c, i) => (!c ? null
        : i < (unit.frames ?? 0) ? unit.frameHints?.[i] ?? null
          : placeOf.get(unit.labels[i])?.hint ?? null));
      // Two people in one picture are the same picture and notes, so without
      // this the second was answered from the first one's cache entry: in a
      // piggyback test both got the girl's description (6 Oct 2026). A crop
      // is its own picture, so its box is part of the key too.
      const where = [unit.framePosition, ...unit.placements.map((p) => `${p.index}:${p.position ?? ''}:${p.hint ?? ''}`),
        ...unit.crops.map((c, i) => (c ? `${i + 1}#${boxKey(c)}${unit.cropHints[i] ? `:${unit.cropHints[i]}` : ''}` : null))].filter(Boolean).join(',');
      if (where) unit.role = `${unit.role}@${where}`;
    }
  }
  for (const f of cast.frames) add(`<Picture ${f.picture}>`, 'frame', [{ picture: f.picture, ref: f.ref }]);
  // A picture of several characters with neither an order nor a hint: nobody
  // in it can be read alone, so until 12 Oct 2026 it was not read at all, and
  // the prompt never said what anyone in it looked like (a user, "doesn't even
  // look like it saw the image"). Read once as a group instead; each of them
  // gets that reading, marked as the whole picture.
  for (const g of groupPictures(cast)) {
    if (!g.ref?.image) continue;
    units.push({
      tag: groupTag(g.picture),
      kind: 'group',
      name: null,
      role: `describe-group@${g.picture}:${g.members.length}`,
      labels: [`<Picture ${g.picture}>`],
      refs: [g.ref],
      frames: 0,
      people: g.members.length,
      // Who is in it, by number: a group whose people all have a card is not read.
      members: g.members.map((m) => m.number),
      maxTokens: Math.min(640, 90 * g.members.length + 120),
    });
  }
  return units;
}

/** The key a group reading is kept under: not "<Picture N>", which a frame may also be. */
const groupTag = (picture) => `<Picture ${picture}> people`;
/** A group reading says a sentence per person; everything else keeps to two. */
const sentencesFor = (tag) => (/> people$/.test(String(tag)) ? 12 : 2);
/** A description entry as { look, kept }: a reader's answer is split and cut, a card's is already. */
const readOf = (entry, tag) => (entry && typeof entry === 'object' ? entry : splitDescription(entry, sentencesFor(tag)));

/**
 * Pictures of several characters that nobody placed: no order picked and no
 * hint given for anyone in them. [{ picture, ref, members: [subject] }].
 */
function groupPictures(cast) {
  const byPicture = new Map();
  for (const s of cast.subjects) {
    if (s.kind !== 'character') continue;
    (s.placements ?? []).forEach((p) => {
      const g = byPicture.get(p.picture) ?? { picture: p.picture, ref: null, members: [], placed: false };
      g.members.push(s);
      if (p.position || p.hint || p.crop) g.placed = true;
      const i = s.refPictures.indexOf(p.picture);
      if (i >= 0) g.ref = s.refs[i];
      byPicture.set(p.picture, g);
    });
  }
  return [...byPicture.values()].filter((g) => !g.placed && g.members.length > 1);
}

/** The group a subject shares an unplaced picture with, or null. */
function groupOf(cast, s) {
  return groupPictures(cast).find((g) => g.members.includes(s)) ?? null;
}

/**
 * A group reading split per person: "1: ..." to "N: ...", left to right, as
 * the reader is asked to write it. null unless all N are there. Given them
 * whole, every character's definition repeated the same paragraph (a user,
 * 12 Oct 2026: "it repeated the same thing twice").
 */
export function groupLines(text, people) {
  const found = new Map();
  for (const raw of String(text ?? '').split('\n')) {
    const m = raw.match(/^\s*\**\s*(?:character\s*|person\s*)?(\d{1,2})\s*\**\s*[:.)\-–—]\s*\**\s*(.+)$/i);
    if (m && !found.has(Number(m[1]))) found.set(Number(m[1]), twoSentences(m[2]));
  }
  const lines = Array.from({ length: people }, (_, i) => found.get(i + 1));
  return lines.every(Boolean) ? lines : null;
}

/**
 * One person's line as a list of traits for Retention: "A young man with short
 * dark hair and brown eyes wears a white collared shirt and a blue tie." ->
 * "short dark hair and brown eyes, a white collared shirt and a blue tie".
 * Who they are and the verbs go; what is kept stays as the reader said it.
 */
export function traitsOf(line) {
  let t = String(line ?? '').trim().replace(/[.!\s]+$/, '');
  t = t.replace(/^(?:an?|the)\s+(?:[\w-]+\s+){0,3}?(?:man|woman|girl|boy|person|character|child|kid|teen\w*|lady|guy|figure)\b\s*(?:with\s+)?/i, '');
  // An "and" before it goes too: "blue eyes, and wears a white dress" read
  // "blue eyes, and, a white dress" (the Forge, 14 Oct 2026).
  t = t.replace(/\s*,?\s*\b(?:and\s+)?(?:is\s+)?(?:wears|wearing|dressed in|clad in)\b\s*/gi, ', ');
  t = t.replace(/^[,\s]+/, '').replace(/\s*,\s*,\s*/g, ', ').replace(/,\s*and\s+/g, ' and ');
  return t;
}

/** "on the left", "the third from the left": the k-th of n, counted left to right. */
function fromTheLeft(k, n) {
  const place = POSITIONS[n]?.[k];
  if (place) return placeWord(place);
  const ordinal = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'][k] ?? `number ${k + 1}`;
  return `${ordinal} from the left`;
}

/**
 * What a group reading says about one of its people. Split per person when
 * the reader numbered its lines: the k-th tapped is the k-th from the left,
 * the order the buttons are tapped in and the order the hints are written in.
 * Otherwise the whole reading, said once, under the first of them.
 */
function groupShare(g, s, read) {
  const k = g.members.indexOf(s);
  const lines = groupLines(read, g.members.length);
  if (lines) return { where: fromTheLeft(k, g.members.length), look: lines[k], whole: false };
  return { where: null, look: k === 0 ? splitDescription(read, 12).look : '', whole: true };
}

/** The reader's message for one unit: what the person said it is, and what they want kept. */
export function describeMessage(unit, brief = '') {
  const frames = unit.frames ?? 0;
  // The person's brief, read with the picture (7 Oct 2026). It says what
  // things are (a field the picture alone shows as flowers is a cornfield)
  // and what changes: "the male has orange hair" was ignored, because the
  // description said the picture's hair and Retention kept it.
  const told = String(brief ?? '').trim().slice(0, 1500);
  const it = unit.name ? `"${unit.name}"` : unit.kind === 'pose' ? 'this pose' : unit.kind === 'group' ? 'these characters' : 'this frame';
  const briefLines = told ? [
    `The person's brief for the video${unit.name ? `, where this is ${it}` : ''}:\n"""\n${told}\n"""`,
    `Use the brief to know what you are looking at, and call things what it calls them. Where it changes how ${it} looks, such as hair, eyes or clothes, describe it the way the brief says, not as the picture shows, and leave the changed traits out of Kept. Anything the brief does not mention, describe as the picture shows.`,
  ] : [];
  const own = unit.refs.slice(frames);
  const keep = [...new Set(own.map((r) => String(r.keep ?? '').trim()).filter(Boolean))];
  const drop = [...new Set(own.map((r) => String(r.drop ?? '').trim()).filter(Boolean))];
  const ordinal = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth'];
  // Pictures with several people: which one this character is, by place.
  // First in the message and explicit about whom to leave out: told only
  // "the one in front", the reader still described the more prominent person
  // behind him in a piggyback (6 Oct 2026).
  // The person's hint wins over the position where both are given: a small
  // reader matches "red hair, guitar" where it could not find "middle left".
  const theOne = (p) => (p.hint ? `the one the person describes as "${p.hint}"` : `the one ${describeWhere(p.position)}`);
  const placed = (unit.placements ?? []).map((p) => {
    const which = ordinal[p.index - 1] ?? `number ${p.index}`;
    const not = (p.others ?? []).map(theOne).join(' or ');
    return `The ${which} picture shows ${(p.others?.length ?? 0) + 1} people. Describe ONLY ${theOne(p)}${not ? `, not ${not}` : ''}. Every detail you give must belong to that one person.`;
  });
  // A picture cut to one person's box (people-boxes.mjs). Bits of a neighbour
  // can show at the edges; the person is the one it was cut around.
  // The character's own pictures here; a frame cut to them is said below.
  const cut = (unit.crops ?? []).map((c, i) => (c && i >= frames ? i + 1 : null)).filter(Boolean);
  if (cut.length) {
    const which = cut.map((i) => ordinal[i - 1] ?? `number ${i}`);
    placed.push(`The ${joinAnd(which)} ${cut.length === 1 ? 'picture is' : 'pictures are'} cut from a picture of several people, around this one person. Describe only the person it is cut around, not anyone showing at the edges.`);
    // A hint the person gave for them, when a neighbour shows in the crop too.
    const hint = cut.map((i) => unit.cropHints?.[i - 1]).find(Boolean);
    if (hint) placed.push(`The person describes them as "${hint}": that is who to describe.`);
  }
  const lines = [];
  if (frames) {
    // The frame is how the character looks in the video; their own pictures
    // supply only what the person asked to keep from them.
    // A frame cut to this character's people box: the crop shows them, so
    // no "the one on the left" (13 Oct 2026).
    const frameCut = (unit.crops ?? []).slice(0, frames).some(Boolean);
    const who = unit.framePosition && !frameCut ? `the character ${describeWhere(unit.framePosition)}` : 'the character';
    if (frameCut) {
      lines.push(
        `The first ${frames === 1 ? 'picture is a frame' : `${frames} pictures are frames`} of the video, cut around the one person to describe: their face, build, hair and what they are wearing, colours included.`,
        'Describe only the person it is cut around, not anyone showing at the edges. Every detail you give must belong to them.'
      );
      const hint = (unit.cropHints ?? []).slice(0, frames).find(Boolean);
      if (hint) lines.push(`The person describes them as "${hint}": that is who to describe.`);
    } else {
      lines.push(
        frames === 1
          ? `The first picture is a frame of the video, and ${who} in it is the one to describe: their face, build, hair and what they are wearing, colours included.`
          : `The first ${frames} pictures are frames of the video, and ${who} in them is the one to describe: their face, build, hair and what they are wearing, colours included.`
      );
      if (unit.framePosition) lines.push('Describe ONLY that one person, not anyone else in the frame. Every detail you give must belong to them.');
    }
    if (own.length && keep.length) lines.push(`The other ${own.length === 1 ? 'picture is' : 'pictures are'} a reference for: ${keep.join('; ')}. Describe that from ${own.length === 1 ? 'it' : 'them'}, in place of what the frame shows, and the rest from the frame.`);
    else if (own.length) lines.push(`The other ${own.length === 1 ? 'picture shows' : 'pictures show'} the same character.`);
    if (drop.length) lines.push(`The person wants to leave out: ${drop.join('; ')}.`);
    lines.push(...placed, ...briefLines);
    lines.push('Describe the whole character, not only the kept part. One or two sentences.');
    return lines.join('\n');
  }
  lines.push(...placed);
  if (unit.kind !== 'group') lines.push(`This shows ${DESCRIBE_KIND[unit.kind] ?? 'a subject'}.`);
  // Said here as well as in the instruction: told only there, a 27B still
  // kept "holding a fishing rod" and "sits on a pier" as her traits (6 Oct 2026).
  if (unit.kind === 'character') {
    lines.push('Describe how they look, never what they are doing, holding or sitting on, or where they are: the video puts them in a new scene.');
  }
  // The place from a picture of the characters: they are described on their own.
  if (unit.kind === 'group') {
    // "Who they are" first (12 Oct 2026): asked only for hair, eyes, build
    // and clothes, r4's lines began "Short dark purple hair...", never said
    // "a young man", and the writer had him open "her brown eyes".
    lines.push(`It shows ${unit.people} characters. Describe each of them in turn, left to right, one line each, starting with their number and a colon: "1:" for the one furthest left, then "2:" and so on. Each line starts with who they are - a young man, a woman, a girl - then their hair (colour, length, style), eyes, build and what they are wearing, colours included. Never what they are doing or where they are: the video puts them in a new scene.`);
  }
  if (unit.kind === 'style') {
    // Told only "This shows a style.", r4 described what was in the style
    // picture - the woman, her rod, the cat - in 10 of 18 reads, and the
    // writer put the pier's lantern light into a sunlit dining hall.
    // The medium first (the owner's call, 15 Oct 2026): anime against
    // semi-real changes everything else. Light only as how soft or harsh it
    // is: asked for "lighting", r4 brought the lantern back in as the light.
    // "photograph, realistic 3D" first in the list made r4 call a photo-real
    // render "Realistic 3D" 3 of 3; this list, 12 of 12 media right and
    // 1 of 12 naming what is in it, against 10 of 18 with no line.
    lines.push('Start with the medium in a few words: photorealistic, 3D render, semi-realistic, anime, cel-shaded, flat 2D illustration, painterly illustration, oil painting, watercolour, pixel art. Then the linework, the shading and the colour palette, and light only as how soft or harsh it is. Never what is in the picture, no people, animals, objects, places or light sources: the video has its own content and takes only the look.');
  }
  if (unit.kind === 'pose') {
    // Stance only, said twice over (12 Oct 2026): told "not who it is" once,
    // r4 still wrote "the figure on the left has long lavender hair in a thick
    // braid" into a two-person pose, and that line goes into the prompt as the
    // pose the owner's characters take.
    const n = unit.takers ?? 0;
    lines.push('Describe only the pose: the stance, where the arms and legs are, the gesture, the tilt of the head and which way they face.');
    if (n > 1) lines.push(`It shows ${n} people posing together. Give each one's pose, calling them only "the one on the left", "the one on the right" and so on, and say how they stand to each other.`);
    lines.push('Never their hair, eyes, face, skin, body, clothes, colours or the background, not even to tell them apart: other characters take this pose. The Kept line lists the stance and gesture only.');
  }
  // A place picture that also shows the characters, by its kinds. Until 14
  // Oct 2026 this looked only at also_place, which the page stopped sending
  // on 6 Oct, so the setting-only line never went out.
  if (unit.kind === 'place' && unit.refs.some((r) => kindsOf(r).includes('character'))) {
    lines.push('Describe only the setting: the location, its layout, light and time of day. Leave out the people in it; they are described separately.');
  }
  if (unit.refs.length > 1) lines.push(`These ${unit.refs.length} pictures show the same ${unit.kind === 'character' ? 'character' : 'thing'}; describe it once.`);
  // A note typed on one of several pictures is about that picture: "her
  // face" on a close-up beside a full-body shot. Said for all of them, the
  // reader described only her face and the outfit from the other picture was
  // lost (14 Oct 2026, a Cast card read from two pictures).
  const notes = own.map((r) => ({ keep: String(r.keep ?? '').trim(), drop: String(r.drop ?? '').trim() }));
  const perPicture = own.length > 1 && new Set(notes.map((x) => `${x.keep}\0${x.drop}`)).size > 1;
  if (perPicture) {
    notes.forEach((x, i) => {
      const which = ordinal[i] ?? `number ${i + 1}`;
      if (x.keep) lines.push(`From the ${which} picture, take only: ${x.keep}.`);
      if (x.drop) lines.push(`From the ${which} picture, leave out: ${x.drop}.`);
    });
    lines.push('Take everything else from the other pictures.');
  } else {
    if (keep.length) lines.push(`The person wants to keep: ${keep.join('; ')}.`);
    if (drop.length) lines.push(`The person wants to leave out: ${drop.join('; ')}.`);
  }
  lines.push(...briefLines);
  lines.push(unit.kind === 'group' ? `${unit.people} numbered lines, one per character, then the Kept line.` : 'One or two sentences.');
  return lines.join('\n');
}

/** At most two sentences (more for a group, one per person), whatever came back. */
export function twoSentences(text, max = 2) {
  // A 27B's reading came back "A young woman with auburn hair… Final Answer: A
  // young woman with auburn hair…", and both went into Subject definitions
  // (12 Oct 2026). The label goes, and a sentence said twice counts once.
  const t = String(text ?? '').replace(/\s+/g, ' ').replace(/\bfinal answer\s*:\s*/gi, '').trim();
  if (!t) return '';
  const said = new Set();
  const parts = (t.match(/[^.!?]+[.!?]+(?:["')\]]+)?/g) ?? [t])
    .map((p) => p.trim())
    .filter((p) => {
      const key = p.toLowerCase();
      if (said.has(key)) return false;
      said.add(key);
      return true;
    });
  const out = parts.slice(0, max).join(' ');
  return /[.!?]["')\]]*$/.test(out) ? out : `${out}.`;
}

/**
 * The reader's answer, split: the look (two sentences, for Subject
 * definitions) and its closing "Kept:" line, the traits as one list for
 * Retention analysis ("her long dark hair, blue cardigan and silver
 * necklace"). A reader that leaves the line off gets the stock wording.
 */
export function splitDescription(text, sentences = 2) {
  const t = String(text ?? '');
  const line = /^[ \t]*\**kept\**[ \t]*:\**[ \t]*(.+)$/im;
  const m = t.match(line);
  const kept = m ? m[1].trim().replace(/[.;,\s]+$/, '') : '';
  return {
    // Every Kept line out of the look: a reader wrote it twice (6 Oct 2026).
    look: twoSentences(t.replace(new RegExp(line.source, 'gim'), ''), sentences),
    kept: kept.length <= 400 ? kept : '',
  };
}

const notesOf = (refs) => {
  const keep = [...new Set(refs.map((r) => String(r?.keep ?? '').trim()).filter(Boolean))];
  const drop = [...new Set(refs.map((r) => String(r?.drop ?? '').trim()).filter(Boolean))];
  return { keep: keep.join('; '), drop: drop.join('; ') };
};

/**
 * A pose reading with every clause about looks taken out: hair, eyes, skin,
 * clothes and colours. The owner's call (12 Oct 2026), "we are just going for
 * pose": told plainly, r4 still wrote "the woman's long lavender braid... the
 * man's silver hair" into a back-to-back pose in 1 run of 3, and that line is
 * what H3 applies to the person's own characters. A prompt asks; this makes
 * sure. Clauses, not sentences: "facing the viewer while her long hair flows
 * down her back" keeps the facing. "face" is not on the list - "facing
 * forward" is a pose.
 */
// Not "eyes": "eyes closed" is part of a pose, and an eye colour is caught by
// the colour (r4's "head tilted down and eyes closed" went whole, 12 Oct 2026).
const LOOKS = /\b(?:hair\w*|braid\w*|ponytails?|pigtails?|twintails?|bangs|fringe|ahoge|eyelashes|eyebrows?|irises|pupils|skin|freckles?|makeup|tattoos?|clothes|clothing|outfits?|dress(?:es)?|skirts?|shirts?|blouses?|jackets?|coats?|suits?|bodysuits?|uniforms?|armou?r\w*|sweaters?|hoodies?|turtlenecks?|gloves?|boots?|shoes|hats?|glasses|ribbons?|red|blue|green|yellow|purple|violet|lavender|pink|orange|silver|golden|gold|blonde?|brunette|black|white|grey|gray|brown|teal|cyan|magenta)\b/i;
const CLAUSE = /(,\s*|;\s*|\s+while\s+|\s+with\s+|\s+and\s+(?=(?:her|his|their|its)\b))/i;

export function poseOnly(text) {
  const sentences = String(text ?? '').match(/[^.!?]+[.!?]*/g) ?? [];
  const kept = [];
  for (const sentence of sentences) {
    const parts = sentence.trim().replace(/[.!?]+$/, '').split(CLAUSE);
    // parts alternate clause, separator, clause...: keep a clause with the
    // separator in front of it, so the sentence still reads.
    // A clause hung on a dropped one by "with" goes too: from "the one on the
    // left has lavender hair and stands with arms crossed", "arms crossed"
    // alone would belong to nobody.
    let out = '';
    let dropped = false;
    for (let i = 0; i < parts.length; i += 2) {
      const attached = /^\s+with\s+$/i.test(parts[i - 1] ?? '');
      if (!parts[i] || LOOKS.test(parts[i]) || (dropped && attached)) {
        dropped = true;
        continue;
      }
      dropped = false;
      out += (out ? parts[i - 1] ?? ' ' : '') + parts[i];
    }
    out = out.trim().replace(/^(?:while|with|and)\s+/i, '');
    if (out.split(/\s+/).length >= 3) kept.push(`${out[0].toUpperCase()}${out.slice(1)}.`);
  }
  return kept.join(' ');
}

/** The Kept list of a pose, without the items that are about looks. */
const poseKept = (list) => {
  const text = String(list ?? '');
  if (!LOOKS.test(text)) return text;
  return text.split(/,\s*|\s+and\s+/).filter((x) => x.trim() && !LOOKS.test(x)).join(', ');
};

/** Who takes a pose, as the tags the prompt cites: "<Subject 1> and <Subject 2>", or "" when nobody was tapped. */
function takersOf(s, cast) {
  const tag = (n) => cast.subjects.find((c) => c.kind === 'character' && c.number === n)?.tag ?? `Character ${n}`;
  return joinAnd((s.takers ?? []).map(tag));
}

/** The cast block for the user message, in place of the per-picture reference lines. */
export function labelledLines(cast, descriptions = new Map()) {
  // What the reader saw, handed on (6 Oct 2026, "what's the point of an image
  // input if the LLM doesn't see the image?"). Told only the tags, the writer
  // guessed: a twilight pier became "a warm, intimate indoor setting". The
  // official guide wants each shot to establish appearance, environment and
  // light, which a writer that has not seen the pictures cannot do alone.
  const looks = (tag) => readOf(descriptions.get(tag), tag).look;
  // A character with no reading of their own but a group reading of a picture
  // they share: the whole picture, said as that, with who else is in it.
  const groupLooks = (s) => {
    const g = groupOf(cast, s);
    const read = g ? descriptions.get(groupTag(g.picture)) : '';
    if (!read) return '';
    const share = groupShare(g, s, read);
    if (!share.whole) return `the one ${share.where} in <Picture ${g.picture}> · looks: ${share.look}`;
    const others = joinAnd(g.members.filter((m) => m !== s).map((m) => m.tag));
    return share.look
      ? `looks (the whole of <Picture ${g.picture}>, shared with ${others}; which one is which is not marked): ${share.look}`
      : `looks: described with ${g.members[0].tag}`;
  };
  const read = cast.subjects.some((s) => looks(s.tag) || groupLooks(s)) || cast.frames.some((f) => looks(`<Picture ${f.picture}>`));
  // A card was read before the brief was finished, or edited by hand, and
  // is never read again when the brief changes: the brief wins where they
  // differ (the H3 Forge, Dark's fix of 14 Oct 2026).
  const carded = cast.subjects.some((s) => descriptions.get(s.tag)?.written);
  const lines = [
    '',
    read
      ? `Cast (fixed). The person labelled every picture, and Subject definitions are already written from those labels. Use exactly these subjects: add none, merge none, split none. "looks:" is what was seen in the pictures: set each shot in that place and light, and keep everyone looking as described. ${carded ? `Never contradict it, except: ${CARD_PRIORITY}` : 'Never contradict it.'}`
      : 'Cast (fixed). The person labelled every picture, and Subject definitions are already written from those labels. Use exactly these subjects: add none, merge none, split none. The video model sees the pictures itself, so never describe how anyone or anything looks.',
  ];
  for (const s of cast.subjects) {
    const { keep, drop } = notesOf(s.refs);
    const own = looks(s.tag) ? `looks: ${looks(s.tag)}` : s.kind === 'character' ? groupLooks(s) : '';
    const extra = [keep && `keep: ${keep}`, drop && `leave out: ${drop}`, own].filter(Boolean).join(' · ');
    const tail = extra ? ` · ${extra}` : '';
    if (s.kind === 'character') {
      lines.push(`- ${s.tag} is "${s.name}" in the brief, a character, shown ${shownIn(s)}${tail}`);
    } else if (s.kind === 'place') {
      lines.push(`- ${s.tag} is the place, shown in ${pictureList(s.pictures)}. The shots happen here; anyone else in it is part of the place, not a subject${tail}`);
    } else if (s.kind === 'pose') {
      const stance = poseOnly(looks(s.tag));
      const notes = [keep && `keep: ${keep}`, drop && `leave out: ${drop}`, stance && `pose: ${stance}`].filter(Boolean).join(' · ');
      const who = takersOf(s, cast);
      lines.push(`- ${s.tag} is a pose, from ${pictureList(s.pictures)}: only the stance, limb positions and gesture, never who is in that picture, their clothes or its background. `
        + `${who ? `${cap(who)} ${s.takers.length > 1 ? 'take' : 'takes'} this pose` : 'Whoever the brief says takes this pose'}, as themselves${notes ? ` · ${notes}` : ''}`);
    } else {
      lines.push(`- ${s.tag} is the rendering style, from ${pictureList(s.pictures)}: how the video looks, not what is in it${tail}`);
    }
  }
  for (const f of cast.frames) {
    // A frame's typed notes reach the writer too, so its Keep line can say
    // what the person meant ("keep the character, background and first frame").
    const { keep, drop } = notesOf([f.ref]);
    const look = looks(`<Picture ${f.picture}>`);
    const extra = [keep && `keep: ${keep}`, drop && `leave out: ${drop}`, look && `looks: ${look}`].filter(Boolean).join(' · ');
    lines.push((f.which === 'first'
      ? `- <Picture ${f.picture}> is the first frame: [Shot 1] opens on it exactly`
      : `- <Picture ${f.picture}> is the last frame: the final shot ends on it exactly`) + (extra ? ` · ${extra}` : ''));
  }
  return lines;
}

// ── after the model has written ──────────────────────────────────────────

/** Shot number -> that shot's text, from Detailed description. */
export function shotsOf(description = '') {
  const shots = new Map();
  const parts = String(description).split(/\[Shot (\d+)\]/);
  for (let i = 1; i < parts.length; i += 2) {
    const n = Number(parts[i]);
    shots.set(n, `${shots.get(n) ?? ''}${parts[i + 1] ?? ''}`);
  }
  return shots;
}

/**
 * The writer's Keep lines, by tag: "Keep <Subject 1>: the haircut from
 * <Picture 2>" -> "<Subject 1>" => "the haircut from <Picture 2>". One or two
 * sentences, used as written.
 * Its reading of what the person typed, because typed notes are often
 * instructions rather than traits: pasted as typed, "Keep the character,
 * background and first frame" came out as "keep: Keep the character…"
 * (5 Oct 2026). A line with nothing after the colon, or a runaway, is ignored.
 */
export function keepLines(body = '') {
  const out = new Map();
  for (const raw of String(body).split('\n')) {
    const m = raw.match(/^\s*(?:[-*•]\s*)?keeps?\s+(<(?:Subject|Picture) \d+>)\s*[:—–-]\s*(.+)$/i);
    if (!m) continue;
    const phrase = m[2].trim().replace(/^keep(?:s|ing)?\s*:?\s*/i, '').replace(/[.;,\s]+$/, '');
    if (!phrase || phrase.length > 500) continue;
    out.set(m[1], phrase);
  }
  return out;
}

const cap = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);

const span = (nums) => {
  if (!nums.length) return null;
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  return lo === hi ? `[Shot ${lo}]` : `[Shot ${lo}]-[Shot ${hi}]`;
};

// Words that name how a video is made. The writer has not seen the pictures,
// so it cannot know any of these; a 4B model wrote "Live-action, cinematic"
// for anime pictures despite ref2va-labelled.md saying not to (1 Oct 2026).
const MEDIUM = /\b(live[- ]action|photo-?real\w*|realistic|anime|cartoon|animated|animation|2d|3d|cgi|pixel art|watercolou?r|oil painting|claymation|stop[- ]motion|cel[- ]shad\w*|film grain|cinematic)\b/gi;

/** The style line names no medium the brief did not: it says the pictures' look instead. */
export function keepReferenceLook(description = '', brief = '') {
  const text = String(description);
  const at = text.indexOf('[Shot');
  if (at <= 0) return text;
  const head = text.slice(0, at);
  const asked = new Set((String(brief).match(MEDIUM) ?? []).map((m) => m.toLowerCase()));
  const guesses = (part) => (part.match(MEDIUM) ?? []).some((m) => !asked.has(m.toLowerCase()));
  if (!guesses(head) || !head.trim()) return text;
  // Only the clauses that guess go: "Cinematic 2D animation, warm dusk light
  // with lantern glow" keeps the light. Until 6 Oct 2026 the whole sentence
  // was replaced, and a Q6's lighting went with the guess.
  const opener = /^\s*keeps the look of the reference pictures\s*[,.;:—–-]?\s*/i;
  const kept = head.replace(opener, '').split(/[,;]/)
    .map((p) => p.trim().replace(/[.\s]+$/, ''))
    .filter((p) => p && !guesses(p));
  const rest = kept.join(', ');
  return `Keeps the look of the reference pictures${rest ? `, ${rest}` : ''}.\n\n${text.slice(at)}`;
}

/**
 * Subject definitions and Retention analysis, written in code, and the
 * segments with those two put in their place.
 *
 * @returns {{ segments: Array<{label, body}>, warnings: string[] }}
 */
export function labelledSegments(model, cast, segments = [], descriptions = new Map()) {
  const byLabel = new Map(segments.map((s) => [s.label, s]));
  // The official REF2VA guide's shape (6 Oct 2026, a user comparing ours to
  // it): the definition says what the subject looks like, and Retention
  // names the traits kept — "fully_preserved - the brick wall, orange sofa
  // and neon sign are retained". Until then the look trailed Retention as
  // "As the pictures show:" and the definition carried acting, which the
  // guide never puts there. Both come from the reader's description.
  const looks = new Map([...descriptions].map(([tag, entry]) => [tag, readOf(entry, tag)]));
  const lookOf = (tag) => looks.get(tag)?.look ?? '';
  const keptOf = (tag) => looks.get(tag)?.kept ?? '';
  const keeps = keepLines(byLabel.get('Subject definitions')?.body ?? '');
  // The writer's reading of a typed note, when it gave one; the note as typed
  // otherwise. Only where something was typed: the writer never gets to make
  // a subject partial on its own.
  const noteFor = (tag, typed) => (typed ? keeps.get(tag) ?? typed : '');
  const shots = shotsOf(byLabel.get('Detailed description')?.body ?? '');
  const allShots = [...shots.keys()];
  const lastShot = allShots.length ? Math.max(...allShots) : null;
  const warnings = [];

  const definitions = [];
  const retention = [];
  for (const s of cast.subjects) {
    const pics = pictureList(s.pictures);
    const cited = allShots.filter((n) => shots.get(n).includes(s.tag));
    // What the person typed for this subject's pictures. When there is any,
    // it replaces the stock "keep everything" wording: "keep: a braided bun"
    // from a side-profile picture means that picture gives the hair, not the
    // whole person, which is MiniMax's partially_preserved.
    const notes = noteFor(s.tag, typedNotes(picturesWithRefs(s)));
    // "<Subject 1> is the character in <Picture 1>. A young woman with …",
    // then the typed note when there is one.
    // A card: the video model is told the detailed description's changes win (CARD_PRIORITY).
    const carded = Boolean(descriptions.get(s.tag)?.written);
    const define = (head, fallback) => {
      const look = lookOf(s.tag);
      return [`${head}${look || notes ? '.' : fallback}`, look, notes && `${cap(notes)}.`,
        carded && 'Reference appearance only: explicit changes in the detailed description override conflicting traits above; all unchanged traits are kept.'].filter(Boolean).join(' ');
    };
    const kept = (stock) => (notes ? `partially_preserved — ${notes}.`
      : `fully_preserved — ${keptOf(s.tag) ? `${keptOf(s.tag)} are retained${carded ? ', except traits the detailed description explicitly changes' : ''}.` : stock}`);
    // No reading of their own, but a group reading of a picture they share
    // with others nobody placed: the whole picture, said as that.
    const group = s.kind === 'character' && !lookOf(s.tag) ? groupOf(cast, s) : null;
    const groupRead = group ? descriptions.get(groupTag(group.picture)) ?? '' : '';
    if (s.kind === 'character' && groupRead) {
      const share = groupShare(group, s, groupRead);
      const others = joinAnd(group.members.filter((m) => m !== s).map((m) => m.tag));
      const head = !share.whole
        // Their own line: "<Subject 1> is the character on the left in <Picture 1>. A young woman with ..."
        ? `${s.tag} is the character ${share.where} in <Picture ${group.picture}>. ${share.look}`
        : share.look
          ? `${s.tag} and ${others} are the characters in <Picture ${group.picture}>. <Picture ${group.picture}> shows them: ${share.look}`
          : `${s.tag} is one of the characters in <Picture ${group.picture}>, described with ${group.members[0].tag}.`;
      definitions.push([head, notes && `${cap(notes)}.`].filter(Boolean).join(' '));
      // Where they appear: shots naming them, and shots naming no subject at
      // all - "their faces" in a kiss is both of them. Counting tags alone put
      // a couple "in [Shot 1]" of a two-shot clip (12 Oct 2026).
      const inShot = allShots.filter((n) => shots.get(n).includes(s.tag) || !/<Subject \d+>/.test(shots.get(n)));
      const where = span(inShot) ?? (lastShot ? span(allShots) : 'every shot');
      // The guide's shape: name what is kept, as the per-character readings
      // always did - "fully_preserved — short dark hair, brown eyes, white
      // collared shirt and blue tie are retained" - from their own line.
      const traits = !share.whole ? traitsOf(share.look) : '';
      retention.push(`${s.tag} (appears in ${where}): ${notes ? `partially_preserved — ${notes}.`
        : traits ? `fully_preserved — ${traits} are retained.`
          : `fully_preserved — their face, hair, build and outfit as <Picture ${group.picture}> shows them are retained.`}`);
      if (allShots.length && !cited.length) {
        warnings.push(`${s.name} (${s.tag}) is never named in a shot. Check Detailed description, or say in the brief what ${s.name} does.`);
      }
    } else if (s.kind === 'character') {
      definitions.push(define(`${s.tag} is the character ${shownIn(s)}`, '; keep their appearance exactly as the pictures show.'));
      if (allShots.length && !cited.length) {
        warnings.push(`${s.name} (${s.tag}) is never named in a shot. Check Detailed description, or say in the brief what ${s.name} does.`);
      }
      const where = span(cited) ?? (lastShot ? span(allShots) : 'every shot');
      retention.push(`${s.tag} (appears in ${where}): ${kept('their face, hair, build and outfit are retained in every shot.')}`);
    } else if (s.kind === 'place') {
      definitions.push(define(`${s.tag} is the place in ${pics}, where the video happens`, '; keep it as the picture shows.'));
      // The setting of every shot, whether or not a shot names it again.
      const where = lastShot ? span(allShots) : 'every shot';
      retention.push(`${s.tag} (appears in ${where}): ${kept('its layout, landmarks, light and time of day are retained.')}`);
    } else if (s.kind === 'pose') {
      // The guide's shape for content one asset lends another: "the woman whose
      // appearance comes from <Picture 1> and whose walking motion comes from
      // <Video 1>". The pose is transferred, never kept as the picture's person.
      const who = takersOf(s, cast);
      const look = poseOnly(lookOf(s.tag));
      definitions.push([
        `${s.tag} is the pose in ${pics}: only its stance, limb positions and gesture${who ? `, taken by ${who}` : ''}, not the identity, clothing or background of ${pics}.`,
        look,
        notes && `${cap(notes)}.`,
      ].filter(Boolean).join(' '));
      const takerTags = (s.takers ?? []).map((n) => cast.subjects.find((c) => c.kind === 'character' && c.number === n)?.tag).filter(Boolean);
      const posed = allShots.filter((n) => shots.get(n).includes(s.tag) || takerTags.some((t) => shots.get(n).includes(t)));
      const where = span(posed) ?? (lastShot ? span(allShots) : 'every shot');
      const what = poseKept(keptOf(s.tag)) || 'the stance, limb positions and gesture';
      retention.push(`${s.tag} (appears in ${where}): transferred — ${what} ${who ? `applied to ${who}` : 'applied'}; nobody else from ${pics} is carried over.`);
    } else {
      definitions.push(define(`${s.tag} is the rendering style of ${pics}, applied to the whole video and not its content`, '.'));
      retention.push(`${s.tag} (applies to every shot): ${kept('its rendering is retained throughout.')}`);
    }
  }
  for (const f of cast.frames) {
    const tag = `<Picture ${f.picture}>`;
    const shot = f.which === 'first' ? '[Shot 1]' : lastShot ? `[Shot ${lastShot}]` : 'the final shot';
    const notes = noteFor(tag, typedNotes([{ picture: f.picture, ref: f.ref }]));
    const look = lookOf(tag);
    definitions.push([`${tag} is the ${f.which} frame of ${shot}.`, look, notes && `${cap(notes)}.`].filter(Boolean).join(' '));
    retention.push(`${tag} (${shot} ${f.which} frame): ${notes ? `partially_preserved — ${notes}.`
      : `fully_preserved — ${keptOf(tag) ? `${keptOf(tag)} are retained.` : `the ${f.which === 'first' ? 'opening' : 'closing'} composition, lighting and subject positions are retained.`}`}`);
  }

  const written = {
    'Subject definitions': definitions.join('\n\n'),
    'Retention analysis': retention.join('\n'),
  };
  const order = model?.segments ?? [];
  const out = [];
  const placed = new Set();
  for (const label of order) {
    if (written[label] != null) {
      if (written[label]) out.push({ ...(byLabel.get(label) ?? {}), label, body: written[label] });
      placed.add(label);
    } else if (byLabel.has(label)) {
      out.push(byLabel.get(label));
      placed.add(label);
    }
  }
  // Anything the registry order does not name keeps its place at the end.
  for (const s of segments) if (!placed.has(s.label)) out.push(s);

  // <Picture N> is for a first or last frame only; the guide gives everything
  // else a <Subject N>. A 9B wrote "The shot begins from <Picture 3>" for the
  // place picture (6 Oct 2026), which tells H3 to open on it. The prompt
  // already says so, so it is fixed here: the subject a picture belongs to
  // replaces it. A picture of several subjects is not guessed, only warned.
  const frames = new Set(cast.frames.map((f) => f.picture));
  const owners = new Map();
  for (const s of cast.subjects) {
    for (const n of new Set([...s.pictures, ...(s.placements ?? []).map((p) => p.picture)])) {
      owners.set(n, [...(owners.get(n) ?? []), s.tag]);
    }
  }
  const swapped = new Map();
  const shared = new Set();
  const fixPictures = (body) => String(body ?? '').replace(/<Picture (\d+)>/g, (m, d) => {
    const n = Number(d);
    const tags = owners.get(n);
    if (frames.has(n) || !tags) return m;
    if (tags.length > 1) {
      shared.add(n);
      return m;
    }
    swapped.set(n, tags[0]);
    return tags[0];
  });
  const fixed = out.map((s) => (written[s.label] != null ? s : { ...s, body: fixPictures(s.body) }));
  for (const [n, tag] of swapped) {
    warnings.push(`<Picture ${n}> is not a first or last frame, but the prompt cited it like one; it now says ${tag}, the subject it shows.`);
  }
  for (const n of shared) {
    warnings.push(`<Picture ${n}> is not a first or last frame, but the prompt cites it. It shows more than one subject, so it was left as written; check that line.`);
  }
  return { segments: fixed, warnings };
}
