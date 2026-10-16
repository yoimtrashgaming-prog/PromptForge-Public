// What each person has chosen for themselves, validated.
//
// Split out of server.mjs on 26 Aug 2026, when `language` was added and the
// count made the problem obvious: `DEFAULT_PREFS` in server/storage.mjs
// defined **seven** preferences and this accepted **four**. The three left
// out — theme, keep_datasets_by_default, force_search — returned 200 from
// `POST /api/me` and stored nothing at all. That was deliberate and
// documented (they had no control behind them yet), but it is a trap: every
// new preference has to be added in two files, and forgetting the second one
// fails silently in the direction that looks like success.
//
// So the list of keys nothing accepts is now **explicit and exported**, and
// `npm run test-auth` walks `DEFAULT_PREFS` and holds every key to being
// either round-trippable or named in it. Adding a key to storage and nowhere
// else is a test failure now rather than a shrug.
//
// **Everything here drops a bad value rather than clamping it.** The controls
// cannot produce out-of-range input, so a value that arrives anyway is a
// hand-rolled request, and silently rewriting it would hide the mistake from
// whoever made it.

/** Chat sampling temperature. Served on /api/status so the slider's bounds
 *  come from the same constant this enforces. */
/** How long a standing instruction may be. Served on /api/status so the
 *  textarea's limit and this one cannot drift apart. */
import { optionalSegments } from './segments.mjs';

export const CUSTOM_INSTRUCTION_MAX = 500;

export const CHAT_TEMPERATURE_RANGE = { min: 0, max: 1.5, step: 0.05, default: 0.7 };

/**
 * UI languages. `en` is the source language: every string in the app is
 * written in English and the dictionaries in web/i18n.js are keyed on it, so
 * `en` needs no dictionary and can never be missing one.
 *
 * French came first because a French-speaking contributor's own build of this
 * idea shipped one, and German came with it in the same file. Adding a fourth
 * is a dictionary in web/i18n.js plus one line here.
 */
export const LANGUAGES = ['en', 'fr', 'de'];

/**
 * Who reads a reference image. `taggers` is animetimm + EVA02 on the CPU;
 * `llm` is the model this person writes prompts with, shown the picture.
 *
 * Served on /api/status so the control offers exactly what this validates,
 * for the same reason the temperature band is.
 */
export const REFERENCE_ANALYSIS = ['taggers', 'llm'];

/**
 * Which reference surface the builder shows.
 *
 * `tags` is the chip list off the card — pick what you want, it rides with
 * the reference. `analysis` is the read-back: the model that will write the
 * prompt looks at the picture and says what it will keep and what it will
 * ignore, and you correct it before generating.
 *
 * **Not the same question as REFERENCE_ANALYSIS above, and the names are
 * close enough to be worth pinning down.** That one decides who produces the
 * TAGS at upload time. This one decides what the front end puts in front of
 * you. They are independent on purpose: the taggers cost nothing on the CPU
 * and their list is still there when you switch back, so nothing is re-read
 * and nothing is re-spent by moving between the two.
 *
 * Added 8 Sep 2026, with the picture itself finally reaching the model.
 */
export const REFERENCE_MODE = ['tags', 'analysis'];

/** Whether the guided tour has been offered, and what was said. Nothing
 *  server-side reads it; it is stored so the offer is made once per account,
 *  not once per browser. */
export const TOUR_STATES = ['unasked', 'taken', 'declined'];

/**
 * Preferences that `server/storage.mjs` defines and this deliberately does
 * not accept, each with the reason. Named rather than silently ignored: a key
 * that stores nothing is indistinguishable from a broken save otherwise.
 *
 * Emptying this list is the goal, not the design. Each of these becomes
 * acceptable the moment something offers it.
 */
export const UNACCEPTED = {
  force_search: 'chat reads it, but the button supersedes it — see search.enabled in config/server.yaml',
  keep_datasets_by_default: 'Tab 2 is built against the stub backend and has no dataset flow yet',
};

/**
 * Colour schemes, each a full palette in web/themes.css.
 *
 * `midnight` is the original and lives in styles.css :root rather than in a
 * themes block, so a browser that never loads that file renders exactly as
 * the app did before themes existed. It therefore has no `[data-theme]`
 * block, and setting it means REMOVING the attribute rather than changing it.
 *
 * `lime` is A user's palette, from the build this app has been borrowing
 * ideas from. The rest are the schemes people already recognise from their
 * editors, which is most of the value: someone who has used Nord for five
 * years does not want to be talked into a new one.
 */
