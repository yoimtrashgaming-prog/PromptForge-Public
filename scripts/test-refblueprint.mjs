// The look-first half of the reference pipeline.
//
//   node scripts/test-refblueprint.mjs
//
// No server, no model, no network — every builder in server/refblueprint.mjs
// is pure, which is why they are builders and not one function that also
// talks to the GPU.
//
// What this is defending. A user's workflow splits one call into two: an
// analyst that looks at the pictures under their assigned roles, and a
// compiler that writes the prompt from that text with the pictures off the
// wire. Both halves fail quietly when they fail. A pose reference that leaks
// its source character's hair reads as an ordinary prompt; a numbering that
// slips by one annotates the wrong photograph and says nothing; a blueprint
// the model could not produce, gone unnoticed, means a prompt written from
// nothing at all. None of that shows up in output you can look at, so it has
// to show up here.

import {
  BLUEPRINT_RULE,
  BLUEPRINT_TEMPERATURE,
  blueprintBudget,
  buildBlueprintMessage,
  blueprintUsable,
  referenceAnalysisIdentity,
  reusableReferenceAnalysis,
  referenceLabelLeaks,
  stripFence,
  tagHints,
  matchesReserved,
  leaveFor,
} from '../server/refblueprint.mjs';
import { orderReferences } from '../server/imagerefs.mjs';
import { ROLE_CARRIES_CHARACTER, isRoleTag } from '../web/appearance.js';
// The real registry, for the role that has to exist in it. The DEFAULTS
// fixture below is a stand-in for the grouping tests and proves nothing about
// what config/models.yaml actually declares — see [[fixtures-are-not-verification]].
import { loadRegistry } from '../server/registry.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
const failures = [];
function check(what, ok, detail) {
  if (ok) passed += 1;
  else failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
}

// Registry order, which is what the grouping follows. Same keys as
// config/models.yaml; the rules are shortened, since nothing here reads them
// for content.
const DEFAULTS = {
  image_reference_roles: {
    character: { label: 'Character', rule: 'who is in the picture' },
    outfit: { label: 'Outfit', rule: 'clothing, materials, colours' },
    background: { label: 'Background', rule: 'the setting' },
    pose: { label: 'Pose', rule: 'posture, body orientation, hands' },
  },
  default_image_reference_role: 'character',
  max_image_references: 6,
};

const carries = (role) => ROLE_CARRIES_CHARACTER.has(role);

// Cached analysis is bound to content and ordered roles, never to row count.
{
  const model = { key: 'illustrious', type: 'image' };
  const refs = [{ role: 'pose', image: 'image-a', note: 'hands up' }, { role: 'pose', image: 'image-b' }];
  const brief = 'a person waving';
  const reading = 'A completed role-isolated reading with enough text to be usable. '.repeat(3);
  const identity = referenceAnalysisIdentity(model, brief, refs, DEFAULTS);
  const controls = { image_references: refs, reference_analysis: reading, reference_analysis_identity: identity };
  check('identical reference inputs reuse the reading', reusableReferenceAnalysis(model, brief, controls, DEFAULTS) === reading.trim());
  check('object property order is not reference identity',
    referenceAnalysisIdentity(model, brief, [{ note: 'hands up', image: 'image-a', role: 'pose' }, refs[1]], DEFAULTS) === identity);
  check('same-role reordering invalidates numbered readings',
    reusableReferenceAnalysis(model, brief, { ...controls, image_references: [...refs].reverse() }, DEFAULTS) === '');
  check('an unrelated creativity control does not invalidate a reading',
    reusableReferenceAnalysis(model, brief, { ...controls, creativity: 'wild' }, DEFAULTS) === reading.trim());
  check('a changed image ceiling invalidates analyst input provenance',
    reusableReferenceAnalysis(model, brief, controls, { ...DEFAULTS, max_image_references: 1 }) === '');
  check('missing provenance is not reusable',
    reusableReferenceAnalysis(model, brief, { ...controls, reference_analysis_identity: undefined }, DEFAULTS) === '');
  check('a video model cannot reuse an image blueprint',
    reusableReferenceAnalysis({ key: 'h3', type: 'video' }, brief, controls, DEFAULTS) === '');
  check('an unusable reading is refused even with matching inputs',
    reusableReferenceAnalysis(model, brief, { ...controls, reference_analysis: 'UNAVAILABLE' }, DEFAULTS) === '');
}

