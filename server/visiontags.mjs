// Cross-checking a tagger's output against a model that can actually see.
//
// The tagger proposes and the model disposes. animetimm and WD v3 have high
// recall over a fixed Danbooru vocabulary and no idea what the picture looks
// like as a picture; a vision-capable LLM can see it but cannot reliably spell
// `braided_ponytail`. Asking each to do the half it is good at is the whole
// idea here, and it is the owner's — 29 Aug 2026.
//
// ── Why this is not the captioning feature that was dropped ────────────────
//
// The four caption modes were dropped on 21 Aug 2026 because they needed a
// SEPARATE vision model: new weights, VRAM, and `kind: "gguf"` support in
// server/taggers.mjs, which does not exist. None of that applies here. This
// uses the vision the user's own prompt model already has — on the P40 both
// 27Bs carry a 460M CLIP projector — so there is nothing to pull and nothing
// extra resident. Models that cannot see simply do not get this pass, and the
// tagger's output stands exactly as it does today.
//
// ── Everything it adds is verified, not trusted ────────────────────────────
//
// A model inventing `rain_slicked_concrete` would do real damage silently: it
// is not a tag any checkpoint was trained on, so it steers nothing AND
// displaces the tag that would have worked. That is the same failure the
// character block guards against in server/character.mjs. So every added tag
// is checked against the local Danbooru database before it is allowed
// through. The instruction file says so too, but the instruction is not what
// makes it true — this is.
//
// The instructions live in prompts/_shared/reference-vision.md rather than
// here, for the reason config/models.yaml gives about its own preset wording:
// it is the owner's to change without a code edit.
//
// ── Two modes, and they are alternatives ───────────────────────────────────
//
// `refine()` is the cross-check above: the tagger proposes, the model
// disposes. `describe()` is the other arm, added 7 Sep 2026 at the owner's
// request — no tagger at all, the model reads the picture and writes the tag
// list itself. A reference image is read by ONE of them, never both, and
// which one is a per-account preference (`reference_analysis`).
//
// They share everything that matters: the same backend, the same model, the
// same `canSee` gate, and the same rule that a tag is verified against the
// local Danbooru database before it counts. What differs is only who
// proposes the tags.
//
// The reason for offering the choice rather than picking one: the taggers see
// a fixed vocabulary very well and the picture not at all — animetimm is the
// only thing on this box that identified Frieren — while a model that can see
// finds the layer no tagger scores, light and framing and surface. Which of
// those a given reference needs is a judgement about that picture, so it is
// the person's to make.

/**
 * Parse the three-line contract the prompt file asks for.
 *
 * Exported for scripts/test-visiontags.mjs. These are regexes with a format
 * contract behind them, and this project's rule about that is written on
 * dialect-check.mjs: a mangled pattern silently passes everything, and it has
 * been bitten by exactly that more than once.
 */
/** The tags on one `LABEL: a, b, c` line. `none` is an empty list, not a tag
 *  called none. Shared by both parsers so the two contracts cannot drift. */
function tagsOnLine(line) {
  const body = line.replace(/^[A-Z]+:\s*/, '').trim();
  if (!body || /^none$/i.test(body)) return [];
  return body
    .split(',')
    .map((t) => t.trim().toLowerCase().replace(/\s+/g, '_'))
    .filter(Boolean);
}

export function parseDecision(text) {
  const out = { keep: null, drop: [], add: [] };
  if (!text) return null;
  if (/^\s*UNAVAILABLE\s*$/im.test(text)) return null;

  const list = tagsOnLine;

  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (/^KEEP:/i.test(line)) out.keep = list(line);
    else if (/^DROP:/i.test(line)) out.drop = list(line);
    else if (/^ADD:/i.test(line)) out.add = list(line);
  }

  // Fails closed. A reply with no KEEP line is not a model saying "drop
  // everything" — it is a model that ignored the format, and acting on it
  // would silently empty a tag list the tagger got right.
  if (out.keep === null) return null;
  return out;
}

/**
 * Parse the two-line contract prompts/_shared/reference-tags.md asks for.
 *
 * Exported for scripts/test-visiontags.mjs, and for the same reason
 * parseDecision is: a regex with a format contract behind it fails by
 * silently matching nothing, and on this path matching nothing means the
 * reference contributed no tags at all.
 */
