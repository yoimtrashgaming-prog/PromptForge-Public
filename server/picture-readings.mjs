// h3 REF2VA: look at each reference picture on its own, then write.
//
// 29 Sep 2026, a user's five references (one character in three pictures, a
// second character, a background) with a brief that names no picture. With all
// five attached to one call, models lost track of which picture was which: the
// 8B described the background picture as a second copy of the character and
// dropped the background, and the 27Bs swapped <Picture 2> and <Picture 4>
// until each picture got its own label. A call that sees one picture has
// nothing to mix up.
//
// So each picture is read once by itself, and a group of pictures the person
// marked as one subject is read together, because those are meant to look
// alike. The readings go to the prompt writer under their labels. Whether the
// writer still gets the pictures as well is the reference_picture_mode switch
// in config/server.yaml.
//
// Same shape as server/keyframes.mjs, which does this for the LTX Director:
// readings are cached by content so a re-roll does not read again, and nothing
// here calls the model. The streaming lives in server.mjs.

import { createHash } from 'node:crypto';
import { formatReferences, pictureGroups } from './references.mjs';
import { usableReading } from './keyframes.mjs';

/** Extraction, not writing — same temperature as the keyframe reader. */
export const PICTURE_TEMPERATURE = 0.2;

/** A short paragraph per picture; this is the ceiling, not the target. */
export const PICTURE_BUDGET = 320;

// What each role means to the reader, in one clause. Mirrors the job the
// Director gives the file (server/references.mjs ROLE_NOTE), in plain words.
const ROLE_HINT = {
  subject: 'It shows a subject for the video: a person, creature, object or place that should appear in it.',
  style: 'It is a style reference: only how it is rendered matters, not what it shows.',
  keyframe: 'It is a keyframe: an exact frame the video will show at some point.',
};

/**
 * What to read, in the Director's order: each picture on its own, except the
 * pictures of one subject group, which are read together.
 *
 * Returns [{ labels: ['<Picture 1>', ...], refs: [ref, ...], role }], only for
 * pictures that carry an image.
 */
export function readingUnits(references = [], mode = 'REF2VA') {
  const { images } = formatReferences(references, mode);
  const pictures = images.filter((i) => /^<Picture \d+>$/.test(i.label) && i.ref?.image);
  const groupOf = new Map();
  for (const g of mode === 'REF2VA' ? pictureGroups(references) : []) {
    for (const n of g.pictures) groupOf.set(n, g);
  }
  const units = [];
  const done = new Set();
  for (const pic of pictures) {
    const n = Number(pic.label.match(/\d+/)[0]);
    if (done.has(n)) continue;
    const group = groupOf.get(n);
    const members = group
      ? pictures.filter((p) => group.pictures.includes(Number(p.label.match(/\d+/)[0])))
      : [pic];
    for (const m of members) done.add(Number(m.label.match(/\d+/)[0]));
    units.push({
      labels: members.map((m) => m.label),
      refs: members.map((m) => m.ref),
      role: members[0].ref?.role ?? 'subject',
    });
  }
  return units;
}

/** Longest description the page may hand back; a real one is a paragraph. */
export const GIVEN_READING_MAX = 2000;

/**
 * The description the page already holds for a unit, or null. Scanned earlier
 * or written by the person, it stands in for a scan. A group counts only when
 * every picture in it carries the same text: a picture added to the group
 * since, or one whose notes changed, means the group has to be looked at again.
 */
export function givenReading(unit) {
  const texts = unit.refs.map((r) => (typeof r?.reading === 'string' ? r.reading.trim() : ''));
  if (!texts.length || texts.some((t) => !t || t !== texts[0])) return null;
  return texts[0].slice(0, GIVEN_READING_MAX);
}

/**
 * The cache key: the pictures and everything the reader is told about them.
 * The brief is left out on purpose (see readingMessage), so re-wording the
 * brief does not throw readings away.
 */
export function readingHash(unit) {
  const h = createHash('sha256');
  h.update(String(unit.role));
  for (const r of unit.refs) {
    h.update('\0');
    h.update(String(r.image ?? ''));
    h.update('\0');
    h.update(`${r.keep ?? ''}\0${r.drop ?? ''}`);
  }
  return h.digest('hex').slice(0, 32);
}

/**
 * What the reader is told. Not the brief: a reader told the story reports it
 * back as something it saw, and a picture read against one brief would be
 * cached as if it were a fact about the picture. Not its label either — the
 * number is the file's slot, which changes when the person reorders, and the
 * reading is cached by content.
 */
export function readingMessage(unit) {
  const lines = [];
  const n = unit.refs.length;
  lines.push(ROLE_HINT[unit.role] ?? ROLE_HINT.subject);
  if (n > 1) {
    lines.push(`These ${n} pictures show the same subject. Describe it once, as one subject, and say briefly what differs between the pictures (outfit, pose, framing).`);
  }
  const keep = unit.refs.map((r) => String(r.keep ?? '').trim()).filter(Boolean);
  const drop = unit.refs.map((r) => String(r.drop ?? '').trim()).filter(Boolean);
  if (keep.length) lines.push(`The person wants to keep: ${[...new Set(keep)].join('; ')}.`);
  if (drop.length) lines.push(`The person wants to leave out: ${[...new Set(drop)].join('; ')}.`);
  return lines.join('\n');
}

/**
 * The readings, for the prompt writer, under the labels the Director uses.
 * Returns [] when nothing was read, so the caller can spread it.
 *
 * @param {Array<{labels:string[]}>} units
 * @param {Map<string,string>} readings  labels.join(', ') -> reading
 */
export function readingLines(units = [], readings = new Map()) {
  const kept = units.filter((u) => usableReading(readings.get(u.labels.join(', '))));
  if (!kept.length) return [];
  const lines = [
    '',
    'What is in each picture. Each was looked at on its own, so these say which picture shows what. ' +
      'Cite every picture by exactly the label given here. These are notes to you: do not copy their wording.',
  ];
  for (const u of kept) lines.push(`${u.labels.join(', ')}: ${usableReading(readings.get(u.labels.join(', ')))}`);
  return lines;
}
