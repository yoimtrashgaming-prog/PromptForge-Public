// Does this danbooru tag describe what a character LOOKS LIKE?
//
// Two separate paths kept putting furniture into prompts about a person, and
// both were reported with screenshots on 27 Aug 2026:
//
//   - the danbooru canon lookup (server/traits.mjs). Frieren's ranked traits
//     are `teardrop_earrings, mage_staff, long_pointy_ears, white_capelet,
//     elf, holding_staff, staff, capelet, pointy_ears, parted_bangs,
//     earrings, twintails, jewelry, white_hair, green_eyes, grey_hair,
//     holding, closed_mouth`. Most of those say who she is. `holding`,
//     `holding_staff` and `closed_mouth` say what she happened to be doing in
//     the sampled posts — and they were being handed to the model as canon,
//     under a brief that said "drinking coffee".
//   - a Character reference image. animetimm read one and returned, among 27
//     tags, `looking_at_viewer, blurry, open_mouth, blurry_background,
//     upper_body, artist_name, brick_wall`. All true about the photograph.
//     None of them true about her.
//
// ── Why this is a stoplist and not a whitelist ────────────────────────────
//
// There is no whitelist to write. Danbooru's general tags run to six figures
// and the appearance ones are the open end of that set — every new series
// brings new hair ornaments, new coat shapes, new horn arrangements. So the
// DEFAULT here is appearance, and only tags in a named class fall out. An
// unrecognised tag stays in the prompt, which is the direction that fails
// safely: the old behaviour.
//
// traits.mjs already warns about this, and the warning is the design brief:
// "a stoplist of 'things that looked wrong' grows forever and starts eating
// real traits; a stoplist of 'subject count and framing' has an edge you can
// defend." So every entry below belongs to one of five classes with a
// statable edge, and nothing is here because it merely looked wrong once:
//
//   framing     how the picture is cropped and angled, and how many people
//               are in it. Not a property of any of them.
//   quality     the file rather than its contents — resolution, artefacts,
//               the artist's signature, the medium.
//   expression  the face at one instant. A design has a mouth; it does not
//               have a `closed_mouth`.
//   action      what the body is doing at one instant, and what the hands
//               hold. The brief decides this, not danbooru's average post.
//   scene       where it happens and what else is in shot.
//
// ── Where the line sits, and the cases that test it ───────────────────────
//
// `fang` is appearance and `fang_out` is expression — one is a tooth she has,
// the other is a tooth being shown. Same for `tongue` and `tongue_out`.
//
// `flower` is scene and `hair_flower` is appearance. This is the one that
// produced the reported prompt: Frieren, brief "drinking coffee", came back
// carrying `flower`. Danbooru tags a flower she is standing near exactly the
// same way whether it is in her hand or in her hair, and only the compound
// form says it belongs to her.
//
// ── Role scoping: this filter is only ever right about characters ─────────
//
// Nothing here calls a tag "bad". `brick_wall` is furniture in a Character
// reference and is the entire point of a Background one; `looking_at_viewer`
// is noise about a face and is the answer for a Pose reference.
//
// That was originally the argument for applying this to the character role
// and the canon lookup and to nothing else. It is really an argument for
// filtering every role by its own answer, and until 6 Sep 2026 the second
// half was missing: seven of the eight roles narrowed nothing, so a Pose
// reference handed the model a whole photograph under a fidelity rule that
// said "keep the listed traits". ROLE_KEEPS below is where each role's
// answer is now written down; the canon lookup still asks the coarse
// question and still gets the same answers it always did.
//
// Lives under web/ because the browser has to fetch it: the chips in the
// reference card grey themselves with the same list the server strips with,
// and two copies of a list like this would drift within a week. Node imports
// it across the directory the same way scripts/test-app.mjs imports app.js.

/** Any spelling in, one comparable form out. Models hold these spaced. */
function key(tag) {
  return String(tag ?? '').trim().toLowerCase().replace(/\s+/g, '_');
}

// ── framing, in four parts ──
//
// `framing` was one set until 6 Sep 2026, because the only question anyone
// asked it was "does this describe the character", and for that question the
// four below are one answer. A Pose reference asks a different question and
// needs them apart: `from_side` says which way a body is turned and belongs
// in a pose, `upper_body` says where the picture was cut and does not.
//
// The four still group back to `framing` — see GROUP — so every existing
// caller sees exactly what it saw before.

// ── body ──
//
// What she IS, as opposed to what she is WEARING. Added 6 Sep 2026, because
// an Outfit reference of a Frieren picture was returning `pointy_ears, elf,
// green_eyes, grey_hair` alongside the coat — "if we are asking for just
// clothes and it mentions elf ears that's wrong".
//
// ── Why this is a body stoplist and not a clothing whitelist ─────────────
//
// The obvious move is a `clothing` class, and it is the wrong one for the
// reason this file's header already gives about appearance generally:
// danbooru's clothing vocabulary is the open end of the set. Every series
// brings coat shapes nobody has listed, so a clothing whitelist is
// permanently incomplete — and under the role fallback an incomplete
// whitelist silently eats real garments, which is a worse bug than the one
// being fixed and an invisible one.
//
// So `appearance` stays the fallback and only the body falls out of it. An
// unrecognised tag is still assumed to be something she is wearing, which is
// the direction that fails safely: a strange new jacket survives, and the
// cost of a miss is one body tag getting through rather than a garment
// silently vanishing.
//
// Hair, eyes, ears, horns, tails, wings, skin, face and build. The edge is
// "could she take it off": `pointy_ears` no, `hair_ribbon` yes. That
// compound case is the same one the header already calls out for
// `flower` / `hair_flower`, and it is handled the same way — as a named
// exception ahead of the structural rule, not by hoping the pattern is
// enough.
const BODY = new Set([
  // species and what she is
  'elf', 'human', 'demon', 'demon_girl', 'angel', 'oni', 'vampire', 'youkai',
  'monster_girl', 'mermaid', 'dragon_girl', 'robot', 'android', 'ghost',
  'furry', 'kemonomimi',
  // skin
  'dark_skin', 'pale_skin', 'tan', 'tanlines', 'very_dark_skin',
  // face, permanently
  'freckles', 'mole', 'mole_under_eye', 'mole_under_mouth', 'mole_on_neck',
  'thick_eyebrows', 'thin_eyebrows', 'eyebrows', 'eyelashes',
  'long_eyelashes', 'fang', 'fangs', 'sharp_teeth', 'tongue', 'lips',
  'thick_lips', 'tsurime', 'tareme', 'jitome', 'sanpaku',
  'bags_under_eyes', 'heterochromia', 'scar', 'scar_on_face',
  'scar_across_eye', 'birthmark', 'tattoo', 'facial_mark',
  // build
  'muscular', 'muscular_female', 'muscular_male', 'plump', 'slim', 'petite',
  'curvy', 'wide_hips', 'thick_thighs', 'toned', 'abs', 'navel',
  'collarbone', 'thighs', 'tall', 'short',
  // Bare parts. The `_bangs`/`_eyes` suffix rules catch `parted_bangs` and
  // `green_eyes` but not the unqualified word, and at the 0.05 floor a
  // reference image gets plenty of the unqualified word.
  'bangs', 'forehead', 'nose', 'neck', 'ear', 'shoulder', 'cheek', 'chin',
  'short_eyebrows', 'long_eyebrows', 'thin_eyebrows',
  // hairstyles, which name no material and end in no pattern
  'twintails', 'twin_tails', 'ponytail', 'side_ponytail', 'high_ponytail',
  'low_ponytail', 'braid', 'braids', 'twin_braids', 'single_braid',
  'french_braid', 'crown_braid', 'hair_bun', 'double_bun', 'single_hair_bun',
  'cone_hair_bun', 'bob_cut', 'hime_cut', 'ahoge', 'antenna_hair',
  'sidelocks', 'drill_hair', 'twin_drills', 'hair_intakes', 'blunt_ends',
]);

