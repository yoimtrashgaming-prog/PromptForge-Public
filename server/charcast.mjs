// The cast of a series, for Image Analysis' "Describe it" (22 Sep 2026).
//
// Recognising a character from memory is where the vision model fails: on the
// owner's Frieren picture it described Aura perfectly - purple hair, demon
// horns, braids - and could not name her. Handed the cast of the series the
// tagger had already recognised, the same model named her with the exact tag.
// Choosing from twenty relevant characters by eye is easier than recalling one.
//
// Deliberately NOT a search by looks across every character: prototyped the
// same day, it ranked Aura 278th (26th weighted by rarity) under confident
// wrong answers, and a wrong candidate list steers the model toward a wrong
// name. The series comes from a character the tagger is already sure of.
//
// Data: data/tags/character_series.json (tag -> series, written by
// scripts/import-character-traits.mjs) and the character table's looks.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Framing tags every character carries, which say nothing about who they are.
const NOT_A_LOOK = /^(1girl|1boy|2girls|2boys|solo|multiple_girls|multiple_boys|breasts|large_breasts|medium_breasts|small_breasts)$/;

export function createCharCast({ rootDir, seriesPath, tablePath, minPosts = 50, max = 25, maxLook = 14 }) {
  let series = null; // tag -> series
  let bySeries = null; // series -> [tag]
  let db = null;
  let unavailable = null;

  function load() {
    if (series || unavailable) return;
    const sp = path.resolve(rootDir, seriesPath);
    const tp = path.resolve(rootDir, tablePath);
    if (!existsSync(sp) || !existsSync(tp)) {
      unavailable = `missing ${existsSync(sp) ? tablePath : seriesPath}`;
      return;
    }
    try {
      series = JSON.parse(readFileSync(sp, 'utf8'));
      bySeries = new Map();
      for (const [tag, s] of Object.entries(series)) {
        if (!bySeries.has(s)) bySeries.set(s, []);
        bySeries.get(s).push(tag);
      }
      db = new DatabaseSync(tp, { readOnly: true });
    } catch (err) {
      unavailable = err.message;
      series = null;
    }
  }

  /**
   * The cast of every series the given characters belong to, most-drawn first,
   * each with their usual look. [] when none of them has a known series.
   */
  function castFor(characterTags) {
    load();
    if (!series) return [];
    const row = db.prepare('SELECT traits, posts FROM characters WHERE tag = ?');
    const out = [];
    for (const name of [...new Set(characterTags.map((t) => series[t]).filter(Boolean))]) {
      const members = (bySeries.get(name) ?? [])
        .map((tag) => {
          const r = row.get(tag);
          if (!r || (r.posts ?? 0) < minPosts) return null;
          let look = [];
          try {
            look = JSON.parse(r.traits).map((x) => x.tag).filter((t) => !NOT_A_LOOK.test(t));
          } catch { /* unreadable row */ }
          return look.length ? { tag, posts: r.posts, look: look.slice(0, maxLook) } : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.posts - a.posts)
        .slice(0, max);
      if (members.length > 1) out.push({ series: name, cast: members });
    }
    return out;
  }

  return { castFor, detail: () => unavailable };
}
