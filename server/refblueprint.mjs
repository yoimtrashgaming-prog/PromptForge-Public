// The role-isolated read of the reference pictures, run BEFORE the prompt is
// written.
//
// A user's workflow, 8 Sep 2026, generalised from Anima to every image model at
// the owner's call — "we are gonna use these rules for all the image models
// when doing image reference".
//
// **What changed and why.** Since 8 Sep the pictures travel with the
// generation call, which was the right fix for the previous failure (a
// reference was only as good as the tagger's list). It left one call doing
// five jobs at once: look at the pictures, keep only the half each picture's
// role allows, swap the user's character in for whoever is in the pose shot,
// follow the target model's dialect, and build verified tags. The reported
// failure mode is quiet — a pose reference leaking its source character's
// hair reads as a perfectly ordinary prompt, and nothing in the output says
// where the hair came from.
//
// So: one call looks, one call writes. This module builds the looking call.
// The pictures then come OFF the wire and the compile call gets the text.
//
// **This is not a saving.** It is a second generation on a box that decodes
// at 9-18 tok/s, and it is bought with wall-clock time. What it buys back is
// a reading that can be printed, checked and argued with, instead of a
// judgement made silently inside a prompt nobody can see.
//
// Nothing here calls the model. The builders are pure so they can be tested
// without a GPU, and the streaming lives in server.mjs beside the other two
// passes that do the same thing.

// ── The note outranks the LEAVE list, in code (18 Sep 2026) ──
//
// A user, 18 Sep: a Pose reference with the note "Reproduce this pose, the
// background, and outfit", and the reading came back "IGNORE: … clothing,
// accessories, background …". The note line said it outranked the two above
// it; the analyst copied the LEAVE line into IGNORE anyway, and the prompt
// writer only ever sees the reading. A rule the model can lose belongs in
// code: whatever the note asks for is taken out of LEAVE before it is sent,
// so the two can no longer disagree.
//
// Matched by topic, not by exact words: each LEAVE item and each clause of
// the note are checked against the same word groups. A clause with a
// negation in it ("but not the background") asks for nothing.
import { createHash } from 'node:crypto';
import { orderReferences } from './imagerefs.mjs';
import { ROLE_CARRIES_CHARACTER } from '../web/appearance.js';

// This is provenance for cache reuse, not authentication of client text.
// Include the complete ordered selection (bytes and metadata), the brief the
// analyst read, and its role instructions. Never infer identity from a count.
export function referenceAnalysisIdentity(model, brief, references = [], defaults = {}) {
  if (model?.type !== 'image' || !references.length) return '';
  const ordered = orderReferences(references, defaults);
  const input = {
    model: model.key,
    brief: String(brief ?? '').trim(),
    references: ordered,
    imageCeiling: defaults.max_image_references ?? 6,
    instruction: buildBlueprintMessage(ordered, brief, defaults, (role) => ROLE_CARRIES_CHARACTER.has(role)),
  };
  const canonical = JSON.stringify(input, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]))
      : value);
  return createHash('sha256').update(canonical).digest('hex');
}

export function reusableReferenceAnalysis(model, brief, controls = {}, defaults = {}) {
  const identity = referenceAnalysisIdentity(model, brief, controls.image_references ?? [], defaults);
  return identity && controls.reference_analysis_identity === identity && blueprintUsable(controls.reference_analysis)
    ? String(controls.reference_analysis).trim()
    : '';
}