// Worn in the hair, not made of it. Named ahead of the `hair_*` and `*_hair`
// rules below, which would otherwise call a ribbon part of her head — the
// same trap as `flower` / `hair_flower` in the header, and the reason these
// are listed rather than pattern-matched.
const HAIR_WORN = new Set([
  // `hat_flower` is here rather than with the hair items for the same reason
  // they are: it is a flower she is WEARING, and the `_flower` rule below
  // would otherwise call it scenery.
  'hat_flower',
  'hair_ribbon', 'hair_bow', 'hair_ornament', 'hair_flower', 'hair_clip',
  'hairclip', 'hairband', 'hair_tie', 'hair_bobbles', 'hair_tubes',
  'hair_bell', 'hair_rings', 'hair_beads', 'hair_scrunchie', 'hair_stick',
  'hairpin', 'hair_pin', 'hair_ribbons',
]);

// Costume rather than anatomy. Same shape of exception, other direction:
// these look like body parts and come off at the end of the con.
const FAKE_BODY = new Set([
  'fake_animal_ears', 'fake_horns', 'fake_tail', 'fake_wings',
  'animal_ear_headphones',
]);

/**
 * Is this tag a GARMENT — something she puts on and could take off?
 *
 * Not the same question as `tagFacet(tag) === 'appearance'`, and that
 * distinction is the whole reason this exists. `appearance` is the catch-all
 * every unclassified tag falls into, so it holds Seia's `white_dress` and
 * `detached_sleeves` alongside her `cross_halo`, `fox_girl` and `tail`. One
 * set is clothing and the other is who she is; dropping the facet wholesale
 * would take her halo with her sleeves.
 *
 * Built 8 Sep 2026 for exactly one job: canonical clothing must not fight a
 * user who asked for different clothing. "Frieren in a sundress" must not
 * carry her capelet, and it did, because the capelet was arriving from
 * danbooru as canon rather than from the model's memory — so no amount of
 * prompt wording could settle it. See characterCanon in server.mjs.
 *
 * **Structural first, list second.** Danbooru mints garment tags to patterns:
 * a colour or a qualifier in front of a garment noun. Matching the NOUN
 * catches `white_dress`, `pleated_skirt`, `off-shoulder_sweater` and the
 * thousands more nobody will ever enumerate; the list is only for garments
 * whose noun is the whole tag or which no pattern reaches.
 *
 * Deliberately conservative. A false positive drops a canon trait the person
 * might have wanted; a false negative leaves a garment in, which is the state
 * this whole thing was in yesterday. Anything unrecognised stays.
 */
const GARMENT_NOUNS = [
  // upper
  'shirt', 'blouse', 'sweater', 'cardigan', 'hoodie', 'jacket', 'coat',
  'blazer', 'vest', 'waistcoat', 'tank_top', 'camisole', 'crop_top', 'top',
  'jersey', 'poncho', 'cloak', 'cape', 'capelet', 'shawl', 'robe', 'kimono',
  'yukata', 'haori', 'hanfu', 'sari', 'tunic', 'surcoat', 'tabard',
  // lower
  'skirt', 'shorts', 'pants', 'trousers', 'jeans', 'leggings', 'hakama',
  'bloomers', 'culottes',
  // whole
  'dress', 'gown', 'sundress', 'jumpsuit', 'overalls', 'romper', 'leotard',
  'bodysuit', 'swimsuit', 'bikini', 'uniform', 'apron', 'armor', 'armour',
  // legs and feet
  'pantyhose', 'tights', 'stockings', 'thighhighs', 'kneehighs', 'socks',
  'boots', 'shoes', 'sandals', 'heels', 'loafers', 'sneakers', 'geta',
  'zori', 'slippers',
  // hands, arms, neck
  'gloves', 'mittens', 'gauntlets', 'bracers', 'sleeves', 'armlet', 'cuffs',
  'scarf', 'muffler', 'necktie', 'tie', 'bowtie', 'ascot', 'collar',
  'choker', 'ribbon',
  // head
  'hat', 'cap', 'beret', 'bonnet', 'hood', 'helmet', 'headband', 'headdress',
  'veil', 'crown', 'tiara', 'circlet', 'visor', 'goggles', 'glasses',
  'eyewear', 'sunglasses', 'mask', 'eyepatch',
  // under and around
  'bra', 'panties', 'underwear', 'lingerie', 'corset', 'belt', 'sash',
  'obi', 'harness', 'suspenders', 'garter', 'garter_belt', 'buckle',
  // Found 18 Sep 2026 reading the canon handed to the prompt for 129
  // characters: every one of these reached the model as how she LOOKS.
  // Outfits named whole — Rem's `maid`, Shimakaze's `serafuku`, Kaga's
  // `muneate`, Asuna's `playboy_bunny`, Madoka's `magical_girl` — and
  // `*_clothes`, which is how danbooru spells a style of dress
  // (`japanese_clothes`, `chinese_clothes`, `formal_clothes`,
  // `plaid_clothes`, `pom_pom_(clothes)`).
  'clothes', '(clothes)', 'serafuku', 'maid', 'miko', 'playboy_bunny',
  'race_queen', 'magical_girl', 'plugsuit', 'suit', 'tasuki', 'muneate',
  'pauldrons', 'randoseru', 'bodystocking',
  // 19 Sep 2026, the Konosuba/NieR/Dress-Up Darling read: Eris's `nun`,
  // Kaine's `negligee`, Chris's `denim`, Shizuku-tan's `gothic_lolita` and
  // `lolita_fashion`, and the `wig` a cosplay of her wears.
  'nun', 'negligee', 'denim', 'lolita', 'wig',
  // GATE, 19 Sep 2026: Tuka and Itami's `military_fatigues`, `camouflage`
  // and the `japan_self-defense_force` family are the uniform.
  'fatigues', 'military', 'camouflage', 'self-defense',
  // Zelda / Street Fighter / Girls und Panzer, 19 Sep 2026. Fighting-game
  // costumes and their pieces: Chun-Li's `qipao` and `pelvic_curtain`, Ryu's
  // `dougi`, R. Mika's `wrestling_outfit`, Urbosa's `breastplate`, Decapre's
  // `shoulder_pads`, Kimberly's `arm_wrap`, the Garupan `miniskirt` (one word,
  // so `skirt` never matched it), school `emblem`s and the cuts of a top.
  'qipao', 'pelvic_curtain', 'dougi', 'outfit', 'breastplate', 'shoulder_pads',
  'armband', 'wristband', 'wrap', 'miniskirt', 'emblem', 'v-neck', 'off_shoulder',
  'hip_vent', 'lowleg', 'topless', 'watch', 'smartwatch', 'wristwatch', 'converse',
  // Parts and cuts of a garment rather than the garment: a turtleneck is her
  // top, `sleeveless` and `frills` are her dress, `print` is its fabric.
  'neckerchief', 'turtleneck', 'halterneck', 'halter', 'strap',
  'legwear', 'thighhigh', 'pocket', 'frills', 'button', 'buttons',
  'double-breasted', 'sleeveless', 'cutout', 'print',
  // Skin an outfit shows. True of one dress, not of her: Tifa in a coat has
  // no `midriff`.
  'midriff', 'bare_shoulders', 'covered_navel',
  // Blue Archive, 19 Sep 2026: the track event's `buruma`, `lanyard` and
  // `id_card`, Fuuka's `headscarf`, Maki's `beanie`, Neru's `sukajan`, Saki's
  // `knee_pads` and `rash_guard`, Izuna's `fishnets`, Tsubaki's
  // `single_breast_curtain`, Ako's `plunging_neckline`, the swimsuit event's
  // `whistle_around_neck` and `name_tag`, and outfits named by who wears
  // them — Hibiki's `cheerleader`, Serina's `nurse`, Fubuki's `police`.
  // Not `tassel`: Tsubaki's is her kimono's, but `hair_tassel` is canon hair.
  'buruma', 'lanyard', 'id_card', 'headscarf', 'beanie', 'sukajan',
  'knee_pads', 'elbow_pads', 'rash_guard', 'fishnets',
  'breast_curtain', 'breast_curtains', 'neckline', 'whistle', 'name_tag',
  'cheerleader', 'nurse', 'police', 'unzipped',
  // The same students' costumes once their samples were clean: Toki's and
  // Hina's `strapless`, Shun's `side_slit` and `mary_janes`, and skin the
  // swimsuit shows — Shiroko `barefoot`, Miyako's `bare_arms`.
  'strapless', 'slit', 'mary_janes', 'barefoot', 'bare_arms', 'bare_legs',
];

