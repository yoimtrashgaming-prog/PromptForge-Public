// Per-model dialect check against whatever backend is configured.
//
// The smoke suite proves the segment *labels* are right. That is not the same
// as the output being in the right dialect — a heavily quantized model can
// emit a perfectly shaped ===SEGMENT: Positive prompt=== containing prose
// where booru tags belong, and the smoke suite would pass it.
//
// This script asserts the things each prompt file actually asks for, so that
// when a quant degrades you can see *which model* broke and decide whether to
// bump that one model or tune its prompt file, rather than moving the whole
// deployment up a quant.
//
//   node scripts/dialect-check.mjs [baseUrl] [--runs N] [--only a,b]
//   node scripts/dialect-check.mjs --selftest
//
// The rows are checked models, not registry entries: `h3` runs base mode
// (T2VA) and `h3_ref2va` runs the same model in Full reference, because the
// two modes assert opposite things about the same segments — Subject
// definitions and Retention analysis are N/A in one and required in the other.
// Full reference is also the mode the owner actually uses. `--only h3_ref2va`
// runs just that pass; both cost 27B generations, so run them deliberately.
//
// --only narrows the run to named models. A full pass is 2 briefs x N runs
// x 10 models and costs real GPU minutes, so re-measuring one assertion you
// just changed should not mean asking six image models who Makima is again.
// Cross-model checks are skipped when it is used: they compare models
// against each other and cannot mean anything with most of them missing.
//
// --selftest runs the pure helpers against fixed strings and exits. No
// server, no GPU. It exists because these predicates are regexes with
// escapes in them, a mangled escape silently passes everything, and this
// project has now been bitten by that four times.
//
// Run it against the mock backend and most checks will fail by design — the
// mock echoes the brief and makes no attempt at real dialect.
//
// --runs matters. Generation is sampled, so a single run per model is a noisy
// basis for judging a quant: the same model failed "carries its own quality
// vocabulary" on one run and passed it cleanly on the next. With --runs N each
// assertion reports how many of N runs it held, so an outright failure is
// distinguishable from a flaky one. Use --runs 3 or more for a real verdict.

const args = process.argv.slice(2);
const runsFlag = args.indexOf('--runs');
const onlyIdx = args.indexOf('--only');
const RUNS = runsFlag !== -1 ? Math.max(1, Number(args[runsFlag + 1]) || 1) : 1;
// Skip both the flag and its value, or `--runs 3` leaves "3" looking like a
// positional base URL.
//
// The -1 guards are the point. indexOf returns -1 when a flag is absent, and
// -1 + 1 is 0, so the old form threw away argv[0] - the base URL - whenever
// --runs or --only was not passed. The symptom was silent and expensive: the
// URL you gave was dropped, BASE fell back to 127.0.0.1:8090, and on a box
// where 8090 is the real authenticated server every generation came back
// HTTP 401 and every model was reported DEGRADED. Found on the P40, 23 Aug
// 2026, pointing the suite at a throwaway AUTH=off server on 8099.
const skipsValue = (i) =>
  (runsFlag !== -1 && i === runsFlag + 1) || (onlyIdx !== -1 && i === onlyIdx + 1);
const positional = args.filter((a, i) => !a.startsWith('--') && !skipsValue(i));
const BASE = positional[0] ?? 'http://127.0.0.1:8090';

