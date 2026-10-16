// Tool calling — the booru tag database, exposed as a function the model calls.
//
// Why this exists. Every booru prompt file carries a wall of text trying to
// teach a 27B which tags danbooru actually has, and it does not work: asked
// for 250 words on illustrious, the model produced `wet_boots, rainboots,
// rubber_boots` and five hair colours at once. Two of those three tags are
// not real. No amount of prose in a system prompt fixes that, because the
// model is not misunderstanding the instruction — it is recalling tags from
// training data that has no idea what danbooru retired last year.
//
// A tool call replaces recall with a lookup. The model asks "what tags
// contain 'boots'", gets eight real ones with post counts, and picks.
//
// **This file reports facts and gives no instructions.** It used to answer an
// empty search with "that tag does not exist — do not write it", and the owner
// stopped it on 30 Aug 2026: that reads as a stop sign on anything danbooru
// has no entry for, and danbooru having no entry is not the same as the words
// doing nothing. `from_front` and `harsh lighting` are ordinary English the
// text encoder still reads; `wet_boots` is a fake compound that reads as
// neither a tag nor a phrase. A post count cannot tell those apart, so it must
// not pretend to.
//
// What to DO with an empty result is policy, it is a judgement, and in this
// project judgement lives in prompts/ — see prompts/_shared/tag-search.md,
// which is appended to the system prompt only when tools are actually
// offered, and which the owner can tune without touching code.
//
// **Not every model gets this.** Tools are a capability the backend reports
// per model, and `hf.co/OBLITERATUS/Qwen3.8-27B-OBLITERATED:Q4_K_M` — checked
// 30 Aug 2026 — does not have it, while `qwen3.8-27b-heretic`, the unsloth
// base and `huihui_ai/qwen3.5-abliterated:9b` all do. So this must degrade to
// exactly the behaviour of the day before it existed: no tools offered, the
// prompt file's own knowledge doing the whole job.
//
// The tag database being absent is the same story. A fresh checkout has no
// `data/tags/tags.sqlite` until `npm run update-tags` runs, and offering a
// model a tool that answers "database not loaded" every time is worse than
// offering it nothing.

/** How many search results one call may return. */
const DEFAULT_LIMIT = 15;
/**
 * How many queries one search_tags call may carry.
 *
 * Not a style rule — a cost ceiling. See the note at the slice below: a
 * degenerating model asked for thousands in a single call and every one was
 * looked up and fed back into its own context.
 */
const DEFAULT_MAX_QUERIES = 24;

const MAX_LIMIT = 30;

/**
 * Danbooru's category codes, by the name a model would use for them.
 *
 * `meta` is deliberately absent: nothing in a prompt wants `highres` or
 * `commentary_request`, and offering the filter invites asking for them.
 */
const CATEGORIES = {
  general: 0,
  artist: 1,
  copyright: 3,
  character: 4,
};

/**
 * A tool call's arguments, as an object.
 *
 * **Exported because every tool needs it and only one of them had it.** The
 * backend hands arguments over as a JSON STRING — see llm.mjs, which
 * normalises the native and OpenAI shapes to that on purpose. This function
 * lived inside createToolbox, so search_tags parsed its arguments and
 * read_guidance did not: it read `args?.name` straight off a string, got
 * undefined, and answered "read_guidance needs a document name" to every call
 * it ever received. Measured 5 Sep 2026: three calls, three failures, zero
 * successes, each one costing a tool round and returning nothing.
 *
 * An unparseable string comes back as { __text }, so the caller decides what a
 * bare string means — the query for a search, the document name for a read.
 */
export function toolArguments(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : { __text: String(parsed) };
  } catch {
    return { __text: raw };
  }
}