/**
 * Garments whose tag is not a noun match, and near-misses that must NOT be
 * read as clothing. The second half matters more: `tail` ends in no garment
 * noun but `ponytail` contains one, and `cross_halo` is a Blue Archive
 * student's halo rather than something she dressed in.
 */
const NOT_GARMENT = new Set([
  // hairstyles the noun rule would catch through `tail` or `ribbon`
  'ponytail', 'twintails', 'twin_tails', 'side_ponytail', 'high_ponytail',
  'low_ponytail', 'tail', 'cat_tail', 'fox_tail', 'wolf_tail', 'animal_tail',
  // worn, but identity rather than wardrobe — every Blue Archive student has
  // a halo, and it is the single strongest trait Seia has at lift 7194
  'halo', 'cross_halo', 'yellow_halo', 'blue_halo', 'red_halo', 'green_halo',
  'white_halo', 'black_halo', 'purple_halo', 'orange_halo', 'pink_halo',
  // parts of her, not things she put on
  'animal_ear_fluff', 'fox_girl', 'cat_girl', 'wolf_girl', 'dog_girl',
  'horse_girl', 'rabbit_girl', 'mouse_girl',
  // a doll's face, which the `button` rule would call a coat's
  'button_eyes',
]);

export function isGarment(tag) {
  const k = key(tag);
  if (!k) return false;
  if (NOT_GARMENT.has(k)) return false;
  // Worn in the hair is worn, but it is an ornament rather than clothing and
  // nobody asking for a sundress means "remove her hairpin".
  if (HAIR_WORN.has(k)) return false;
  // Costume ears and tails are costume: Asuna's `fake_animal_ears` is the
  // bunny suit, not her.
  if (FAKE_BODY.has(k)) return true;
  const words = k.split('_');
  return GARMENT_NOUNS.some(
    (n) => k === n || words.includes(n) || (n.includes('_') && k.includes(n))
  );
}

/**
 * Is this tag a PROP — something she is carrying rather than something she is?
 *
 * The second half of the same problem, reported the same night: a brief came
 * back with a dagger nobody had asked for. Every bare weapon and carried
 * object lands in the `appearance` catch-all, so danbooru's tally of what a
 * character usually holds was reaching the model as canon.
 *
 * `holding_staff` was already caught, in August, by the `holding_` rule — but
 * `staff` on its own was not, and danbooru tags both. That gap is this.
 *
 * A prop is per-scene by nature. Frieren usually holds a staff; "Frieren
 * drinking coffee" does not want one, and it is not a fact about how she
 * looks. Withheld from the canon block for the same reason garments are, and
 * offered as a chip in the traits panel for anyone who does want it.
 */
const PROP_NOUNS = [
  // weapons. `bow` alone is deliberately absent — on danbooru that is the
  // ribbon, and the weapon is `bow_(weapon)`.
  'sword', 'katana', 'dagger', 'knife', 'blade', 'rapier', 'scimitar',
  'greatsword', 'spear', 'lance', 'halberd', 'glaive', 'naginata', 'axe',
  'scythe', 'sickle', 'hammer', 'mace', 'club', 'staff', 'wand', 'rod',
  'crossbow', 'bow_(weapon)', 'arrow', 'quiver', 'shield', 'gun', 'rifle',
  'pistol', 'revolver', 'shotgun', 'cannon', 'kunai', 'shuriken', 'whip',
  'chain', 'sheath', 'scabbard', 'weapon', 'firearm', 'polearm',
  // carried things
  'bag', 'backpack', 'purse', 'handbag', 'satchel', 'briefcase', 'suitcase',
  'basket', 'box', 'crate', 'barrel', 'bucket', 'umbrella', 'parasol',
  'lantern', 'lamp', 'torch', 'candle', 'broom', 'mop', 'camera', 'phone',
  'smartphone', 'bottle', 'flask', 'cup', 'mug', 'glass', 'plate', 'tray',
  'book', 'scroll', 'map', 'letter', 'envelope', 'fan', 'mirror', 'key',
  'coin', 'purse', 'pouch', 'doll', 'plushie', 'teddy_bear', 'balloon',
  'instrument', 'guitar', 'violin', 'flute', 'microphone',
  // 18 Sep 2026, same read: Racing Miku's `flag`, Reimu's `gohei`, Nue's
  // `trident`, Suika's `gourd`, Ainz's `orb`.
  'flag', 'gohei', 'trident', 'gourd', 'orb',
  // Yao (GATE): `stuffed_rabbit`, `stuffed_animal`, `stuffed_toy`.
  'stuffed',
  // Kimberly (Street Fighter 6) was sent all of these as her look.
  'walkman', 'spray_can', 'cable',
  // Blue Archive, 19 Sep 2026: Ayane's `tablet_pc`, Ako's `shackles`, and the
  // swimsuit event's `swim_ring`, `innertube` and `inflatable_toy`.
  'tablet_pc', 'shackles', 'swim_ring', 'innertube', 'inflatable',
  // Hibiki's cheer `pom_pom_(cheerleading)` — spelled out, because
  // `pom_pom_hair_ornament` is Moe's hair — and Miyako's `cellphone`.
  'pom_pom_(cheerleading)', 'cellphone',
];

