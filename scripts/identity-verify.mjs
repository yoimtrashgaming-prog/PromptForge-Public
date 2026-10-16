// Check every group in config/same-person.yaml against danbooru's own wiki.
//
//   node scripts/identity-verify.mjs
//
// Needs a network connection; about one request per listed tag, so a couple
// of minutes. Run it after adding a franchise, before committing.
//
// For each tag after the first in a group, it reads that tag's wiki page and
// looks for a sentence that names ANOTHER member of the group with same-person
// wording: "an alternate version of", "true identity", "younger version". The
// first tag in a group is the base and needs no proof.
//
// Any member counts, not just the first. In a chain like Artoria -> Saber ->
// Saber Alter, Saber Alter's page says "an alternate version of Saber", which
// is proof. An earlier version of this compared only against the first tag and
// reported that as a doubt.
//
// What is left over is worth reading, not necessarily wrong. On 16 Sep 2026 it
// confirmed 177 of 186; the rest were phrasings this pattern lacks ("Saber
// wearing a full body lion costume", "Marie Antoinette's alter form") and the
// look-alikes listed deliberately without being one person — the Tribbie
// triplets, the Arknights Endfield counterparts — where no wiki sentence will
// ever say "same person".

import { loadConfig } from '../server/config.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = { 'User-Agent': 'PromptForge/2.0 (private local tool)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SAME = /\b(alternate|alter ego|incarnation|identity|another name|another version|also known as|second form|form of|human form|dragon form|true (?:form|name|identity)|playable (?:as|under)|genderbend|genderswap|version of|variant|aspect|counterpart|depiction|umbrella|all versions|aged.?(?:up|down)|younger|corrupt\w*|twisted|remodel|clone|persona|crossdressing|chibi|alter.?ego|alias|pseudonym|civilian (?:name|identity)|real name|redesign|skin|as (?:she|he|they) appears|as seen in|visually identical|in \w+(?: \w+){0,3} form|transforms? into|able to transform|used to be)\b/i;

const bare = (t) => (t.includes('_(') ? t.slice(0, t.indexOf('_(')) : t);
const flat = (s) => String(s).toLowerCase().replace(/_/g, ' ');
const namesIt = (sentence, name) => {
  const h = ` ${flat(sentence).replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ')} `;
  return h.includes(` ${name} `) || h.includes(` ${name}'s `);
};

const { config, error } = loadConfig(ROOT, 'same-person');
if (!config) {
  console.error(error ?? 'config/same-person.yaml did not load');
  process.exit(1);
}
const groups = config.same_person ?? [];

let checked = 0;
let confirmed = 0;
const doubts = [];

for (const group of groups) {
  const names = group.map((t) => flat(bare(t)));
  for (let i = 1; i < group.length; i += 1) {
    checked += 1;
    let body = '';
    try {
      const w = await fetch(
        `https://danbooru.donmai.us/wiki_pages.json?search%5Btitle%5D=${encodeURIComponent(group[i])}`,
        { headers: UA, signal: AbortSignal.timeout(25000) }
      ).then((r) => (r.ok ? r.json() : []));
      body = String(w?.[0]?.body ?? '').replace(/\s+/g, ' ');
    } catch { /* treated as no page */ }
    await sleep(330);

    const naming = body.split(/(?<=[.!?])\s/).filter((s) => names.some((n, j) => j !== i && namesIt(s, n)));
    if (naming.length && SAME.test(naming.join(' '))) {
      confirmed += 1;
      continue;
    }
    doubts.push({ tag: group[i], group, line: (naming[0] ?? body).slice(0, 180) });
  }
}

console.log(`\n${groups.length} groups. Confirmed by the wiki: ${confirmed} of ${checked} non-base tags.`);
if (doubts.length) {
  console.log(`\nNo same-person sentence found for ${doubts.length} — read these:`);
  for (const d of doubts) {
    console.log(`\n  ${d.tag}`);
    console.log(`     group: ${d.group.join(', ').slice(0, 150)}`);
    console.log(`     wiki : ${d.line || '(no wiki page)'}`);
  }
}