export const THEMES = ['midnight', 'lime', 'nord', 'dracula', 'gruvbox', 'tokyo', 'sakura', 'paper'];

/** Typeface stacks, in web/themes.css. Nothing downloads — see the note there. */
// 'system' was dropped 6 Sep 2026 — it rendered identically to the default on
// every platform that matters here. A stored 'system' fails this check, so the
// preference resets to default rather than sticking on a key with no CSS rule.
export const FONTS = ['default', 'grotesk', 'humanist', 'serif', 'mono'];

/** Three steps, and a small range: past about 16px the fixed-width panels
 *  start wrapping in ways nothing has been checked against. */
export const TEXT_SIZES = ['small', 'normal', 'large'];

/**
 * Validate a preferences patch. Unknown and unacceptable keys are dropped.
 *
 * @param input   what arrived in the request body
 * @param deps    { registry, taggers, llm } — live, so a preference pointing
 *                at a model or tagger that no longer exists is refused rather
 *                than stored. A saved default naming something gone would
 *                otherwise select nothing on load, a long way from the edit
 *                that caused it.
 */
export async function validatePreferences(input, { registry, taggers, llm }) {
  const out = {};
  if (!input || typeof input !== 'object') return out;

  // Checked against what Ollama actually has, for the same reason the model
  // default is checked against the registry: a saved choice pointing at
  // something that is not installed would fail at generate time, which is a
  // long way from where the mistake was made. '' means "the configured
  // default" and is always valid.
  if (typeof input.prompt_llm === 'string') {
    const wanted = input.prompt_llm.trim();
    if (!wanted) {
      out.prompt_llm = '';
    } else {
      const installed = (await llm.health())?.installed ?? [];
      // An empty list means the backend could not be asked — mock, or Ollama
      // down. Accepting the value beats refusing a valid one because the
      // backend was briefly unreachable; a wrong one surfaces at generate
      // time with a message that names it.
      if (!installed.length || installed.includes(wanted)) out.prompt_llm = wanted;
    }
  }

  // One default, not one per type. The image/video split is a grouping over
  // ten targets, and you only ever land on one of them — currentType starts
  // at 'image', so a separate video default could never affect what opens.
  // Storing the model alone lets the frontend derive the group from it, which
  // is how someone who mostly writes H3 prompts can actually open on H3.
  if (registry.keys().includes(input.default_model)) {
    out.default_model = input.default_model;
  }

  const taggerKeys = ['both', ...(taggers.info().taggers ?? []).map((t) => t.key)];
  if (taggerKeys.includes(input.default_tagger)) {
    out.default_tagger = input.default_tagger;
  }

  // Who reads a reference image: the ONNX taggers, or the model this person
  // writes prompts with. Two values and nothing else — the third state people
  // ask for, "both", is not on offer, because the two produce the same shape
  // of list from the same picture and merging them is the cross-check, which
  // is a different feature with its own switch in config/server.yaml.
  //
  // Accepted even when the server has the LLM arm switched off. The route
  // falls back to the taggers and says on the card that it did, which is a
  // better answer than a preference that refuses to save for a reason the
  // person cannot see — and turning the arm back on then costs no re-picking.
  if (REFERENCE_ANALYSIS.includes(input.reference_analysis)) {
    out.reference_analysis = input.reference_analysis;
  }

  // Which surface the builder shows. Nothing server-side reads this — it is
  // a front-end mode — but it is stored per account so the toggle is where
  // you left it, which is the whole reason it is a preference and not a
  // variable in app.js.
  if (REFERENCE_MODE.includes(input.reference_mode)) {
    out.reference_mode = input.reference_mode;
  }

  // Chat has read this since it was built; until it became settable, every
  // chat ran at the 0.7 default.
  if (typeof input.chat_temperature === 'number' && Number.isFinite(input.chat_temperature)) {
    const t = Math.round(input.chat_temperature * 100) / 100;
    if (t >= CHAT_TEMPERATURE_RANGE.min && t <= CHAT_TEMPERATURE_RANGE.max) {
      out.chat_temperature = t;
    }
  }

  // Which language the interface is drawn in.
  //
  // Stored per account rather than in localStorage, which is what the French
  // build this borrows from does. localStorage is per browser: signing in from
  // a phone would put someone back into a language they do not read, and the
  // whole point is that a person picks once. The login wall itself still
  // falls back to localStorage, because there is no account to read yet at
  // that moment — see web/i18n.js.
  if (typeof input.language === 'string' && LANGUAGES.includes(input.language)) {
    out.language = input.language;
  }

  // How the app looks, to this person and nobody else. All three are applied
  // client-side by setting an attribute on <html>, so they change one
  // browser's rendering of one account and touch neither the server's own
  // output nor anyone else's session.
  //
  // `theme` was in UNACCEPTED until 26 Aug 2026 with the reason "there is one
  // theme", which was true when it was written.
  if (typeof input.theme === 'string' && THEMES.includes(input.theme)) {
    out.theme = input.theme;
  }
  if (typeof input.font === 'string' && FONTS.includes(input.font)) {
    out.font = input.font;
  }
  if (typeof input.text_size === 'string' && TEXT_SIZES.includes(input.text_size)) {
    out.text_size = input.text_size;
  }

  if (TOUR_STATES.includes(input.tour)) {
    out.tour = input.tour;
  }

  // A standing instruction, prepended to nothing and appended to nothing —
  // it is one labelled line in the USER turn of every prompt this person
  // generates. See buildUserMessage.
  //
  // Deliberately not part of the system prompt. The system prompt is the
  // model's dialect and it is the product; a per-account string spliced into
  // it would be ten different prompt files per person and the end of any
  // measurement meaning anything. In the user turn it is a preference the
  // model weighs against its format, which is what it is.
  //
  // Trimmed, capped, and dropped rather than clamped when it is too long —
  // the textarea enforces the same number, so a longer one is a hand-rolled
  // request and silently truncating it would hide the mistake. Empty string
  // is a legitimate value: it is how you turn the feature off.
  // Which self-written system prompt is switched on, per model. An object
  // rather than one value because a block is per model by design — an Anima
  // prompt is not an H3 prompt — so "which one is on" is a question per tab.
  //
  //   { illustrious: 'sys_ab12…', anima: null }
  //
  // Validated key by key against the registry, and a value that is not a
  // string is read as "off". The id is NOT checked for existence here: a
  // block someone deleted must not make the whole preferences object
  // unsaveable, and the generate path already falls back to the shipped
  // prompt when the id resolves to nothing.
  if (input.system_prompts && typeof input.system_prompts === 'object' && !Array.isArray(input.system_prompts)) {
    const known = new Set(registry.keys());
    const out2 = {};
    for (const [key, value] of Object.entries(input.system_prompts)) {
      if (!known.has(key)) continue;
      if (typeof value === 'string' && value) out2[key] = value;
      // Anything else means "use the prompt this repo ships", which is the
      // absence of an entry rather than a stored null.
    }
    out.system_prompts = out2;
  }

  // Per model, the segments this person switched off.
  //
  // Validated against the registry AND against what that model actually
  // offers: server/segments.mjs decides which are optional, and it is the
  // only place that decides. A stored "Positive prompt" would be ignored at
  // generation time anyway, but storing it at all would leave a preference
  // that reads as if it does something.
  //
  // An unknown model key or an empty list is dropped rather than stored, so
  // the object stays a record of live choices instead of accumulating
  // settings for models that no longer exist.
  if (input.omit_segments && typeof input.omit_segments === 'object' && !Array.isArray(input.omit_segments)) {
    const out2 = {};
    for (const [key, value] of Object.entries(input.omit_segments)) {
      const model = registry.get?.(key);
      if (!model || !Array.isArray(value)) continue;
      const allowed = new Set(optionalSegments(model));
      const kept = [...new Set(value.filter((l) => allowed.has(l)))];
      // Stored even when EMPTY, which matters from 5 Sep 2026: the optional
      // segments are off by default, so "no entry for this model" means the
      // default and an empty list means "I ticked them all back on". Dropping
      // the empty one would make those two the same thing, and every attempt
      // to switch a segment on would snap off again on the next reload.
      out2[key] = kept;
    }
    out.omit_segments = out2;
  }

  if (typeof input.custom_instruction === 'string') {
    const text = input.custom_instruction.trim();
    if (text.length <= CUSTOM_INSTRUCTION_MAX) out.custom_instruction = text;
  }

  return out;
}