// ── the budget ───────────────────────────────────────────────
{
  check('one picture gets the base budget', blueprintBudget(1) === 830, String(blueprintBudget(1)));
  check('the budget grows with pictures', blueprintBudget(3) > blueprintBudget(1));
  check('the budget is capped', blueprintBudget(20) === 1600, String(blueprintBudget(20)));
  check('extraction runs cold', BLUEPRINT_TEMPERATURE <= 0.3, String(BLUEPRINT_TEMPERATURE));
}

// ── numbering ────────────────────────────────────────────────
//
// The bug this is here for, found 8 Sep 2026: the notes were numbered in
// registry role order and the pictures were sent in upload order, so
// attaching a pose and then a character made "Reference 1" describe the
// character while picture 1 was the pose. Both sides go through
// orderReferences now, and the blueprint message is a third reader of the
// same numbering — so it has to agree with them, not merely with itself.
{
  const uploaded = [
    { role: 'pose', image: 'data:image/png;base64,AAAA' },
    { role: 'character', image: 'data:image/png;base64,BBBB' },
  ];
  const ordered = orderReferences(uploaded, DEFAULTS);
  check('registry order wins over upload order',
    ordered.map((r) => r.role).join(',') === 'character,pose',
    ordered.map((r) => r.role).join(','));

  const msg = buildBlueprintMessage(ordered, 'frieren in a market', DEFAULTS, carries);
  const one = msg.indexOf('Reference 1');
  const two = msg.indexOf('Reference 2');
  check('Reference 1 is the character', msg.slice(one, two).includes('Character'), msg.slice(one, two));
  check('Reference 2 is the pose', msg.slice(two).includes('Pose'), msg.slice(two));
  // The picture at index 0 of the ordered list is the one the analyst is
  // told is Reference 1. That is the whole correspondence.
  check('the pictures line up with the numbering',
    ordered[0].image === 'data:image/png;base64,BBBB', ordered[0].image);
}

// ── an unknown role is not dropped ───────────────────────────
{
  const ordered = orderReferences([{ role: 'lighting', image: 'x' }], DEFAULTS);
  check('a role the registry does not declare still gets a slot', ordered.length === 1);
}

// ── role isolation: the character name ───────────────────────
//
// The strongest thing a reference can carry and so the worst one to leak. A
// Pose reference is somebody else's photograph borrowed for a posture; an
// analyst told it is Frieren describes Frieren, and every guard downstream is
// then arguing with evidence rather than with an invention.
{
  const pose = buildBlueprintMessage(
    [{ role: 'pose', character: 'frieren' }], '', DEFAULTS, carries
  );
  check('a pose reference is not told who it is',
    !/frieren/i.test(pose), pose);

  const character = buildBlueprintMessage(
    [{ role: 'character', character: 'frieren' }], '', DEFAULTS, carries
  );
  check('a character reference is told who it is',
    /frieren/i.test(character), character);

  const outfit = buildBlueprintMessage(
    [{ role: 'outfit', character: 'frieren' }], '', DEFAULTS, carries
  );
  check('an outfit reference is not told who it is',
    !/frieren/i.test(outfit), outfit);
}

