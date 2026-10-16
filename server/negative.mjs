// Two mechanical defects in generated negative prompts, both fixable without
// judgement and both fixing a rule the prompt files already state.
//
// Found in real output on 21 Aug, on an Illustrious prompt for Fern:
//
//   worst_quality, low_quality, … , multiple_girls, mage_staff, robe,
//   extra_hands, floating_hands, … , extra_eyes, floating_eyes, extra_mouth,
//   floating_mouth, extra_nose, floating_nose, extra_ears, floating_ears,
//   extra_tongue, floating_tongue, extra_eyes, floating_eyes, extra_mouth,
//   floating_mouth, extra_nose, floating_nose, extra_ears, floating_ears,
//   extra_tongue, floating_tongue
//
// 1. A ten-tag block repeated verbatim. The 8B degenerating into a loop. A
//    comma-separated tag list containing the same tag twice is simply broken,
//    and illustrious.md says "past roughly fifteen it stops helping and starts
//    pulling colour and contrast out of the image" — so the duplicates are not
//    merely untidy, they cost image quality.
//
// 2. `mage_staff` in the negative while the user had clicked mage_staff into
//    the POSITIVE as one of Fern's traits. illustrious.md: "Never put a
//    concept in the negative that you also put in the positive."
//    house-rules.md: "The user's intent wins. Preserve everything they named."
//    The model copied its own worked example's negative line verbatim, which
//    happens to negate a staff and a robe.
//
// Deliberately NOT doing anything about length, ordering, or which tags are
// sensible. Those are judgement, and judgement belongs in prompts/.

/**
 * A tag reduced to what two spellings of the same concept have in common:
 * lowercase, no weight syntax, underscores and spaces treated alike.
 *
 * The comparison has to survive `(purple_hair:1.30)` on one side and
 * `purple hair` on the other, because the positive can carry a user's weight
 * and the two halves of a prompt can use different tag styles.
 */
