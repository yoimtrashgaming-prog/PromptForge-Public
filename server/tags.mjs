// Danbooru tag database — prefix search for the booru and hybrid templates.
//
// node:sqlite rather than a native binding, deliberately: platform-specific
// binaries in node_modules are one of the documented ways this project breaks
// when it moves to Linux.
//
// If the database file is missing the app still starts. Autocomplete degrades
// to "tag database not loaded" and everything else works — that is a stated
// requirement, not a nicety, because the database is a 2.5MB download that
// may not have happened yet on a fresh checkout.

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import path from 'node:path';
// One definition of "the name half of a character tag", shared rather than
// re-spelled here. character.mjs imports nothing, so this is not a cycle.
import { namePart } from './character.mjs';

// Danbooru category codes → the pill classes the frontend colours by.
export const CATEGORY = {
  0: 'general',
  1: 'artist',
  3: 'copyright',
  4: 'character',
  5: 'meta',
};

export function createTagStore(rootDir, config, { warn = console.warn } = {}) {
  const rel = config.tags?.db_path ?? 'data/tags/tags.sqlite';
  const dbPath = path.join(rootDir, rel);
  const defaultVariant = (config.tags?.variants ?? ['underscore'])[0];

  let db = null;
  let meta = {};
  let loadError = null;
  // Character name index, built on first use by `charactersNamed` below.
  let byNamePart = null;
  // General-tag word index, built on first use by `generalTokenTop` below.
  let generalTokens = null;
  // Word -> tags containing that word, built on first use by `tagsWithTokens`.
  let tokenIndex = null;
  // Retired name -> the live tag that replaced it, built on first use by
  // `aliasTarget` below.
  let aliasIndex = null;

  function open() {
    if (!existsSync(dbPath)) {
      loadError = `tag database not loaded — run: npm run update-tags`;
      warn(`[tags] ${loadError} (looked in ${rel})`);
      return;
    }
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const rows = db.prepare('SELECT key, value FROM meta').all();
      meta = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      loadError = null;
    } catch (err) {
      db = null;
      loadError = `tag database could not be opened: ${err.message}`;
      warn(`[tags] ${loadError}`);
    }
  }

  function close(reason) {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
    db = null;
    byNamePart = null;
    generalTokens = null;
    tokenIndex = null;
    aliasIndex = null;
    if (reason) loadError = reason;
  }

  open();

  // Databases built before 26 Aug 2026 have no `deprecated` column. A query
  // naming a column that does not exist throws rather than returning nothing, so
  // the filter is composed in only when the column is there. Checked once at
  // open: a PRAGMA per search would be a real cost on a path that runs on every
  // keystroke.