// ── the General role ─────────────────────────────────────────
//
// Added 9 Sep 2026 for the case none of the single-aspect roles covers:
// "replace this character with this character". Reported against Character on
// a two-subject picture — the second person "gets ignored and wont get
// prompted in" — which is Character behaving correctly, since it strips the
// pose, clothes, setting and framing that a second person needs to exist in.
{
  const REAL = loadRegistry(ROOT).defaults;
  const roles = REAL.image_reference_roles ?? {};
  check('the registry declares it', Boolean(roles.general), Object.keys(roles).join(','));
  check('it is first in the picker', Object.keys(roles)[0] === 'general', Object.keys(roles)[0]);
  // The rule is what the model is shown, so the load-bearing clauses have to
  // survive an edit to it. The count is the one that answers the report.
  check('its rule hands the decision to the brief',
    /your brief decides/i.test(roles.general?.rule ?? ''), roles.general?.rule);
  check('its rule promises the unmentioned survives',
    /stays as it is/i.test(roles.general?.rule ?? ''), roles.general?.rule);
  check('it is flagged brief-driven', roles.general?.driven_by_brief === true);

  // ── the role's instructions live HERE, not in the prompt file ──
  //
  // A user's shape, adopted 9 Sep 2026 after the prompt file reached 1,564
  // words listing all nine roles at once. His spec is a twenty-word system
  // instruction with the role travelling per picture; the owner's call was
  // "just have the base output structure thats needed no other prompts".
  //
  // So: every role carries its own extract text, and a request sends only the
  // roles it actually uses. A role added later with no extract line would
  // silently reach the model as a bare label.
  for (const [name, def] of Object.entries(roles)) {
    check(`${name} tells the analyst what to take`, Boolean(def.extract), JSON.stringify(def));
  }
  // The one role that must NOT carry an ignore list of its own — its whole
  // contract is that the brief decides what to leave.
  check('every aspect role says what to leave',
    Object.entries(roles).filter(([n]) => n !== 'general').every(([, d]) => Boolean(d.ignore)));

  // Only the roles in play. The failure being defended against is the one
  // that was shipped: an analyst given one Pose reference reading eight other
  // roles' rules to find the one it was handed.
  const onePose = buildBlueprintMessage([{ role: 'pose' }], 'anything', REAL, carries);
  check('one reference sends one role\'s rules',
    onePose.includes(REAL.image_reference_roles.pose.extract) &&
      !onePose.includes(REAL.image_reference_roles.outfit.extract), onePose);
  check('and its leave list with it',
    onePose.includes(REAL.image_reference_roles.pose.ignore));

  // The note is the person typing about this exact picture. It has to arrive
  // marked as outranking the role, or it is one more line among three.
  const noted = buildBlueprintMessage(
    [{ role: 'pose', note: 'he is standing, carrying her' }], '', REAL, carries
  );
  check('a note outranks the role, out loud',
    /outranks the two above: he is standing, carrying her/.test(noted), noted);

  // Never names the source person. In a two-subject picture a single
  // `character` field cannot say whether it names the one being replaced or
  // the one staying, so it names neither and the brief decides.
  check('it may not name a character', !ROLE_CARRIES_CHARACTER.has('general'));
  const msg = buildBlueprintMessage(
    [{ role: 'general', character: 'frieren' }], 'replace the blue haired girl with frieren',
    REAL, carries
  );
  check('a recognised character does not reach the analyst',
    !/this is frieren/i.test(msg), msg);
  // The brief still does, and must: under this role it is the ONLY thing
  // deciding what to take.
  check('the brief still does', /replace the blue haired girl/i.test(msg), msg);
  check('the brief arrives as an instruction, not as context',
    /your instruction for what to take/i.test(msg) && !/context only/i.test(msg), msg);
  check('and the unmentioned is promised to survive',
    /did not ask to change, they are keeping/i.test(msg), msg);
  // Both halves of the flag. An aspect role in the same request must still be
  // told the brief is context — the flag is per role, not per request, and a
  // mixed set is the case that would catch a `some()` used as an `every()`.
  const aspectOnly = buildBlueprintMessage(
    [{ role: 'pose' }], 'replace the blue haired girl with frieren', REAL, carries
  );
  check('an aspect role still gets the brief as context',
    /context only/i.test(aspectOnly), aspectOnly);
  check('and is not handed the instruction framing',
    !/your instruction for what to take/i.test(aspectOnly), aspectOnly);

  // Greys no chips. Absent from ROLE_KEEPS, not empty in it — see the note
  // there. An empty entry would grey every chip, which is the exact opposite.
  check('it keeps every tag', isRoleTag('white_hair', 'general') && isRoleTag('forest', 'general') &&
    isRoleTag('from_side', 'general') && isRoleTag('school_uniform', 'general'));
  check('a single-aspect role still narrows', isRoleTag('forest', 'outfit') === false);

  // The compiler's rule has to carry the opposite failure to the pose one.
  check('the rule warns against dropping the other subject',
    /must not produce a prompt with one person in it/i.test(BLUEPRINT_RULE));
  check('the rule says the brief outranks the reading',
    /the brief wins/i.test(BLUEPRINT_RULE));
}