export function parseTagReading(text) {
  const out = { character: [], tags: null };
  if (!text) return null;
  if (/^\s*UNAVAILABLE\s*$/im.test(text)) return null;

  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (/^CHARACTER:/i.test(line)) out.character = tagsOnLine(line);
    else if (/^TAGS:/i.test(line)) out.tags = tagsOnLine(line);
  }

  // Fails closed, exactly as parseDecision does. A reply with no TAGS line is
  // a model that ignored the format, not a model saying the picture is empty
  // — and on this path there is no tagger result underneath to fall back on,
  // so the caller needs to be able to tell those apart.
  if (out.tags === null) return null;
  return out;
}

/**
 * @param opts.baseUrl    the configured LLM base url (may end in /v1)
 * @param opts.timeoutMs  per-call ceiling
 * @param opts.tagStore   createTagStore() — used to verify added tags
 * @param opts.getPrompt  () => contents of prompts/_shared/reference-vision.md
 *                        A function, not a string: the prompt store re-reads
 *                        its files on POST /api/prompts/reload, and a value
 *                        captured at construction would pin this pass to
 *                        whatever was on disk at boot.
 * @param opts.getDescribePrompt
 *                        () => contents of prompts/_shared/reference-tags.md,
 *                        the other arm's instructions. Same reasoning.
 * @param opts.backend    config.llm.backend, which decides the default
 *                        transport — see `transport` below. Not the url: on a
 *                        box where the two diverge the caller passes both.
 * @param opts.settings   config.reference_vision block
 */