//
  // The effect on an old database is that nothing is filtered, which is exactly
  // how it behaved yesterday. Run `npm run update-tags -- --deprecations-only`
  // to add it without a 40MB re-download.
  const hasDeprecated = (() => {
    if (!db) return false;
    try {
      return db.prepare('PRAGMA table_info(tags)').all().some((c) => c.name === 'deprecated');
    } catch {
      return false;
    }
  })();

  /**
   * Prefix search, ranked by post count — the ordering that makes
   * autocomplete useful, since the common tag is nearly always the one meant.
   * Also matches aliases, so typing "boobs" finds "breasts".
   */
  function search(query, { variant = defaultVariant, category = null, limit = 20 } = {}) {
    if (!db) return { ok: false, error: loadError, results: [] };

    // `space` is not a stored variant. The danbooru CSVs ship `_underscore`
    // and `_dash` only, and the models whose prompt files ask for spaces —
    // pony, sdxl, anima, all `tag_style: "space"` — used to be served the dash
    // list, which is the wrong spelling and cannot be repaired downstream.
    //
    // Dash is lossy: it writes a word-internal hyphen and a word separator as
    // the same character, so `t-shirt` (hyphen) and `long-hair` (separator)
    // are indistinguishable and a naive `-` to space gives `t shirt`. Not an
    // edge case — `two-tone_hair` has 236k posts, `dark-skinned_female` 176k,
    // `see-through_clothes` 152k. Underscore keeps the two apart, so the
    // spaced form is derived from underscore and never from dash. Measured
    // 20 Aug 2026; see "Open: Pony gets dashes" in the context doc.
    const spaced = variant === 'space';
    const storedVariant = spaced ? 'underscore' : variant;

    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return { ok: true, results: [] };

    // Rows are stored underscored, so typing "long hair" has to be matched as
    // "long_hair". Underscores typed directly still work: both spellings
    // normalise to the same needle.
    //
    // Keyed on the STORED variant, not on whether the model wants spaces. It
    // used to be `spaced ? ... : q`, which left the underscore models
    // unforgiving in a way the space models were not: on Illustrious, typing
    // "purple hair" returned nothing at all, while Pony accepted both
    // spellings. Nothing is lost by normalising here — stored underscore rows
    // never contain a literal space, so a spaced query could only ever have
    // matched zero rows.
    const needle = storedVariant === 'underscore' ? q.replace(/ /g, '_') : q;

    // Escape LIKE wildcards in user input. Note `_` is one of them, and after
    // the normalisation above a space model's query is full of them.
    const esc = needle.replace(/[\\%_]/g, (c) => `\\${c}`);
    const catFilter = category != null ? 'AND category = ?' : '';
    // Danbooru's retired and misspelled tags. Measured 26 Aug 2026: 398 of
    // them were in this database, offered with the post counts they had
    // before they were retired — `sleeveless_turtleneck_shirt`,
    // `three_quarter_profile`, 22 kinds of `*_sleeve_cuffs`. That is the
    // "tags used 0 times" the owner reported: they are used zero times, and
    // our snapshot predates danbooru zeroing the count.
    //
    // Deprecated tags are RANKED LAST, not removed.
    //
    // Removing them was the first attempt and the literal reading of the ask.
    // Measured immediately afterwards: typing "black_foot" returned NOTHING —
    // `black_footwear` is retired and no live tag starts that way — and so did
    // "light_blue_h". Silence is a worse answer than clutter: it reads as a
    // broken database, and it hides the very fact worth knowing, which is that
    // the tag was retired and something else replaced it.
    //
    // So they sort below every live match and come back flagged, and the
    // frontend greys them and says "retired". A person looking for a tag that
    // no longer exists is told so, and a person browsing never sees one until
    // the live matches run out.
    const deprecatedRank = hasDeprecated ? 'deprecated' : '0';

    // Exact prefix on the tag itself first, then alias hits, so a typed
    // prefix never gets buried under a popular tag that merely aliases it.
    // `retired` is the outer sort key: a retired exact match still loses to a
    // live alias hit, because the live tag is the one that will work.
    const sql = `
      SELECT tag, category, post_count, aliases, 0 AS rank, ${deprecatedRank} AS retired
        FROM tags
       WHERE variant = ? AND tag LIKE ? ESCAPE '\\' ${catFilter}
      UNION ALL
      SELECT tag, category, post_count, aliases, 1 AS rank, ${deprecatedRank} AS retired
        FROM tags
       WHERE variant = ? AND tag NOT LIKE ? ESCAPE '\\'
             AND ',' || aliases || ',' LIKE ? ESCAPE '\\' ${catFilter}
       ORDER BY retired ASC, rank ASC, post_count DESC
       LIMIT ?
    `;

    const params = [storedVariant, `${esc}%`];
    if (category != null) params.push(category);
    params.push(storedVariant, `${esc}%`, `%,${esc}%`);
    if (category != null) params.push(category);
    params.push(limit);

    // Underscore to space on the way out, never dash to space. Word-internal
    // hyphens are left alone, so `two-tone_hair` becomes `two-tone hair` and
    // `t-shirt` stays `t-shirt`.
    const style = spaced ? (s) => s.replace(/_/g, ' ') : (s) => s;

    const rows = db.prepare(sql).all(...params);
    return {
      ok: true,
      results: rows.map((r) => ({
        tag: style(r.tag),
        category: r.category,
        category_name: CATEGORY[r.category] ?? 'general',
        post_count: r.post_count,
        aliases: r.aliases ? r.aliases.split(',').filter(Boolean).map(style) : [],
        matched_alias: r.rank === 1,
        // Retired on danbooru. The count beside it is from our snapshot,
        // taken before danbooru zeroed it, so it is history rather than a
        // reason to pick the tag.
        deprecated: r.retired === 1,
      })),
    };
  }

  /**
   * Substring search across every category — the backend for the search_tags
   * tool in server/tools.mjs.
   *
   * `search` is a PREFIX search because that is what autocomplete needs: you
   * have typed "purp" and you want "purple_hair" without having typed the
   * word you are looking for. A model asking the database a question is in the
   * opposite position. It knows the word and wants every tag built around it —
   * ask a prefix search for "boots" and `knee_boots`, `thigh_boots` and
   * `rubber_boots` are all invisible, which are the three answers it wanted.
   *
   * Ranked by post count with retired tags last, same as `search`, and the
   * spelling follows the model's variant so a space-style model is never shown
   * an underscored tag it would then copy verbatim.
   */
  function lookup(query, { variant = defaultVariant, category = null, limit = 15 } = {}) {
    if (!db) return { ok: false, error: loadError, results: [] };

    const spaced = variant === 'space';
    const storedVariant = spaced ? 'underscore' : variant;

    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return { ok: true, results: [] };

    const needle = storedVariant === 'underscore' ? q.replace(/ /g, '_') : q;
    const esc = needle.replace(/[\\%_]/g, (c) => `\\${c}`);
    const catFilter = category != null ? 'AND category = ?' : '';
    const deprecatedRank = hasDeprecated ? 'deprecated' : '0';

    // Exact match first, then prefix, then anywhere. Without the ladder a
    // one-word query is answered by whatever long tag happens to be popular:
    // "hair" returns `long_hair` at 4.3M before `hair` itself, and a model
    // reading top-down takes the first row as the answer to what it asked.
    const sql = `
      SELECT tag, category, post_count, ${deprecatedRank} AS retired,
             CASE WHEN tag = ? THEN 0
                  WHEN tag LIKE ? ESCAPE '\\' THEN 1
                  ELSE 2 END AS rank
        FROM tags
       WHERE variant = ? AND tag LIKE ? ESCAPE '\\' ${catFilter}
       ORDER BY retired ASC, rank ASC, post_count DESC
       LIMIT ?
    `;

    const params = [needle, `${esc}%`, storedVariant, `%${esc}%`];
    if (category != null) params.push(category);
    params.push(limit);

    const style = spaced ? (s) => s.replace(/_/g, ' ') : (s) => s;
    const rows = db.prepare(sql).all(...params);
    return {
      ok: true,
      results: rows.map((r) => ({
        tag: style(r.tag),
        category: r.category,
        category_name: CATEGORY[r.category] ?? 'general',
        post_count: r.post_count,
        deprecated: r.retired === 1,
      })),
    };
  }

  /**
   * Candidate pool for AI-assisted tag finding. The spec is explicit that
   * Qwen must select from the database rather than recall tags from memory,
   * so it gets given candidates to choose among.
   */
  function candidates(terms, { variant = defaultVariant, perTerm = 12 } = {}) {
    if (!db) return { ok: false, error: loadError, results: [] };
    const seen = new Map();
    for (const term of terms) {
      for (const r of search(term, { variant, limit: perTerm }).results) {
        if (!seen.has(r.tag)) seen.set(r.tag, r);
      }
    }
    return { ok: true, results: [...seen.values()] };
  }

  function info() {
    if (!db) return { loaded: false, error: loadError };
    const { c } = db.prepare('SELECT COUNT(*) AS c FROM tags').get();
    const byCat = db
      .prepare('SELECT category, COUNT(*) AS c FROM tags WHERE variant = ? GROUP BY category')
      .all(defaultVariant);
    // `auto_update_days` is a staleness threshold, not a schedule. Nothing
    // downloads on a timer — the owner presses a button. This is what makes
    // the admin panel able to say "12 days old" and mean something by it.
    const staleAfter = config.tags?.auto_update_days ?? null;
    const updatedAt = meta.updated_at ?? null;
    const ageDays = updatedAt ? (Date.now() - Date.parse(updatedAt)) / 86400000 : null;

    return {
      loaded: true,
      total_rows: c,
      updated_at: updatedAt,
      age_days: ageDays == null || Number.isNaN(ageDays) ? null : Math.floor(ageDays),
      stale_after_days: staleAfter,
      stale: staleAfter != null && ageDays != null && !Number.isNaN(ageDays)
        ? ageDays > staleAfter
        : false,
      source: meta.source ?? null,
      files: meta.files ? JSON.parse(meta.files) : [],
      variants: config.tags?.variants ?? [],
      by_category: Object.fromEntries(
        byCat.map((r) => [CATEGORY[r.category] ?? String(r.category), r.c])
      ),
    };
  }

  /**
   * Danbooru-wide post count for one tag, 0 if unknown.
   *
   * The trait lookup needs it to tell a character trait from furniture:
   * `ringed_eyes` and `1girl` are equally common on Makima's posts, and only
   * the global count says one of them is on 0.2% of danbooru and the other on
   * two thirds of it. Always the underscore variant — the space rows are a
   * synthetic view of the same data, so counting them would double nothing
   * and miss tags whose spaced spelling never appears.
   */
  /**
   * Character tags CONTAINING this text, most-used first.
   *
   * Narrow on purpose, and deliberately not part of `search`. That one is a
   * prefix search because it runs on every keystroke and prefix is what makes
   * autocomplete feel like autocomplete; a substring scan there would change
   * what typing "hair" means for everyone.
   *
   * This runs on one path only — a character lookup that found nothing — where
   * prefix is exactly the wrong shape. `miku` is not a prefix of
   * `hatsune_miku`, and our alias data does not connect them either, so the
   * prefix search offers five Kancolle ships and misses the character with
   * 106,043 posts. Measured at 1–9ms over 181,714 rows, on a path that runs
   * once per miss rather than once per letter.
   */
  /**
   * Every live character tag whose NAME PART is exactly this word.
   *
   * `makima` -> makima_(chainsaw_man); `zhongli` -> the plain tag and both
   * costume variants; `miku` -> nothing, because no character's name part is
   * "miku".
   *
   * This exists because server/character.mjs was asking that question with a
   * per-gram prefix search, which is the wrong shape twice over. It costs a
   * query (~37ms here) for a question the answer to which never changes
   * between generations, and it made the resolver expensive enough to need a
   * cap on how many words of a brief it would look at — a cap a realistic
   * brief exhausted before it reached the character's name. Measured 27 Aug
   * 2026: "Makima from Chainsaw Man on a rain-slick Tokyo rooftop at night,
   * city lights below her, coat collar turned up against the wind" is 57
   * n-grams against a budget of 24, and resolved nobody, silently.
   *
   * One pass over the 25,540 character rows builds the whole map. It is built
   * on first use rather than at open, so a session that never resolves a
   * character never pays for it, and dropped by `close` so an updated database
   * is not answered from the old one.
   */
  function charactersNamed(name) {
    if (!db) return [];
    if (!byNamePart) {
      const live = hasDeprecated ? 'AND deprecated = 0' : '';
      const rows = db
        .prepare(
          `SELECT tag, post_count FROM tags
            WHERE variant = 'underscore' AND category = 4 ${live}`
        )
        .all();
      byNamePart = new Map();
      for (const r of rows) {
        const key = namePart(r.tag);
        const list = byNamePart.get(key);
        if (list) list.push(r);
        else byNamePart.set(key, [r]);
      }
    }
    const key = String(name ?? '').trim().toLowerCase().replace(/\s+/g, '_');
    return (byNamePart.get(key) ?? []).map((r) => ({ tag: r.tag, post_count: r.post_count }));
  }

  /**
   * The most-used GENERAL tag that contains this word, as a post count.
   *
   * `long` -> 4,323,141, because `long_hair` is a word away. `makima` -> 0,
   * because no general tag contains her name at all. server/character.mjs uses
   * the gap to tell a description from a name where an exact-tag test cannot:
   * there is no general tag `long`, so nothing else says the word is English.
   *
   * Parenthetical general tags are excluded. danbooru files
   * `makima_(chainsaw_man)_(cosplay)` as general, and counting it would have
   * every character's own name arguing that their name is a common word.
   *
   * Same lifecycle as the character index above: built once on demand over the
   * 24,317 general rows, dropped by `close`.
   */

  function generalTokenTop(word) {
    if (!db) return 0;
    if (!generalTokens) {
      const rows = db
        .prepare("SELECT tag, post_count FROM tags WHERE variant = 'underscore' AND category = 0")
        .all();
      generalTokens = new Map();
      for (const r of rows) {
        if (r.tag.includes('(')) continue;
        for (const t of new Set(r.tag.split('_'))) {
          const cur = generalTokens.get(t) ?? 0;
          if (r.post_count > cur) generalTokens.set(t, r.post_count);
        }
      }
    }
    return generalTokens.get(String(word ?? '').trim().toLowerCase()) ?? 0;
  }

  /**
   * Every tag whose NAME CONTAINS all of these words, as whole words.
   *
   * The backend for server/candidates.mjs, and the reason it is a word index
   * rather than a LIKE query. Measured 30 Aug 2026 against the brief "frieren
   * sitting in a field of flowers reading a book": a substring search for
   * "reading" returns `spreading_own_pussy` at 11,909 posts, because "reading"
   * is inside "spreading". That tag then goes into the candidate pool of a
   * brief about a book. Word boundaries are not a nicety here.
   *
   * Passing several words finds tags containing all of them in any order, so
   * `['field', 'flower']` finds `flower_field` — which a phrase search for
   * "field of flowers" never would, since danbooru writes it the other way
   * round and has no "of".
   *
   * Ranked exact match first, then fewest words (the general tag before the
   * specific one), then post count. `book` should outrank `book_stack` for a
   * brief that just said "book".
   *
   * Artists and meta are excluded. Nobody's brief means to summon
   * `commentary_request`, and an artist tag arrives through the style control
   * rather than by accident of spelling.
   *
   * The index is one pass over the underscore rows, built on first use and
   * dropped by `close` — same lifecycle as the character and general-token
   * indexes above, and for the same reasons.
   */
  function tagsWithTokens(words, { limit = 8, minPostCount = 0, categories = [0, 3, 4] } = {}) {
    if (!db) return [];
    const wanted = (Array.isArray(words) ? words : [words])
      .map((w) => String(w ?? '').trim().toLowerCase())
      .filter(Boolean);
    if (!wanted.length) return [];

    if (!tokenIndex) {
      const live = hasDeprecated ? 'AND deprecated = 0' : '';
      const rows = db
        .prepare(
          `SELECT tag, post_count, category FROM tags
             WHERE variant = 'underscore' AND category IN (0, 3, 4) ${live}`
        )
        .all();
      tokenIndex = new Map();
      for (const r of rows) {
        // Parenthetical qualifiers are part of the tag but not part of what a
        // brief means: `makima_(chainsaw_man)` should be findable by "makima",
        // not by "chainsaw".
        const bare = r.tag.replace(/_?\([^)]*\)/g, '');
        for (const w of new Set(bare.split('_').filter(Boolean))) {
          const list = tokenIndex.get(w);
          if (list) list.push(r);
          else tokenIndex.set(w, [r]);
        }
      }
    }

    // Start from the rarest word's posting list, so an ordinary word like
    // "girl" never costs a scan of its 20,000 tags when it is paired with
    // something selective.
    const lists = wanted.map((w) => tokenIndex.get(w) ?? []);
    if (lists.some((l) => !l.length)) return [];
    lists.sort((a, b) => a.length - b.length);

    const joined = wanted.join('_');
    const out = [];
    for (const row of lists[0]) {
      if (row.post_count < minPostCount) continue;
      const bare = row.tag.replace(/_?\([^)]*\)/g, '');
      const tokens = new Set(bare.split('_').filter(Boolean));
      if (!wanted.every((w) => tokens.has(w))) continue;
      if (!categories.includes(row.category)) continue;
      out.push(row);
    }
    out.sort(
      (a, b) =>
        (b.tag === joined) - (a.tag === joined) ||
        a.tag.split('_').length - b.tag.split('_').length ||
        b.post_count - a.post_count
    );
    return out.slice(0, limit).map((r) => ({
      tag: r.tag,
      post_count: r.post_count,
      category: r.category,
      category_name: CATEGORY[r.category] ?? 'general',
    }));
  }

  function findCharacters(text, limit = 5) {
    if (!db) return [];
    const needle = String(text ?? '').trim().toLowerCase().replace(/\s+/g, '_');
    if (needle.length < 2) return [];
    const esc = needle.replace(/[\\%_]/g, (c) => `\\${c}`);
    const live = hasDeprecated ? 'AND deprecated = 0' : '';
    const rows = db
      .prepare(
        `SELECT tag, post_count FROM tags
          WHERE variant = 'underscore' AND category = 4 ${live}
                AND tag LIKE ? ESCAPE '\\'
          ORDER BY post_count DESC LIMIT ?`
      )
      .all(`%${esc}%`, limit);
    return rows.map((r) => ({ tag: r.tag, post_count: r.post_count }));
  }

  /**
   * The retired names danbooru now answers with this one.
   *
   * The character trait table is keyed by whatever each community list called
   * a character when it was built, and danbooru renames characters — measured
   * 15 Sep 2026, 6,019 of the table's 34,157 keys are names the live database
   * no longer holds, `gojou_satoru` and `itadori_yuuji` among them. Looking a
   * character up by its current name therefore missed the table entirely. The
   * old names are already in the `aliases` column of the live row, so this
   * turns the current name back into the ones a stale key might use.
   *
   * @returns {string[]} retired names, or [] for a tag with none
   */
  function aliasesOf(tag) {
    if (!db) return [];
    const key = String(tag ?? '').trim().toLowerCase().replace(/\s+/g, '_');
    const row = db
      .prepare("SELECT aliases FROM tags WHERE tag = ? AND variant = 'underscore'")
      .get(key);
    if (!row?.aliases) return [];
    return String(row.aliases)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /**
   * The live tag that replaced this retired one — the opposite direction to
   * `aliasesOf`.
   *
   * Danbooru retires a tag in two ways and only one of them has a replacement.
   * `china_dress` was renamed to `qipao` and every post moved with it, so the
   * trait is still true and only its name changed; `bangs` was deprecated as
   * meaningless and nothing replaced it. This answers the first case and
   * returns null for the second, which is what lets the trait table rename
   * what it can and drop the rest.
   *
   * Indexed on first use: the whole column is one pass, and the caller asks
   * once per dead tag per character.
   *
   * @returns {string|null} the live tag, or null if nothing replaced this one
   */
  function aliasTarget(tag) {
    if (!db) return null;
    if (!aliasIndex) {
      aliasIndex = new Map();
      const rows = db
        .prepare(
          `SELECT tag, aliases, post_count FROM tags
            WHERE variant = 'underscore' AND aliases IS NOT NULL AND aliases <> ''`
        )
        .all();
      for (const r of rows) {
        for (const part of String(r.aliases).split(',')) {
          const retired = part.trim();
          if (!retired) continue;
          // A name can appear under more than one live tag. The busiest one is
          // the replacement people actually use.
          const held = aliasIndex.get(retired);
          if (!held || r.post_count > held.posts) {
            aliasIndex.set(retired, { tag: r.tag, posts: r.post_count });
          }
        }
      }
    }
    const key = String(tag ?? '').trim().toLowerCase().replace(/\s+/g, '_');
    return aliasIndex.get(key)?.tag ?? null;
  }

  /**
   * Whether danbooru has retired this tag.
   *
   * Exposed separately rather than folded into `postCount` returning 0,
   * because two callers ask that question for different reasons and only one
   * of them wants this: the negative cleanup uses postCount to decide whether
   * a tag exists at all, and a deprecated tag does exist — it is just no
   * longer the right name for the thing. Conflating them would have silently
   * changed what gets stripped from negative prompts, which is a separate
   * decision nobody asked for.
   *
   * False on a database built before 26 Aug 2026, which has no column.
   */
  function isDeprecated(tag) {
    if (!db || !hasDeprecated) return false;
    const key = String(tag ?? '').trim().toLowerCase().replace(/\s+/g, '_');
    const row = db
      .prepare("SELECT deprecated FROM tags WHERE tag = ? AND variant = 'underscore'")
      .get(key);
    return row?.deprecated === 1;
  }

  /**
   * Every exact row for a name, across categories.
   *
   * `search` is a PREFIX search with a limit, which makes it the wrong tool
   * for "does this exact tag exist and in which category" — `tea` sits below
   * `tears` and `teacher` by post count, so a limited prefix query can miss
   * the exact match it was asked about. server/character.mjs needs that
   * question answered precisely: it decides whether a word is somebody's name
   * or an ordinary noun by comparing the general tag's post count against the
   * character tag's, and a missed row reads as "no general tag" and injects a
   * stranger's canon into a prompt about a cup of tea.
   *
   * Categories are danbooru's: 0 general, 1 artist, 3 copyright, 4 character.
   */
  function exactRows(tag) {
    if (!db) return [];
    const key = String(tag ?? '').trim().toLowerCase().replace(/\s+/g, '_');
    return db
      .prepare(
        "SELECT tag, category, post_count FROM tags WHERE tag = ? AND variant = 'underscore'"
      )
      .all(key);
  }

  function postCount(tag) {
    if (!db) return 0;
    // Accept either spelling. Stored rows are underscored, and callers hold
    // tags in whatever style their model wants — the negative cleanup compares
    // in spaces, so without this every multi-word tag looked unknown and
    // multiple_girls got dropped as invented. Safe in this direction only: the
    // underscore list is the source, and a space can only ever have been one.
    const key = String(tag ?? '').trim().toLowerCase().replace(/\s+/g, '_');
    const row = db
      .prepare("SELECT post_count FROM tags WHERE tag = ? AND variant = 'underscore'")
      .get(key);
    return row?.post_count ?? 0;
  }

  return {
    search,
    lookup,
    tagsWithTokens,
    candidates,
    info,
    postCount,
    exactRows,
    isDeprecated,
    aliasesOf,
    aliasTarget,
    findCharacters,
    charactersNamed,
    generalTokenTop,
    get loaded() {
      return Boolean(db);
    },
    reload() {
      close('tag database is reloading');
      open();
      return info();
    },

    /**
     * Release the file so something else can replace it.
     *
     * Needed because the update writes a new database and renames it over
     * this one, and Windows refuses to rename over a file with an open
     * handle. Searches degrade to `reason` while it is shut, which the
     * suggestion list already renders — the same path as a missing database.
     */
    close,
  };
}