// ── the tagger's guesses, as a hint ──────────────────────────
//
// Asked for 9 Sep 2026. The evidence is clean: on a two-character
// princess-carry reference animetimm scored `princess_carry` 1.00,
// `head_wreath` 0.88 and `1girl`/`1boy` 0.99/0.97 — the three things the
// vision pass kept getting wrong. The same run returned 136 tags with
// `ice_skates` at 0.06 in the tail, which is why there is a threshold.
//
// The constraint the numbers exist to honour: "i just dont want lose what we
// already have thats why i want it as a loose reference not a full ref".
{
  const REAL = loadRegistry(ROOT).defaults;
  // A slice of the real animetimm run, top and tail.
  const detected = [
    { tag: 'princess_carry', confidence: 1.0 },
    { tag: '1girl', confidence: 0.99 },
    { tag: '1boy', confidence: 0.97 },
    { tag: 'head_wreath', confidence: 0.88 },
    { tag: 'grey_hair', confidence: 0.74 },
    { tag: 'skirt', confidence: 0.36 },
    { tag: 'virtual_youtuber', confidence: 0.14 },
    { tag: 'ice_skates', confidence: 0.12 },
    { tag: '@_@', confidence: 0.07 },
    // The vision cross-check's additions are never scored. A null must not
    // read as a zero, and must not be offered back to a model that is looking
    // at the same picture — that is a loop, not evidence.
    { tag: 'added_by_the_vision_pass', confidence: null },
  ];

  const TESTING = REAL.image_reference_roles.general_testing;
  const PLAIN = REAL.image_reference_roles.general;
  const BROAD = { ...REAL, reference_tag_hint_broad: true };
  const hints = tagHints({ detected }, BROAD, TESTING).confident;
  check('the confident ones survive', hints.includes('princess_carry') && hints.includes('head_wreath'), hints.join(','));
  check('the subject count survives', hints.includes('1girl') && hints.includes('1boy'), hints.join(','));
  check('the junk tail is cut', !hints.some((t) => ['ice_skates', 'virtual_youtuber', '@_@'].includes(t)), hints.join(','));
  check('an unscored tag is dropped', !hints.includes('added_by_the_vision_pass'), hints.join(','));
  check('best first', hints[0] === 'princess_carry', hints.join(','));
  check('capped', tagHints({ detected: Array.from({ length: 200 }, (_, i) => ({ tag: `t${i}`, confidence: 0.9 })) }, BROAD, TESTING).confident.length
    === (REAL.reference_tag_hint_max ?? 20));
  check('a threshold above 1 switches it off',
    tagHints({ detected }, { ...BROAD, reference_tag_hint_threshold: 1.5 }, TESTING).confident.length === 0);
  check('no tags, no line', tagHints({}, BROAD, TESTING).confident.length === 0);

  // ── the A/B, which only means anything if the arms differ ──
  //
  // Two people are going to run these against each other on real work. If
  // plain General quietly started sending hints too there would be nothing to
  // compare and nobody would be able to tell.
  check('plain General is the control arm', PLAIN?.tag_hints !== true, JSON.stringify(PLAIN?.tag_hints));
  check('and gets no hints', tagHints({ detected }, BROAD, PLAIN).confident.length === 0);
  check('General testing is the treatment arm', TESTING?.tag_hints === true);
  check('the two arms differ only in hints',
    TESTING.extract === PLAIN.extract && TESTING.ignore === PLAIN.ignore &&
      TESTING.driven_by_brief === PLAIN.driven_by_brief,
    'extract/ignore/driven_by_brief must match or the comparison measures the wrong thing');
  check('General testing may not name a character', !ROLE_CARRIES_CHARACTER.has('general_testing'));
  check('and greys no chips', isRoleTag('white_hair', 'general_testing'));
  const plainMsg = buildBlueprintMessage([{ role: 'general', detected }], 'a brief', BROAD, carries);
  check('no hint line on the control arm', !/A TAGGER ALSO READ/.test(plainMsg), plainMsg);

  // In the message, and framed so the analyst checks rather than copies. The
  // failure being defended against is a tag arriving in the reading
  // indistinguishable from something observed — the compile call has no
  // picture and no way to tell those apart.
  // BROAD, because the wide list is off by default now — "how can we inject
  // just those then". These two still matter: the lane is one config line
  // from coming back, and its framing is what stops the model copying it.
  const msg = buildBlueprintMessage([{ role: 'general_testing', detected }], 'a brief', BROAD, carries);
  check('the hint reaches the analyst', /princess_carry/.test(msg), msg);
  check('and is marked as somebody else\'s guess', /A TAGGER ALSO READ THIS PICTURE/.test(msg), msg);
  check('and told to confirm, not copy',
    /only the ones you can confirm/i.test(msg) && /never copy the list back/i.test(msg), msg);

  // ── the matcher, which was a substring test and wrong ──
  //
  // Printed against the real 134-tag run: `bra` had claimed four of eighteen
  // slots with braid, half_up_braid, french_braid and bracelet. The lane is
  // small on purpose, so four wasted slots is a quarter of it.
  {
    const P = ['bra', 'ass', 'back', 'breast', 'hip', 'bare_', 'on_back', 'spread_'];
    check('bra does not match braid', !matchesReserved('braid', P));
    check('bra does not match bracelet', !matchesReserved('bracelet', P));
    check('bra does not match french_braid', !matchesReserved('french_braid', P));
    check('but bra matches bra', matchesReserved('bra', P));
    check('and sports_bra', matchesReserved('sports_bra', P));
    // The one that would have been actively wrong: a weapon in the anatomy lane.
    check('ass does not match assault_rifle', !matchesReserved('assault_rifle', P));
    check('but ass matches ass', matchesReserved('ass', P));
    // `background` is in nearly every tagger run.
    check('back does not match background', !matchesReserved('background', P));
    check('but back matches on_back', matchesReserved('on_back', P));
    // Plurals, so the list needs one spelling and not two.
    check('breast matches breasts', matchesReserved('breasts', P));
    check('hip matches hips', matchesReserved('hips', P));
    check('and small_breasts', matchesReserved('small_breasts', P));
    // A pattern with an underscore stays a substring — that is how a family
    // gets named without listing every member.
    check('bare_ is a prefix family', matchesReserved('bare_shoulders', P) && matchesReserved('bare_legs', P));
    check('spread_ likewise', matchesReserved('spread_legs', P));
    check('nothing matches nothing', !matchesReserved('cityscape', P));
  }

  // ── fidelity, on a brief-driven role ──
  //
  // "does the how closely to follow it work with the general testing?" — it
  // did not. Printed per fidelity, the compile message was contradicting
  // itself in eight lines: `exact` said "take nothing else from that
  // picture" while the role said everything unmentioned stays, and
  // `attribute` said "ignore everything else about it".
  //
  // And the role's own `rule` was going to the model, so the prompt writer
  // was reading "Being tried against General — pick whichever gives you
  // better output" as guidance about a photograph.
  {
    const R = loadRegistry(ROOT).defaults;
    for (const name of ['general', 'general_testing']) {
      const def = R.image_reference_roles[name];
      check(`${name} has a model-facing rule`, Boolean(def.compile_rule), name);
      check(`${name} keeps the A/B note away from the model`,
        !/pick whichever|being tried/i.test(def.compile_rule ?? ''), def.compile_rule);
      check(`${name} overrides the fidelity wording`,
        Object.keys(def.fidelity_rules ?? {}).length === Object.keys(R.reference_fidelity).length,
        Object.keys(def.fidelity_rules ?? {}).join(','));
      // The specific contradiction. None of this role's fidelity rules may
      // tell the model to take nothing else from the picture.
      for (const [k, v] of Object.entries(def.fidelity_rules ?? {})) {
        check(`${name}/${k} does not contradict the role`,
          !/nothing else|ignore everything else/i.test(v.rule ?? ''), v.rule);
      }
    }
    // The two arms must still differ only in tag_hints.
    const a = R.image_reference_roles.general;
    const b = R.image_reference_roles.general_testing;
    check('the arms still match on the compile rule', a.compile_rule === b.compile_rule);
    check('and on every fidelity rule',
      JSON.stringify(a.fidelity_rules) === JSON.stringify(b.fidelity_rules));

    // An aspect role must be untouched — its shared wording is correct.
    check('pose still uses the shared fidelity rules',
      !R.image_reference_roles.pose.fidelity_rules);
  }

  // ── coverage: the vocabulary must reach the named things ──
  //
  // "and this gives it the terms needed for anatomy even slang words? ... or
  // positions that have specific names". The first draft covered about half:
  // `paizuri` at 41k posts, `sideboob` at 117k, `anus` at 115k and
  // `open_shirt` at 116k were all being dropped.
  //
  // A named position is the sharpest loss. `mating_press` and `full_nelson`
  // are one tag each with no other way to say them, so a filter that drops
  // one has thrown away the picture. archive/scripts/audit-reference-coverage.mjs is
  // the full sweep; these are the ones worth failing a build over.
  {
    const REAL3 = loadRegistry(ROOT).defaults;
    const T3 = REAL3.image_reference_roles.general_testing;
    check('the testing arm still declares hints', T3?.tag_hints === true);
    const must = [
      'mating_press', 'full_nelson', 'suspended_congress', 'prone_bone',
      'cowgirl_position', 'missionary', 'doggystyle', 'all_fours', 'spread_legs',
      'paizuri', 'fellatio', 'handjob', 'footjob', 'masturbation', 'fingering',
      'sideboob', 'underboob', 'anus', 'cameltoe', 'clitoris', 'testicles',
      'open_shirt', 'skirt_lift', 'panty_pull', 'clothing_aside', 'no_panties',
      'ahegao', 'nude', 'topless', 'bottomless',
    ];
    // Against the matcher, not tagHints — tagHints caps at
    // reference_tag_hint_reserved_max and this list is deliberately longer
    // than the cap. What is being asserted is that the VOCABULARY reaches
    // these, not that all thirty would fit in one request.
    const inc = (REAL3.reference_tag_hint_reserved ?? []).map((x) => String(x).toLowerCase());
    const exc = (REAL3.reference_tag_hint_excluded ?? []).map((x) => String(x).toLowerCase());
    const passes = (t) => matchesReserved(t, inc) && !matchesReserved(t, exc);
    const gaps = must.filter((t) => !passes(t));
    check(`every named position and act gets through (${must.length})`,
      gaps.length === 0, gaps.join(', '));

    // And the generic tags that would eat the lane must NOT. open_mouth is in
    // the millions; `open_` was claiming it until the audit caught it.
    const never = ['open_mouth', 'open_eyes', 'loose_socks', 'loose_necktie',
      'zipper_pull_tab', 'cheek_bulge', 'feet_out_of_frame', 'thick_eyebrows'];
    const leaked = never.filter((t) => passes(t));
    check('and the generic ones stay out', leaked.length === 0, leaked.join(', '));
  }

  // ── the exclusion list ──
  //
  // Every entry in it was found by running the vocabulary over all 90,857
  // danbooru tags (archive/scripts/audit-reference-vocab.mjs), and none was
  // imaginable at a desk. `feet_out_of_frame` is the sharpest: it means the
  // feet are NOT in shot, which is the opposite of what the lane is for.
  {
    const REAL2 = loadRegistry(ROOT).defaults;
    const T = REAL2.image_reference_roles.general_testing;
    const wrong = [
      { tag: 'feet_out_of_frame', confidence: 0.9 },
      { tag: 'thick_eyebrows', confidence: 0.9 },
      { tag: 'transparent_background', confidence: 0.9 },
      { tag: 'weapon_on_back', confidence: 0.9 },
      { tag: 'jacket_on_shoulders', confidence: 0.9 },
      { tag: 'cigarette_butt', confidence: 0.9 },
      // and one real one at the same confidence, to prove the list is not
      // simply eating the lane
      { tag: 'bare_shoulders', confidence: 0.9 },
    ];
    const out = tagHints({ detected: wrong }, REAL2, T).reserved;
    for (const t of ['feet_out_of_frame', 'thick_eyebrows', 'transparent_background',
                     'weapon_on_back', 'jacket_on_shoulders', 'cigarette_butt']) {
      check(`${t} is excluded`, !out.includes(t), out.join(','));
    }
    check('and a real one at the same score survives', out.includes('bare_shoulders'), out.join(','));
    check('the exclusion list is in config', Array.isArray(REAL2.reference_tag_hint_excluded) &&
      REAL2.reference_tag_hint_excluded.length > 10);
  }

  // ── the reserved lane ──
  //
  // The blind spot: "those more nsfw or anatomy or positions needed for that
  // civitia red side would really help with which is our one blind spot".
  // Measured — with the floor at 0.20 and 45 slots, `panties`, `ass`,
  // `thighs` and `bare_legs` were STILL cut, because the tagger is more
  // certain about hair colour and 45 slots fill up first. Confidence ranking
  // structurally cannot reach this category.
  //
  // And the owner's objection to just dropping the floor, which is the reason
  // this is a vocabulary rather than a number: "if its below the ceiling we
  // get abunch of noise prompts too right".
  {
    const nsfw = [
      { tag: 'princess_carry', confidence: 1.0 },
      { tag: 'multicolored_hair', confidence: 0.98 },
      { tag: 'upskirt', confidence: 0.42 },
      { tag: 'ass', confidence: 0.24 },
      { tag: 'panties', confidence: 0.23 },
      { tag: 'thighs', confidence: 0.27 },
      { tag: 'cleavage_cutout', confidence: 0.13 },
      // Junk at the same depth as the anatomy above. Matches no pattern, so
      // the low floor must not reach it — this is the whole safeguard.
      { tag: 'ice_skates', confidence: 0.30 },
      { tag: 'virtual_youtuber', confidence: 0.28 },
      { tag: 'science_fiction', confidence: 0.14 },
    ];
    const out = tagHints({ detected: nsfw }, REAL, TESTING);
    const all = [...out.confident, ...out.reserved];
    for (const t of ['upskirt', 'ass', 'panties', 'thighs', 'cleavage_cutout']) {
      check(`${t} reaches the analyst`, all.includes(t), all.join(','));
    }
    // The noise the owner asked about. Same confidence band, no pattern match.
    check('junk at the same depth stays out',
      !out.reserved.includes('ice_skates') && !out.reserved.includes('virtual_youtuber') &&
      !out.reserved.includes('science_fiction'), out.reserved.join(','));
    check('reserved tags are kept apart from confident ones',
      out.reserved.includes('panties') && !out.confident.includes('panties'),
      JSON.stringify(out));
    check('the control arm gets none of it', tagHints({ detected: nsfw }, REAL, PLAIN).reserved.length === 0);
    // "how can we inject just those then" — the broad list is off, so the
    // only tags that reach the analyst are the named category.
    check('the broad list is off by default', REAL.reference_tag_hint_broad !== true);
    check('so only the named category travels',
      tagHints({ detected: nsfw }, REAL, TESTING).confident.length === 0 &&
        tagHints({ detected: nsfw }, REAL, TESTING).reserved.length > 0);

    const m = buildBlueprintMessage([{ role: 'general_testing', detected: nsfw }], 'a brief', REAL, carries);
    check('the weak lane is labelled as weaker',
      /much less confidence/.test(m) && /panties/.test(m), m);
    check('and told to look before believing',
      /Look for each one specifically/.test(m) && /say nothing at all about the ones that are not/.test(m), m);
    // It must NOT reach the compile call. That side has no picture and could
    // only take a 0.24 guess on trust.
    check('the vocabulary lives in config, for the owner to edit',
      Array.isArray(REAL.reference_tag_hint_reserved) && REAL.reference_tag_hint_reserved.length > 20);
  }

  check('a reference with no tagger output gets no hint line',
    !/A TAGGER ALSO READ/.test(buildBlueprintMessage([{ role: 'general_testing' }], 'a brief', REAL, carries)));
}