export function normaliseTag(tag) {
  return String(tag ?? '')
    .trim()
    .toLowerCase()
    // Strip one layer of weight syntax: (tag:1.30) -> tag
    .replace(/^\((.*):\s*[\d.]+\)$/, '$1')
    // Illustrious-style emphasis, and stray brackets from a malformed weight.
    .replace(/[()[\]{}]/g, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const split = (s) => String(s ?? '').split(',').map((t) => t.trim()).filter(Boolean);

/**
 * Clean a generated negative prompt.
 *
 * @param negative   the Negative prompt segment body
 * @param positives  strings whose tags must not appear in the negative — the
 *                   positive segment, and the tags the user picked by hand
 * @param opts.known (tag) => does danbooru have this tag. Omit to skip the
 *                   check entirely, which is what happens with no tag
 *                   database loaded.
 * @param opts.protected  strings whose tags are never dropped as unknown —
 *                   the model's negative_defaults and whatever the user typed
 * @returns { text, removed: { duplicates, contradictions }, noted: { unknown } }
 *
 * `unknown` is NOT removed — it is reported so the log can say when a model is
 * inventing vocabulary, and kept in the prompt regardless. See the note at the
 * check itself for why it stopped being a deletion on 30 Aug 2026.
 */
export function cleanNegative(negative, positives = [], opts = {}) {
  const banned = new Set();
  for (const source of positives) {
    for (const tag of split(source)) banned.add(normaliseTag(tag));
  }
  banned.delete('');

  // Config and user input are never second-guessed. negative_defaults is the
  // owner's deliberate setting — and it matters here, because two of
  // illustrious.md's own defaults (extra_fingers, fewer_fingers) are SD
  // community convention rather than danbooru vocabulary and would otherwise
  // be dropped as unknown.
  const spared = new Set();
  for (const source of opts.protected ?? []) {
    for (const tag of split(source)) spared.add(normaliseTag(tag));
  }

  const seen = new Set();
  const kept = [];
  const duplicates = [];
  const contradictions = [];
  const unknown = [];

  for (const raw of split(negative)) {
    const key = normaliseTag(raw);
    if (!key) continue;
    if (banned.has(key)) {
      contradictions.push(raw);
      continue;
    }
    if (seen.has(key)) {
      duplicates.push(raw);
      continue;
    }
    // A tag danbooru has never heard of is NOTED AND KEPT.
    //
    // It used to be deleted. The reasoning was that a tag the database has
    // never seen cannot steer a danbooru-trained model, and there was real
    // evidence for it: of 22 body-part tags one run invented, every
    // `floating_*` was absent from all 181,714 rows — pattern completion, not
    // recall.
    //
    // Two things undo that. The run was on `qwen3:8b`, which the owner ruled
    // out as a measurement target on 28 Aug 2026. And the premise is wrong
    // anyway — his correction, 30 Aug: *"just cause its not in a box doesnt
    // mean it doesnt exsist... base 0.1 doesnt know anything nsfw yet theres
    // hundreds of checkpoints people have made to do that."* Nobody generates
    // on base Illustrious. `tags.sqlite` is a snapshot of danbooru's labels,
    // not of what the checkpoint someone is running understands.
    //
    // This function's own comment already conceded the point: it spares
    // `extra_fingers` and `fewer_fingers` — SD community convention, absent
    // from danbooru — because they come from config. The same tag was kept
    // when the owner typed it and deleted when the model wrote it.
    //
    // Deleting is also the one option that loses the intent. Measured 30 Aug:
    // `bare_feet` was dropped, and after that the prompt excluded bare feet
    // nowhere at all, while the real tag `barefoot` (368,823 posts) sat one
    // step away unused. A nonsense negative tag does close to nothing; a
    // deleted one silently removes an exclusion somebody wanted.
    //
    // Still reported, because the signal was worth having: a model emitting
    // fifteen tags danbooru has never seen is a prompt-file problem, and the
    // log line is how that becomes visible without diffing output by hand.
    if (opts.known && !spared.has(key) && !opts.known(key)) {
      unknown.push(raw);
    }
    seen.add(key);
    kept.push(raw);
  }

  return {
    text: kept.join(', '),
    removed: { duplicates, contradictions },
    noted: { unknown },
  };
}

/**
 * Put back the registry defaults the model forgot.
 *
 * cleanNegative above removes; this adds. The two are not symmetrical and the
 * asymmetry is the point — a tag the model invented is its own, but
 * `negative_defaults` is the owner's declared floor and every prompt file
 * already tells the model to start from it. Illustrious: "Start from the
 * registry's negative_defaults." Pony: "Start from the registry defaults,
 * which already contain the score negatives."
 *
 * Measured on the P40's 9B, 27 Aug 2026, and this is the case for doing it
 * mechanically rather than asking again:
 *
 *   pony, "puts low scores in the negative"
 *     0/6   before — pony.md's wording was ambiguous about whether the score
 *           ladder could appear in the negative at all
 *     2/6   after that wording was fixed
 *
 * Rewriting the sentence moved it and did not fix it. `score_6, score_5,
 * score_4` never varies by brief, it is already sitting in config, and it is
 * the single highest-value thing in a Pony negative — asking a 9B to
 * transcribe a constant is a job it can only lose at. The 27B scored 7/7 on
 * the same file, which is the usual shape: the instruction is fine and the
 * small model is the one deploying.
 *
 * Same idea as stripAspect and as cleanNegative itself, and the same limit:
 * rules the prompt files already state, enforced mechanically. Nothing here
 * decides what a good negative contains — that is judgement, and judgement
 * lives in prompts/.
 *
 * **Never re-adds a default that the positive asked for.** cleanNegative has
 * just stripped those as contradictions, and putting them back would undo the
 * repair in the same breath — a user who deliberately prompts for a tag that
 * happens to sit in negative_defaults must win.
 *
 * @param negative   the cleaned Negative prompt segment
 * @param defaults   the model's `negative_defaults` string
 * @param positives  strings whose tags must never be added — the positive
 *                   segment, and whatever the user picked by hand
 */
/**
 * Keep the registry defaults and at most `max` tags the model added itself.
 *
 * Run after ensureDefaults, which prepends the missing defaults — so the list
 * is always `[defaults][model's own]` and the cut is at a known boundary
 * rather than a guess about which tags were whose.
 *
 * **Why this exists.** Measured 2 Sep 2026 on illustrious, thinking off, lean
 * prompts: a 402-character positive prompt against a 1,652-character negative.
 * The first sixteen tags were the registry defaults plus four real ones —
 * `multiple_girls, 2girls, indoors, night` — and then it stopped writing a
 * prompt and started reciting vocabulary:
 *
 *   ... username, social_media_handle, website, url, link, share, save,
 *   download, print, buy, sell, trade, exchange, gift, present, reward,
 *   prize, competition, contest, game, sport, music, dance, art, painting ...
 *
 * illustrious.md already says "past roughly fifteen it stops helping and
 * starts pulling colour and contrast out of the image". The file said it, the
 * model ignored it, and nothing checked — the same shape as the negation ban
 * and the parenthesis escaping before it.
 *
 * `max = 0` is the owner's call: the registry negative is what the base model
 * normally wants, and the brief-specific additions were not worth what came
 * attached to them. Raising it to 4 would have kept every good tag in the run
 * above, so the knob is there if the judgement changes.
 */
export function capExtras(negative, defaults, max) {
  if (max == null || max < 0) return { text: negative, dropped: [] };
  const floor = new Set(split(defaults).map(normaliseTag));
  const kept = [];
  const dropped = [];
  let extras = 0;
  for (const raw of split(negative)) {
    if (floor.has(normaliseTag(raw))) {
      kept.push(raw);
      continue;
    }
    if (extras < max) {
      extras += 1;
      kept.push(raw);
      continue;
    }
    dropped.push(raw);
  }
  return { text: kept.join(', '), dropped };
}

export function ensureDefaults(negative, defaults, positives = []) {
  const present = new Set(split(negative).map(normaliseTag));
  const banned = new Set();
  for (const source of positives) {
    for (const tag of split(source)) banned.add(normaliseTag(tag));
  }
  banned.delete('');

  const missing = [];
  for (const raw of split(defaults)) {
    const key = normaliseTag(raw);
    if (!key || present.has(key) || banned.has(key)) continue;
    present.add(key);
    missing.push(raw);
  }

  if (!missing.length) return { text: negative, added: [] };
  // Prepended, because "start from the registry defaults" is what the files
  // say and a negative that starts with the floor reads the way they describe.
  return { text: [...missing, ...split(negative)].join(', '), added: missing };
}
