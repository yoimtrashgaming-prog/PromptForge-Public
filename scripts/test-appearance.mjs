// Which tags describe a character, and which describe the photograph.
//
//   node scripts/test-appearance.mjs
//
// No server, no model, no network. Every assertion is traceable to one of the
// two failures reported with screenshots on 27 Aug 2026:
//
//   1. the danbooru canon lookup handed the model `holding`, `holding_staff`
//      and `closed_mouth` as Frieren's canonical appearance, under a brief
//      that said "drinking coffee";
//   2. a Character reference image contributed `looking_at_viewer, blurry,
//      open_mouth, blurry_background, upper_body, artist_name, brick_wall` to
//      a prompt about her face.
//
// The two lists below are the REAL data from those reports — the cached
// traits row and the 27 chips in the screenshot — so this suite fails if the
// exact reported output ever comes back.

import { tagClass, tagFacet, isAppearanceTag, isRoleTag, isGarment, isProp, splitAppearance, splitForRole, withoutCostumeBody, CLASS_REASON, ROLE_KEEPS }
  from '../web/appearance.js';
import { formatImageReferences } from '../server/imagerefs.mjs';

let passed = 0;
const failures = [];

function check(what, ok, detail) {
  if (ok) passed += 1;
  else failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
}

const is = (tag, want) =>
  check(`${tag} is ${want}`, tagClass(tag) === want, tagClass(tag));

// ── report 1: Frieren's cached traits row ────────────────────
// Verbatim from data/tags/traits.sqlite, ranked by lift.
const FRIEREN = [
  'teardrop_earrings', 'mage_staff', 'long_pointy_ears', 'white_capelet',
  'elf', 'holding_staff', 'staff', 'capelet', 'pointy_ears', 'parted_bangs',
  'earrings', 'twintails', 'jewelry', 'white_hair', 'green_eyes', 'grey_hair',
  'holding', 'closed_mouth',
];
{
  const { kept, dropped } = splitAppearance(FRIEREN);
  check('the three reported offenders are the three dropped',
    dropped.join(',') === 'holding_staff,holding,closed_mouth', dropped.join(','));
  // Everything else survives. This is the half that matters more: a filter
  // that also ate `long_pointy_ears` would have fixed the complaint by
  // breaking the feature.
  check('every other Frieren trait survives', kept.length === 15, `${kept.length}`);
  for (const t of ['teardrop_earrings', 'long_pointy_ears', 'white_capelet', 'elf',
    'parted_bangs', 'twintails', 'white_hair', 'green_eyes', 'grey_hair']) {
    check(`${t} is kept as canon`, kept.includes(t));
  }
  // A prop she is drawn with is hers; a prop she is drawn HOLDING is a pose.
  // The staff is the case that makes this distinction visible, and it is
  // deliberate — `mage_staff` says what her staff looks like, `holding_staff`
  // says what her hands were doing in the sampled posts.
  check('mage_staff stays and holding_staff goes',
    kept.includes('mage_staff') && !kept.includes('holding_staff'));
}

// ── report 2: the 27 chips on the Character reference card ───
const CARD = [
  'frieren', '1girl', 'pointy_ears', 'elf', 'scarf', 'blue_scarf', 'jewelry',
  'solo', 'twintails', 'green_eyes', 'earrings', 'long_hair', 'parted_bangs',
  'looking_at_viewer', 'coat', 'blurry', 'open_mouth', 'blurry_background',
  'upper_body', 'floating_earring', 'white_coat', 'artist_name', 'grey_hair',
  'thick_eyebrows', 'brick_wall',
];
{
  const { kept, dropped } = splitAppearance(CARD);
  for (const t of ['1girl', 'solo', 'looking_at_viewer', 'blurry', 'open_mouth',
    'blurry_background', 'upper_body', 'artist_name', 'brick_wall']) {
    check(`${t} is dropped from a character card`, dropped.includes(t), tagClass(t));
  }
  for (const t of ['frieren', 'pointy_ears', 'elf', 'blue_scarf', 'twintails',
    'green_eyes', 'long_hair', 'white_coat', 'thick_eyebrows', 'floating_earring']) {
    check(`${t} is kept on a character card`, kept.includes(t), tagClass(t));
  }
  check('nine of the twenty-five go', dropped.length === 9, `${dropped.length}`);
}

// ── the class edges, one case each ───────────────────────────
is('1girl', 'framing');
is('upper_body', 'framing');
is('from_below', 'framing');
is('simple_background', 'framing');
is('blurry', 'quality');
is('artist_name', 'quality');
is('absurdres', 'quality');
is('closed_mouth', 'expression');
is('blush', 'expression');
is('holding', 'action');
is('spread_legs', 'action');
is('indoors', 'scene');
is('brick_wall', 'scene');