// ── what the analyst is deliberately NOT given ───────────────
{
  const msg = buildBlueprintMessage(
    [{
      role: 'outfit',
      fidelity: 'loose',
      note: 'only the coat',
      applies_to: 'the elf',
      tags: ['white_hair', 'blurry', 'artist_name'],
    }],
    'two people in a market',
    DEFAULTS,
    carries
  );
  check('the note reaches it', msg.includes('only the coat'), msg);
  check('who it applies to reaches it', msg.includes('the elf'), msg);
  // Picked tags are the person's selection and they reach the COMPILER. Sent
  // here they come back as things the analyst claims to have seen, and a tag
  // laundered through a USE section cannot be told from an observation.
  check('picked tags do not reach it', !msg.includes('white_hair'), msg);
  // Fidelity is the compiler's decision. An analyst told "loose inspiration"
  // has been given a reason to look less carefully.
  check('fidelity does not reach it', !/loose/i.test(msg), msg);
}

// ── the brief is context, not a request ──────────────────────
{
  const msg = buildBlueprintMessage([{ role: 'pose' }], 'frieren in a market', DEFAULTS, carries);
  check('the brief travels', msg.includes('frieren in a market'), msg);
  check('and is marked as context',
    /do not (answer|write)/i.test(msg), msg);
}