export function createVisionTags({ baseUrl, backend = 'ollama', timeoutMs, numCtx, tagStore, getPrompt, getDescribePrompt, settings = {}, warn = console.warn }) {
  const enabled = settings.enabled !== false;
  // A tag the tagger is very sure about is not one a general-purpose model
  // should be overruling — it was trained on millions of hand-tagged images
  // for exactly this. Only lower-confidence tags are eligible to be dropped.
  // **This floor is a guess and has not been measured.** It is written down
  // as a guess deliberately; an unverified number pretending to be a
  // measurement is worse than an absent one.
  const dropCeiling = settings.drop_confidence_ceiling ?? 0.85;
  // A real tag nobody uses is not worth a slot. Same shape of guard as the
  // character lookup's dominance test, and the same caveat: a guess.
  const minPosts = settings.min_post_count ?? 50;
  const maxAdded = settings.max_added ?? 12;

  // The other arm — the model reads the picture and no tagger runs. Its own
  // switch rather than riding on `enabled` above, because "the cross-check
  // costs 20-60s on top of the tagger and is off" and "nobody may choose the
  // LLM reader instead of the tagger" are different decisions, and 7 Sep 2026
  // is the day the first was true and the second was not.
  const describeSettings = settings.describe ?? {};
  const describeEnabled = describeSettings.enabled !== false;
  // A ceiling, not a target. The role filter downstream keeps only the
  // classes one reference needs, so a long list is mostly discarded work —
  // and the prompt file says forty is plenty for the same reason.
  const describeMaxTags = describeSettings.max_tags ?? 40;
  const describeMinPosts = describeSettings.min_post_count ?? minPosts;

  /**
   * Which shape of request carries a picture.
   *
   *   ollama  the native /api/chat, with `images: [base64]`
   *   openai  /v1/chat/completions, with an `image_url` data URI
   *
   * Two transports and not one because the box changed underneath this file.
   * Until 8 Sep 2026 only Ollama could be shown a picture here, so llama.cpp
   * serving prompts meant a SECOND 27B loading in Ollama beside it on a card
   * that fits one — the cost that got the cross-check switched off. Started
   * with `--mmproj`, llama-server reads images on its own OpenAI path, and
   * the model writing the prompt is the model reading the reference.
   *
   * Measured on the P40, 8 Sep 2026, same picture and same prompt file:
   * 9.5-11.4s here against 86-151s through Ollama.
   *
   * `auto` follows llm.backend, which is right whenever vision and generation
   * share a server. Set it explicitly when they diverge.
   */
  const transport = (() => {
    const want = settings.transport ?? 'auto';
    if (want === 'ollama' || want === 'openai') return want;
    return backend === 'ollama' || backend === 'mock' ? 'ollama' : 'openai';
  })();

  /** Native /api/chat, not the OpenAI-compatible path — images only go there. */
  const nativeRoot = () => String(baseUrl).replace(/[/]v1[/]?$/, '').replace(/[/]$/, '');
  /** …and the OpenAI path, which wants the /v1 the native one strips. */
  const openaiRoot = () => {
    const bare = String(baseUrl).replace(/[/]$/, '');
    return /\/v1$/.test(bare) ? bare : `${bare}/v1`;
  };

  /**
   * One image question, answered or null. Both arms ask the same way — same
   * endpoint, same sampling, same failure handling — so this is the single
   * place any of that can be got wrong.
   *
   * **Thinking off, and this is not optional.** Measured 29 Aug 2026 on the
   * P40: with it left at the model's default, settling six tags took 215
   * seconds — 1s to load, 15.6s of image prefill, and 197.6s of reasoning to
   * produce three lines. Measured again on llama.cpp on 8 Sep, where it is
   * worse: the reply came back EMPTY at exactly the token ceiling, all 900 of
   * them spent in `reasoning_content`, in 74s. With thinking off the same
   * question answered correctly in 11.4s. Same trap h3 documents in
   * config/server.yaml, and there is nothing to reason about here — the model
   * is reading a picture and writing down what is in it.
   *
   * The two backends spell it differently and neither is a default:
   * ollama takes `think: false`, and the OpenAI shape has no equivalent at
   * all, so it goes through the chat template — the same field and the same
   * reasoning as the stream path in server/llm.mjs.
   */
  async function ask({ model, system, user, image }) {
    const url =
      transport === 'openai'
        ? `${openaiRoot()}/chat/completions`
        : `${nativeRoot()}/api/chat`;

    const body =
      transport === 'openai'
        ? {
            model,
            stream: false,
            // Low temperature: this is a reading task, not a writing one. The
            // creativity presets are for prompts and have no business here.
            temperature: 0.2,
            chat_template_kwargs: { enable_thinking: false },
            messages: [
              { role: 'system', content: system },
              {
                role: 'user',
                content: [
                  { type: 'text', text: user },
                  {
                    type: 'image_url',
                    // The mime type is cosmetic to llama.cpp, which sniffs the
                    // bytes — but visionBytes() has already converted anything
                    // it could not read, so by here this is png or jpeg.
                    image_url: { url: `data:image/png;base64,${Buffer.from(image).toString('base64')}` },
                  },
                ],
              },
            ],
          }
        : {
            model,
            stream: false,
            think: false,
            // num_ctx passed explicitly because this is the native endpoint —
            // the OpenAI-compatible /v1 path silently discards it, which is
            // why config/server.yaml says to set it here.
            options: { temperature: 0.2, ...(numCtx ? { num_ctx: numCtx } : {}) },
            messages: [
              { role: 'system', content: system },
              {
                role: 'user',
                content: user,
                images: [Buffer.from(image).toString('base64')],
              },
            ],
          };

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs ?? 120000),
      });
      if (!res.ok) {
        warn(`[vision-tags] ${model} returned HTTP ${res.status}`);
        return null;
      }
      const data = await res.json().catch(() => ({}));
      return transport === 'openai'
        ? (data?.choices?.[0]?.message?.content ?? '')
        : (data?.message?.content ?? '');
    } catch (err) {
      warn(`[vision-tags] ${model}: ${err.message}`);
      return null;
    }
  }

  /**
   * Is this a tag an image model was actually trained on, and is it worth a
   * slot? The guard both arms run every added tag through.
   *
   * Order matters: unknown before deprecated before rare, so the reason
   * reported is the most specific true one.
   *
   * @returns { ok: true, category } | { ok: false, why }
   */
  function verify(tag, { minimumPosts }) {
    if (!tagStore?.loaded) return { ok: false, why: 'no tag database' };
    const rows = tagStore.exactRows(tag);
    if (!rows.length) return { ok: false, why: 'not a danbooru tag' };
    if (tagStore.isDeprecated(tag)) return { ok: false, why: 'deprecated' };
    if (tagStore.postCount(tag) < minimumPosts) return { ok: false, why: 'too rare' };
    return { ok: true, category: rows[0].category ?? 0 };
  }

  /**
   * Settle a tagger result against the image.
   *
   * Returns null whenever anything is off — disabled, no vision, a timeout, an
   * unparseable reply. Null means "the tagger's list stands", which is the
   * behaviour this app had before and is always a safe answer.
   */
  async function refine(image, { model, general = [] } = {}) {
    const prompt = typeof getPrompt === 'function' ? getPrompt() : null;
    if (!enabled || !model || !image?.length || !prompt) return null;
    if (!general.length) return null;

    const started = Date.now();
    const proposed = general.map((t) => t.tag);
    const confidence = new Map(general.map((t) => [t.tag, t.confidence ?? 0]));

    const reply = await ask({
      model,
      system: prompt,
      user: `Tagger output for this image:\n${proposed.join(', ')}`,
      image,
    });
    if (reply == null) return null;

    const decision = parseDecision(reply);
    if (!decision) {
      warn(`[vision-tags] ${model} did not answer in the KEEP/DROP/ADD format`);
      return null;
    }

    // Drops, guarded. A tag the model wants gone that the tagger was sure
    // about stays, and is reported so the guard can be measured rather than
    // believed.
    const dropped = [];
    const refused = [];
    for (const tag of decision.drop) {
      if (!confidence.has(tag)) continue;
      if ((confidence.get(tag) ?? 0) >= dropCeiling) refused.push(tag);
      else dropped.push(tag);
    }

    // Additions, verified — see verify() for the order of the checks.
    const added = [];
    const rejected = [];
    for (const tag of decision.add) {
      if (added.length >= maxAdded) break;
      if (confidence.has(tag)) continue; // already there
      const check = verify(tag, { minimumPosts: minPosts });
      if (!check.ok) { rejected.push({ tag, why: check.why }); continue; }
      added.push(tag);
    }

    const droppedSet = new Set(dropped);
    const tags = [
      ...general.filter((t) => !droppedSet.has(t.tag)),
      // Added tags carry no confidence of their own — they were not scored by
      // the tagger. Reported as null rather than as a number nobody measured.
      ...added.map((tag) => ({ tag, confidence: null, added_by_vision: true })),
    ];

    return { tags, dropped, added, rejected, refused, model, took_ms: Date.now() - started };
  }

  /**
   * Read a reference image with no tagger involved.
   *
   * The other arm of the choice — see the header. Returns a result shaped like
   * a tagger's so the route, the reference cards and the prompt formatter all
   * take it without knowing which read the picture: `character` and `general`
   * lists of `{ tag, confidence }`.
   *
   * **Confidence is null on every tag, and that is not a rounding of zero.**
   * The model did not score anything; it either wrote the tag down or it did
   * not. A number here would be invented, and the chip tooltip already knows
   * how to say "the model added this" rather than "0% confident" — that path
   * was built for the cross-check's additions and is the same claim.
   *
   * **Answers `{ ok: false, reason }` rather than null, unlike refine().**
   * The difference is what the caller can do about it. A null from refine
   * leaves the tagger's list standing, which is a good answer on its own; a
   * failure here leaves nothing at all, so the route has to fall back to the
   * taggers and tell the person it did. "The model refused" and "the model
   * cannot be reached" send someone to two different fixes, and on this box
   * the first is common — a picture this group would attach is one the base
   * quant declines to look at, measured 7 Sep 2026.
   */
  async function describe(image, { model } = {}) {
    const prompt = typeof getDescribePrompt === 'function' ? getDescribePrompt() : null;
    if (!describeEnabled) return { ok: false, reason: 'the LLM reader is switched off on this server' };
    if (!prompt) return { ok: false, reason: 'the reading instructions are not on this box' };
    if (!model) return { ok: false, reason: 'no model is selected' };
    if (!image?.length) return { ok: false, reason: 'there was no image to read' };

    const started = Date.now();
    const reply = await ask({ model, system: prompt, user: 'Tag this image.', image });
    if (reply == null) return { ok: false, reason: `${model} could not be reached` };

    const read = parseTagReading(reply);
    if (!read) {
      warn(`[vision-tags] ${model} did not answer in the CHARACTER/TAGS format`);
      // A refusal is not a format bug, and calling it one sends someone to
      // check the parser when the fix is to pick a different model. Measured
      // on the P40: the base 27B answers a picture this group would attach
      // with "I'm unable to complete this request", in 30.8s, while the
      // decensored one reads it in 86s. Both are "no tag list" and only one
      // of them is worth changing the prompt file over.
      const refused = /\b(?:i'?m unable|i am unable|i can'?t|i cannot|unable to (?:complete|process|assist)|i won'?t)\b/i.test(reply);
      return {
        ok: false,
        reason: refused
          ? `${model} declined to read the picture`
          : `${model} did not answer in the expected format`,
      };
    }

    const rejected = [];
    const character = [];
    const general = [];
    const seen = new Set();

    // Characters first, so a name that also turns up in the TAGS line is
    // already claimed and cannot arrive twice.
    //
    // A name is only accepted if the database says it IS a character — a
    // model answering `CHARACTER: elf` has told us something about the
    // picture, but not the thing this line means. Downstream that field is
    // the strongest claim a reference can carry and the one the role gate
    // decides whether to say out loud, so a general tag wearing it would
    // put a word like `elf` on the character line of a Character reference
    // and leave the actual subject unnamed.
    for (const tag of read.character) {
      if (seen.has(tag)) continue;
      const check = verify(tag, { minimumPosts: describeMinPosts });
      if (!check.ok) { rejected.push({ tag, why: check.why }); continue; }
      if (check.category !== 4) { rejected.push({ tag, why: 'not a character tag' }); continue; }
      seen.add(tag);
      character.push({ tag, confidence: null, added_by_vision: true });
    }

    for (const tag of read.tags) {
      if (general.length >= describeMaxTags) break;
      if (seen.has(tag)) continue;
      const check = verify(tag, { minimumPosts: describeMinPosts });
      if (!check.ok) { rejected.push({ tag, why: check.why }); continue; }
      seen.add(tag);
      // A character named in the TAGS line is still a character. The split
      // is load-bearing rather than cosmetic: server/imagerefs.mjs strips the
      // recognised character out of the tag list so an Outfit reference of a
      // Frieren picture carries the coat and not the elf, and it can only do
      // that for a name it was told about. A tagger reports the two lists
      // separately; this keeps that true whoever did the reading.
      if (check.category === 4) {
        character.push({ tag, confidence: null, added_by_vision: true });
        continue;
      }
      // An artist name is not a description of the picture, and a meta tag
      // (`highres`, `commentary`) describes the file rather than the image.
      // The prompt file asks for neither; this is what makes it true.
      if (check.category === 1 || check.category === 5) {
        rejected.push({ tag, why: check.category === 1 ? 'artist name' : 'meta tag' });
        continue;
      }
      general.push({ tag, confidence: null, added_by_vision: true });
    }

    if (!character.length && !general.length) {
      warn(`[vision-tags] ${model} read the image and nothing it wrote survived the tag check`);
      return {
        ok: false,
        reason: `${model} read it, but none of the ${read.tags.length + read.character.length} tags it wrote are danbooru tags`,
      };
    }

    return { ok: true, character, general, rejected, model, took_ms: Date.now() - started };
  }

  /**
   * Can this model see, asked of the backend that will actually be shown the
   * picturerather than of whichever one happens to be generating prompts.
   *
   * Added 4 Sep 2026, because the caller was asking the wrong server. It
   * consulted `llm.catalog()`, and on 1 Sep prompt generation moved to
   * llama.cpp while this pass stayed pointed at Ollama — where the image
   * endpoint lives. llama-swap reports no capability fields at all, so every
   * row came back `vision: null`, the gate read `null !== true` as "cannot
   * see", and the whole cross-check went silently dead for three days. Nothing
   * failed; it simply stopped happening.
   *
   * **Three answers, not two.** `true` and `false` are the backend's, `null`
   * is "it did not say" — an unreachable host, a backend with no /api/show, a
   * model it has never heard of. Null must not read as no: that is precisely
   * the bug this replaces, and toolsFor() in server.mjs already draws this
   * distinction correctly for the tool capability.
   *
   * **On llama.cpp it is a config fact, not a question.** There is no
   * /api/show to ask, and vision there is a property of how the model was
   * STARTED — an entry with `--mmproj` can see and one without cannot. The
   * file that decides it is the one that should answer for it, so
   * reference_vision.vision_models names them and this reads that list.
   * Declaring it is not a workaround for a missing endpoint: it is the truth
   * moving to where it is actually decided.
   */
  const declaredVision = Array.isArray(settings.vision_models) ? settings.vision_models : null;
  const seeCache = new Map();
  async function canSee(model) {
    if (!model) return false;
    // A declared list is exhaustive by construction: it lists every entry
    // started with a projector, so absence is a real `false` rather than a
    // shrug. That is the one place in this file where not-listed means no.
    if (declaredVision) return declaredVision.includes(model);
    if (seeCache.has(model)) return seeCache.get(model);
    try {
      const res = await fetch(`${nativeRoot()}/api/show`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: model }),
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) return null;
      const data = await res.json().catch(() => ({}));
      const list = Array.isArray(data.capabilities) ? data.capabilities : null;
      if (!list) return null;
      const out = list.includes('vision');
      seeCache.set(model, out);
      return out;
    } catch {
      return null;
    }
  }

  return {
    refine,
    describe,
    canSee,
    get enabled() { return enabled; },
    /** Whether the LLM-only arm may be chosen at all on this box. The account
     *  panel reads it through /api/status so it can say why the option is off
     *  rather than offering a setting that silently does nothing. */
    get describeEnabled() { return describeEnabled && typeof getDescribePrompt === 'function' && Boolean(getDescribePrompt()); },
  };
}