// The pairs the header calls out. One is a feature of the design, the other
// is that feature being used at the instant the picture was taken.
is('fang', 'appearance');
is('fang_out', 'expression');
is('tongue', 'appearance');
is('tongue_out', 'expression');
// The one that produced the reported Frieren prompt. Danbooru tags a flower
// she stands near the same way whether it is in her hand or in her hair, and
// only the compound form says it is hers.
is('flower', 'scene');
is('hair_flower', 'appearance');
// Permanent facial drawing conventions are canon, not mood.
is('eyelashes', 'appearance');
is('mole_under_eye', 'appearance');

// ── structural rules ─────────────────────────────────────────
// These exist because the underlying families are open-ended: danbooru mints
// a `holding_x` per object in existence and a `_background` per colour.
is('holding_coffee_cup', 'action');
is('holding_umbrella', 'action');
is('looking_at_viewer', 'framing');
is('looking_afar', 'framing');
is('teal_background', 'framing');
is('ass_focus', 'framing');
is('photo_(medium)', 'quality');
is('commentary_request', 'quality');
is('6+girls', 'framing');
is('4boys', 'framing');
is('1other', 'framing');

// ── body vs worn: the edge added 6 Sep 2026 ──────────────────
// "Could she take it off." Both sides group to `appearance`, so none of this
// changes what the canon lookup or the traits panel sees — it only decides
// what an Outfit reference leaves behind.
{
  const facet = (t, want) => check(`${t} is ${want}`, tagFacet(t) === want, tagFacet(t));
  // Hers, permanently.
  for (const t of ['pointy_ears', 'elf', 'green_eyes', 'grey_hair', 'long_hair',
    'parted_bangs', 'twintails', 'thick_eyebrows', 'dark_skin', 'freckles',
    'cat_ears', 'dragon_horns', 'cat_tail', 'angel_wings', 'heterochromia']) {
    facet(t, 'body');
  }
  // Worn, and takeable off.
  for (const t of ['white_coat', 'blue_scarf', 'scarf', 'coat', 'jewelry',
    'earrings', 'floating_earring', 'white_capelet', 'pleated_skirt',
    'school_uniform', 'thighhighs']) {
    facet(t, 'appearance');
  }
  // The compound traps, both directions. `hair_ribbon` and `hair_intakes`
  // are spelled identically and are opposites; so are `cat_ears` and
  // `fake_animal_ears`. Neither survives as a pattern, which is why both
  // have named exception sets ahead of the structural rules.
  facet('hair_ribbon', 'appearance');
  facet('hair_flower', 'appearance');
  facet('hair_ornament', 'appearance');
  facet('hair_intakes', 'body');
  facet('fake_animal_ears', 'appearance');
  facet('fake_horns', 'appearance');
  // The existing `flower` / `hair_flower` pair still reads the same way at
  // the coarse resolution, which is what the header promises about it.
  check('hair_flower still groups to appearance', tagClass('hair_flower') === 'appearance');
  // ── flora, found by running a real image on 7 Sep 2026 ──
  // A Hinata standing in a sunflower field. `sunflower` and `yellow_flower`
  // fell through to the appearance default and went to the model as things
  // she was WEARING, while the Background reference got the lone tag
  // `flower`. Every hand-written fixture in this file missed it; only real
  // tagger output on real pixels showed it.
  facet('sunflower', 'scene');
  facet('yellow_flower', 'scene');
  facet('red_rose', 'scene');
  facet('rose', 'scene');
  facet('rose_petals', 'scene');
  // The worn half, which a blanket flower rule would have eaten. `rose_print`
  // is a pattern on fabric and `flower_earrings` are jewellery.
  facet('hat_flower', 'appearance');
  facet('rose_print', 'appearance');
  facet('flower_earrings', 'appearance');
  facet('flower_wreath', 'appearance');
  // The word that is not a flower at all, and the reason the rule needs the
  // separator instead of a bare substring.
  facet('cauliflower', 'appearance');

  // ── watermarks, found on a Crunchyroll screenshot 7 Sep 2026 ──
  // `copyright_notice` and `nature` fell through to the appearance default
  // and were sent to the model as things Frieren was WEARING.
  facet('copyright_notice', 'meta');
  facet('notice_lines', 'meta');
  facet('patreon_username', 'meta');
  facet('twitter_logo', 'meta');
  facet('sample_watermark', 'meta');
  facet('nature', 'scene');
  facet('scenery', 'scene');
  facet('landscape', 'scene');
  // In-universe emblems are printed on the clothes, not over the picture.
  facet('rhine_lab_logo', 'appearance');
  facet('chaldea_logo', 'appearance');

  // ── what the 0.05 reference floor exposed, 7 Sep 2026 ──
  // Reference images are now read by three taggers at a 0.05 floor instead
  // of one at 0.38, because the role filter discards every class the role
  // cannot use before the model sees any of it — so recall is nearly free
  // and only noise INSIDE a role's classes costs anything.
  //
  // The low floor immediately showed what the high one had been hiding. On a
  // forest screenshot the Outfit reference carried `path`, `cobblestone`,
  // `stone_floor`, `arch`, `copyright`, `company_name`, `anime_coloring`,
  // `bangs` and `short_eyebrows` — the setting, the watermark, the rendering
  // and her face, all sent as clothing.
  for (const t of ['path', 'pavement', 'cobblestone', 'arch', 'stone_floor',
    'checkered_floor', 'brick_floor', 'tile_wall', 'wooden_fence']) facet(t, 'scene');
  for (const t of ['company_name', 'copyright', 'subtitled', 'fourth_wall']) facet(t, 'meta');
  for (const t of ['bangs', 'forehead', 'nose', 'short_eyebrows']) facet(t, 'body');
  // Rendering technique. Before these, a Visual style reference came back
  // empty at every threshold down to 0.02 — no tagger sees "style" unless
  // these are classed as style, and `anime_coloring` was the one on that
  // screenshot.
  for (const t of ['anime_coloring', 'flat_color', 'halftone', 'oekaki',
    'realistic', 'retro_artstyle', 'screentones']) facet(t, 'medium');
  // Poses that merely name a wall. The `_wall` rule runs before the ACTION
  // set, so these need naming ahead of it or leaning on something becomes a
  // setting — the same ordering trap as `hair_ribbon` and `hat_flower`.
  for (const t of ['against_wall', 'hand_on_wall']) facet(t, 'action');
  // And the clothes are still clothes. This is the half that matters: the
  // families above are aggressive, and a rule that also ate `high_collar` or
  // `belt_buckle` would have fixed the complaint by breaking the feature.
  for (const t of ['white_capelet', 'striped_shirt', 'belt_buckle', 'gold_trim',
    'high_collar', 'white_jacket', 'dangle_earrings']) facet(t, 'appearance');

  // Hairstyle families, minted per arrangement.
  facet('quad_braids', 'body');
  facet('side_braid', 'body');
  facet('low_ponytail', 'body');
  // `_cut` is deliberately not a rule: one is a hairstyle, one is a neckline.
  facet('bob_cut', 'body');
  facet('low-cut', 'appearance');
  // An unrecognised garment still survives on an Outfit reference. This is
  // the property a clothing whitelist would have destroyed, and the whole
  // reason this is a body stoplist instead.
  for (const t of ['jujutsu_tech_uniform', 'juliet_sleeves', 'invented_garment_2099']) {
    check(`${t} survives an outfit reference`, isRoleTag(t, 'outfit'), tagFacet(t));
  }
}

