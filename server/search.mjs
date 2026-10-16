// Web search for chat.
//
// Two backends, one interface. Both return the same shape, so nothing
// downstream cares which is running:
//
//   { ok, query, results: [{ n, title, url, domain, snippet }], detail }
//
// **searxng** is what the spec asks for: a local instance, `format=json`,
// nothing leaving the box except the query itself. It needs Docker, which is
// out of scope this pass, so it is configured but not the default.
//
// **duckduckgo** is the no-dependency fallback that made search possible now.
// It reads the plain HTML endpoint the site serves for browsers without
// JavaScript and pulls the same three fields out of it. Two honest caveats:
//
//   1. It is scraping. The markup can change without warning, and when it does
//      this returns no results rather than wrong ones — the parser requires
//      the anchor class it knows, and a page it does not recognise yields an
//      empty list, which the caller reports as "search found nothing" instead
//      of inventing citations.
//   2. Queries go to DuckDuckGo directly. On searxng they would be proxied.
//      The chat rules panel says so plainly rather than leaving people to
//      assume the local-only property still holds.
//
// Never throws. Search is an enhancement to an answer, and a chat turn must
// still complete when it fails — the model is simply told it has nothing.

const DEFAULTS = {
  backend: 'duckduckgo',
  base_url: 'http://127.0.0.1:8888',
  max_results: 5,
  timeout_ms: 8000,
};

/** Bare host, for display: "civitai.com" rather than the full URL. */
function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// The HTML endpoint hands back entity-encoded text. Only these five matter for
// titles and snippets, and a full entity decoder is a dependency this project
// does not need.
function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(html) {
  return decodeEntities(String(html ?? '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/**
 * DuckDuckGo wraps every result URL in a redirect: `/l/?uddg=<encoded>`. The
 * real destination is what gets cited, so it is unwrapped here — a citation
 * pointing at a redirector is a citation nobody can check at a glance.
 */
function unwrapDuckDuckGo(href) {
  const raw = String(href ?? '');
  const match = /[?&]uddg=([^&]+)/.exec(raw);
  const url = match ? decodeURIComponent(match[1]) : raw;
  const absolute = url.startsWith('//') ? `https:${url}` : url;
  return /^https?:\/\//.test(absolute) ? absolute : null;
}

function parseDuckDuckGo(html, limit) {
  const results = [];
  // Anchors carrying the result class, then the snippet that follows each one.
  // Deliberately narrow: markup this does not recognise produces nothing,
  // which is a visible "no results" rather than silently wrong citations.
  const blocks = String(html).split('class="result__a"').slice(1);
  const snippets = [...String(html).matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map(
    (m) => stripTags(m[1])
  );

  for (const [i, block] of blocks.entries()) {
    if (results.length >= limit) break;
    const href = /href="([^"]+)"/.exec(block)?.[1];
    const title = stripTags(block.slice(block.indexOf('>') + 1, block.indexOf('</a>')));
    const url = unwrapDuckDuckGo(href);
    if (!url || !title) continue;
    results.push({
      n: results.length + 1,
      title,
      url,
      domain: domainOf(url),
      snippet: snippets[i] ?? '',
    });
  }
  return results;
}

function parseSearxng(json, limit) {
  return (json?.results ?? []).slice(0, limit).map((r, i) => ({
    n: i + 1,
    title: String(r.title ?? '').trim(),
    url: String(r.url ?? ''),
    domain: domainOf(r.url),
    snippet: String(r.content ?? '').replace(/\s+/g, ' ').trim(),
  }));
}

export function createSearch(config) {
  const cfg = { ...DEFAULTS, ...(config?.search ?? {}) };
  const enabled = Boolean(cfg.enabled);
  const backend = cfg.backend ?? DEFAULTS.backend;

  async function run(query) {
    const q = String(query ?? '').trim();
    if (!enabled) return { ok: false, query: q, results: [], detail: 'Web search is switched off.' };
    if (!q) return { ok: false, query: q, results: [], detail: 'Nothing to search for.' };

    const limit = Number(cfg.max_results) > 0 ? Number(cfg.max_results) : DEFAULTS.max_results;
    const signal = AbortSignal.timeout(Number(cfg.timeout_ms) || DEFAULTS.timeout_ms);

    try {
      if (backend === 'searxng') {
        const base = String(cfg.base_url ?? DEFAULTS.base_url).replace(/\/$/, '');
        const res = await fetch(`${base}/search?q=${encodeURIComponent(q)}&format=json`, { signal });
        if (!res.ok) {
          // The single most common cause, and it is silent otherwise: JSON
          // output is off by default in SearXNG and the instance answers 403.
          return {
            ok: false,
            query: q,
            results: [],
            detail:
              res.status === 403
                ? `SearXNG refused the JSON request (403). Its settings.yml needs search.formats to include json.`
                : `SearXNG answered ${res.status}.`,
          };
        }
        const results = parseSearxng(await res.json(), limit);
        return { ok: results.length > 0, query: q, results, detail: results.length ? null : 'No results.' };
      }

      // The HTML endpoint, which is what a browser without JavaScript gets.
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
        signal,
        headers: {
          // Without a browser-shaped agent this endpoint answers with a
          // challenge page instead of results.
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'accept-language': 'en-US,en;q=0.9',
        },
      });
      if (!res.ok) {
        return { ok: false, query: q, results: [], detail: `DuckDuckGo answered ${res.status}.` };
      }
      const results = parseDuckDuckGo(await res.text(), limit);
      return {
        ok: results.length > 0,
        query: q,
        results,
        detail: results.length
          ? null
          : 'No results came back — the page shape may have changed, or the query found nothing.',
      };
    } catch (err) {
      // Timeouts, DNS failures, a box with no internet. All the same to the
      // caller: no results, and a reason it can show.
      return {
        ok: false,
        query: q,
        results: [],
        detail: err.name === 'TimeoutError' ? 'The search timed out.' : `Search failed: ${err.message}`,
      };
    }
  }

  /**
   * Search results as the block that goes into the model's context.
   *
   * Numbered, because the numbers are the citation contract: the model is told
   * to write [1] and the client turns [1] into a link to result 1. Numbering
   * them here rather than in the prompt keeps one source of truth for what [1]
   * means.
   */
  function asContext(result) {
    if (!result?.results?.length) return null;
    const lines = result.results.map(
      (r) => `[${r.n}] ${r.title} — ${r.domain}\n    ${r.snippet}\n    ${r.url}`
    );
    return (
      `Web search results for "${result.query}", retrieved just now:\n\n${lines.join('\n\n')}\n\n` +
      'Use these where they help and cite them inline as [1], [2] and so on, ' +
      'immediately after the claim they support. Do not cite a result you did ' +
      'not use. If they do not answer the question, say so and answer from what ' +
      'you know, making clear which is which.'
    );
  }

  function info() {
    return { enabled, backend, max_results: cfg.max_results };
  }

  return { enabled, backend, run, asContext, info };
}

// Exported for tests: these are the parts that break silently.
export const __testing = { parseDuckDuckGo, parseSearxng, unwrapDuckDuckGo, domainOf, stripTags };