/**
 * Tags a prop noun would catch that are not props.
 *
 * `chain` is the one that matters: `chain_necklace` is jewellery she wears,
 * and the bare word is a prop. `glass` cuts both ways for the same reason —
 * `glasses` is already a garment and `stained_glass` is scenery.
 */
const NOT_PROP = new Set([
  'chain_necklace', 'neck_chain', 'chain_belt', 'stained_glass',
  'glass_bottle', 'hourglass', 'sunglasses', 'eyeglasses',
  // an instrument she IS rather than carries — a tail, not a prop
  'tail', 'fan_(object)_removed',
]);

export function isProp(tag) {
  const k = key(tag);
  if (!k) return false;
  if (NOT_PROP.has(k)) return false;
  // A garment wins the tie. `chain_belt` and `glasses` read as both, and
  // wardrobe is the more useful answer for anything worn.
  if (isGarment(k)) return false;
  const words = k.split('_');
  return PROP_NOUNS.some(
    (n) => k === n || words.includes(n) || (n.includes('_') && k.includes(n))
  );
}

// ── count ──
// How many people are in shot. Not a property of any of them, and the tags
// are minted to a pattern (see the numeric rule in tagFacet).
const COUNT = new Set([
  '1girl', '1boy', '1other', '2girls', '2boys', '3girls', '3boys', '4girls',
  '5girls', '6+girls', '6+boys', 'multiple_girls', 'multiple_boys',
  'multiple_others', 'male_focus', 'female_focus', 'solo', 'solo_focus',
  'duo', 'trio', 'group',
  // Who else is in the picture. Popola (NieR) was sent `twins, sisters,
  // siblings` as her own look, 19 Sep 2026.
  'twins', 'sisters', 'brothers', 'siblings', 'brother_and_sister',
  // The whole cast in one picture — Blue Archive's anniversary art.
  'everyone', 'absolutely_everyone',
]);

// ── crop ──
// Where the frame was cut, and backgrounds used as a treatment rather than a
// place. `simple_background` is not somewhere she is standing.
const CROP = new Set([
  'full_body', 'upper_body', 'lower_body', 'cowboy_shot', 'portrait',
  'close-up', 'wide_shot', 'cropped', 'cropped_torso', 'cropped_legs',
  'cropped_arms', 'cropped_head', 'out_of_frame',
  'simple_background', 'white_background', 'transparent_background',
  'gradient_background', 'two-tone_background', 'grey_background',
  'black_background', 'blue_background', 'pink_background', 'red_background',
  'yellow_background', 'green_background', 'purple_background',
  'floral_background', 'patterned_background', 'abstract_background',
  // What the frame shows, not what she has: Ayane and Kasumi were sent `legs`.
  'legs',
]);

// ── angle ──
// Where the camera was put. Moving it changes the picture and changes
// nothing about the person — which is exactly what separates these from the
// gaze set below.
const ANGLE = new Set([
  'straight-on', 'dutch_angle', 'sideways', 'rotated',
  'from_above', 'from_below', 'from_outside', 'pov', 'first-person_view',
]);

// ── gaze ──
// Which way the body and the eyes are turned. Danbooru has no separate
// vocabulary for "she is standing in profile" — `from_side` and `profile`
// are the only tags that carry it, and a Pose reference that drops them
// loses the orientation half of what a pose IS.
//
// The edge against `angle`: `from_above` moves the camera and leaves her
// facing wherever she was facing; `from_behind` cannot be true unless she is
// turned away. If the tag constrains the subject, it is gaze.
const GAZE = new Set([
  'profile', 'facing_viewer', 'facing_away', 'facing_to_the_side',
  'eye_contact', 'from_side', 'from_behind',
]);

// ── quality, in two parts ──
//
// Split for the same reason framing was: about the character, these are one
// answer, and a Visual style reference needs them apart. `pixel_art` is the
// whole point of a style reference; `absurdres` is a pixel count and
// `watermark` is somebody's signature. Both group back to `quality`.

// ── medium ──
// A decision somebody made about how the picture is rendered. The edge
// against `meta` is intent: `depth_of_field` is a lens chosen on purpose and
// `blurry` is a picture that came out wrong. reference-vision.md already
// treats that trio — `motion_blur`, `depth_of_field`, `bokeh` — as worth
// adding, so calling them defects here would contradict it.
const MEDIUM = new Set([
  'depth_of_field', 'bokeh', 'motion_blur', 'chromatic_aberration',
  'film_grain',
  'greyscale', 'monochrome', 'sepia', 'limited_palette', 'spot_color',
  'official_art', 'game_cg', 'promotional_art', 'key_visual',
  'traditional_media', 'pixel_art', 'sketch', 'lineart', 'unfinished',
  // Rendering technique. Added 7 Sep 2026 because a Visual style reference
  // came back empty at every threshold down to 0.02 on a real screenshot —
  // no tagger sees "style" unless these are classed as style. `anime_coloring`
  // was the tag on that image, and it was reaching the model as clothing.
  'anime_coloring', 'anime_screencap', 'flat_color', 'cel_shading',
  'soft_shading', 'toon_shading', 'halftone', 'screentones', 'painterly',
  'watercolor_(medium)', 'oekaki', 'retro_artstyle', 'realistic',
  'photorealistic', 'impasto', 'gradient',
  // How the picture is drawn, not the person in it. 18 Sep 2026: `chibi`
  // went to the model as Kaga's canon, and Sensei's as `full_page_comic`.
  'chibi', 'chibi_only', 'comic', '4koma', 'full_page_comic', 'silent_comic',
]);

