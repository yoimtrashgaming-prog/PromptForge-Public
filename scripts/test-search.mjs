// Web search: the parsers, and the promise that a failed search is not a
// failed answer.
//
//   node scripts/test-search.mjs
//
// No network. Every case runs against fixture markup or a stubbed fetch, both
// because a suite must work on a box with no internet and because the point of
// most of these is what happens when the network misbehaves.
//
// The parser is the fragile part by design. It reads DuckDuckGo's HTML, which
// can change without warning, so the contract it has to keep is: markup I do
// not recognise produces NO results, never wrong ones. A search that finds
// nothing is a visible "nothing came back"; a search that invents a citation
// is an answer with a fake source under it.

import { createSearch, __testing } from '../server/search.mjs';

const { parseDuckDuckGo, parseSearxng, unwrapDuckDuckGo, domainOf, stripTags } = __testing;

let passed = 0;
const failures = [];
const check = (what, ok, detail) => {
  if (ok) passed += 1;
  else failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
};

// A cut-down copy of what the endpoint actually returns, keeping the shapes
// that matter: the redirect wrapper, entity-encoded text, and markup inside a
// title.
const FIXTURE = `
<div class="results">
  <div class="result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fcivitai.com%2Farticles%2F9148%2Flora&amp;rut=abc">
      Illustrious LoRA Training &amp; Discussion
    </a>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fcivitai.com%2Farticles%2F9148%2Flora">
      Rank <b>128</b> is a good default for characters.
    </a>
  </div>
  <div class="result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.reddit.com%2Fr%2FStableDiffusion%2Fcomments%2Fabc%2F">
      Best network rank and alpha - Reddit
    </a>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.reddit.com%2Fr%2F">
      People report 32 to 64 for small datasets.
    </a>
  </div>
</div>`;

// ── the parser ───────────────────────────────────────────────
{
  const results = parseDuckDuckGo(FIXTURE, 5);
  check('both results are found', results.length === 2, String(results.length));
  check('numbered from one', results.map((r) => r.n).join(',') === '1,2');

  // The redirect wrapper is unwrapped, because a citation pointing at a
  // redirector is one nobody can check at a glance.
  check(
    'the real URL is unwrapped from the redirect',
    results[0].url === 'https://civitai.com/articles/9148/lora',
    results[0].url
  );
  check('the domain is bare', results[0].domain === 'civitai.com', results[0].domain);
  check('www is dropped from the domain', results[1].domain === 'reddit.com', results[1].domain);
  check(
    'entities are decoded in the title',
    results[0].title === 'Illustrious LoRA Training & Discussion',
    results[0].title
  );
  check(
    'markup inside a snippet is stripped, not rendered',
    results[0].snippet === 'Rank 128 is a good default for characters.',
    results[0].snippet
  );
  check('max_results is respected', parseDuckDuckGo(FIXTURE, 1).length === 1);
}

{
  // The contract that matters most: markup this does not recognise yields
  // nothing rather than garbage that would be cited as a source.
  check('unfamiliar markup produces no results', parseDuckDuckGo('<div>hello</div>', 5).length === 0);
  check('an empty page produces no results', parseDuckDuckGo('', 5).length === 0);
  check(
    'a challenge page produces no results',
    parseDuckDuckGo('<html><body>Please verify you are human</body></html>', 5).length === 0
  );
  // A result whose href will not resolve to a real URL is skipped rather than
  // cited as a relative path.
  check(
    'a result with no usable URL is skipped',
    parseDuckDuckGo('<a class="result__a" href="/settings">Settings</a>', 5).length === 0
  );
}

{
  check(
    'a plain absolute URL survives unwrapping',
    unwrapDuckDuckGo('https://example.com/x') === 'https://example.com/x'
  );
  check(
    'a protocol-relative URL gains https',
    unwrapDuckDuckGo('//example.com/x') === 'https://example.com/x'
  );
  check('a javascript: URL is refused', unwrapDuckDuckGo('javascript:alert(1)') === null);
  check('a relative path is refused', unwrapDuckDuckGo('/l/?x=1') === null);
  check('nothing is refused', unwrapDuckDuckGo(undefined) === null);
  check('a malformed URL has no domain', domainOf('not a url') === '');
  check('tags come out of text', stripTags('<b>a</b> <i>b</i>') === 'a b');
}