const LEAVE_TOPICS = [
  ['background', 'setting', 'scene', 'location', 'environment', 'room', 'place', 'backdrop', 'surround', 'everything around'],
  ['cloth', 'outfit', 'footwear', 'shoe', 'what they wear', 'dress', 'costume', 'garment', 'uniform'],
  ['accessor', 'jewel', 'outfit'],
  ['hair'],
  ['eye'],
  ['who', 'character(?!istic)', 'identity', 'face', 'same person', 'same girl', 'same guy', 'same woman', 'same man'],
  ['body'],
  ['pose', 'posture', 'doing'],
  ['light'],
  ['palette', 'colour', 'color'],
  ['style', 'drawing', 'rendering', 'art'],
  ['composition', 'framing', 'camera', 'angle'],
];
const NEGATION = /\b(no|not|don'?t|do not|without|ignore|leave|except|skip|drop|minus|never)\b/i;

const topicsIn = (text) => {
  const t = ` ${String(text).toLowerCase()} `;
  return LEAVE_TOPICS.map((words, i) => (words.some((w) => new RegExp(`\\b${w}`).test(t)) ? i : -1)).filter((i) => i >= 0);
};

/** The topics a note asks FOR — negated clauses left out. */
function askedTopics(note) {
  const asked = new Set();
  for (const clause of String(note ?? '').split(/[,.;]|\bbut\b/i)) {
    if (!clause.trim() || NEGATION.test(clause)) continue;
    for (const i of topicsIn(clause)) asked.add(i);
  }
  return asked;
}

/**
 * The role's LEAVE text with everything the person's note asked for removed,
 * or '' when nothing is left. The first sentence is the list; any sentence
 * after it (the Pose role's "the character named in the brief replaces the
 * person you can see") is kept unless the note asked for the identity.
 */
export function leaveFor(ignore, note) {
  const text = String(ignore ?? '').trim();
  if (!text) return '';
  const asked = askedTopics(note);
  if (!asked.size) return text;
  const hit = (s) => topicsIn(s).some((i) => asked.has(i));

  const [list, ...rest] = text.split(/(?<=\.)\s+/);
  const items = list.replace(/\.$/, '').split(/;\s*|,\s*/).map((s) => s.trim()).filter(Boolean);
  const kept = items.filter((item) => !hit(item));
  const tail = rest.filter((s) => !hit(s));
  if (kept.length === items.length && tail.length === rest.length) return text;
  const out = [kept.length ? `${kept.join('; ')}.` : '', ...tail].filter(Boolean).join(' ');
  return out;
}

/** A user's number, and it is not arbitrary: this is extraction, not writing.
 *  A creative temperature on an extraction task invents detail that the
 *  compiler then has no way to tell from something that was in the picture. */
export const BLUEPRINT_TEMPERATURE = 0.2;

/**
 * How much room the analyst gets, by picture count.
 *
 * A ceiling rather than a target — a simple picture gets a short block, and
 * the prompt says so. The ceiling exists because an analyst that rambles
 * spends the compile call's context on prose nobody asked for, and because
 * every token here is wall-clock time on a queue five people share.
 */
export function blueprintBudget(imageCount) {
  return Math.min(1600, 650 + Math.max(0, imageCount) * 180);
}

/**
 * What the analyst is told about each picture.
 *
 * Deliberately thin. It gets the brief, the role, and whatever the person
 * typed under the picture — the three things that decide which half of the
 * image is being asked about. It does NOT get:
 *
 *   - the picked tags. Those are the person's own selection and they reach
 *     the compiler already. Handing them to the analyst invites it to report
 *     them back as things it saw, and a tag laundered through a "USE" section
 *     is indistinguishable from an observation.
 *   - the fidelity. How hard to follow a picture is the compiler's decision;
 *     an analyst told "loose inspiration" has a reason to look less carefully,
 *     which is not a trade anyone asked for.
 *   - the character name, except on a role that is allowed to carry it. Same
 *     rule as the compile message, and it matters more here: a model told the
 *     pose reference is Frieren will describe Frieren.
 *
 * @param references ordered by orderReferences — the SAME order the picture
 *                   parts are in, which is what makes "Reference 2" mean
 *                   anything at all.
 */
export function buildBlueprintMessage(references = [], brief = '', defaults = {}, carriesCharacter = () => false) {
  const roles = defaults.image_reference_roles ?? {};
  const lines = [];

  // Does any reference here take its orders from the brief rather than from
  // its role? Read off the registry, never off a role key — a second
  // brief-driven role should be a config edit. See config/models.yaml.
  const brixDriven = references.some((r) => roles[r?.role]?.driven_by_brief === true);

  const trimmed = String(brief ?? '').trim();
  if (trimmed) {
    // Two different things the same sentence can be, and getting it backwards
    // breaks one role or the other.
    //
    // Under an aspect role the brief is CONTEXT: it says which parts of the
    // picture are going to matter — that the coat is the ask and the
    // wallpaper is not — and an analyst that acted on it would answer the
    // request instead of reading the photograph.
    //
    // Under a brief-driven role it is the INSTRUCTION, and there is nothing
    // else deciding what to take. Telling the model to treat it as context
    // there would switch off the only thing steering the read.
    //
    // "Do not write a prompt" holds in both. It is the boundary between this
    // call and the next one, not a statement about the brief.
    if (brixDriven) {
      lines.push(`What the person asked for: "${trimmed}"`);
      lines.push('');
      lines.push(
        'That is your instruction for what to take from the picture and what to leave. Read the ' +
        'picture against it. Whatever they did not ask to change, they are keeping — describe it so ' +
        'it can be redrawn. Do not write the prompt itself; that is the next step.'
      );
      lines.push('');
    } else {
      lines.push(`The prompt this will be used for: "${trimmed}"`);
      lines.push('');
      lines.push('That is context only. Do not answer it, and do not write a prompt.');
      lines.push('');
    }
  }

  lines.push(
    references.length === 1
      ? 'One picture is attached. Read it under the role below.'
      : `${references.length} pictures are attached, in the order listed below. Read each under its own role.`
  );
  lines.push('');

  // One block per picture, carrying that picture's OWN role instructions.
  //
  // This is a user's shape and it is the correction to what shipped first: the
  // prompt file listed all nine roles' extract and ignore rules, so an
  // analyst reading one Pose reference waded through eight roles it had not
  // been given to find the one it had. His spec is a twenty-word system
  // instruction with the role travelling per picture, and only the roles in
  // play ever reach the model this way.
  references.forEach((ref, i) => {
    const role = ref.role;
    const roleDef = roles[role] ?? {};
    lines.push(`Reference ${i + 1} — ${roleDef.label ?? role}`);
    if (roleDef.extract) {
      lines.push(`  TAKE: ${roleDef.extract}`);
    } else if (roleDef.rule) {
      // A role that declares no extract text falls back to the human-facing
      // line. Thin, but better than sending a role name with nothing after it.
      lines.push(`  TAKE: ${roleDef.rule}`);
    }
    const leave = leaveFor(roleDef.ignore, ref.note);
    if (leave) {
      lines.push(`  LEAVE: ${leave}`);
    }
    if (ref.character && carriesCharacter(role)) {
      lines.push(`  This is ${ref.character}.`);
    }
    if (ref.applies_to) {
      lines.push(`  Applies to: ${ref.applies_to}`);
    }
    if (ref.note) {
      // Last, and said to outrank the role out loud. It is the person typing
      // about this specific picture, which beats anything the registry says
      // about the category it belongs to.
      lines.push(`  THE PERSON ASKED FOR, and this outranks the two above: ${ref.note}`);
    }
    const hints = tagHints(ref, defaults, roleDef);
    if (hints.reserved?.length) {
      // Said separately from the confident list, and said to be weaker.
      //
      // These cleared a much lower floor because they belong to a named
      // category, not because the tagger was sure — so an analyst that took
      // them on the same footing as `princess_carry` at 1.00 would be
      // asserting things at 0.24 confidence. The instruction is the whole
      // safeguard: look, and drop what is not there.
      //
      // They are here rather than in the compile message for the same reason.
      // The compiler has no picture and could only take them on trust; this
      // call is looking at the photograph and can throw them out.
      lines.push(
        `  THE TAGGER ALSO GUESSED, with much less confidence: ${hints.reserved.join(', ')}. ` +
        'These are the details a description usually skips — anatomy, state of dress, how the ' +
        'bodies are arranged. Look for each one specifically. Describe the ones that are really ' +
        'there, plainly and without euphemism, and say nothing at all about the ones that are not.'
      );
    }
    if (hints.confident?.length) {
      // A hint, phrased as a hint. The analyst is looking at the photograph
      // and these are somebody else's guesses about it — a booru tagger that
      // is very good at naming a position or a garment and has no idea what
      // the picture is for. Measured on a princess-carry reference: it scored
      // `princess_carry` 1.00 and `head_wreath` 0.88, both of which the vision
      // pass kept losing.
      //
      // "Confirm or ignore, never repeat" is the load-bearing half. A tag
      // copied through without being looked for is worse than no tag: it
      // arrives in the reading indistinguishable from something observed, and
      // the compile call has no way to tell the two apart.
      lines.push(
        `  A TAGGER ALSO READ THIS PICTURE and guessed: ${hints.confident.join(', ')}. ` +
        'It is reliable about positions, anatomy and garments and unreliable about ' +
        'everything else, and it cannot see what the picture is for. Use it as a checklist ' +
        'of things to look for. Write down only the ones you can confirm by looking, in ' +
        'your own words. Say nothing about the ones you cannot see, and never copy the ' +
        'list back.'
      );
    }
    lines.push('');
  });

  return lines.join('\n');
}

/**
 * The reading, with the model's packaging taken off.
 *
 * Measured on the P40, 8 Sep 2026: the 27B returns the whole blueprint inside
 * a ```text fence. It is copying the prompt file, which shows the schema in a
 * fence because that is how a schema is written in markdown — and the fence
 * is not part of the schema.
 *
 * Deterministic, because it is a mechanical defect with a mechanical fix.
 * Asking the prompt file to say "do not use code fences" spends instruction
 * budget on something a four-line function settles, and the model would obey
 * it about as often as models obey any negative.
 *
 * **Every fence line, not only a wrapping pair.** The first version of this
 * took off a fence that wrapped the whole answer, on the grounds that a fence
 * in the middle might be the analyst quoting something. Measured on the P40
 * an hour later: the 27B fenced the REFERENCE block and left COMBINED
 * BLUEPRINT outside it, so a lone ``` line went into the compile message.
 *
 * A blueprint is prose about a photograph. It has no legitimate code in it —
 * the prompt file forbids tags and lists, and nothing here is parsed — so
 * there is no fence in this text that means anything, and the careful version
 * was being careful about a case that cannot arise.
 */
export function stripFence(text) {
  return String(text ?? '')
    .split('\n')
    .filter((line) => !/^\s*```[a-z]*\s*$/i.test(line))
    .join('\n')
    .trim();
}

/**
 * The tagger's confident guesses about one picture, for the analyst to check.
 *
 * Confidence-filtered and hard-capped, and both numbers live in the registry
 * because the right values are a measurement rather than a principle — see
 * config/models.yaml for the run they came off.
 *
 * **Why a threshold at all.** animetimm returns everything above its own low
 * floor: 136 tags on one reference, of which the top 26 are all things a
 * person would agree with and the tail is `ice_skates` at 0.06 and `@_@` at
 * 0.07. The owner's constraint is the design — "i just dont want lose what we
 * already have thats why i want it as a loose reference not a full ref" — and
 * a hundred junk tags in a 131-word prompt would drown the role instructions
 * that make the reading work.
 *
 * Sorted by confidence so the cap keeps the best ones rather than whichever
 * arrived first. The score itself is deliberately NOT sent: it invites the
 * model to arithmetic about a number it cannot check, when the only question
 * that matters is whether the thing is visible in the picture.
 *
 * A tag the vision cross-check added carries a null confidence — it was never
 * scored — and is dropped here rather than treated as a zero. It came from a
 * model looking at the picture in the first place, so offering it back to a
 * model looking at the picture is a loop, not evidence.
 */
/**
 * Does this danbooru tag belong to the reserved vocabulary?
 *
 * **Not a substring test, and that was the first version's bug.** Printed
 * against the real 134-tag run on 9 Sep 2026, the pattern `bra` had claimed
 * four of the eighteen slots with `braid`, `half_up_braid`, `french_braid`
 * and `bracelet`. `back` would have taken `background` the same way, and
 * `ass` would have taken `assault_rifle` — a tag that means the opposite of
 * everything this lane is for.
 *
 * Two shapes, and which one applies is decided by the pattern itself:
 *
 *   - a pattern with an underscore in it (`bare_`, `spread_`, `on_back`,
 *     `clothes_lift`) is a substring. Those are already specific enough that
 *     nothing else collides, and the trailing-underscore ones are how a
 *     family gets named without listing it.
 *   - a bare word (`bra`, `ass`, `hip`, `breast`) must match a WHOLE word of
 *     the tag, where danbooru's words are the underscore-separated parts. A
 *     trailing `s` is allowed, so `breast` catches `breasts` and `hip`
 *     catches `hips` without needing both spellings in the list.
 *
 * The rule is written down here rather than in the config file because it is
 * about how the matcher works. What is IN the list stays the owner's.
 */
export function matchesReserved(tag, patterns = []) {
  const k = String(tag ?? '').toLowerCase();
  if (!k) return false;
  const words = k.split('_').filter(Boolean);
  return patterns.some((p) => {
    if (p.includes('_')) return k.includes(p);
    return words.some((w) => w === p || (w.endsWith('s') && w.slice(0, -1) === p));
  });
}

export function tagHints(ref, defaults = {}, roleDef = {}) {
  // Per ROLE, not globally, and that is the point of it for now. Shipped
  // 9 Sep 2026 as a second role — "General testing" — sitting beside the
  // plain one so the two can be run against each other by two people on real
  // work: "if it works well then we can remove that and implement it across
  // the board but it needs real testing".
  //
  // My own three runs could not separate it from the prompt-size fix that
  // landed an hour earlier — the pose was already 3 of 3 without hints, and
  // the flower crown went 0 of 3 to 1 of 3, which is one run. That is not
  // evidence, and a flag is cheaper than pretending otherwise.
  const none = { confident: [], reserved: [] };
  if (roleDef?.tag_hints !== true) return none;
  const floor = defaults.reference_tag_hint_threshold ?? 0.6;
  const max = defaults.reference_tag_hint_max ?? 20;

  const all = (Array.isArray(ref?.detected) ? ref.detected : [])
    .filter((t) => t && typeof t.tag === 'string' && typeof t.confidence === 'number')
    .sort((a, b) => b.confidence - a.confidence);

  // The broad list is OFF by default, and that is the owner's call: "how can
  // we inject just those then". It is the better shape — the analyst is
  // already looking at the picture, so forty tags telling it about hair
  // colour and boots are forty tags it did not need, in a prompt that got
  // reliable precisely by being cut to 131 words. Only the category the
  // vision model will not describe on its own earns the room.
  //
  // Kept rather than deleted because it is one config line to put back, and
  // because the two lanes answer different questions: this one is "what else
  // is in the picture", the reserved one is "what will you not say".
  const confident = defaults.reference_tag_hint_broad === true && floor <= 1
    ? all.filter((t) => t.confidence >= floor).slice(0, max)
    : [];

  // ── the reserved lane ──
  //
  // The owner's objection to simply lowering the floor, and it is correct:
  // "but then the issue with that is if its below the ceiling we get abunch
  // of noise prompts too right". A low floor across the whole list admits
  // `ice_skates` at 0.06 and `@_@` at 0.07.
  //
  // So the floor drops for a NAMED CATEGORY and not for everything. A tag
  // matching nothing in reference_tag_hint_reserved never gets the lower
  // floor, however low it scores, so the noise this would otherwise let in
  // has no way through.
  //
  // It exists because confidence ranking structurally cannot surface this
  // category — measured with 45 slots at a 0.20 floor, `panties`, `ass`,
  // `thighs` and `bare_legs` were all still cut by hair colours the tagger
  // was simply more certain about.
  const patterns = (defaults.reference_tag_hint_reserved ?? [])
    .map((p) => String(p).toLowerCase())
    .filter(Boolean);
  const excluded = (defaults.reference_tag_hint_excluded ?? [])
    .map((p) => String(p).toLowerCase())
    .filter(Boolean);
  const reservedFloor = defaults.reference_tag_hint_reserved_floor ?? 0.12;
  const reservedMax = defaults.reference_tag_hint_reserved_max ?? 18;

  const seen = new Set(confident.map((t) => t.tag));
  const reserved = patterns.length
    ? all
        .filter((t) => !seen.has(t.tag))
        .filter((t) => t.confidence >= reservedFloor)
        .filter((t) => matchesReserved(t.tag, patterns))
        // Subtracted after, never woven into the include list. Audited
        // against all 90,857 danbooru tags on 9 Sep 2026, which is the only
        // way this was ever going to be got right: `transparent` was claiming
        // `transparent_background`, `feet` was claiming `feet_out_of_frame`
        // (a tag meaning the feet are NOT in shot), `on_back` was claiming
        // `sword_on_back`, and `thick` was claiming `thick_eyebrows`.
        //
        // Two lists rather than a cleverer include list, because the include
        // list is the owner's vocabulary and should read like one. Excluding
        // `transparent_background` must not require knowing that it is the
        // word `transparent` that let it in.
        //
        // archive/scripts/audit-reference-vocab.mjs re-runs the audit after an edit.
        .filter((t) => !matchesReserved(t.tag, excluded))
        .slice(0, reservedMax)
    : [];

  return { confident: confident.map((t) => t.tag), reserved: reserved.map((t) => t.tag) };
}

/**
 * Is this blueprint worth using?
 *
 * `UNAVAILABLE` is the prompt file's own answer for "I cannot see the
 * images", and it is the case that must not go through: a compile call given
 * the word UNAVAILABLE as its visual evidence, with the pictures already
 * stripped off the wire, would write a prompt from nothing and say nothing
 * about it. Falling back to sending the pictures is the safe answer.
 *
 * The length floor is for the other shape of the same failure — a model that
 * answers "I see an image." Anything under a couple of sentences did not do
 * the job the pass exists for.
 */
export function blueprintUsable(text) {
  const t = stripFence(text);
  if (!t) return false;
  if (/^UNAVAILABLE\b/i.test(t)) return false;
  return t.length >= 120;
}

/**
 * The rule the compiler gets alongside the blueprint.
 *
 * A user's, near enough verbatim, and every clause in it is load-bearing:
 *
 *   - "completed visual reading" stops the model asking to see the picture,
 *     which it will otherwise do when told there was one.
 *   - the role boundary is restated HERE and not only in the analysis prompt,
 *     because the analysis prompt is a different call and its instructions do
 *     not travel with its output.
 *   - the label ban is the difference between a prompt and a note about a
 *     prompt. "Same pose as the reference" is not something an image model
 *     can draw.
 */
export const BLUEPRINT_RULE = [
  'Reference reading — this is the completed visual analysis of the pictures the user attached.',
  'You are not being shown those pictures, and you do not need them: everything below was read off',
  'them for you. Write the prompt from it directly. Do not ask to see the images, and do not mention',
  'them.',
  '',
  'The role boundaries in that reading are absolute. A Pose reading gives you geometry and nothing',
  'else — never carry across the identity, face, hair, eyes, outfit, accessories, setting, lighting or',
  'drawing style of whoever was in that picture. The character named in the brief is the one who goes',
  'in the prompt.',
  '',
  // The whole-picture case, which is the opposite failure and needs saying
  // separately. Reported 9 Sep 2026 on a two-subject reference: the person
  // the brief did not mention "gets ignored and wont get prompted in". A
  // model asked to replace one of two people reads the request as being about
  // that one person and writes a prompt with one person in it.
  'A Whole picture reading is the opposite: everything in it carries across EXCEPT the identities.',
  'It describes every person in the frame, and every one of them belongs in your prompt — their',
  'clothes, what they are doing, where they stand, and their number. The brief names which of them is',
  'being replaced and by whom. That one becomes the character the brief names; everybody else stays',
  'exactly as the reading describes them, and the subject count does not change. Replacing one person',
  'in a picture of two must not produce a prompt with one person in it.',
  '',
  'Where the brief contradicts the reading, the brief wins. It is the person telling you what they',
  'want; the reading only says what was in the picture.',
  '',
  'Your prompt must never contain the words "reference", "picture 1", "the source image", "same pose",',
  '"as shown" or any other pointer back at an image. Whoever reads your prompt has no image. Write out',
  'the geometry, the garment, the light — the things the reading gave you.',
].join('\n');

/**
 * Pointers back at an image, found in generated output.
 *
 * Deterministic, and a warning rather than a rewrite. This is the one defect
 * of this pipeline that a person can see instantly and a model cannot check
 * itself for, and it is worth saying out loud — but a regex that edited the
 * prose would be making a judgement about a sentence it cannot read.
 *
 * Narrow on purpose. "reference" alone is a real English word that belongs in
 * plenty of prompts (a reference book, a photo reference on a desk); what
 * fails is the deictic use, where the prompt points at something the image
 * model has no access to.
 */
const LABEL_LEAKS = [
  /\b(?:the\s+)?(?:reference|source|input|attached|provided|original)\s+(?:image|picture|photo|images|pictures|photos)\b/gi,
  /\b(?:picture|reference|image)\s*#?\s*\d+\b/gi,
  /\b(?:the\s+)?same\s+(?:pose|outfit|clothes|clothing|background|lighting|style|composition|framing|angle)\b/gi,
  /\bas\s+(?:shown|seen|depicted|pictured)\b/gi,
  /\b(?:like|matching|from)\s+the\s+(?:reference|photo|picture|image)\b/gi,
];

export function referenceLabelLeaks(text) {
  const found = new Set();
  for (const re of LABEL_LEAKS) {
    // Fresh lastIndex each call — these are module-level /g regexes and a
    // leftover index silently skips the first match of the next string.
    re.lastIndex = 0;
    for (const m of String(text ?? '').matchAll(re)) found.add(m[0].trim().toLowerCase());
  }
  return [...found];
}