// ── meta ──
// About the file rather than the picture, plus anything printed over it.
// Nothing here is ever worth carrying into a prompt at any role.
const META = new Set([
  'blurry', 'blurry_background', 'blurry_foreground', 'noise',
  'jpeg_artifacts', 'scan', 'scan_artifacts', 'lowres', 'highres',
  'absurdres', 'incredibly_absurdres', 'huge_filesize',
  'artist_name', 'signature', 'watermark', 'web_address', 'username',
  'twitter_username', 'dated', 'character_name', 'copyright_name', 'logo',
  'artist_logo', 'company_name', 'copyright', 'credits', 'studio_name',
  'subtitled', 'screencap', 'anime_screenshot', 'stitched',
  'third-party_edit', 'episode_number',
  'english_text', 'japanese_text', 'text_focus',
  'speech_bubble', 'thought_bubble', 'translated', 'translation_request',
  'check_translation',
  'border', 'framed', 'letterboxed', 'pillarboxed', 'outside_border',
  'reference_sheet', 'character_sheet', 'multiple_views', 'variant_set',
  // Labels on the post, not features of her. `alternate_costume` rode along
  // as canon for a dozen characters on 18 Sep 2026 — it says the picture is
  // NOT her usual look, the opposite of what canon is for.
  'alternate_costume', 'official_alternate_costume', 'alternate_hairstyle',
  'official_alternate_hairstyle', 'alternate_hair_color', 'alternate_eye_color',
  'cosplay', 'virtual_youtuber',
  // What the picture is used as: Lelei (GATE) was sent `album_cover`.
  'album_cover', 'cover', 'magazine_cover', 'cover_page',
  // A genre label on the post, not the man in it (Ryu, Ganondorf).
  'bara',
  // Peroro's lists, 19 Sep 2026: what the posts are, not what he is.
  'no_humans', 'parody', 'red_theme',
]);

// ── expression ──
// The face at one instant. A design has a mouth and eyes; it does not have a
// `closed_mouth` or a `blush`. Note what is NOT here: `fang`, `tongue`,
// `eyelashes`, `mole_under_eye`, `tsurime`, `jitome` — permanent features of
// how the face is drawn, which are exactly what canon is for.
const EXPRESSION = new Set([
  // `sweat` is the moment, not the person: Pina (GATE) was sent it, 19 Sep.
  'sweat',
  'smile', 'grin', 'evil_grin', 'smirk', 'light_smile', 'closed_eyes',
  'one_eye_closed', 'half-closed_eyes', 'wide-eyed', 'narrowed_eyes',
  'open_mouth', 'closed_mouth', 'parted_lips', 'frown', 'pout', 'gasp',
  'clenched_teeth', 'teeth', 'fang_out', 'tongue_out', 'licking_lips',
  'blush', 'blush_stickers', 'nose_blush', 'embarrassed', 'flying_sweatdrops',
  'sweatdrop', 'crying', 'crying_with_eyes_open', 'tears', 'happy', 'sad',
  'angry', 'annoyed', 'surprised', 'shocked', 'scared', 'serious', 'smug',
  'expressionless', 'empty_eyes', 'sleepy', 'yawning', 'wink', 'wince',
  ':d', ':o', ':3', ':>', ':<', ':|', ';d', ';)', '^_^', 'xd', 'o_o', '@_@',
  'heart-shaped_pupils', 'nervous', 'confused', 'determined',
]);

// ── action ──
// What the body is doing right now, and what the hands hold. Every one of
// these is the brief's to decide — the whole reported failure was canon
// telling the model she holds a staff under a brief that said coffee.
//
// `holding_*` is a prefix rule rather than a list: danbooru mints one of
// these per object in existence and enumerating them is not a finite job.
const ACTION = new Set([
  'holding', 'carrying', 'grabbing', 'reaching', 'pointing', 'waving',
  // 19 Sep 2026: Chris (Konosuba) and Shizuku-tan (Dress-Up Darling) were
  // sent these as canon.
  'reaching_towards_viewer', 'between_breasts', 'restrained', 'listening_to_music',
  'sitting', 'standing', 'walking', 'running', 'jumping', 'flying',
  'floating', 'falling', 'kneeling', 'squatting', 'crouching', 'leaning',
  'leaning_forward', 'leaning_back', 'lying', 'on_back', 'on_side',
  'on_stomach', 'sleeping', 'stretching', 'bending_over', 'all_fours',
  'arm_up', 'arms_up', 'arm_at_side', 'arms_at_sides', 'arms_crossed',
  'arms_behind_back', 'arms_behind_head', 'hand_up', 'hands_up',
  'hand_on_hip', 'hands_on_hips', 'hand_on_own_chest', 'hand_on_own_face',
  // These name a wall and are not about the wall. Named ahead of the `_wall`
  // rule below, which would otherwise call leaning on something a setting.
  'against_wall', 'hand_on_wall', 'arm_against_wall',
  'hand_in_pocket', 'hands_in_pockets',
  'hand_in_hair', 'own_hands_together', 'outstretched_arm',
  'outstretched_hand', 'open_hand', 'clenched_hand', 'clenched_hands',
  'v', 'salute', 'thumbs_up', 'peace_sign',
  'legs_crossed', 'crossed_legs', 'legs_up', 'spread_legs', 'legs_apart',
  'knees_together_feet_apart', 'standing_on_one_leg',
  'drinking', 'eating', 'cooking', 'reading', 'writing', 'singing',
  'dancing', 'smoking', 'playing_instrument', 'fighting', 'aiming',
  'hug', 'hugging', 'hugging_object', 'kissing', 'riding', 'swimming',
  'looking_at_another', 'talking', 'shouting', 'laughing',
]);

// ── scene ──
// Where it happens and what else is in shot. `brick_wall` is the reported
// one; it is a real and useful fact about a photograph and says nothing at
// all about the person standing in front of it.
// ── light ──
// Carved out of `scene` on 6 Sep 2026 so a Lighting reference has something
// to keep. Time of day is here rather than in `scene` because `sunset` is
// almost never attached to a picture for the hour it names — it is attached
// for the colour of the light, which is what reference-vision.md already
// says when it lists `sunset` beside `backlighting` and `god_rays`.
//
// A Background reference keeps this set as well as `scene`: "at night" is
// part of a setting. A Lighting reference keeps only this one.
const LIGHT = new Set([
  'day', 'night', 'evening', 'morning', 'sunset', 'sunrise', 'dusk',
  'twilight',
  'sunlight', 'backlighting', 'rim_lighting', 'lens_flare', 'light_rays',
  'neon_lights', 'neon_trim',
  'sunbeam', 'dappled_sunlight', 'god_rays', 'dim_lighting', 'bright',
  'dark', 'silhouette', 'shadow', 'cast_shadow',
  'lantern', 'candle', 'lamp', 'glowing', 'light_particles',
  'sparkle', 'sparkles',
]);