// ── is the reading usable ────────────────────────────────────
//
// The case that must not go through: the compile call has already had the
// pictures stripped off it, so a blueprint saying UNAVAILABLE would have it
// writing from nothing while reporting success.
{
  check('UNAVAILABLE is refused', blueprintUsable('UNAVAILABLE') === false);
  check('UNAVAILABLE with trailing noise is refused',
    blueprintUsable('UNAVAILABLE\n') === false);
  check('empty is refused', blueprintUsable('') === false);
  check('null is refused', blueprintUsable(null) === false);
  check('"I see an image." is refused', blueprintUsable('I see an image.') === false);
  const real = [
    'REFERENCE 1 — POSE',
    '',
    'USE:',
    'Standing three-quarters to camera, weight on the left leg, right hand',
    'raised to shoulder height with the palm turned out, head following it.',
    '',
    'IGNORE:',
    'Identity, hair and eye colour, garments, setting, palette.',
  ].join('\n');
  check('a real reading is accepted', blueprintUsable(real) === true, real);
  // Measured on the P40, 8 Sep 2026: the 27B returns the whole thing inside a
  // ```text fence, copying the schema in the prompt file. Left on, it goes
  // into the compile message as literal backticks.
  check('a fenced reading is accepted', blueprintUsable('```text\n' + real + '\n```') === true);
}