// ── the default is appearance ────────────────────────────────
// The direction this file has to fail in. Danbooru's appearance vocabulary is
// the open end of a six-figure tag set, so anything unrecognised must survive
// into the prompt — that reproduces the old behaviour, and the alternative is
// a filter that silently eats every costume tag from a series released after
// this file was written.
for (const t of ['quad_braids', 'jujutsu_tech_uniform', 'ringed_eyes',
  'weighing_scale', 'triforce', 'juliet_sleeves', 'gyaru', 'invented_tag_2099']) {
  check(`${t} defaults to appearance`, isAppearanceTag(t), tagClass(t));
}
check('an empty tag does not throw and defaults to appearance', isAppearanceTag(''));
check('null does not throw', tagClass(null) === 'appearance');

// ── spelling-agnostic ────────────────────────────────────────
// The browser holds these in the model's spelling and the server in
// danbooru's. Both sides classify off this one file, so both spellings have
// to land in the same class or a chip is greyed for one reason and dropped
// for another.
check('spaced and underscored agree', ['looking at viewer', 'brick wall', 'long hair',
  'holding coffee cup', 'closed mouth'].every((t) => tagClass(t) === tagClass(t.replace(/ /g, '_'))));
check('spaced looking at viewer is framing', tagClass('looking at viewer') === 'framing');
check('case is ignored', tagClass('Brick_Wall') === 'scene');