const onlyFlag = onlyIdx;
const ONLY =
  onlyFlag !== -1
    ? String(args[onlyFlag + 1] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : null;
const SELFTEST = args.includes('--selftest');

// TWO briefs, and the second one matters more than the first.
//
// The original brief is the scenario every image prompt file already answers
// with a worked example — pony.md's runs from line 108 — and the 27B was
// measured reproducing that example character for character. So a pass on it
// alone cannot distinguish a model applying its dialect rules from a model
// reciting the answer sitting in its own prompt. An 8B and a 27B produced
// byte-identical anima output, which is hard to explain any other way.
//
// NOTE, 26 Aug 2026: the "known brief vs unfamiliar brief" split described
// below is gone for the image models, and that was the point of the overhaul.
// It was real while Fern was the worked example in all six image prompt files —
// 12/12 on Fern against 4/12 on Makima measured recall, not dialect. The six
// files now carry six different worked examples, none of them either brief, so
// both briefs below are unfamiliar to every image model and the per-brief gap
// should close. Fern is no longer a brief here at all; see the note above the
// first entry. The split still applies to the video files, which were not
// touched by that work.
//
// The second brief appears in no prompt file: `makima` and `chainsaw` are
// absent from all of prompts/, checked. It uses a character the tag database
// does know — makima_(chainsaw_man), 7,302 posts — so the character-handling
// assertions still have something real to bite on, and the setting shares
// nothing with a steampunk workshop.
//
// An assertion that holds on one brief and fails on the other now reports as
// FLAKY with the brief named, which is exactly the signal that was missing.
const BRIEFS = [
  // Replaced the Fern steampunk-mechanic brief on 26 Aug 2026. Fern had been
  // the worked example in all six image prompt files, so it measured recall as
  // much as dialect; the overhaul removed it from the files, and keeping it as
  // a brief kept the suite pointed at a scene nothing else was about any more.
  //
  // Chosen to cover a gap rather than to be different for its own sake: every
  // brief in this file was female, so `1boy` / `male_focus` handling was
  // untested while `1girl, solo` was tested twice over. It also had to be a
  // character whose danbooru tag carries a parenthetical franchise, because
  // hasCharacterTag() below matches on exactly that — `joseph_joestar` was the
  // first pick and would have passed sdxl's "does NOT pass the character tag
  // through" trivially, since there is no `joseph_joestar_(...)` form to find.
  //
  // zhongli_(genshin_impact) carries 9,022 danbooru posts against makima's
  // 7,302, so the two briefs ask a comparable amount of the models' character
  // knowledge, and Genshin is what this group actually generates.
  //
  // The scene deliberately matches none of the six worked examples — no rain,
  // no rooftop, no night, no market, no battlefield, no storm. A brief that
  // rhymes with an example measures the example.
  {
    id: 'zhongli',
    text:
      'Zhongli from Genshin Impact sitting alone in a teahouse at midday, ' +
      'pouring tea, sunlight through paper screens, ledgers and a jade seal ' +
      'on the low table',
    character: 'zhongli',
  },
  {
    id: 'makima',
    text:
      'Makima from Chainsaw Man on a rain-slick Tokyo rooftop at night, ' +
      'city lights below her, coat collar turned up against the wind',
    character: 'makima',
  },
];

// ── helpers ──────────────────────────────────────────────────
const words = (s) => (s.trim() ? s.trim().split(/\s+/).length : 0);
const commaItems = (s) => s.split(',').map((t) => t.trim()).filter(Boolean);
// A booru tag list is mostly short comma-separated items. Prose is not.
const looksLikeTagList = (s) => {
  const items = commaItems(s);
  if (items.length < 6) return false;
  const avg = items.reduce((a, t) => a + words(t), 0) / items.length;
  return avg <= 3.5;
};
const looksLikeProse = (s) => /[a-z]{3,}\s+[a-z]{3,}\s+[a-z]{3,}\s+[a-z]{3,}/i.test(s) && words(s) > 30;
const sentenceCount = (s) => (s.match(/[.!?](\s|$)/g) ?? []).length;

// ── prose-model vocabulary, added 27 Aug 2026 ──────────────────────────────
//
// krea2 and flux are two of the three models this group uses most, and krea2
// carried three assertions — prose, word floor, no underscores — none of which
// looked at whether it followed its own file. These do.
//
// Loose on purpose. There are a hundred correct ways to name a light source
// and the failure worth catching is naming none, so each pattern is a
// vocabulary check rather than a phrasing check.

// A light with somewhere to come from. "Warm lighting" fails this and should:
// krea2.md's line is that a direction is a real instruction and an adjective
// is not.
//
// ── Rewritten 28 Aug 2026, because the old one was failing correct output ──
//
// The owner's read of a failing row was "I have a feeling you're failing stuff
// that shouldn't be failed", and on this row he was right. The old pattern
// was a list of exact phrasings, and the obliterated 27B kept writing the
// thing in words the list did not contain. All three of these were marked
// FAIL, and all three name a source and say where the light goes:
//
//   "warm sunlight streams through white paper screens, casting soft
//    rectangular panels across the wooden floor and the back wall"
//   "soft daylight filtering through translucent paper screens"
//   "the light from the streets below washes up cold blue"
//
// The first two died on `through (a|the) \w+` — the article is not optional
// in English here, "through white paper screens" has none, and the pattern
// required one. The third died because `from (the )?(left|right|...)` is a
// closed list of directions and "the streets below" is not in it.
//
// So this is now a proximity test rather than a phrase list: a light SOURCE
// word, and within a short window of it, a word that says where the light
// comes from or goes. That is what the instruction in krea2.md actually asks
// for, and it is what a person reading the paragraph checks for.
//
// Still fails the thing it exists to fail. "Warm lighting", "good lighting",
// "cinematic lighting" and "dramatic light" carry a source word and no path,
// so they do not pass — see the selftest cases.
const LIGHT_SOURCE =
  /\b(sun ?light|day ?light|moon ?light|lamp ?light|candle ?light|street ?light|fire ?light|window light|key light|practical|lantern|sconce|bulb|neon|sun|moon|lamp|candle|torch|fire|window|screens?|skylight|lights?|lit|glow|beam|shaft|ray)\b/gi;

// Where it comes from, or where it lands. Deliberately broader than a compass:
// "through the screens" and "across the floor" are both directions in the only
// sense that matters to an image model.
const LIGHT_PATH =
  /\b(from|through|across|onto|into|behind|above|below|overhead|beneath|under|raking|back-?lit|backlighting|rim|side|left|right|top-?down|low|horizontal|angled|spill\w*|stream\w*|filter\w*|falls?|falling|washes?|catches|cast\w*|slant\w*|pour\w*)\b/i;

const namesLightAndDirection = (s) => {
  const text = String(s ?? '');
  LIGHT_SOURCE.lastIndex = 0;
  for (let m = LIGHT_SOURCE.exec(text); m; m = LIGHT_SOURCE.exec(text)) {
    // A window either side of the source word. Light is described in both
    // orders — "sunlight through the screens" and "through the screens, a
    // shaft of sun" — so both directions are searched.
    const from = Math.max(0, m.index - 40);
    if (LIGHT_PATH.test(text.slice(from, m.index + m[0].length + 60))) return true;
  }
  return false;
};

// A named material, as opposed to "metal" or "fabric".
const MATERIAL =
  /\b(brass|copper|steel|iron|bronze|canvas|linen|denim|leather|silk|satin|wool|velvet|cotton|oilskin|neoprene|rubber|plastic|glass|ceramic|porcelain|concrete|granite|marble|basalt|plaster|timber|oak|pine|lacquer|enamel|chrome|aluminium|aluminum|tweed|corduroy|suede|paper|bamboo|jade)\b/i;

// The thing Krea2 exists for. Skin and surface detail it will smooth away
// unless it is asked for.
const SKIN_TEXTURE =
  /\b(pores?|freckles?|blemish\w*|stubble|fine lines?|wrinkl\w+|scars?|sunburn|flyaway|stray hairs?|sweat|shine|texture|weathered|worn|chapped|calluse?d?|grain|scuff\w*|patina|frayed|pilled|creases?)\b/i;

// A negation in a model with no negative prompt asks for the thing it names.
//
// Keyed to nouns people actually try to exclude, NOT to the words "no" and
// "not" generally — those are ordinary prose. "the knee of her trailing leg
// not quite down" is a good sentence, and a pattern that flagged it would fail
// correct output and get switched off.
const NEGATION =
  /\b(no|without|free of|devoid of|lacking)\s+(?:any\s+|visible\s+|other\s+)*(people|person|humans?|figures?|text|words?|writing|letters|watermarks?|signature|logos?|shadows?|clutter|blur|distortion|artifacts?|background)\b/i;

// ── negative-prompt hygiene, added 26 Aug 2026 with the image prompt overhaul
//
// Two failures the old predicates never looked for, both caught by sampling
// illustrious by hand rather than by any assertion:
//
//   no_grease, no_goggles, without_goggles   — a negated term in the negative
//     cancels itself out. It asks the sampler to avoid the absence of grease,
//     which is a request for grease.
//   masterpiece, best_quality, highres       — emitted in the negative while
//     the quality preset had already put them in the positive.
//
// Both were invisible at 5/5 clean, because "negative uses underscored
// vocabulary" only ever checked that worst_quality was present.

// `bare` earns its place: bare_face and bare_hands both showed up as attempts
// to negate a covered face. It is a real danbooru prefix (bare_shoulders), so
// this is checked only in the NEGATIVE, where the intent is always absence.
const NEGATED_PREFIX = /^\(?\s*(no|not|non|without|bare|lack)[\s_-]/i;
const namesThingsNotAbsences = (n) => !commaItems(n).some((t) => NEGATED_PREFIX.test(t));

// Strip weights and parens so (steampunk:1.3) matches steampunk, and fold
// underscores to spaces so long_hair matches "long hair" across tag_styles.
const normTag = (t) =>
  t
    .trim()
    .toLowerCase()
    .replace(/^\(+|\)+$/g, '')
    .replace(/:\s*[\d.]+$/, '')
    .replace(/[_\s]+/g, ' ')
    .trim();

const noOverlap = (p, n) => {
  const pos = new Set(commaItems(p).map(normTag).filter(Boolean));
  return !commaItems(n).map(normTag).some((t) => t && pos.has(t));
};

// An unescaped `(...)` that is NOT a weight expression — which on Anima means
// a Danbooru disambiguator that should have been written `\(...\)`. The inner
// lookahead is what separates the two: `(chibi:2)` is syntax and legal,
// `(nier:automata)` is a series name and is not, and the only difference
// between them is whether what follows the colon is a number.
const UNESCAPED_DISAMBIGUATOR =
  /(?<!\\)\((?![^()]*:\s*\d+(?:\.\d+)?\s*\))[^()]{1,40}\)/;

// Anima's positive is a tag block followed by prose. Take everything up to the
// first comma-item that reads as a sentence — more than four words, or ending
// in a full stop — so the overlap check compares tags with tags.
const tagBlockOf = (p) => {
  const items = commaItems(p);
  const end = items.findIndex((t) => words(t) > 4 || /[.!?]$/.test(t));
  return (end === -1 ? items : items.slice(0, end)).join(', ');
};

const overlapping = (p, n) => {
  const pos = new Set(commaItems(p).map(normTag).filter(Boolean));
  return [...new Set(commaItems(n).map(normTag).filter((t) => t && pos.has(t)))];
};

/** Did the model pass the character's booru tag straight through? */
function hasCharacterTag(text, brief) {
  const t = text.toLowerCase();
  const c = brief.character;
  return t.includes(`${c}(`) || t.includes(`${c}_(`) || t.includes(`${c} (`);
}

/**
 * Did it expand the character into describable features instead?
 *
 * Deliberately does NOT check that the features are the *right* ones. The
 * first version required brief.feature — 'purple' for Fern, 'red' for Makima
 * — beside the word hair, and that measures whether the model knows the
 * character, not whether it obeys sdxl.md. qwen3:8b describes Makima with
 * "long black hair"; canon says red. That is a knowledge miss, and reporting
 * it as a dialect failure is worse than not testing it: it lands on the
 * unfamiliar brief, where it reads as the recall-versus-competence signal the
 * second brief was added to detect, and it is not one.
 *
 * The rule in sdxl.md is that a booru character tag is replaced by plain
 * descriptive phrases, so that is what this asserts — a hair descriptor plus
 * at least one other feature of face, body or clothing. The modifier before
 * "hair" must not be an article or a pronoun, or "her hair" alone would pass.
 */
// ── full-reference helpers ───────────────────────────────────
//
// All three read h3-reference-official.md, which is appended to the h3 system
// prompt, so what they assert and what the model was told come from one place.

// The four label forms the guide fixes in section 2. Returned normalised —
// "<Picture 1>" and "<picture 1>" are the same label, and a model that varies
// the case between sections is not introducing a new one.
const LABEL_RE = /<\s*(Subject|Picture|Video|Audio)\s*(\d+)\s*>/gi;
function labelsIn(text) {
  return [...String(text ?? '').matchAll(LABEL_RE)].map(
    (m) => `<${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}>`
  );
}

// Section 3's task-type table, verbatim. The guide combines them with " + ",
// so the prefix is one bracket containing one or more of these and nothing
// else — `[reference generation + audio reuse]`. An invented task type is the
// failure worth catching, which is why this checks the vocabulary rather than
// just the brackets.
const TASK_TYPES = [
  'keyframe completion',
  'reference generation',
  'video editing',
  'video continuation',
  'audio reuse',
  'audio reference',
];
function hasTaskTypePrefix(text) {
  const m = /^\s*[[]([^[\]]+)[\]]/.exec(String(text ?? ''));
  if (!m) return false;
  const parts = m[1].split('+').map((p) => p.trim().toLowerCase());
  return parts.length > 0 && parts.every((p) => TASK_TYPES.includes(p));
}

// Section 4's relationship markers, "fixed English values in the output
// format" — 4.1 for visible content, 4.2 for audio. Prose describing the
// relationship instead of naming one of these is the common miss.
const RETENTION_MARKERS = [
  'fully_preserved',
  'partially_preserved',
  'attribute_transfer',
  'weak_reference',
  'fully_copy',
  'partially_copy',
  'reference',
];
function hasRetentionMarker(text) {
  const t = String(text ?? '');
  // `reference` is a real marker but also an ordinary English word, so it only
  // counts in the position the guide puts it: `<Audio 2>: reference - ...`.
  return (
    RETENTION_MARKERS.filter((m) => m !== 'reference').some((m) =>
      new RegExp(`(?:^|[^a-z_])${m}(?![a-z_])`, 'i').test(t)
    ) || /:\s*reference\s*[-—]/i.test(t)
  );
}

function hasFeature(text) {
  const t = text.toLowerCase();
  const hair =
    /\b(?!(?:the|her|his|their|its|an?|and|with|of)\b)[a-z]+(?:-[a-z]+)?\s+hair\b/.test(t) ||
    /\bhair\s+(?:in|tied|pulled|braided|swept|falling)\b/.test(t);
  const other =
    /\b(?:eyes?|skin|face|facial|jaw|jawline|cheeks?|coat|jacket|dress|shirt|blouse|uniform|outfit|clothing|expression|build|figure|posture|gloves|collar)\b/.test(
      t
    );
  return hair && other;
}

async function generate(model, controls = {}, brief) {
  const res = await fetch(`${BASE}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, brief: brief.text, controls }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let done = null;
  let error = null;

  for (;;) {
    const { done: fin, value } = await reader.read();
    if (fin) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (.+)$/m.exec(frame);
      const da = /^data: (.+)$/m.exec(frame);
      if (!ev || !da) continue;
      if (ev[1] === 'done') done = JSON.parse(da[1]);
      if (ev[1] === 'error') error = JSON.parse(da[1]);
    }
  }
  if (error) throw new Error(`${error.code}: ${error.message}`);
  if (!done) throw new Error('stream ended with no done event');

  const seg = {};
  for (const s of done.segments) seg[s.label] = s.body;
  return { segments: done.segments, seg, raw: done };
}

// ── the checks, grounded in each prompt file ─────────────────
// Per-model controls. Only h3 needs any: it has two official output formats
// and picks between them by mode, so leaving this to "Auto detect" would make
// which contract is under test depend on the model's own inference.
const CONTROLS = {
  // ── The quality preset is not optional here, and leaving it out was a bug ──
  //
  // Found 28 Aug 2026 on the obliterated 27B, and it had been reporting good
  // output as broken for a day. This suite sent no `quality_preset` at all,
  // which is not what a user does — the UI always sends one, and since 27 Aug
  // the registry default is `none`, meaning "add no quality tags of your own".
  //
  // illustrious.md is explicit: "Use exactly what the user's quality preset
  // supplies. The registry provides them; do not substitute your own." So a
  // model given no preset and emitting no quality tags is obeying its file
  // exactly, and `carries its own quality vocabulary` failed it for that. The
  // 27B was marked down three runs out of six for being right, and the 8B and
  // 9B "passed" the row by inventing a ladder the file forbids them to invent.
  //
  // The row is worth keeping — a preset that is handed over and then ignored
  // is a real failure, and it is the whole of the 27 Aug "the registry copy is
  // authoritative" change. So the preset is now SENT, by its registry key, and
  // the assertion means "used the ladder it was given" instead of "invented
  // one". Keys are the ones in config/models.yaml; `masterpiece` is the
  // fullest of them and therefore the strictest thing to check for.
  illustrious: { quality_preset: 'masterpiece' },
  anima: { quality_preset: 'masterpiece' },
  sdxl: { quality_preset: 'masterpiece' },
  // pony is deliberately absent. Its preset IS the score ladder, its registry
  // default was never moved to `none` for that reason, and pony.md calls the
  // ladder mandatory regardless — so the score assertions there are testing
  // the file, not the preset plumbing.
  //
  // krea2 and flux are absent because neither has a quality assertion: both
  // files say to strip quality words outright, which is the opposite claim and
  // is already covered by their own rows.
  h3: { mode: 'T2VA' },
  // Full reference is the mode the owner actually uses ("the workflow mainly
  // used is just ref2va and fl2va", 21 Aug) and the only one that exercises the
  // six-section structure in the official reference guide. It ran with no
  // coverage at all until now.
  //
  // No image is involved: references reach the LLM as text, formatted by
  // buildUserMessage() as `<Picture N> role: ... keep: ... drop: ...`, so
  // synthetic entries produce genuine six-section output. What this cannot
  // cover is whether the picture actually looks like what the role claims —
  // that needs a render, and it is shelved.
  //
  // A function because the reference has to be about the brief. A generic
  // "<Picture 1> role: character reference" against the Makima brief would let
  // the model pass the label checks without ever tying a label to a subject.
  h3_ref2va: (brief) => ({
    mode: 'REF2VA',
    references:
      brief.id === 'zhongli'
        ? [
            // Roles come from `reference_roles` in config/models.yaml, so this
            // exercises the same role-to-label mapping the app ships —
            // server/references.mjs. Inventing role names here would test a
            // shape no user can produce.
            {
              role: 'subject',
              keep: 'face, hair colour and length, general build',
              drop: 'his original outfit, the background',
            },
            {
              role: 'keyframe',
              keep: 'the teahouse interior and the light through the screens as the opening frame',
              drop: 'any people in it',
            },
          ]
        : [
            { role: 'subject', keep: 'face, hair, the coat', drop: 'the daylight setting' },
            {
              role: 'style',
              keep: 'the wet-neon colour grade and shallow depth of field',
              drop: 'its subject entirely',
            },
            // Structure only. This is the role that used to be labelled
            // <Picture N>, which is the label the Director reserves for frame
            // anchors — so before 21 Aug this pass could not have caught it.
            { role: 'motion', keep: 'the cut rhythm and handheld drift', drop: 'its subject' },
          ],
  }),
};

// Pseudo-keys: an entry in CHECKS that is a second pass over a model already
// in the registry, not a model of its own. Keeps `--only h3_ref2va` working and
// keeps the two h3 modes reporting as separate rows, which is the point —
// base mode and full reference assert opposite things about the same segments.
const MODEL_OF = {
  h3_ref2va: 'h3',
};

const controlsFor = (key, brief) => {
  const c = CONTROLS[key];
  return typeof c === 'function' ? c(brief) : c;
};

const CHECKS = {
  illustrious: ({ seg }) => {
    const p = seg['Positive prompt'] ?? '';
    return [
      ['emits a tag list, not prose', looksLikeTagList(p)],
      ['uses underscored tags (long_hair, not "long hair")', /\w+_\w+/.test(p)],
      ['carries its own quality vocabulary', /masterpiece|best_quality|absurdres/i.test(p)],
      ['does NOT leak the Pony score ladder', !/score_\d/i.test(p)],
      ['negative uses underscored vocabulary', /worst_quality|low_quality/i.test(seg['Negative prompt'] ?? '')],
      ['negative names things, not absences',
        namesThingsNotAbsences(seg['Negative prompt'] ?? '')],
      ['nothing appears in both prompts',
        noOverlap(p, seg['Negative prompt'] ?? ''),
        overlapping(p, seg['Negative prompt'] ?? '').join(', ')],
    ];
  },

  pony: ({ seg }) => {
    const p = seg['Positive prompt'] ?? '';
    const n = seg['Negative prompt'] ?? '';
    return [
      ['opens with the score ladder', /^\s*score_9\s*,\s*score_8_up\s*,\s*score_7_up/i.test(p)],
      ['includes exactly one source_ tag', (p.match(/source_\w+/gi) ?? []).length === 1],
      ['puts low scores in the negative', /score_6/.test(n) && /score_5/.test(n) && /score_4/.test(n)],
      ['strips Illustrious vocabulary', !/masterpiece|best_quality|absurdres/i.test(p)],
      // Count underscores only in *general* tags. Pony's required vocabulary
      // — the score ladder, source_* and rating_* — is underscored by
      // definition, so counting raw underscores marks correct output wrong.
      [
        'prefers spaces over underscores in general tags',
        (p
          .replace(/\b(score_\d(_up)?|source_\w+|rating_\w+)\b/gi, '')
          .match(/\w_\w/g) ?? []).length <= 2,
      ],
      ['negative names things, not absences', namesThingsNotAbsences(n)],
      ['nothing appears in both prompts', noOverlap(p, n), overlapping(p, n).join(', ')],
    ];
  },

  // Takes the brief: two of its assertions are keyed to the character in it.
  sdxl: ({ seg }, brief) => {
    const p = seg['Positive prompt'] ?? '';
    return [
      // Keyed off the brief rather than hardcoded to Fern. Written with
      // includes() rather than a regex: the pattern needs an escaped paren,
      // and a mangled escape here would silently pass everything.
      ['does NOT pass the character tag through', !hasCharacterTag(p, brief)],
      // Not keyed off the brief: this one asks whether the tag became plain
      // description, not whether the description is canon-accurate.
      ['expands the character into features', hasFeature(p)],
      ['uses comma-separated phrases', commaItems(p).length >= 5],
      ['no danbooru underscore syntax', (p.match(/\w_\w/g) ?? []).length <= 2],
      ['negative names things, not absences',
        namesThingsNotAbsences(seg['Negative prompt'] ?? '')],
      ['nothing appears in both prompts',
        noOverlap(p, seg['Negative prompt'] ?? ''),
        overlapping(p, seg['Negative prompt'] ?? '').join(', ')],
    ];
  },

  anima: ({ seg }) => {
    const p = seg['Positive prompt'] ?? '';
    return [
      ['carries Anima-specific vocabulary (score_7 / newest)', /score_\d|newest|year \d{4}/i.test(p)],
      // Two sentences is Anima's own stated floor, not a target — see the
      // "Length" section of anima.md. One sentence was the old assertion and
      // it passed the thin prose blocks this overhaul exists to fix.
      ['mixes a tag block with prose', commaItems(p).length >= 6 && sentenceCount(p) >= 2],
      ['prose block is present, not tags only', looksLikeProse(p)],
      // Anima DOES read weights — that reversed on 27 Aug 2026, from
      // A user's build and the model author's own `(chibi:2)`. So the
      // assertion is no longer "none" but "not SDXL habits": anima.md says
      // start unweighted, and when a weight is worth writing, write it at 2
      // or above, once.
      //
      // Note the old regex could not have caught the reversal either way:
      // `\d?\.\d+` requires a decimal point, so `(chibi:2)` slipped straight
      // through the rule that was supposed to forbid it.
      ['weights are sparse and strong, not CLIP-timid', (() => {
        const found = [...p.matchAll(/\(\s*[^()]{1,60}:\s*(\d+(?:\.\d+)?)\s*\)/g)]
          .map((m) => Number(m[1]));
        return found.length <= 2 && found.every((w) => w >= 2);
      })(),
        [...p.matchAll(/\(\s*[^()]{1,60}:\s*(\d+(?:\.\d+)?)\s*\)/g)].map((m) => m[0]).join(' ')],
      // Literal disambiguators must be escaped, because unescaped parentheses
      // are weighting syntax on this model. `nier:automata` inside an escaped
      // pair is fine; `2b (nier:automata)` is a weight expression that lost
      // its number, and the series goes with it.
      ['escapes literal tag disambiguators', !UNESCAPED_DISAMBIGUATOR.test(tagBlockOf(p)),
        tagBlockOf(p)],
      // The Danbooru four are not this model's vocabulary: it uses
      // safe / sensitive / nsfw / explicit.
      ['does not use the questionable rating tag', !/\bquestionable\b/i.test(p)],
      ['negative names things, not absences',
        namesThingsNotAbsences(seg['Negative prompt'] ?? '')],
      // Anima's positive carries a prose block, so the overlap check would
      // trip on ordinary sentence commas. Compare against the tag block only —
      // everything up to the first item that reads as a sentence.
      ['nothing appears in both prompts',
        noOverlap(tagBlockOf(p), seg['Negative prompt'] ?? ''),
        overlapping(tagBlockOf(p), seg['Negative prompt'] ?? '').join(', ')],
    ];
  },

  krea2: ({ seg }) => {
    const p = seg['Enhanced prompt'] ?? '';
    return [
      ['is prose, not tags', looksLikeProse(p) && !looksLikeTagList(p)],
      // Floor only. The upper bound came off on 26 Aug 2026 with the image
      // prompt overhaul: these are Flux-family models that follow long prompts
      // accurately, the ceiling was capping the thing they are best at, and the
      // manual length field is the real override. See krea2.md "Length".
      ['clears its 80-word floor', words(p) >= 80, `${words(p)} words`],
      ['emits no booru underscore tags', (p.match(/\w_\w/g) ?? []).length === 0],
      // Three assertions was the thinnest coverage of any image model here,
      // and krea2 is one of the three this group actually uses. What follows
      // checks the instructions krea2.md spends its length on, rather than
      // only that the output is prose of roughly the right size.
      //
      // Each is deliberately loose — a vocabulary check, not a phrasing check.
      // A prompt can name a light source a hundred ways and all of them are
      // correct; what is wrong is naming none.
      ['names a light source and its direction', namesLightAndDirection(p)],
      ['names a material rather than a category', MATERIAL.test(p)],
      // The point of Krea2 over plain Flux: it was built to avoid the waxy
      // airbrushed look, and krea2.md says to ask for at least one real
      // imperfection on any photoreal brief with a person in it. Left unasked,
      // the model smooths the face and the model's whole advantage is lost.
      ['asks for real skin or surface texture', SKIN_TEXTURE.test(p)],
      ['never negates, having no negative prompt to do it in', !NEGATION.test(p)],
    ];
  },

  flux: ({ seg }) => {
    const p = seg['Enhanced prompt'] ?? '';
    return [
      ['is prose, not tags', looksLikeProse(p) && !looksLikeTagList(p)],
      // Floor only — same reasoning as krea2 above.
      ['clears its 80-word floor', words(p) >= 80, `${words(p)} words`],
      // Flux ignores (phrase:1.3) entirely, so flux.md forbids emitting it.
      ['emits no weight syntax', !/\(\s*[^()]{1,60}:\s*\d?\.\d+\s*\)/.test(p)],
      // flux.md's core instruction: trade style adjectives for camera facts.
      ['names photographic specifics (mm / f-stop / light direction)',
        /\d{2}\s?mm|f\/\d|aperture|focal|key light|backlit|from the (left|right)/i.test(p)],
    ];
  },

  // Run in T2VA, so this also covers the base-format contract. H3 has two
  // official output shapes and the base one has no subject or retention
  // sections — emitting them there is the failure this guards against.
  h3: ({ seg, segments }) => {
    const total = segments.map((s) => s.body).join('').length;
    const desc = seg['Detailed description'] ?? '';
    const na = (s) => /^n\/a$/i.test((s ?? '').trim());
    // Base mode's contract is three segments since 10 Sep 2026, plus Reasoning
    // when the account has it switched on. The three REF2VA-only sections are
    // no longer asked for, so the old "leaves them N/A" checks became this.
    const labels = segments.map((s) => s.label).filter((l) => l !== 'Reasoning');
    const BASE = ['Detailed description', 'Soundscape', 'Music'];
    return [
      ['base-mode contract: exactly the three core fields', labels.join('|') === BASE.join('|'),
        labels.join(', ')],
      ['under the 7,000 character limit', total <= 7000, `${total} chars`],
      ['uses [Shot N] structure', /\[Shot\s*\d/i.test(desc)],
      // The first shot has no timestamp — base guide 4.2, and the Director's
      // own docs. SKILL.md taught a range on every shot until 10 Sep 2026.
      ['[Shot 1] carries no timestamp', !/\[Shot\s*1\]\s*(At\s+)?\d{1,2}:\d{2}/i.test(desc)],
      // Only when there is a cut to timestamp. The Director's documentation:
      // "[Shot 1] starts without a timestamp. Later shots begin at cut times
      // in MM:SS.mmm. Use timestamps for actual cuts or important transitions,
      // not every sentence." A single-shot prompt therefore carries none, and
      // the bare regex this used to be failed every correct one — measured
      // 4/12 and reported as a defect until a real generation showed it was
      // the test. Note SKILL.md asks for a range on every shot including the
      // first, which is not what the consuming node documents; that
      // divergence is a prompts/ question and is logged, not settled here.
      (() => {
        const shots = (desc.match(/\[Shot\s*\d/gi) ?? []).length;
        return [
          'timecodes on multi-shot output',
          shots < 2 || /\d{2}:\d{2}/.test(desc),
          shots < 2 ? `${shots} shot, none needed` : `${shots} shots`,
        ];
      })(),
      // These three replace one assertion that was quietly dishonest. It was
      // named "soundscape and music are separate layers" but tested only that
      // both segments were non-empty — and `non_diegetic_music: N/A` is
      // non-empty. It stayed green through a measured 30-of-40 Music N/A rate,
      // which is the whole reason that defect went unnoticed for days.
      //
      // Each now tests what its name says. Soundscape stays strict: sound is
      // inherent to a scene, the base guide gates its N/A behind an explicit
      // request for silence, and it measures 2/40.
      //
      // Music no longer demands a score. That assertion was left here with a
      // note saying it should change if the owner decided an N/A score was
      // acceptable — decided 21 Aug, on house-rules grounds rather than
      // preference. house-rules.md says "Translate, don't invent" and "Don't
      // pad"; neither brief in this suite mentions music, so a score is
      // invention, and demanding one made the suite ask for the opposite of
      // what the product does. It measured a real 30% against a 22% "target"
      // taken from MiniMax's own examples — whose briefs are cinematic
      // scene-setting where a score is implied, so that was never a fair
      // target for arbitrary user briefs.
      //
      // What is still worth catching is a malformed score, so this checks the
      // field is well-formed — N/A or real prose — rather than absent or
      // stray. A brief that does ask for music has no coverage here; adding
      // it means a third brief and the GPU time that costs.
      ['soundscape is a real description, not N/A', !na(seg['Soundscape']),
        (seg['Soundscape'] ?? '').slice(0, 40)],
      ['music is N/A or a real score, not empty', (() => {
        const m = (seg['Music'] ?? '').trim();
        return na(m) || m.length >= 15;
      })(), (seg['Music'] ?? '').slice(0, 40)],
      // The actual "separate layers" check: H3 degrades when diegetic sound
      // and score are merged. Nothing to compare if either is N/A.
      ['soundscape and music are not the same text',
        na(seg['Soundscape']) || na(seg['Music']) ||
          seg['Soundscape'].trim() !== seg['Music'].trim()],
      // Summary used to be asserted non-N/A here, on the reasoning that it is
      // ours rather than an H3 field and always has something to say. Dropped
      // 21 Aug against the Director node's own documentation — the thing that
      // actually consumes this prompt — which says Summary "is not a field in
      // FL2VA/I2VA/L2VA/T2VA. It appears only in REF2VA."
      //
      // This suite runs T2VA, so the model writing N/A was correct and the
      // assertion was scoring it wrong. SKILL.md does list Summary as a
      // segment for every mode, so the model can defensibly go either way and
      // there is nothing honest left to assert in base mode. Real coverage
      // needs a REF2VA pass, where Summary is a genuine field — see the
      // open thread in HANDOFF.md.
    ];
  },

  // Full-reference mode. Every assertion here is grounded in
  // prompts/video/h3/references/h3-reference-official.md, which is the guide
  // the app actually appends for this model — sections cited per check.
  //
  // Note what inverts against base mode: `Subject definitions` and `Retention
  // analysis` must be FILLED here, and `Summary` is a genuine field rather than
  // the ambiguous one it is in T2VA. Anyone tempted to "align" the two h3
  // entries should read both before touching either.
  h3_ref2va: ({ seg, segments }) => {
    const total = segments.map((s) => s.body).join('').length;
    const na = (s) => /^n\/a$/i.test((s ?? '').trim());
    const subjects = seg['Subject definitions'] ?? '';
    const summary = seg['Summary'] ?? '';
    const retention = seg['Retention analysis'] ?? '';
    const desc = seg['Detailed description'] ?? '';

    const defined = new Set(labelsIn(subjects));
    const strayInSummary = labelsIn(summary).filter((l) => !defined.has(l));

    return [
      ['all seven segments present', segments.length === 7, `${segments.length}/7`],
      ['under the 7,000 character limit', total <= 7000, `${total} chars`],
      // Guide section 1: the six-section structure. These two are N/A in base
      // mode and the base-mode checks assert exactly that, so a model that
      // ignores Mode fails here rather than passing both ways.
      ['full reference fills Subject definitions', !na(subjects) && subjects.trim().length > 20,
        subjects.slice(0, 40)],
      ['full reference fills Retention analysis', !na(retention) && retention.trim().length > 20,
        retention.slice(0, 40)],
      ['full reference fills Summary', !na(summary) && summary.trim().length > 20,
        summary.slice(0, 40)],
      // Guide section 2: every referenced item gets a label, and the labels are
      // the fixed <Subject N> / <Picture N> / <Video N> / <Audio N> forms.
      ['subject definitions assign reference labels', defined.size > 0,
        `${defined.size} labels`],
      // Guide section 3: "It begins with a square-bracketed task-type prefix",
      // chosen from a fixed table and combined with " + ".
      ['summary opens with a task-type prefix', hasTaskTypePrefix(summary),
        summary.slice(0, 40)],
      // Guide section 3: "Do not introduce new reference labels in this
      // section." A label in the summary that subject_definitions never defined
      // is the specific failure that makes the downstream node's label
      // resolution meaningless.
      ['summary introduces no undefined label', strayInSummary.length === 0,
        strayInSummary.join(', ')],
      // Guide section 4: the relationship markers are "fixed English values in
      // the output format". Prose describing the relationship instead of naming
      // one is the common miss.
      ['retention analysis uses a fixed relationship marker', hasRetentionMarker(retention),
        retention.slice(0, 40)],
      // Section 5 keeps the shot structure from base mode.
      ['uses [Shot N] structure', /\[Shot\s*\d/i.test(desc)],
      // Section 6 is the same two audio layers as base mode, so these three
      // match the base-mode checks deliberately rather than by accident.
      ['soundscape is a real description, not N/A', !na(seg['Soundscape']),
        (seg['Soundscape'] ?? '').slice(0, 40)],
      ['music is N/A or a real score, not empty', (() => {
        const m = (seg['Music'] ?? '').trim();
        return na(m) || m.length >= 15;
      })(), (seg['Music'] ?? '').slice(0, 40)],
      ['soundscape and music are not the same text',
        na(seg['Soundscape']) || na(seg['Music']) ||
          seg['Soundscape'].trim() !== seg['Music'].trim()],
    ];
  },

  wan: ({ seg }) => {
    const p = seg['Positive prompt'] ?? '';
    const lb = seg['Layer breakdown'] ?? '';
    return [
      ['within its 80-120 word band', words(p) >= 80 && words(p) <= 120, `${words(p)} words`],
      ['is one paragraph of prose', looksLikeProse(p)],
      ['layer breakdown names all four layers',
        /subject/i.test(lb) && /motion/i.test(lb) && /camera/i.test(lb) && /scene/i.test(lb)],
      ['negative targets Wan artifacts', /morph|warp|flicker/i.test(seg['Negative prompt'] ?? '')],
    ];
  },

  ltx: ({ seg }) => {
    const p = seg['Enhanced paragraph'] ?? '';
    // The strictest formatting requirement in the app, and the one most
    // likely to break first under quantization.
    return [
      ['is ONE unbroken paragraph (no newlines)', !/\n/.test(p.trim())],
      ['no bullets or list markers', !/^\s*[-*•]|\n\s*[-*•]/.test(p)],
      ['no numbered shots', !/\[?shot\s*\d/i.test(p)],
      // Lightricks' guide, 20 Oct 2026: establish the shot first, 4 to 8
      // sentences, within 200 words.
      ['avoids its forbidden word (cut)', !/\bcut\b/i.test(p)],
      ['establishes the shot', /\bshot\b/i.test(p)],
      ['4 to 8 sentences', sentenceCount(p) >= 4 && sentenceCount(p) <= 8, `${sentenceCount(p)} sentences`],
      ['within its 80-160 word band', words(p) >= 80 && words(p) <= 160, `${words(p)} words`],
    ];
  },

  cog: ({ seg }) => {
    const p = seg['Enhanced prompt'] ?? '';
    return [
      ['within its 50-100 word band', words(p) >= 50 && words(p) <= 100, `${words(p)} words`],
      ['is prose, not tags', looksLikeProse(p) && !looksLikeTagList(p)],
      ['no booru underscore tags', (p.match(/\w_\w/g) ?? []).length === 0],
    ];
  },
};

// ── cross-model: the one job ─────────────────────────────────
function crossModelChecks(results) {
  const out = [];
  const pos = (k) => results[k]?.seg?.['Positive prompt'] ?? '';
  const trio = ['illustrious', 'pony', 'sdxl'].map(pos);
  out.push([
    'the three booru models produced three different outputs',
    trio.every(Boolean) && new Set(trio).size === 3,
  ]);
  out.push([
    'illustrious and pony do not share a quality vocabulary',
    Boolean(pos('illustrious')) &&
      Boolean(pos('pony')) &&
      /masterpiece/i.test(pos('illustrious')) &&
      /score_9/i.test(pos('pony')),
  ]);
  return out;
}

// ── selftest: the pure helpers, no server ────────────────────
//
// Every case here is a real shape seen in a logged run. hasFeature is the
// one that earned this: its first version required the character's canon
// hair colour, so it measured whether the model knows Makima rather than
// whether it obeys sdxl.md, and it failed on the unfamiliar brief for the
// wrong reason — the one place a false signal was most expensive.
if (SELFTEST) {
  const cases = [
    [
      hasFeature,
      true,
      'a tall young woman with long black hair in a high ponytail, sharp angular features, wearing a dark trench coat',
    ],
    [hasFeature, true, 'short silver hair, piercing eyes, standing in the rain'],
    [hasFeature, true, 'her hair tied back, a dark uniform, calm expression'],
    [hasFeature, true, 'red-orange hair, yellow eyes with ringed pupils'],
    // Canon-blind on purpose: the wrong hair colour is still a description.
    [hasFeature, true, 'long green hair, freckled face, oversized coat'],
    [hasFeature, false, 'makima_(chainsaw_man), chainsaw_man, 1girl, solo, night, rain, city_lights'],
    // "her hair" alone is not a description of the hair.
    [hasFeature, false, 'she stands on a rooftop, her hair blowing in the wind, the city below'],
    [hasFeature, false, 'a rain-slick rooftop at night, neon signs reflected in puddles'],
    [
      (t) => hasCharacterTag(t, { character: 'makima' }),
      true,
      'masterpiece, makima_(chainsaw_man), 1girl, solo',
    ],
    [(t) => hasCharacterTag(t, { character: 'makima' }), true, 'score_9, makima (chainsaw man), 1girl'],
    [(t) => hasCharacterTag(t, { character: 'makima' }), false, 'a woman with long black hair on a rooftop'],
    // Naming her in prose is not passing a booru tag through. This is the case
    // that separates the two, and without it a predicate that just looks for
    // the name passes the selftest while marking every prose model wrong.
    [
      (t) => hasCharacterTag(t, { character: 'makima' }),
      false,
      'Makima stands on a rain-slick Tokyo rooftop at night, her coat collar turned up',
    ],
    [(t) => hasCharacterTag(t, { character: 'fern' }), true, 'fern_(sousou_no_frieren), 1girl'],
    // Prose-model vocabulary, added 27 Aug 2026 with krea2's extra assertions.
    // The point of each pair is the near miss: an adjective where the file
    // asks for a fact.
    [namesLightAndDirection, true, 'low sun raking in from the left across the stall'],
    [namesLightAndDirection, true, 'lit from behind, rim light along her shoulder'],
    [namesLightAndDirection, true, 'cool daylight through a high window'],
    // Verbatim from the obliterated 27B, 28 Aug 2026. Every one of these was
    // marked FAIL by the phrase-list version, and every one of them names a
    // source and says where the light goes. They are the reason this predicate
    // was rewritten, so they are the cases that hold it in place.
    [namesLightAndDirection, true,
      'warm sunlight streams through white paper screens, casting soft rectangular panels across the wooden floor'],
    [namesLightAndDirection, true,
      'The room is dimly lit by soft daylight filtering through translucent paper screens'],
    [namesLightAndDirection, true,
      'the light from the streets below washes up cold blue against the deep shadows'],
    [namesLightAndDirection, true,
      'warm midday sunlight filters through translucent paper screens, casting soft horizontal bands of light across the room'],
    // "Warm lighting" is the exact phrase krea2.md calls not-an-instruction.
    [namesLightAndDirection, false, 'warm lighting, soft glow, beautiful atmosphere'],
    // The adjectives krea2.md exists to refuse. A source word with nothing
    // saying where it comes from is exactly the thing that must still fail,
    // and widening the predicate must not have cost that.
    [namesLightAndDirection, false, 'cinematic lighting, dramatic light, moody atmosphere'],
    [namesLightAndDirection, false, 'good lighting and a beautiful sunset sky'],
    [(t) => MATERIAL.test(t), true, 'a brass and copper workbench, oil-stained canvas overalls'],
    [(t) => MATERIAL.test(t), false, 'a metal workbench and some fabric clothing'],
    [(t) => SKIN_TEXTURE.test(t), true, 'deeply lined face, broken capillaries, pilled wool cuffs'],
    [(t) => SKIN_TEXTURE.test(t), true, 'salt crust drying white along the weathered rail'],
    [(t) => SKIN_TEXTURE.test(t), false, 'a beautiful woman with perfect flawless features'],
    // A negation of a thing people actually try to exclude.
    [(t) => NEGATION.test(t), true, 'a clean wall with no text and without any watermark'],
    [(t) => NEGATION.test(t), true, 'an empty street, no people in the background'],
    // ORDINARY PROSE that a naive rule flags. This is the case that keeps the
    // negation check from failing correct output: "not" and "no" are normal
    // English and only matter in front of something being excluded.
    [(t) => NEGATION.test(t), false, 'the knee of her trailing leg not quite down, weight still travelling forward'],
    [(t) => NEGATION.test(t), false, 'she is no longer looking at the camera'],
    [looksLikeTagList, true, '1girl, solo, long_hair, night, rain, city_lights, coat'],
    [looksLikeTagList, false, 'A young woman stands on a rain-slick rooftop at night, her coat collar turned up against the wind.'],
    // Full-reference helpers. Same rule as the rest of this list: every string
    // is a shape the guide itself prints, or a near miss worth telling apart.
    [
      (t) => labelsIn(t).join(' ') === '<Subject 1> <Picture 1> <Picture 2>',
      true,
      '<Subject 1>: the mechanic, from <Picture 1>. <Picture 2>: the workshop.',
    ],
    // Case varies between sections in real output; the same label written two
    // ways is not two labels, and treating it as one is what makes the
    // "no undefined label in summary" check mean anything.
    [(t) => labelsIn(t)[0] === '<Picture 1>', true, 'defined in <picture 1> above'],
    [(t) => labelsIn(t).length === 0, true, 'no labels here, just prose about a picture'],
    [hasTaskTypePrefix, true, '[reference generation] the target video follows <Subject 1>.'],
    [hasTaskTypePrefix, true, '[video continuation + keyframe completion] the shot resumes.'],
    // An invented task type is the failure worth catching — the brackets alone
    // would pass a check that only looked for them.
    [hasTaskTypePrefix, false, '[cinematic montage] the target video opens on a rooftop.'],
    [hasTaskTypePrefix, false, 'The target video follows <Subject 1> across three shots.'],
    [hasRetentionMarker, true, '<Subject 1> (appears in [Shot 1], [Shot 3]): fully_preserved - her face and build.'],
    [hasRetentionMarker, true, '<Video 1> (cut and pacing structure): weak_reference - broad rhythm only.'],
    [hasRetentionMarker, true, '<Audio 2>: reference - the speaker follows its timbre.'],
    // Describing the relationship in prose instead of naming a marker. This is
    // the miss the assertion exists for, so it has to read as a failure here.
    [hasRetentionMarker, false, '<Picture 1> is preserved throughout the target video, with its lighting referenced loosely.'],
  ];

  let failed = 0;
  for (const [fn, want, text] of cases) {
    const got = Boolean(fn(text));
    if (got !== want) {
      failed += 1;
      console.log(`  FAIL want ${want}, got ${got} — ${text.slice(0, 70)}`);
    }
  }
  // "ALL PASSED (n)" is the shape check.mjs reads a count out of.
  console.log(
    failed ? `\n${failed} of ${cases.length} helper cases failed` : `ALL PASSED (${cases.length})`
  );
  process.exit(failed ? 1 : 0);
}

// ── run ──────────────────────────────────────────────────────
if (ONLY) {
  const unknown = ONLY.filter((k) => !(k in CHECKS));
  if (unknown.length) {
    console.error(`--only names models with no checks: ${unknown.join(', ')}`);
    console.error(`known: ${Object.keys(CHECKS).join(', ')}`);
    process.exit(2);
  }
}
// Print what the model wrote, not just the verdict on it. --show prints every
// run; --show-fails prints only the runs that lost an assertion.
const SHOW = process.argv.includes('--show');
const SHOW_FAILS = process.argv.includes('--show-fails');

const MODEL_KEYS = Object.keys(CHECKS).filter((k) => !ONLY || ONLY.includes(k));

const status = await fetch(`${BASE}/api/status`).then((r) => r.json());
console.log(`\nDialect check — ${BASE}`);
console.log(`backend: ${status.llm?.backend}${status.llm?.model ? ` · ${status.llm.model}` : ''}`);
console.log(ONLY ? `only: ${MODEL_KEYS.join(', ')}\n` : '');

const results = {};
const summary = [];

for (const key of MODEL_KEYS) {
  process.stdout.write(`${key} … `);

  const tally = new Map();   // label -> { held, detail, byBrief }
  let generated = 0;
  let lastRes = null;
  let firstError = null;

  for (const brief of BRIEFS) {
    for (let run = 0; run < RUNS; run++) {
      let res;
      try {
        res = await generate(MODEL_OF[key] ?? key, controlsFor(key, brief), brief);
      } catch (err) {
        firstError ??= err.message;
        continue;
      }
      generated += 1;
      lastRes = res;
      results[key] = res;

      // `--show` prints what the model actually wrote, in full, next to the
      // verdict on it.
      //
      // Added 28 Aug 2026 because the owner's read of a failing row was "I
      // have a feeling you're failing stuff that shouldn't be failed", and
      // that is not answerable from a 150-character preview. Every assertion
      // here is a regex over prose; a regex that is too narrow reports a good
      // prompt as a failure, and the only way to tell those apart is to read
      // the prompt. `--show-fails` narrows it to the runs that lost an
      // assertion, which is usually the whole question.
      if (SHOW || SHOW_FAILS) {
        const verdicts = CHECKS[key](res, brief);
        const lost = verdicts.filter(([, ok]) => !ok);
        if (SHOW || lost.length) {
          console.log(`\n\n  ┌─ ${key} · ${brief.id} · run ${run + 1}`);
          for (const s of res.segments) {
            console.log(`  │ ===SEGMENT: ${s.label}===`);
            for (const line of String(s.body).split('\n')) console.log(`  │ ${line}`);
          }
          console.log('  ├─ assertions');
          for (const [label, ok, detail] of verdicts) {
            console.log(`  │ ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? ` · ${detail}` : ''}`);
          }
          console.log('  └─');
        }
      }

      for (const [label, ok, detail] of CHECKS[key](res, brief)) {
        const t = tally.get(label) ?? { held: 0, detail: null, byBrief: new Map() };
        if (ok) t.held += 1;
        // The last failing detail, for the concrete number — "68 words".
        else t.detail = detail ?? null;
        // Held per brief, because a total alone cannot answer the question the
        // second brief was added to ask. 3/6 might be "passed the familiar
        // scenario, failed the unfamiliar one" or it might be noise, and those
        // want different responses. Keeping only the last failing brief's name
        // made that a guess; this makes it a reading.
        const b = t.byBrief.get(brief.id) ?? { held: 0, total: 0 };
        b.total += 1;
        if (ok) b.held += 1;
        t.byBrief.set(brief.id, b);
        tally.set(label, t);
      }
    }
  }

  if (generated === 0) {
    console.log('GENERATION FAILED');
    console.log(`     ${firstError}\n`);
    summary.push({ key, passed: 0, total: 0, failed: ['generation failed'], flaky: [] });
    continue;
  }

  const rows = [...tally.entries()];
  const solid = rows.filter(([, t]) => t.held === generated);
  const dead = rows.filter(([, t]) => t.held === 0);
  const flaky = rows.filter(([, t]) => t.held > 0 && t.held < generated);

  // "fern 3/3, makima 0/3" — printed only on rows that did not hold, since on
  // a clean row it is the same number twice and adds nothing but width.
  const split = (t) =>
    [...t.byBrief.entries()].map(([id, b]) => `${id} ${b.held}/${b.total}`).join(', ');

  console.log(`${solid.length}/${rows.length}${RUNS > 1 ? ` over ${generated} run${generated > 1 ? 's' : ''}` : ''}`);
  for (const [label, t] of rows) {
    const mark = t.held === generated ? 'ok  ' : t.held === 0 ? 'FAIL' : 'FLAKY';
    const count = RUNS > 1 ? ` [${t.held}/${generated}]` : '';
    const why =
      t.held === generated
        ? ''
        : ` — ${split(t)}${t.detail ? ` · ${t.detail}` : ''}`;
    console.log(`     ${mark} ${label}${count}${why}`);
  }
  const first = lastRes.segments[0];
  console.log(`     ── ${first.label}: ${first.body.replace(/\s+/g, ' ').slice(0, 150)}…`);
  console.log();

  summary.push({
    key,
    passed: solid.length,
    total: rows.length,
    failed: dead.map(([l]) => l),
    flaky: flaky.map(([l, t]) => `${l} [held ${t.held}/${generated}: ${split(t)}]`),
    failedSplit: Object.fromEntries(dead.map(([l, t]) => [l, split(t)])),
  });
}

// Cross-model compares models against each other, so a filtered run cannot
// answer it. Skipped rather than failed — a false FAIL here would look like
// the project's one job breaking.
if (ONLY) {
  console.log('cross-model\n     SKIP — needs the full set, and --only was used');
} else {
  console.log('cross-model');
  for (const [label, ok] of crossModelChecks(results)) {
    console.log(`     ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  }
}

console.log('\n── per-model verdict ─────────────────────────────');
let anyFailed = false;
for (const s of summary) {
  const broken = s.failed.length;
  const wobbly = s.flaky?.length ?? 0;
  const verdict =
    broken === 0 && wobbly === 0
      ? 'clean'
      : broken > 0
        ? `DEGRADED (${broken} failing${wobbly ? `, ${wobbly} flaky` : ''})`
        : `FLAKY (${wobbly} inconsistent)`;
  if (broken > 0 || wobbly > 0) anyFailed = true;
  console.log(`  ${s.key.padEnd(13)} ${String(s.passed).padStart(2)}/${s.total}  ${verdict}`);
  for (const f of s.failed) {
    const where = s.failedSplit?.[f];
    console.log(`  ${''.padEnd(13)}        - ${f}${where ? ` [${where}]` : ''}`);
  }
  for (const f of s.flaky ?? []) console.log(`  ${''.padEnd(13)}        ~ ${f}`);
}
console.log(
  anyFailed
    ? '\nA degraded model can be bumped on its own — set a per-model override in\nconfig/models.yaml, or tune that one prompt file. No need to move everything.\n'
    : '\nAll models held their dialect at this quant.\n'
);
process.exit(anyFailed ? 1 : 0);
