// The tag list, from danbooru itself.
//
// This project got its tags from a GitHub repo — BetaDoggo/danbooru-tag-list —
// until 7 Sep 2026. That repo publishes CSVs scraped from danbooru, and it
// stopped: the newest dated file on its branch is `danbooru-12-10-24`, so
// `npm run update-tags` re-downloaded a two-year-old snapshot forever and the
// weekly-refresh logic in update-tags.mjs had nothing to refresh to.
//
// ── Why that was worse than merely stale ──────────────────────────────────
//
// Danbooru SPLITS tags, not just renames them. `black_footwear` became
// `black_shoes` and `black_boots` depending on what the picture actually
// shows, and a split has no alias — there is no single answer to redirect to.
// So the database ended up holding `black_footwear` (284,390 posts, correctly
// flagged deprecated by our own deprecations pass) and not holding
// `black_shoes` (271,260 posts) at all. It knew the dead name and had no path
// to the live one.
//
// That is not cosmetic. This database is what the vision pass and the
// `search_tags` tool verify against, so a valid 271k-post tag was being
// rejected as "not a danbooru tag".
//
// ── And the models agree with danbooru, not with the snapshot ─────────────
//
// The obvious worry is that an image model was trained on an older danbooru
// and knows the older vocabulary, which would make freshness actively wrong.
// Checked 7 Sep 2026 against the model-specific tag lists that same repo
// publishes: **Illustrious V1.0 knows `black_shoes` and `black_boots` and
// does NOT know `black_footwear`.** NoobAI XL 1.1 knows all three. So the
// stale snapshot was the outlier, and current danbooru is the right target.
//
// ── The API ───────────────────────────────────────────────────────────────
//
// Same endpoints and same parameters the upstream scraper used, because they
// are the correct ones and there is nothing to improve on:
//
//   tags.json         hide_empty=yes, is_deprecated=no, order=count
//   tag_aliases.json  status=active, order=tag_count
//
// `is_deprecated=no` matters most: dead tags never arrive, so unlike the CSV
// path there is nothing to flag afterwards.
//
// `order=count` descending is what makes the stop condition sound — once a
// page's last row is under the floor, every later page is too.

const BASE = 'https://danbooru.donmai.us';
const PER_PAGE = 1000;
// A ceiling, not a target. Without one, a change in danbooru's paging turns
// this into an unbounded loop against someone else's server. At 1000 per page
// this covers far more than the whole tag set above any sane floor — measured
// 7 Sep 2026, post_count 50 is reached around page 120.
const MAX_PAGES = 400;
// Their scraper uses 0.1s. 0.25 is politer and costs about 30 seconds over a
// full run, which nobody is watching.
const DELAY_MS = 250;

// Tags that are punctuation, where `_` is part of the face rather than a word
// separator. The dash variant must leave these alone or `^_^` becomes `^-^`,
// which is a different tag and not one danbooru has. Verbatim from the
// upstream scraper, which had the same problem.
export const KAOMOJI = new Set([
  '0_0', '(o)_(o)', '+_+', '+_-', '._.', '<o>_<o>', '<|>_<|>', '=_=', '>_<',
  '3_3', '6_9', '>_o', '@_@', '^_^', 'o_o', 'u_u', 'x_x', '|_|', '||_||',
]);

/** danbooru's underscore spelling, in the dash form some models want. */
export function toDash(tag) {
  return KAOMOJI.has(tag) ? tag : tag.replace(/_/g, '-');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One page, with retries. Danbooru sits behind Cloudflare and answers 5xx or
 * 429 under load; the upstream scraper retries forever, which is the wrong
 * shape for something a button in the admin panel can start.
 */
async function getPage(url, { fetchImpl = fetch, tries = 4, timeoutMs = 30_000 } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      const res = await fetchImpl(url, {
        headers: { 'user-agent': 'PromptForge/1.0 (private, self-hosted)' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return await res.json();
      // 4xx other than 429 is a bad request and retrying cannot fix it.
      if (res.status !== 429 && res.status < 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    if (attempt < tries) await sleep(DELAY_MS * 4 * attempt);
  }
  throw lastErr ?? new Error('request failed');
}

/**
 * Every live tag at or above `minPostCount`, most-used first.
 *
 * @returns [{ name, category, post_count }]
 */
export async function fetchTags({
  baseUrl = BASE,
  minPostCount = 50,
  fetchImpl = fetch,
  onProgress = null,
} = {}) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url =
      `${baseUrl}/tags.json?limit=${PER_PAGE}` +
      `&search[hide_empty]=yes&search[is_deprecated]=no&search[order]=count&page=${page}`;
    const rows = await getPage(url, { fetchImpl });
    if (!Array.isArray(rows) || rows.length === 0) break;

    let done = false;
    for (const r of rows) {
      if (r.post_count < minPostCount) { done = true; break; }
      out.push({ name: r.name, category: r.category, post_count: r.post_count });
    }
    onProgress?.(page, out.length);
    // Ordered by count descending, so the first row under the floor means
    // every remaining row on every remaining page is too.
    if (done) break;
    await sleep(DELAY_MS);
  }
  return out;
}

/**
 * Active aliases, as consequent -> [antecedent, ...].
 *
 * The direction matters and is easy to get backwards. `antecedent_name` is the
 * old or colloquial spelling somebody types; `consequent_name` is the live tag
 * it resolves to. Autocomplete wants to find `breasts` when someone types
 * `boobs`, so the live tag owns the list of things that point AT it.
 *
 * Filtered to consequents we actually kept: an alias to a tag below the post
 * floor is a row nothing can ever match.
 */
export async function fetchAliases({
  baseUrl = BASE,
  keep = null,
  fetchImpl = fetch,
  onProgress = null,
} = {}) {
  const byTag = new Map();
  let total = 0;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url =
      `${baseUrl}/tag_aliases.json?limit=${PER_PAGE}` +
      `&search[status]=active&search[order]=tag_count&page=${page}`;
    const rows = await getPage(url, { fetchImpl });
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      const to = r.consequent_name;
      const from = r.antecedent_name;
      if (!to || !from) continue;
      if (keep && !keep.has(to)) continue;
      if (!byTag.has(to)) byTag.set(to, []);
      byTag.get(to).push(from);
      total += 1;
    }
    onProgress?.(page, total);
    await sleep(DELAY_MS);
  }
  return byTag;
}

/**
 * The whole list, ready to insert.
 *
 * Degrades the way everything else that reaches the network here does: an
 * alias failure is reported and the tags still land, because a tag list
 * without aliases is smaller, not broken.
 *
 * @returns { tags, aliases, aliasError }
 */
export async function fetchTagList({
  baseUrl = BASE,
  minPostCount = 50,
  fetchImpl = fetch,
  onProgress = null,
} = {}) {
  const tags = await fetchTags({
    baseUrl, minPostCount, fetchImpl,
    onProgress: (page, n) => onProgress?.('tags', page, n),
  });

  const keep = new Set(tags.map((t) => t.name));
  let aliases = new Map();
  let aliasError = null;
  try {
    aliases = await fetchAliases({
      baseUrl, keep, fetchImpl,
      onProgress: (page, n) => onProgress?.('aliases', page, n),
    });
  } catch (err) {
    aliasError = err.message;
  }

  return { tags, aliases, aliasError };
}