// ── every class has a reason string ──────────────────────────
// The chip tooltip reads CLASS_REASON[...] straight out, so a class with no
// entry there renders "undefined" to the user. Both resolutions are looked
// up: the reference card classifies by leaf, the traits panel by group.
for (const cls of ['appearance', 'framing', 'quality', 'expression', 'action', 'scene',
  'body', 'count', 'crop', 'angle', 'gaze', 'medium', 'meta', 'light']) {
  check(`${cls} has a tooltip reason`, typeof CLASS_REASON[cls] === 'string' && CLASS_REASON[cls].length > 0);
}

// ── the leaf classes group back to the coarse ones ───────────
// The compatibility contract of the 6 Sep 2026 split. `framing` became four
// classes and `quality` and `scene` two each, and the callers that ask the
// coarse question — isAppearanceTag, the canon lookup in server.mjs, the
// traits panel — must not see a single answer change. Every leaf therefore
// has to group back to the class its members were in before.
{
  const GROUPS = {
    appearance: 'appearance', body: 'appearance',
    count: 'framing', crop: 'framing', angle: 'framing', gaze: 'framing',
    medium: 'quality', meta: 'quality',
    expression: 'expression', action: 'action',
    light: 'scene', scene: 'scene',
  };
  // Two per leaf, taken from the sets as they stood before the split.
  const SAMPLES = {
    count: ['1girl', 'solo'], crop: ['upper_body', 'simple_background'],
    angle: ['from_below', 'dutch_angle'], gaze: ['looking_at_viewer', 'from_behind'],
    medium: ['pixel_art', 'depth_of_field'], meta: ['absurdres', 'artist_name'],
    expression: ['blush', 'closed_mouth'], action: ['holding', 'spread_legs'],
    light: ['sunset', 'backlighting'], scene: ['brick_wall', 'indoors'],
    body: ['long_hair', 'pointy_ears'],
    appearance: ['white_coat', 'blue_scarf'],
  };
  for (const [leaf, tags] of Object.entries(SAMPLES)) {
    for (const t of tags) {
      check(`${t} is the leaf ${leaf}`, tagFacet(t) === leaf, tagFacet(t));
      check(`${t} still groups to ${GROUPS[leaf]}`, tagClass(t) === GROUPS[leaf], tagClass(t));
    }
  }
  // Every class ROLE_KEEPS names has to be a leaf tagFacet can actually
  // return. A typo here is silent: the role keeps nothing and the reference
  // goes out empty.
  const leaves = new Set(Object.keys(GROUPS));
  for (const [role, keeps] of Object.entries(ROLE_KEEPS)) {
    for (const cls of keeps) {
      check(`${role} keeps the real class ${cls}`, leaves.has(cls), cls);
    }
  }
}