// ── the model's packaging ────────────────────────────────────
{
  check('a wrapping fence comes off', stripFence('```text\nREFERENCE 1\nUSE:\nx\n```') === 'REFERENCE 1\nUSE:\nx');
  check('a bare fence comes off too', stripFence('```\nhello\n```') === 'hello');
  check('unfenced text is untouched', stripFence('REFERENCE 1\nUSE:\nx') === 'REFERENCE 1\nUSE:\nx');
  // Measured on the P40: the model fenced the REFERENCE block and left
  // COMBINED BLUEPRINT outside it, so a lone ``` line reached the compile
  // message. A blueprint is prose about a photograph — no fence in it means
  // anything, so all of them come off.
  check('a stray unpaired fence comes off',
    stripFence('REFERENCE 1\nUSE:\nx\n```\n\nCOMBINED BLUEPRINT:\ny') ===
      'REFERENCE 1\nUSE:\nx\n\nCOMBINED BLUEPRINT:\ny');
  check('the text between fences survives',
    stripFence('```\nREFERENCE 1\n```\nCOMBINED BLUEPRINT:\ny') === 'REFERENCE 1\nCOMBINED BLUEPRINT:\ny');
  check('a fenced UNAVAILABLE is still refused', blueprintUsable('```\nUNAVAILABLE\n```') === false);
}