export function createToolbox(tags, { limit = DEFAULT_LIMIT, maxQueries = DEFAULT_MAX_QUERIES, lexicon = null } = {}) {
  /**
   * What the paraphrase lexicon reads a query as, when the catalogue search
   * did not already return it. "beauty mark" contains no tag name, so the
   * substring search answers nothing; the lexicon knows it is `mole`.
   *
   * Only for a model with the lexicon switched on — see server/lexicon.mjs —
   * and only for general tags, which is all the lexicon holds.
   */
  function paraphraseNote(query, res, { variant, category }) {
    if (!lexicon || (category && category !== 'general')) return '';
    const shown = new Set((res.results ?? []).map((r) => r.tag.replace(/ /g, '_')));
    const extra = lexicon.lookup(query).filter((h) => !shown.has(h.tag));
    if (!extra.length) return '';
    const spell = variant === 'space' ? (t) => t.replace(/_/g, ' ') : (t) => t;
    const lines = extra.map(
      (h) =>
        spell(h.tag) + ' — ' + Number(tags.postCount?.(h.tag) ?? 0).toLocaleString('en-GB') +
        ' posts (general)'
    );
    return '\nThe reviewed phrase list reads "' + query + '" as:\n' + lines.join('\n');
  }

  /**
   * The schema handed to the backend, or an empty list when there is nothing
   * behind it.
   *
   * `variant` is the model's own tag style, so the spellings that come back
   * are the spellings that model writes — a space-style model shown
   * `thigh_boots` copies the underscore straight into its prompt.
   */
  function definitions({ variant = 'underscore' } = {}) {
    if (!tags?.loaded) return [];
    const example = variant === 'space' ? 'thigh boots' : 'thigh_boots';
    return [
      {
        type: 'function',
        function: {
          name: 'search_tags',
          description:
            'Look up what danbooru actually calls something. Search for any ' +
            'concept you are about to write — clothing, hair, poses, settings, ' +
            'objects — and see the real tag names. It matches anywhere in the ' +
            'tag, so "boots" finds "' + example + '". Results come back ' +
            'most-used first with the number of posts using each one, which is ' +
            'how much the image model was trained on that exact name. Pass ' +
            'every concept you want in ONE call using the queries array — a ' +
            'second call means another full generation pass, which is the ' +
            'slowest thing you can do.',
          parameters: {
            type: 'object',
            properties: {
              queries: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Every concept you want to look up, in one call — for ' +
                  'example ["boots", "raincoat", "city street", "lighting"]. ' +
                  'Ask for all of them at once. Each separate call costs a ' +
                  'full round trip; one call with ten queries costs the same ' +
                  'as one call with one.',
              },
              query: {
                type: 'string',
                description:
                  'A single concept, when you only want one. Prefer the ' +
                  'queries array for anything more.',
              },
              category: {
                type: 'string',
                enum: Object.keys(CATEGORIES),
                description:
                  'Optional. Narrow to one kind of tag: general for ordinary ' +
                  'content, character for a named character, copyright for a ' +
                  'series, artist for a style reference.',
              },
              limit: {
                type: 'integer',
                description: 'How many results to return. Default ' + limit + '.',
              },
            },
          },
        },
      },
    ];
  }

  /**
   * Arguments as the backend actually sends them.
   *
   * Ollama's native API sends a parsed object; the OpenAI-compatible path
   * sends a JSON string. A model that gets the shape slightly wrong — an
   * array where a string belongs, because it wanted to ask three things at
   * once — is answered rather than rejected. Being strict here spends a whole
   * round trip teaching a model a schema it will get right next time by luck.
   */
  // A bare string is nearly always the query itself — the one piece of this
  // that is specific to searching, and so the one piece left here.
  function normalise(raw) {
    const args = toolArguments(raw);
    return args.__text === undefined ? args : { query: args.__text };
  }

  function formatResults(query, res, { category }) {
    if (!res.ok) return 'The tag database is unavailable: ' + (res.error ?? 'unknown error');
    if (!res.results.length) {
      return (
        'No danbooru tag contains "' + query + '"' +
        (category ? ' in category ' + category : '') +
        '. Searched every tag name in the database.'
      );
    }
    const lines = res.results.map((r) => {
      const count = r.post_count.toLocaleString('en-GB');
      // Retired tags are returned and flagged, never silently dropped — the
      // same call server/tags.mjs makes, and for the same reason. A model told
      // "black_footwear was retired" can choose something else; a model told
      // nothing at all writes it from memory and never knows.
      //
      // Flagged, not forbidden. What to do about a retired tag is a judgement,
      // and judgement lives in prompts/ — see the header note.
      const retired = r.deprecated ? ' [retired by danbooru]' : '';
      return r.tag + ' — ' + count + ' posts (' + r.category_name + ')' + retired;
    });
    return (
      res.results.length + ' tag' + (res.results.length === 1 ? '' : 's') +
      ' matching "' + query + '":\n' + lines.join('\n')
    );
  }

  /**
   * Run one tool call and return the text the model gets back.
   *
   * Never throws. A tool that throws inside the generation loop takes down a
   * request that was going fine, and the model has a perfectly good way of
   * handling "that did not work" if you simply tell it.
   */
  function run(name, rawArgs, { variant = 'underscore', paraphrases = false } = {}) {
    if (name !== 'search_tags') {
      return {
        ok: false,
        content:
          'There is no tool called "' + name + '". The only tool available is search_tags.',
      };
    }
    const args = normalise(rawArgs);
    const asked = Array.isArray(args.query)
      ? args.query
      : Array.isArray(args.queries)
        ? args.queries
        : [args.query ?? args.queries ?? args.q ?? args.tag ?? args.name];

    const all = asked.map((q) => String(q ?? '').trim()).filter(Boolean);
    if (!all.length) {
      return { ok: false, content: 'search_tags needs a "query" — a word to look for.' };
    }

    // A degenerating model can ask for thousands.
    //
    // Measured 5 Sep 2026 on a live anima generation: one call whose query
    // list started on the brief — "gaming chair, streaming, webcam" — and then
    // free-associated through clothing, materials, weather, military and
    // anatomy into cell biology and cardiology before jamming on "actigraphy"
    // repeated to the end. Every one of them was looked up, and every result
    // was joined into a tool message that went back into the context. The
    // generation took minutes.
    //
    // The cap does not stop the model degenerating — nothing here can. It
    // stops the degeneration being expensive, which is the part this file
    // owns. Ordinary calls on this box run 11 to 21 queries, so the ceiling is
    // generous rather than tight; anything near it is already a bad sign.
    //
    // Truncated rather than refused. The first queries are the ones drawn from
    // the actual brief — the list only wanders later — so the useful half of a
    // runaway call is still answered.
    const cleaned = all.slice(0, maxQueries);
    const dropped = all.length - cleaned.length;

    const category = typeof args.category === 'string' ? args.category.toLowerCase() : null;
    if (category && !(category in CATEGORIES)) {
      return {
        ok: false,
        content:
          'Unknown category "' + category + '". Valid categories are: ' +
          Object.keys(CATEGORIES).join(', ') + '. Omit it to search all of them.',
      };
    }

    const wanted = Number(args.limit);
    const perQuery = Number.isFinite(wanted) ? Math.min(MAX_LIMIT, Math.max(1, wanted)) : limit;

    try {
      const blocks = cleaned.map((q) => {
        const res = tags.lookup(q, {
          variant,
          category: category ? CATEGORIES[category] : null,
          limit: perQuery,
        });
        return (
          formatResults(q, res, { category }) +
          (paraphrases ? paraphraseNote(q, res, { variant, category }) : '')
        );
      });
      if (dropped) {
        blocks.push(
          `That call carried ${all.length} queries and only the first ${cleaned.length} were run. ` +
            'A list that long is usually a repeating one.'
        );
      }
      return { ok: true, content: blocks.join('\n\n'), queries: cleaned, dropped };
    } catch (err) {
      return { ok: false, content: 'The tag search failed: ' + err.message };
    }
  }

  return {
    definitions,
    run,
    get available() {
      return Boolean(tags?.loaded);
    },
  };
}