// ── role scoping, through the real formatter ─────────────────
// Each role is right about its own question and wrong about the others.
// `brick_wall` is furniture on a Character reference and is the entire
// content of a Background one; `looking_at_viewer` is the reverse.
//
// This block used to assert that every non-character role was untouched.
// That was the bug a user reported on 6 Sep 2026 — he attached a picture to
// copy the pose and got the whole photograph — so the assertion is now the
// other way round.
{
  const defaults = {
    image_reference_roles: {
      character: { label: 'Character', rule: 'who is in the picture' },
      outfit: { label: 'Outfit', rule: 'clothing' },
      background: { label: 'Background', rule: 'the setting' },
      pose: { label: 'Pose', rule: 'posture and gaze' },
      composition: { label: 'Composition', rule: 'framing and angle' },
      lighting: { label: 'Lighting', rule: 'the light' },
      style: { label: 'Visual style', rule: 'rendering and technique' },
      object: { label: 'Object', rule: 'a prop' },
      // No ROLE_KEEPS entry. Must behave as the code did before roles
      // narrowed at all, or adding a role to config becomes a way to
      // silently empty a reference.
      mood: { label: 'Mood', rule: 'invented for this test' },
    },
    reference_fidelity: { exact: { label: 'Reproduce faithfully', rule: 'Carry every listed trait through.' } },
    default_image_reference_role: 'character',
    default_reference_fidelity: 'exact',
  };
  const model = { tag_style: 'underscore' };
  const format = (role, tags = CARD, note) =>
    formatImageReferences([{ role, fidelity: 'exact', tags, ...(note ? { note } : {}) }], defaults, model);
  // Role narrowing moved OUT of formatImageReferences on 8 Sep 2026, when the
  // tag list stopped being injected automatically — see the header of
  // server/imagerefs.mjs. Nothing below is retired by that: the behaviour is
  // unchanged and still load-bearing, it just runs in the browser now, where
  // it greys the chips a role does not use and a person can overrule it by
  // clicking one anyway. Re-applying it server-side would silently discard
  // exactly those overrules.
  //
  // So every role assertion in this block points at splitForRole, which is
  // where the answer lives. The formatter's own contract — pass the picked
  // tags through untouched, whatever the role — is asserted separately below,
  // and the two must not be conflated again.
  const detected = (role, tags = CARD) => splitForRole(tags, role).kept.join(', ');

  check('a character reference sheds the photograph tags',
    !/brick_wall|blurry|artist_name|upper_body|looking_at_viewer/.test(detected('character')),
    detected('character'));
  check('a character reference keeps her hair and her coat',
    /grey_hair/.test(detected('character')) && /white_coat/.test(detected('character')),
    detected('character'));
  check('a BACKGROUND reference keeps brick_wall',
    /brick_wall/.test(detected('background')), detected('background'));
  check('a POSE reference keeps looking_at_viewer',
    /looking_at_viewer/.test(detected('pose')), detected('pose'));

  // ── the reported bug ──
  // A pose reference must not carry the person, her clothes, the weather or
  // the file. Every name below is in CARD.
  check('a POSE reference drops her hair, her coat and the wall',
    !/grey_hair|white_coat|brick_wall|blurry|artist_name/.test(detected('pose')),
    detected('pose'));
  check('a POSE reference is no longer the whole tag list',
    detected('background') !== detected('pose'),
    `${detected('background')} | ${detected('pose')}`);

  // ── each role's own answer ──
  // ── the outfit case, reported 6 Sep 2026 ──
  // "if we are asking for just clothes and it mentions elf ears that's
  // wrong". It was returning her whole appearance: pointy_ears, elf,
  // green_eyes, grey_hair, twintails, parted_bangs, thick_eyebrows.
  check('an OUTFIT reference keeps the coat and drops the wall',
    /white_coat/.test(detected('outfit')) && !/brick_wall/.test(detected('outfit')),
    detected('outfit'));
  check('an OUTFIT reference does not mention her elf ears',
    !/pointy_ears|\belf\b|green_eyes|grey_hair|twintails|parted_bangs|thick_eyebrows/
      .test(detected('outfit')),
    detected('outfit'));
  check('an OUTFIT reference keeps everything she is wearing',
    ['scarf', 'blue_scarf', 'jewelry', 'earrings', 'coat', 'floating_earring', 'white_coat']
      .every((t) => new RegExp(`\\b${t}\\b`).test(detected('outfit'))),
    detected('outfit'));
  // The other half, and the one a clothing whitelist would have broken: a
  // Character reference still gets her body back. `body` exists only so
  // `outfit` can leave it behind.
  check('a CHARACTER reference still keeps her ears and her hair',
    /pointy_ears/.test(detected('character')) && /grey_hair/.test(detected('character'))
      && /\belf\b/.test(detected('character')),
    detected('character'));
  check('a BACKGROUND reference drops the person',
    !/grey_hair|white_coat|looking_at_viewer/.test(detected('background')),
    detected('background'));
  check('a COMPOSITION reference keeps upper_body and drops the wall',
    /upper_body/.test(detected('composition')) && !/brick_wall/.test(detected('composition')),
    detected('composition'));
  check('a LIGHTING reference takes the light and nothing else',
    detected('lighting', ['sunset', 'backlighting', 'brick_wall', 'grey_hair', 'standing'])
      === 'sunset, backlighting',
    detected('lighting', ['sunset', 'backlighting', 'brick_wall', 'grey_hair', 'standing']));
  check('a STYLE reference takes the medium and not the pixel count',
    detected('style', ['pixel_art', 'monochrome', 'absurdres', 'watermark', 'grey_hair'])
      === 'pixel_art, monochrome',
    detected('style', ['pixel_art', 'monochrome', 'absurdres', 'watermark', 'grey_hair']));

  // ── object travels on the note ──
  // It keeps no classes on purpose: a prop and the furniture behind it are
  // both `scene` and danbooru does not tell them apart.
  check('an OBJECT reference sends no tag list at all', detected('object') === '', detected('object'));
  check('an OBJECT reference with a note is not warned about',
    !format('object', CARD, 'the sword').warnings.length,
    format('object', CARD, 'the sword').warnings.join(' | '));
  check('the note still reaches the model',
    format('object', CARD, 'the sword').lines.some((l) => /take from it: the sword/.test(l)),
    format('object', CARD, 'the sword').lines.join('\n'));

  // ── the character line is gated by role too ──
  // Asked on 6 Sep 2026: attach a Frieren picture — does it come back as
  // `frieren`, or as `white_capelet`? Both, and the name is the stronger of
  // the two. Which makes it the worst line to leak: a Pose reference is
  // somebody else's picture borrowed for a posture, and naming her puts her
  // in the output through a channel the tag filter never touches.
  const withName = (role) => formatImageReferences(
    [{ role, fidelity: 'exact', tags: CARD, character: 'frieren' }], defaults, model
  ).lines;
  check('a CHARACTER reference names her',
    withName('character').some((l) => /^\s+character: frieren$/.test(l)),
    withName('character').join('\n'));
  // Not on the character line AND not smuggled into the tag list. The second
  // half is the one that was still broken after the first was fixed: an
  // Outfit reference kept `frieren` among the tags, and her name renders the
  // whole elf when the ask was the coat.
  for (const role of ['pose', 'background', 'outfit', 'composition', 'lighting', 'style', 'object']) {
    check(`a ${role.toUpperCase()} reference does not name her, on either line`,
      !withName(role).some((l) => /\bfrieren\b/.test(l)),
      withName(role).join('\n'));
  }

  // ── and she is not sent twice ──
  // The tagger returns `frieren` as a character tag, so without the dedupe
  // she lands on the `character:` line AND mid-list in `detected:`.
  const namedDetected = (role) =>
    withName(role).find((l) => l.trim().startsWith('tags they picked:')) ?? '';
  check('frieren is not repeated in the detected list',
    !/\bfrieren\b/.test(namedDetected('character')), namedDetected('character'));
  check('her appearance still travels with her',
    /white_coat/.test(namedDetected('character')) && /grey_hair/.test(namedDetected('character')),
    namedDetected('character'));
  // With no character line there is nothing to dedupe against, and the
  // tagger's character tag has to stay in the list or it vanishes entirely.
  check('an un-named reference keeps frieren in the tags',
    /\bfrieren\b/.test(detected('character')), detected('character'));
  // A hand-typed name that differs from what the tagger saw is two claims,
  // and dropping either would lose one.
  {
    const both = formatImageReferences(
      [{ role: 'character', fidelity: 'exact', tags: CARD, character: 'fern' }], defaults, model
    ).lines.join('\n');
    check('a hand-typed name does not swallow the detected one',
      /character: fern/.test(both) && /frieren/.test(both), both);
  }

  // ── a role the owner adds without a ROLE_KEEPS entry ──
  check('an unknown role keeps everything, as before',
    detected('mood').split(', ').length === CARD.length, detected('mood'));

  // ── nothing is carrying this reference ──
  //
  // Rewritten 8 Sep 2026. This used to fire whenever the ROLE filter emptied
  // the tag list, which was the common case and is now impossible: the tags
  // are whatever the person picked and they pass through untouched. Picking
  // none is a perfectly ordinary thing to do, because the PICTURE is what
  // carries the reference now.
  //
  // So the only version still worth warning about is the one where nothing
  // carries it at all — no picture on the wire, nothing picked, nothing
  // typed. Then the model gets a label and a role rule and nothing else.
  check('a reference carrying nothing at all says so',
    format('lighting', []).warnings.some((w) => /carrying nothing/.test(w)),
    format('lighting', []).warnings.join(' | '));
  check('picking no tags is not a warning when the model can see it',
    formatImageReferences(
      [{ role: 'lighting', fidelity: 'exact', tags: [] }], defaults, model, { carriesImage: true }
    ).warnings.length === 0);
  check('a note alone is not a warning',
    format('lighting', [], 'the rim light on her shoulder').warnings.length === 0,
    format('lighting', [], 'the rim light on her shoulder').warnings.join(' | '));

  // A reference with nothing picked must not emit an empty tag line — a colon
  // with nothing after it reads to the model as a list of no traits rather
  // than as an absent claim.
  const none = formatImageReferences(
    [{ role: 'character', fidelity: 'exact', tags: [] }],
    defaults, model
  ).lines;
  check('no tag line when nothing was picked',
    !none.some((l) => l.trim().startsWith('tags they picked:')), none.join('\n'));
  check('the reference itself still appears', none.some((l) => /Character/.test(l)), none.join('\n'));
}

