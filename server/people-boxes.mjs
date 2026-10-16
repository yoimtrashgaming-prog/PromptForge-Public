// People boxes: a box around each character in a picture of several.
//
// The person draws them, or the reader model finds them ("Find people"), and
// either way they are edited the same: dragged, resized, renumbered. A box
// does two jobs. Its place left to right orders the people, so the Who's in
// it numbers and the left/right/front buttons are not needed. And the reader
// describes that person from a crop of the box rather than the whole picture.
//
// Measured 13 Oct 2026 on the Z440, a five-girl band in matching uniforms:
// every method got who-is-who right, but read from the whole picture each
// girl got the same uniform sentence; read from her crop, the details that
// tell them apart came back (one's thigh-high stockings and white ribbons,
// another's headband). On a piggyback the crop of the girl riding on his back
// held his head and chest too, and Q4 described him - so heavily overlapping
// boxes are read from the whole picture by position, as before.
//
// Boxes are fractions of the picture: [x1, y1, x2, y2], 0 to 1.

import { createHash } from 'node:crypto';
import { Jimp } from 'jimp';

/** How many people a picture can have boxes for: the Who's in it cap. */
const MAX_BOXES = 70;
/** A box smaller than this, as a fraction of the picture, is a mis-drag. */
const MIN_SIDE = 0.02;
/**
 * Overlap past this share of the smaller box means the crop would hold
 * someone else as much as its own person: read from the whole picture.
 * The piggyback's two boxes overlap by ~60% of the smaller; the band's
 * neighbours by under 25%.
 */
const OVERLAP_LIMIT = 0.35;
/** Room kept round a crop, as a fraction of the picture. */
const MARGIN = 0.02;

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** A picture's boxes, checked: [{ n, box }], one per character number. */
export function boxesOf(ref, max = MAX_BOXES) {
  if (!Array.isArray(ref?.boxes)) return [];
  const out = [];
  const seen = new Set();
  for (const b of ref.boxes.slice(0, max)) {
    const n = Number(b?.n);
    const box = Array.isArray(b?.box) ? b.box.map(Number) : [];
    if (!Number.isInteger(n) || n < 1 || n > max || seen.has(n)) continue;
    if (box.length !== 4 || box.some((v) => !Number.isFinite(v))) continue;
    const [x1, y1, x2, y2] = [clamp01(Math.min(box[0], box[2])), clamp01(Math.min(box[1], box[3])),
      clamp01(Math.max(box[0], box[2])), clamp01(Math.max(box[1], box[3]))];
    if (x2 - x1 < MIN_SIDE || y2 - y1 < MIN_SIDE) continue;
    seen.add(n);
    out.push({ n, box: [x1, y1, x2, y2] });
  }
  return out;
}

/** The character numbers in a picture, left to right by where their boxes sit. */
export function whoFromBoxes(boxes) {
  return [...boxes].sort((a, b) => (a.box[0] + a.box[2]) - (b.box[0] + b.box[2])).map((b) => b.n);
}

const area = ([x1, y1, x2, y2]) => Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
function overlapShare(a, b) {
  const inter = area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
  return inter / Math.max(1e-9, Math.min(area(a), area(b)));
}

/**
 * The box to read character `n` from, or null: no box for them, or it
 * overlaps another person's box too much to show them alone.
 */
export function cropFor(boxes, n) {
  const own = boxes.find((b) => b.n === n);
  if (!own) return null;
  if (boxes.some((b) => b !== own && overlapShare(own.box, b.box) > OVERLAP_LIMIT)) return null;
  return own.box;
}

/** A short key for a box, for cache roles: "0.23-0.09-0.57-1". */
export const boxKey = (box) => box.map((v) => Number(v.toFixed(3))).join('-');

const cropCache = new Map();
/**
 * The picture cut to a box (plus a small margin), as a JPEG data URL. Kept in
 * memory by picture and box: the same crop is asked for again on every
 * generation that does not change the picture.
 */
export async function cropImage(dataUrl, box) {
  const key = createHash('sha256').update(dataUrl).update(boxKey(box)).digest('hex');
  if (cropCache.has(key)) return cropCache.get(key);
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(String(dataUrl));
  if (!m) throw new Error('not a base64 data URL');
  const img = await Jimp.read(Buffer.from(m[2], 'base64'));
  const W = img.bitmap.width, H = img.bitmap.height;
  const x = Math.round(clamp01(box[0] - MARGIN) * W), y = Math.round(clamp01(box[1] - MARGIN) * H);
  const w = Math.max(1, Math.round(clamp01(box[2] + MARGIN) * W) - x);
  const h = Math.max(1, Math.round(clamp01(box[3] + MARGIN) * H) - y);
  img.crop({ x, y, w, h });
  const out = `data:image/jpeg;base64,${(await img.getBuffer('image/jpeg', { quality: 92 })).toString('base64')}`;
  if (cropCache.size > 200) cropCache.delete(cropCache.keys().next().value);
  cropCache.set(key, out);
  return out;
}

/** The size of a data-URL picture, for scaling a model's pixel boxes. */
export async function pictureSize(dataUrl) {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(String(dataUrl));
  if (!m) throw new Error('not a base64 data URL');
  const img = await Jimp.read(Buffer.from(m[2], 'base64'));
  return { width: img.bitmap.width, height: img.bitmap.height };
}

/** What the reader model is asked when the person presses Find people. */
export const FIND_PEOPLE_PROMPT = 'Find every person in this picture. Answer with JSON only: a list of '
  + '{"label": short description, "bbox_2d": [x1, y1, x2, y2]}, one per person, covering their whole body.';

/**
 * The model's answer as boxes, left to right: [{ box, label }]. Read leniently
 * - r4 put a stray ")" inside the JSON on a five-person picture - by pulling
 * each label and its four numbers. Qwen-VL answers on a 0-1000 grid; numbers
 * past 1000 are taken as pixels of a picture `size` big.
 */
export function parsePeople(text, size = null) {
  const found = [...String(text ?? '').matchAll(/"label"\s*:\s*"([^"]*)"\s*,\s*"bbox_2d"\s*:\s*\[\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/g)]
    .map((m) => ({ label: m[1].trim(), raw: m.slice(2, 6).map(Number) }));
  const pixels = size && found.some((f) => f.raw.some((v) => v > 1000));
  const people = found.map(({ label, raw }) => {
    const [x1, y1, x2, y2] = pixels
      ? [raw[0] / size.width, raw[1] / size.height, raw[2] / size.width, raw[3] / size.height]
      : raw.map((v) => v / 1000);
    return { label, box: [clamp01(Math.min(x1, x2)), clamp01(Math.min(y1, y2)), clamp01(Math.max(x1, x2)), clamp01(Math.max(y1, y2))] };
  }).filter((p) => p.box[2] - p.box[0] >= MIN_SIDE && p.box[3] - p.box[1] >= MIN_SIDE);
  return people.slice(0, MAX_BOXES).sort((a, b) => (a.box[0] + a.box[2]) - (b.box[0] + b.box[2]));
}