const SCENE = new Set([
  'indoors', 'outdoors',
  // The setting named as a whole. Same find as `copyright_notice`: `nature`
  // was reaching the model as part of her outfit.
  'scenery', 'nature', 'landscape',
  // The setting as a genre. Scaramouche's `contemporary`, Ainz's `fantasy`.
  'contemporary', 'fantasy',
  // Yao (GATE) was sent a truck, a cliff and the horizon, 19 Sep 2026.
  'cliff', 'horizon', 'truck', 'car', 'vehicle', 'motor_vehicle', 'military_vehicle',
  'sky', 'cloud', 'clouds', 'cloudy_sky', 'blue_sky', 'night_sky',
  'starry_sky', 'star_(sky)', 'moon', 'full_moon', 'crescent_moon', 'sun',
  'tree', 'trees', 'forest', 'bamboo_forest', 'grass', 'field', 'flower',
  // Solid-word flora the `_flower` rule cannot see, because there is no
  // separator in `sunflower`. Named rather than pattern-matched for the
  // reason `cauliflower` gives.
  'sunflower', 'sunflowers', 'lotus', 'spider_lily', 'lily_(flower)',
  'lily_pad', 'rose_petals', 'flower_pot', 'ivy', 'moss', 'fern',
  'flower_field', 'sunflower_field', 'petals', 'falling_petals',
  'cherry_blossoms', 'leaf',
  'leaves', 'plant', 'potted_plant', 'bush', 'mountain', 'hill', 'rock',
  'ocean', 'sea', 'beach', 'sand', 'water', 'waves', 'river', 'lake',
  'puddle', 'reflection', 'snow', 'snowing', 'rain', 'raining', 'fog', 'wet',
  'mist', 'wind',
  'path', 'pavement', 'cobblestone', 'arch', 'archway', 'column', 'brick',
  'gravel', 'dirt', 'hedge', 'shrub', 'vine',
  'wall', 'brick_wall', 'stone_wall', 'wooden_wall', 'tiled_wall', 'floor',
  'wooden_floor', 'tatami', 'tile_floor', 'ceiling', 'window', 'windowsill',
  'curtains', 'door', 'doorway', 'stairs', 'railing', 'fence', 'pillar',
  'room', 'bedroom', 'bed', 'kitchen', 'bathroom', 'classroom', 'library',
  'office', 'cafe', 'restaurant', 'shop', 'church', 'shrine', 'castle',
  'ruins', 'building', 'city', 'cityscape', 'street', 'road', 'sidewalk',
  'alley', 'bridge', 'rooftop', 'train_interior', 'car_interior',
  'chair', 'table', 'desk', 'bench', 'sofa', 'couch', 'shelf', 'bookshelf',
  'book', 'cup', 'mug', 'teacup', 'bottle', 'glass', 'plate', 'bowl',
  'food', 'drink', 'coffee', 'tea', 'cake', 'fruit',
  'fire', 'smoke', 'confetti',
  'bubble', 'bubbles', 'butterfly', 'bird', 'cat', 'dog',
  // Blue Archive, 19 Sep 2026. Food as the thing on the plate — Airi's
  // `ice_cream_hair_ornament` is spelled differently and stays — and the
  // animals in the picture: Seia's `white_bird`, Miyu's beach.
  'ice_cream', 'ice_cream_cone', 'donut', 'doughnut', 'candy', 'strawberry',
  'birthday_cake', 'white_bird', 'seagull', 'starfish',
  // Shiroko's swimsuit art has her landing a marlin.
  'fish', 'marlin_(fish)', 'animal',
]);

// The leaf classes, in lookup order. `appearance` is not here: it is the
// fallback, and a tag reaches it by matching nothing.
const CLASSES = [
  ['body', BODY],
  ['count', COUNT],
  ['crop', CROP],
  ['angle', ANGLE],
  ['gaze', GAZE],
  ['medium', MEDIUM],
  ['meta', META],
  ['expression', EXPRESSION],
  ['action', ACTION],
  ['light', LIGHT],
  ['scene', SCENE],
];

/**
 * Leaf class -> the coarse class `tagClass` has always returned.
 *
 * This map is the compatibility contract. `isAppearanceTag`, the canon
 * lookup in server.mjs and the traits panel ask one question — "does this
 * describe the character" — and splitting the sets underneath them must not
 * change a single one of their answers. Every leaf below groups back to the
 * class its members were in before the split, so it does not.
 */
const GROUP = {
  // Both halves of "describes the character". `body` is split out only so an
  // Outfit reference can leave it behind; to every caller asking the coarse
  // question, hair and a coat are the same answer and always were.
  appearance: 'appearance', body: 'appearance',
  count: 'framing', crop: 'framing', angle: 'framing', gaze: 'framing',
  medium: 'quality', meta: 'quality',
  expression: 'expression',
  action: 'action',
  light: 'scene', scene: 'scene',
};

/**
 * What each reference role is allowed to take out of a tagger's list, by leaf
 * class. The reason this exists is a bug a user reported on 6 Sep 2026: he
 * attached a picture to copy the POSE from it and got the whole photograph
 * back — hair colour, uniform, cherry blossoms, brick wall — because until
 * now only the `character` role narrowed anything and the other seven passed
 * the list through untouched, under a fidelity rule that says "keep the
 * listed traits".
 *
 * ── The fallback runs the other way here, deliberately ───────────────────
 *
 * This file's rule is that an unrecognised tag is assumed to be appearance,
 * so a vocabulary it has never heard of survives. That is right for the
 * character question and wrong for every role below except the two that keep
 * `appearance`: an unknown tag on a Pose reference is dropped, because
 * `action` and `gaze` are not the fallback.
 *
 * That inversion is the point rather than an oversight. The reported failure
 * was too much reaching the model, the roles below err toward too little,
 * and the escape hatch already exists and already shipped — the chips grey
 * rather than hide, and one click adds any of them anyway.
 *
 * ── Why `outfit` is the same filter as `character` ───────────────────────
 *
 * There is no `clothing` leaf, and adding one would have been the wrong
 * move. Danbooru's clothing vocabulary is the open end of the set — every
 * new series brings coat shapes nobody has listed — so a clothing whitelist
 * is permanently incomplete, and under the inversion above an incomplete one
 * silently eats real garments. Keeping `appearance` for both means an
 * unrecognised item of clothing survives, and the narrowing that actually
 * fixes the complaint (dropping the wall, the blur and the pose) still
 * happens. The role's `rule` text still tells the model which half to read.
 *
 * ── Why `object` keeps nothing ───────────────────────────────────────────
 *
 * Because there is no honest edge to draw. A prop and the furniture behind
 * it are both `scene` and danbooru does not distinguish them, so any filter
 * here would be a guess dressed as a rule. An Object reference therefore
 * travels on its note — "take from it: the sword" — which is the one part of
 * a reference the person wrote themselves. imagerefs.mjs warns when that
 * note is missing rather than silently sending an empty reference.
 */
export const ROLE_KEEPS = {
  // `general` is deliberately absent, not empty. isRoleTag returns true for a
  // role with no entry — every chip stays live — which is exactly right for a
  // role that means "take all of it", and would be wrong for any other role
  // here. `object: []` is the opposite end of the same table, so both extremes
  // are reachable and neither is a special case in the code.
  character: ['appearance', 'body'],
  // Not `body`. This is the whole reason that leaf exists: asking for the
  // clothes and being told about elf ears is the bug, reported 6 Sep 2026.
  // `appearance` is still the fallback here, so an unrecognised garment
  // survives and only what she IS falls away.
  outfit: ['appearance'],
  pose: ['action', 'gaze', 'count'],
  background: ['scene', 'light'],
  style: ['medium'],
  composition: ['crop', 'angle', 'gaze', 'count'],
  lighting: ['light'],
  object: [],
};