// ── garments, so the canon lookup can stop having an opinion ──
//
// characterCanon withholds every garment from the block it sends the model,
// which is what makes "Frieren in a sundress" possible: the capelet used to
// arrive from danbooru labelled "facts, not suggestions" and no prompt wording
// could beat that. What is under test is the line between what she WEARS and
// what she IS - drop too much and Seia loses the halo that is her single
// strongest trait, drop too little and the sleeves come back.
{
  const garment = (t) => check(`${t} is a garment`, isGarment(t), 'would still be sent as canon');
  const notGarment = (t) => check(`${t} is not a garment`, !isGarment(t), 'would be withheld from canon');

  // Seia's canon, the list this was built from.
  for (const t of ['white_dress', 'detached_sleeves', 'sleeves_past_fingers',
                   'sleeves_past_wrists', 'pantyhose', 'dress']) garment(t);
  for (const t of ['cross_halo', 'yellow_halo', 'halo', 'fox_girl', 'fox_ears',
                   'extra_ears', 'animal_ear_fluff', 'tail', 'forehead',
                   'parted_bangs', 'yellow_eyes', 'blonde_hair']) notGarment(t);

  // Frieren's, the case the owner named.
  for (const t of ['capelet', 'white_capelet', 'striped_shirt', 'white_skirt',
                   'jacket', 'black_belt', 'high_collar', 'long_sleeves']) garment(t);
  for (const t of ['elf', 'pointy_ears', 'white_hair', 'green_eyes',
                   'twintails', 'earrings', 'sidelocks']) notGarment(t);

  // The colour-plus-noun pattern is the whole point of matching the noun: no
  // list will ever hold every garment danbooru has minted.
  for (const t of ['pleated_skirt', 'red_dress', 'off-shoulder_sweater',
                   'thigh_boots', 'school_uniform', 'sailor_collar']) garment(t);

  // Near-misses in both directions. A hairstyle that contains a garment noun
  // must not read as clothing, and a hair ornament is worn without being
  // wardrobe - nobody asking for a sundress means "remove her hairpin".
  for (const t of ['ponytail', 'twin_tails', 'fox_tail', 'hair_ribbon',
                   'hairband', 'hair_ornament']) notGarment(t);

  // 18 Sep 2026, from reading the canon sent for 129 characters: outfits named
  // whole, `*_clothes`, and the cut of a garment were all going out as looks.
  for (const t of ['maid', 'serafuku', 'black_serafuku', 'japanese_clothes',
                   'pom_pom_(clothes)', 'playboy_bunny', 'magical_girl',
                   'plugsuit_(evangelion)', 'neckerchief', 'sleeveless', 'frills',
                   'diamond_button', 'frog_print', 'midriff', 'muneate']) garment(t);
  // ...and the look beside them in the same lists, which must stay.
  for (const t of ['button_eyes', 'headphones', 'interface_headset_(evangelion)',
                   'frilled_hair_tubes', 'hair_tubes', 'third_eye', 'crystal_wings',
                   'snowflakes', 'heterochromia', 'drill_hair']) notGarment(t);
  // 19 Sep 2026, the Konosuba/NieR/Dress-Up Darling read.
  for (const t of ['nun', 'negligee', 'denim_shorts', 'denim', 'gothic_lolita', 'lolita_fashion', 'wig']) garment(t);
  // Zelda / Street Fighter / Girls und Panzer, 19 Sep 2026.
  for (const t of ['qipao', 'pelvic_curtain', 'dougi', 'wrestling_outfit', 'breastplate',
                   'shoulder_pads', 'miniskirt', 'arm_wrap', 'off_shoulder', 'topless_male']) garment(t);
  for (const t of ['bun_cover', 'hair_horns', 'twin_braids', 'dark_skin', 'bandages']) notGarment(t);
  check('walkman is a prop', isProp('walkman'), 'would still be sent as canon');
  for (const t of ['listening_to_music', 'bara']) {
    check(`${t} is not appearance`, !isAppearanceTag(t), 'would still be sent as canon');
  }
  // GATE, 19 Sep 2026.
  for (const t of ['military_fatigues', 'camouflage', 'japan_self-defense_force']) garment(t);
  check('stuffed_rabbit is a prop', isProp('stuffed_rabbit'), 'would still be sent as canon');
  for (const t of ['sweat', 'restrained', 'album_cover', 'cliff', 'truck', 'military_vehicle']) {
    check(`${t} is not appearance`, !isAppearanceTag(t), 'would still be sent as canon');
  }
  for (const t of ['reaching_towards_viewer', 'between_breasts', 'twins', 'siblings']) {
    check(`${t} is not appearance`, !isAppearanceTag(t), 'would still be sent as canon');
  }
  for (const t of ['flag', 'gohei', 'trident']) {
    check(`${t} is a prop`, isProp(t), 'would still be sent as canon');
  }
  for (const t of ['alternate_costume', 'virtual_youtuber', 'chibi', 'full_page_comic', 'fantasy']) {
    check(`${t} is not appearance`, !isAppearanceTag(t), 'would still be sent as canon');
  }

  check('an unrecognised tag is kept rather than guessed at',
    !isGarment('some_tag_nobody_has_minted'),
    'a false positive deletes a trait somebody wanted; the default must be to keep');
}

