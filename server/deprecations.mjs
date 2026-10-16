// Danbooru's deprecated tags, which our CSV has no column for.
//
// The owner's report was "remove useless tags that are used 0 times or
// mistyped", and the first look at the database said there were none: 181,714
// rows, minimum post_count 50. Both halves of that were true and the
// conclusion was wrong.
//
// Danbooru DEPRECATES tags — misspellings, retired names, ambiguous ones that
// got split — and zeroes their post count when it does. The upstream CSV is a
// snapshot taken before that happened, so a tag deprecated last month still
// carries the count it had while it was alive. Measured 26 August 2026: 4,042
// deprecated tags on danbooru, **398 of them in our database**, and their
// current count on danbooru is 0. `sleeveless_turtleneck_shirt`,
// `three_quarter_profile`, `holding_own_breasts` and 22 varieties of
// `*_sleeve_cuffs` were all in our autocomplete with counts that no longer
// exist anywhere.
//
// So the report was accurate and the reading of it was not. The tags are used
// zero times; our copy just does not know yet.
//
// This reads tag metadata only. No images are fetched, and nothing runs on a
// timer — same contract as server/traits.mjs.

const DEFAULT_BASE = 'https://danbooru.donmai.us';
const PAGE_SIZE = 1000;

// 4,042 as of 26 Aug 2026, so five pages covers it with room to grow. A
// ceiling rather than a target: without one, a change in danbooru's paging
// behaviour turns this into an unbounded loop against someone else's server.
const MAX_PAGES = 15;

/**
 * Every tag danbooru currently marks deprecated.
 *
 * Degrades like everything else that reaches the network here: no connection
 * means an empty set and a reason, never a throw and never a half-built list.
 * A tag database without the flag is worse than one with it; it is not a
 * failure, and `update-tags` says so and carries on.
 *
 * @returns { ok, names: Set<string>, reason }
 */
export async function fetchDeprecated({
  baseUrl = DEFAULT_BASE,
  timeoutMs = 20_000,
  fetchImpl = fetch,
  onProgress = null,
} = {}) {
  const names = new Set();

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url =
      `${baseUrl}/tags.json?search%5Bis_deprecated%5D=true&limit=${PAGE_SIZE}&page=${page}`;
    let rows;
    try {
      const res = await fetchImpl(url, {
        headers: { 'user-agent': 'PromptForge/2.0 (tag hygiene)' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        // A partial list is still worth having: the tags collected so far are
        // genuinely deprecated, and filtering 3,000 of 4,042 beats filtering
        // none. Reported so the count in the log is not mistaken for the whole.
        return {
          ok: names.size > 0,
          names,
          reason: `danbooru answered ${res.status} on page ${page}`,
        };
      }
      rows = await res.json();
    } catch (err) {
      return {
        ok: names.size > 0,
        names,
        reason: `could not reach danbooru: ${err.message}`,
      };
    }

    if (!Array.isArray(rows) || !rows.length) break;
    for (const row of rows) {
      if (typeof row?.name === 'string' && row.name) names.add(row.name);
    }
    onProgress?.(page, names.size);
    // A short page is the last page. Checked rather than always running to
    // MAX_PAGES, which would be four wasted requests at someone else's expense.
    if (rows.length < PAGE_SIZE) break;
  }

  return { ok: true, names, reason: null };
}

/**
 * Mark the deprecated rows in an open tags database.
 *
 * Flagged, not deleted, and for a reason: deleting means a full re-import to
 * undo, and this list is somebody else's editorial judgement. A column can be
 * ignored by one query and honoured by another — the alias path deliberately
 * still resolves a retired name, because someone typing an old spelling should
 * be sent to the current tag rather than told nothing exists.
 *
 * Both variants are updated. A tag is deprecated as a tag; the underscore and
 * spaced spellings are the same tag.
 *
 * @returns { flagged, scanned }
 */
export function applyDeprecations(db, names) {
  db.exec(`
    ALTER TABLE tags ADD COLUMN deprecated INTEGER NOT NULL DEFAULT 0
  `);
  return markDeprecated(db, names);
}

/** The same, for a database that already has the column. */
export function markDeprecated(db, names) {
  // BOTH spellings, and this is not decoration. The two imported variants
  // store different strings for the same tag — `black_footwear` in the
  // underscore list and `black-footwear` in the dash list — so matching on
  // danbooru's name alone flags the underscore row and leaves the dash row
  // live. Measured on the real database: 398 tags matched 398 underscore rows
  // and only 113 dash rows, those 113 being the single-word tags where the
  // two spellings happen to be identical.
  //
  // Nothing in this app queries the dash variant today — `space` is served out
  // of the underscore rows, for reasons in server/tags.mjs — but the variant
  // is a supported query parameter, and a half-flagged table is the kind of
  // thing that is only ever found by someone hitting it.
  const mark = db.prepare('UPDATE tags SET deprecated = 1 WHERE tag = ? OR tag = ?');
  let flagged = 0;
  db.exec('BEGIN');
  try {
    for (const name of names) {
      // changes() counts every row touched, so the total is rows rather than
      // tags. Reported as rows and named as rows in the log, because "398
      // tags" and "796 rows" are both true and only one matches a SELECT.
      flagged += mark.run(name, name.replace(/_/g, '-')).changes;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { flagged, scanned: names.size };
}

/** Whether a database already carries the column, so a refresh can skip the
 *  ALTER rather than failing on it. */
export function hasDeprecatedColumn(db) {
  const cols = db.prepare('PRAGMA table_info(tags)').all();
  return cols.some((c) => c.name === 'deprecated');
}