/**
 * Which roles may name a character.
 *
 * `character: frieren` is the strongest line a reference carries — for a
 * booru model that knows her it does more work than every appearance tag put
 * together — and on any other role it is a leak. A Pose reference exists to
 * borrow a posture from a picture of somebody else; sending her name with it
 * puts her in the output, which is the same complaint the tag filter above
 * was built to answer, arriving through a different line.
 *
 * Until 6 Sep 2026 the browser gated it by not sending the field at all, and
 * that was worse than it looked: tag categories do not survive the wire, so a
 * server that never learns `frieren` is a person cannot strip her from an
 * Outfit reference's tag list either, and she went out in the list instead.
 * The browser now always sends who the tagger recognised and the server
 * decides what to do with it. This set is the shared vocabulary — the browser
 * reads it to decide which cards show a character field and open the traits
 * panel, the server to decide which references may name her.
 *
 * `applies_to` is deliberately not covered: naming whose coat it is on an
 * Outfit reference is the point of that field, not a leak.
 */
export const ROLE_CARRIES_CHARACTER = new Set(['character']);

/**
 * One line per class, for a chip's tooltip. Never shown as a label.
 *
 * Carries both the leaf names and the coarse ones, because two callers look
 * these up with different resolutions: the reference card classifies by leaf
 * (it knows the role), the traits panel by group (it only ever asks about a
 * character).
 */
export const CLASS_REASON = {
  appearance: 'describes the character',
  body: 'part of her, not something she is wearing',
  framing: 'framing — how the picture is cropped, not who is in it',
  quality: 'about the image file, not the character',
  expression: 'a moment on the face, not part of the design',
  action: 'what they were doing in that picture, not what they look like',
  scene: 'the setting, not the character',
  count: 'how many people are in shot',
  crop: 'where the picture was cut, not what is in it',
  angle: 'where the camera was put',
  gaze: 'which way they are turned',
  medium: 'how the picture is rendered',
  meta: 'about the image file, not the picture',
  light: 'the light, not the setting',
};

/**
 * The fine-grained class a tag belongs to. `appearance` is the default and
 * the fallback: an unrecognised tag is assumed to describe the character, so
 * a vocabulary this file has never heard of survives into the prompt.
 *
 * Pure and spelling-agnostic — `long hair` and `long_hair` classify alike, so
 * it can run on the model's spelling in the browser and on danbooru's on the
 * server without either side converting first.
 */
export function tagFacet(tag) {
  const k = key(tag);
  if (!k) return 'appearance';

  // Structural rules first, because they cover open-ended families no list
  // can finish. Each was checked against the appearance vocabulary and none
  // has a counter-example: there is no appearance tag ending in `_background`
  // or `_focus`, and none beginning `holding_` or `looking_`.
  // Exceptions ahead of the body patterns, both directions: things worn in
  // the hair that the `hair_*` rule would call anatomy, and costume pieces
  // that the `*_ears` / `*_horns` rules would. Neither survives as a
  // pattern — `hair_ribbon` and `hair_intakes` are spelled the same way.
  if (HAIR_WORN.has(k) || FAKE_BODY.has(k)) return 'appearance';
  if (k.startsWith('holding_')) return 'action';
  // Where the eyes go. `looking_at_viewer` is noise on a character sheet and
  // is a large part of the answer on a pose reference.
  if (k.startsWith('looking_')) return 'gaze';
  // Named before the general `_background` rule, which would otherwise
  // shadow their entry in META and hand a blown-out background to a
  // Composition reference as though it were a framing decision. The tag for
  // that decision made on purpose is `depth_of_field`, and it is a medium.
  if (k === 'blurry_background' || k === 'blurry_foreground') return 'meta';
  if (k.endsWith('_background')) return 'crop';
  // Named before the general `_focus` rule: these three say which of several
  // people the picture is about, which is a count question, not a crop one.
  if (k === 'male_focus' || k === 'female_focus' || k === 'solo_focus') return 'count';
  if (k.endsWith('_focus')) return 'crop';
  if (k.endsWith('_(medium)')) return 'medium';
  if (k.startsWith('commentary') || k.endsWith('_commentary')) return 'meta';
  // Somebody's name or mark printed over the picture. Found 7 Sep 2026 on a
  // Crunchyroll screenshot: `copyright_notice` fell through to the appearance
  // default and was sent to the model as something Frieren was WEARING, on
  // both the Character and the Outfit reference.
  //
  // Families rather than a list: danbooru mints one of these per site, and
  // `twitter_username`, `artist_logo` and `watermark` were already named
  // individually while `patreon_username`, `twitter_logo` and
  // `sample_watermark` were not. No garment ends in any of the three.
  //
  // Two exceptions, and they are in-universe emblems rather than site marks:
  // a Rhine Lab badge is printed on the uniform and belongs to the outfit.
  // Named because there is no way to tell a faction crest from a platform
  // logo by its spelling, and the failure direction matters — a watermark
  // getting through costs one junk tag, a dropped uniform crest costs a
  // detail nobody can get back.
  if (k === 'chaldea_logo' || k === 'rhine_lab_logo') return 'appearance';
  if (/_(username|logo|watermark)$/.test(k)) return 'meta';
  if (k === 'copyright_notice' || k === 'notice_lines') return 'meta';
  // Blue Archive's own general tags are clubs, schools, event uniforms, items
  // and memes — `foreclosure_task_force_(blue_archive)`, `pyroxene_`,
  // `momotalk_`, `mutsuki_face_`. All 41 with fifty posts were read on 19 Sep
  // 2026 and none is how a student looks; Satsuki was being sent her club.
  // Named for the one franchise, because the suffix is not a rule elsewhere:
  // Wuthering Waves' `tacet_mark_(wuthering_waves)` is a mark on her skin.
  if (k.endsWith('_(blue_archive)')) return 'meta';
  // `2girls`, `6+boys`, `1other`. Counting the people in frame is framing by
  // definition, and the tags are minted to a pattern.
  if (/^\d+\+?(girls?|boys?|others?)$/.test(k)) return 'count';

  // Body patterns, after the exceptions above. Open-ended families again:
  // danbooru mints a `*_hair` per colour and length and a `*_eyes` per
  // colour, and enumerating them is not a finite job. Checked for
  // counter-examples the same way the others were — no garment ends in
  // `_eyes`, `_bangs`, `_pupils` or `_skin`, and the two families that DO
  // collide, hair ornaments and costume ears, are the named sets above.
  // A listed action wins over the body families it happens to end like:
  // `between_breasts` is something held there, not a size.
  if (ACTION.has(k)) return 'action';
  if (/_(hair|bangs|eyes|pupils|iris|skin|ears|horns|tail|wings|breasts)$/.test(k)) return 'body';
  // Hairstyle families, minted per arrangement the same way colours are:
  // `quad_braids`, `side_braid`, `low_ponytail`, `hair_updo`. No garment
  // ends in any of these. `_cut` is deliberately absent — `bob_cut` is a
  // hairstyle and `low-cut` is a neckline.
  if (/_(braid|braids|ponytail|updo)$/.test(k)) return 'body';
  // Flowers, minted per species and per colour. Found 7 Sep 2026 by running a
  // real photograph through the real tagger for the first time: a Hinata
  // standing in a sunflower field returned `sunflower, yellow_flower`, both
  // fell through to the appearance default, and both were sent to the model
  // as things she was WEARING while the Background reference got the single
  // tag `flower`.
  //
  // This is the `flower` / `hair_flower` pair the header already describes,
  // one level out: danbooru tags a flower she stands near the same way it
  // tags one in her hand. The compounds that ARE worn are named in HAIR_WORN
  // above, which is checked first.
  if (/(^|_)flowers?$/.test(k)) return 'scene';
  // Roses are minted per colour the way hair is. `_rose` and not `rose_`:
  // `rose_print` is a pattern on fabric and `rose_petals` is on the ground,
  // so the suffix is the half that means "an actual rose is in this picture".
  if (/(^|_)roses?$/.test(k)) return 'scene';
  // Ground and structure, minted per material: `checkered_floor`,
  // `brick_floor`, `tile_wall`, `wooden_fence`. The sets above already list
  // half a dozen of each by hand; these are the families they belong to.
  //
  // `fourth_wall` is the one real trap — it is a comics convention, not
  // masonry — and the poses that merely mention a wall are named in ACTION.
  if (k === 'fourth_wall' || k === 'through_wall') return 'meta';
  // Poses that merely mention a wall. Listed in ACTION too, but the set
  // lookup runs after this rule, so they need naming here to reach it.
  if (k === 'against_wall' || k === 'hand_on_wall' || k === 'arm_against_wall') return 'action';
  if (/_(floor|fence|wall)$/.test(k)) return 'scene';
  if (k.startsWith('hair_') || k.startsWith('eyes_')) return 'body';

  for (const [name, set] of CLASSES) if (set.has(k)) return name;
  return 'appearance';
}