// ── props, the other half of what she is not ──
//
// Reported the same night as the garments: a brief came back holding a dagger
// nobody asked for. Every bare weapon lands in the `appearance` catch-all, so
// danbooru's tally of what a character usually carries was reaching the model
// as canon. `holding_staff` was caught in August by the `holding_` rule and
// `staff` was not - this is that gap.
{
  const prop = (t) => check(`${t} is a prop`, isProp(t), 'would still be sent as canon');
  const notProp = (t) => check(`${t} is not a prop`, !isProp(t), 'would be withheld from canon');

  for (const t of ['dagger', 'knife', 'sword', 'staff', 'katana', 'gun', 'rifle',
                   'spear', 'axe', 'wand', 'scythe', 'shield', 'sheath',
                   'bow_(weapon)', 'sheathed_sword', 'broken_sword']) prop(t);
  for (const t of ['umbrella', 'bag', 'backpack', 'phone', 'basket', 'broom',
                   'teddy_bear']) prop(t);

  // `bow` on danbooru is the ribbon, not the weapon - the weapon is
  // `bow_(weapon)`. Getting this backwards would strip a hair bow as a
  // longbow, which is why the noun list names the weapon spelling only.
  for (const t of ['bow', 'hair_bow', 'bowtie', 'rainbow']) notProp(t);
  // Worn, so wardrobe wins the tie - both answers are "withhold" anyway, but
  // the log line should say which it was.
  for (const t of ['chain_necklace', 'sunglasses', 'glasses']) notProp(t);
  // What she IS survives both tests.
  for (const t of ['elf', 'pointy_ears', 'white_hair', 'green_eyes', 'cross_halo',
                   'fox_ears', 'tail', 'earrings', 'forehead', 'blonde_hair']) notProp(t);

  check('a garment is not also reported as a prop',
    !isProp('white_dress') && !isProp('capelet'),
    'the tie goes to wardrobe so the log line names the right reason');
}