// ── the compiler's rule ──────────────────────────────────────
{
  check('the rule says the reading is complete', /completed visual analysis/i.test(BLUEPRINT_RULE));
  check('the rule restates the role boundary', /Pose reading/i.test(BLUEPRINT_RULE));
  check('the rule bans pointers at the picture', /same pose/i.test(BLUEPRINT_RULE));
}

// ── pointers back at a picture the generator cannot see ──────
{
  const leaks = (s) => referenceLabelLeaks(s);
  check('"same pose" is caught', leaks('1girl, standing, same pose as reference').includes('same pose'));
  check('"Picture 1" is caught', leaks('Replicate the pose in Picture 1.').length > 0);
  check('"the reference image" is caught',
    leaks('Match the lighting of the reference image.').length > 0);
  check('"as shown" is caught', leaks('arms crossed as shown, smiling').length > 0);
  check('"like the photo" is caught', leaks('a coat like the photo').length > 0);

  // The other half, and the one that decides whether this is usable: it must
  // stay quiet on ordinary prompts. A warning that fires on good output is a
  // warning people learn to ignore.
  const clean = [
    'masterpiece, best_quality, 1girl, frieren, elf, long_pointy_ears, white_hair,',
    'standing, three-quarter view, weight on left leg, right hand raised,',
    'palm out, market stalls, warm afternoon light, depth of field',
  ].join(' ');
  check('an ordinary prompt is quiet', leaks(clean).length === 0, JSON.stringify(leaks(clean)));
  check('a photograph on a desk is not a pointer',
    leaks('an artist at a desk, reference books, photo references pinned to the wall').length === 0,
    JSON.stringify(leaks('an artist at a desk, reference books, photo references pinned to the wall')));
  // Module-level /g regexes keep a lastIndex between calls. Without the reset
  // in referenceLabelLeaks the second call here silently finds nothing.
  check('two calls in a row agree',
    leaks('same pose').length === leaks('same pose').length &&
      leaks('same pose').length === 1);
}

// ── the note takes its asks out of LEAVE (a user, 18 Sep 2026) ──
//
// A Pose picture noted "Reproduce this pose, the background, and outfit"
// came back with clothing and background under IGNORE: the analyst copied
// LEAVE and lost the note. The asks are now removed before it is sent.
{
  const REAL = loadRegistry(ROOT).defaults;
  const POSE = REAL.image_reference_roles.pose.ignore;
  const asked = leaveFor(POSE, 'Reproduce this pose, the background, and outfit');
  check('a note asking for the background takes it out of LEAVE', !/background/i.test(asked), asked);
  check('...and the outfit takes out clothing and accessories', !/clothing|accessor/i.test(asked), asked);
  check('...but hair, identity and the swap stay', /hair/.test(asked) && /Who this is/.test(asked) && /replaces the person/.test(asked), asked);
  check('no note leaves LEAVE untouched', leaveFor(POSE, '') === POSE);
  check('a negated ask removes nothing', leaveFor(POSE, 'same pose but not the background') === POSE);
  check('"body characteristics" is not the character', /body characteristics/.test(leaveFor(POSE, 'keep her face')));
  check('asking for the face drops the swap sentence', !/replaces the person/.test(leaveFor(POSE, 'keep her face')));
  const msg = buildBlueprintMessage(
    [{ role: 'pose', note: 'Reproduce this pose, the background, and outfit' }], '', REAL, carries
  );
  const leaveLine = msg.split('\n').find((l) => l.includes('LEAVE:')) ?? '';
  check('the message sends the filtered LEAVE', !/background|clothing/.test(leaveLine), leaveLine);
}

console.log();
console.log('reference blueprint: the look-first pass');
console.log();
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log();
  console.log(`${failures.length} FAILED, ${passed} passed`);
  process.exit(1);
}
console.log(`ALL PASSED (${passed})`);