/**
 * The coarse class, and the original contract of this module: one of
 * `appearance`, `framing`, `quality`, `expression`, `action`, `scene`.
 *
 * Every caller that asks "does this describe the character" wants this one
 * and its answers have not changed. `tagFacet` is for callers that know
 * which reference role they are filtering for.
 */
export function tagClass(tag) {
  return GROUP[tagFacet(tag)] ?? 'appearance';
}

/** Does this tag describe the character? The question every caller asks. */
export function isAppearanceTag(tag) {
  return tagClass(tag) === 'appearance';
}

/**
 * Is this tag worth anything to a reference at this role?
 *
 * An unknown role keeps everything. That is the behaviour seven of the eight
 * roles had before this existed, so a role the owner adds to
 * config/models.yaml without a matching entry in ROLE_KEEPS degrades to the
 * old pass-through rather than to an empty reference.
 */
export function isRoleTag(tag, role) {
  const keeps = ROLE_KEEPS[role];
  if (!keeps) return true;
  return keeps.includes(tagFacet(tag));
}

/**
 * Split a tag list by what a given role can use. Same shape as
 * splitAppearance, and `character` gives an identical answer.
 */
export function splitForRole(tags = [], role, pick = (t) => t) {
  const kept = [];
  const dropped = [];
  for (const t of tags) (isRoleTag(pick(t), role) ? kept : dropped).push(t);
  return { kept, dropped };
}

/**
 * Split a tag list into what describes the character and what does not,
 * keeping the original order within each half.
 *
 * @param tags  strings, or objects — `pick` says how to read the tag out
 */
export function splitAppearance(tags = [], pick = (t) => t) {
  const kept = [];
  const dropped = [];
  for (const t of tags) (isAppearanceTag(pick(t)) ? kept : dropped).push(t);
  return { kept, dropped };
}

/**
 * Ears and tails that are part of a costume, judged from the whole list.
 *
 * One tag cannot say it: `rabbit_ears` is Pekora's head and Asuna's bunny
 * suit, spelled the same. The list can. Read 19 Sep 2026 over the top 120
 * Blue Archive students: Asuna, Toki, Karin, Akane and Neru were all sent
 * `rabbit_ears` as their look, from the bunny costume each of them is drawn
 * in constantly, and Miyako, Miyu and Moe from the rabbit-ear headphones of
 * their platoon. Every one of those lists also carried `fake_animal_ears`,
 * `*_ear_headphones` or `playboy_bunny`, and none carried `rabbit_girl`.
 *
 * So: when the list says she wears costume ears, an animal's ears with no
 * `<animal>_girl` beside them are the costume. Kazusa keeps her cat ears
 * (`cat_girl`); Momoi loses hers to `cat_ear_headphones` and keeps her tail,
 * which a third of her solo posts show. A tail goes only with the bunny suit
 * or `fake_tail`.
 *
 * And a girl who IS one animal does not have another's ears: Kanna is a
 * `dog_girl` sent `fox_ears` too, a tagging slip on some of her posts.
 *
 * @returns {{ kept, worn }} worn is what this judged to be costume
 */
export function withoutCostumeBody(tags = [], pick = (t) => t) {
  const keys = tags.map((t) => key(pick(t)));
  const has = new Set(keys);
  const girls = new Set(keys.filter((k) => /^[a-z]+_girl$/.test(k)).map((k) => k.slice(0, -5)));
  const headphones = keys.filter((k) => /^[a-z]+_ear_headphones$/.test(k)).map((k) => k.split('_')[0]);
  const bunny = has.has('playboy_bunny');
  const fakeEars = has.has('fake_animal_ears') || has.has('animal_ear_headphones') || headphones.length > 0 || bunny;
  const fakeTail = has.has('fake_tail') || bunny;
  const species = (k, part) => {
    const m = new RegExp(`^([a-z]+)_${part}$`).exec(k);
    return m && !['extra', 'pointy', 'long', 'animal', 'multiple', 'fake'].includes(m[1]) ? m[1] : null;
  };
  const costume = (k) => {
    const ear = species(k, 'ears');
    if (ear && !girls.has(ear)) {
      if (fakeEars || headphones.includes(ear)) return true;
      if (girls.size) return true;
    }
    const tail = species(k, 'tail');
    if (tail && fakeTail && !girls.has(tail) && (tail === 'rabbit' || has.has('fake_tail'))) return true;
    return false;
  };
  const worn = new Set(keys.filter(costume));
  // The generic tags go with the last specific one.
  const realEars = keys.some((k) => species(k, 'ears') && !worn.has(k)) || girls.size > 0;
  if (!realEars && fakeEars) for (const k of ['animal_ears', 'animal_ear_fluff']) if (has.has(k)) worn.add(k);
  const realTail = keys.some((k) => species(k, 'tail') && !worn.has(k)) || girls.size > 0;
  if (!realTail && fakeTail && has.has('tail')) worn.add('tail');
  const kept = [];
  const out = [];
  tags.forEach((t, i) => (worn.has(keys[i]) ? out : kept).push(t));
  return { kept, worn: out };
}