// ── Blue Archive, 19 Sep 2026 ────────────────────────────────
// The canon of the top 120 students, as the prompt received it.
{
  for (const t of ['blue_buruma', 'lanyard', 'id_card', 'yellow_headscarf', 'beanie', 'sukajan',
                   'knee_pads', 'rash_guard', 'fishnets', 'single_breast_curtain', 'plunging_neckline',
                   'whistle_around_neck', 'name_tag', 'cheerleader', 'nurse', 'police', 'partially_unzipped']) {
    check(`${t} is a garment`, isGarment(t));
  }
  for (const t of ['tablet_pc', 'shackles', 'swim_ring', 'innertube', 'inflatable_toy']) check(`${t} is a prop`, isProp(t));
  for (const t of ['foreclosure_task_force_(blue_archive)', 'pandemonium_society_(blue_archive)', 'everyone',
                   'absolutely_everyone', 'ice_cream', 'donut', 'candy', 'white_bird', 'seagull', 'legs',
                   'no_humans', 'parody', 'red_theme']) {
    check(`${t} is not about her`, !isAppearanceTag(t), tagFacet(t));
  }
  // What stays.
  for (const t of ['ice_cream_hair_ornament', 'tacet_mark_(wuthering_waves)', 'hair_tassel', 'halo', 'leaf_on_head']) {
    check(`${t} is still hers`, isAppearanceTag(t) && !isGarment(t) && !isProp(t), tagFacet(t));
  }

  const costume = (list) => withoutCostumeBody(list.split(' ')).worn.join(' ');
  check('the bunny suit takes its ears and tail',
    costume('blonde_hair animal_ears rabbit_ears fake_animal_ears playboy_bunny rabbit_tail tail') === 'animal_ears rabbit_ears rabbit_tail tail');
  check("Momoi's headphones take the ears and leave the tail",
    costume('cat_ear_headphones cat_ears cat_tail animal_ears tail') === 'cat_ears animal_ears');
  check('a real rabbit girl in a bunny suit keeps her ears',
    costume('rabbit_girl rabbit_ears playboy_bunny rabbit_tail animal_ears') === '');
  check('a cat girl with no costume keeps hers', costume('cat_girl cat_ears animal_ears') === '');
  check("a dog girl does not have a fox's ears", costume('dog_girl dog_ears fox_ears animal_ears extra_ears') === 'fox_ears');
  check('ears with nothing to say they are fake stay', costume('rabbit_ears animal_ears') === '');
}

// ── report ───────────────────────────────────────────────────
if (failures.length) {
  console.log(`\n${failures.length} FAILED:`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
// Bare count: check.mjs reads what is between the parentheses and appends
// "assertions" itself.
console.log(`ALL PASSED (${passed})`);