// ── searxng, which returns JSON ──────────────────────────────
{
  const results = parseSearxng(
    { results: [{ title: 'A', url: 'https://civitai.com/a', content: 'body  text' }] },
    5
  );
  check('searxng results are normalised to the same shape',
    results[0].n === 1 && results[0].domain === 'civitai.com' && results[0].snippet === 'body text',
    JSON.stringify(results[0]));
  check('an empty searxng payload is no results', parseSearxng({}, 5).length === 0);
}

// ── the module, with the network stubbed ─────────────────────
const realFetch = globalThis.fetch;
const stub = (impl) => {
  globalThis.fetch = impl;
};

try {
  {
    const search = createSearch({ search: { enabled: false } });
    const out = await search.run('anything');
    check('switched off, it returns nothing and says why',
      out.ok === false && out.results.length === 0 && /off/i.test(out.detail), JSON.stringify(out));
    check('...and the button is told not to appear', search.info().enabled === false);
  }

  {
    const search = createSearch({ search: { enabled: true, backend: 'duckduckgo' } });
    check('an empty query is refused before any request',
      (await search.run('   ')).detail === 'Nothing to search for.');
  }

  {
    stub(async () => new Response(FIXTURE, { status: 200 }));
    const search = createSearch({ search: { enabled: true, backend: 'duckduckgo', max_results: 5 } });
    const out = await search.run('lora rank');
    check('a good response produces results', out.ok === true && out.results.length === 2);

    // The context block is the citation contract: the numbers the model is
    // told to cite are the numbers the client resolves back to links.
    const context = search.asContext(out);
    check('the context block numbers every result', /\[1\]/.test(context) && /\[2\]/.test(context));
    check('...carries the URLs', context.includes('https://civitai.com/articles/9148/lora'));
    check('...and asks for inline citations', /cite/i.test(context));
    check('no results means no context block rather than an empty one',
      search.asContext({ results: [] }) === null);
  }

  {
    // Every one of these is a real thing that happens to a scraper, and none
    // of them may throw: chat has to answer anyway.
    stub(async () => new Response('nope', { status: 500 }));
    const search = createSearch({ search: { enabled: true, backend: 'duckduckgo' } });
    const out = await search.run('x');
    check('an HTTP error is reported, not thrown', out.ok === false && /500/.test(out.detail), out.detail);

    stub(async () => {
      throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
    });
    const timedOut = await search.run('x');
    check('a timeout is reported, not thrown', timedOut.ok === false && /timed out/i.test(timedOut.detail),
      timedOut.detail);

    stub(async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    });
    const offline = await search.run('x');
    check('a box with no internet is reported, not thrown',
      offline.ok === false && /ENOTFOUND/.test(offline.detail), offline.detail);

    stub(async () => new Response('<html>unfamiliar</html>', { status: 200 }));
    const empty = await search.run('x');
    check('a page it cannot parse reports nothing found',
      empty.ok === false && empty.results.length === 0 && /No results|shape/.test(empty.detail),
      empty.detail);
  }

  {
    // The single most common SearXNG misconfiguration, and it is silent
    // otherwise: JSON output is off by default and the instance answers 403.
    stub(async () => new Response('forbidden', { status: 403 }));
    const search = createSearch({ search: { enabled: true, backend: 'searxng' } });
    const out = await search.run('x');
    check('a SearXNG 403 names the setting that causes it',
      /formats/.test(out.detail), out.detail);
  }

  {
    let seen = null;
    stub(async (url) => {
      seen = String(url);
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });
    const search = createSearch({ search: { enabled: true, backend: 'searxng', base_url: 'http://box:8888/' } });
    await search.run('a b&c');
    check('the query is encoded into the URL', seen.includes('q=a%20b%26c') || seen.includes('q=a+b%26c'), seen);
    check('...against the configured instance, with no doubled slash',
      seen.startsWith('http://box:8888/search?'), seen);
  }
} finally {
  globalThis.fetch = realFetch;
}

if (failures.length) {
  console.log(`${String.fromCharCode(10)}${failures.length} FAILED:`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log(`ALL PASSED (${passed})`);
