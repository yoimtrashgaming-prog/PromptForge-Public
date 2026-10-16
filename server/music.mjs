// h3: a score only when the brief asks for one (owner's rule, 1 Oct 2026).
//
// SKILL.md says so, and a small 4B model ignores it: with a brief
// about reading and waving it wrote a piano score 4 times out of 4, once
// copying the guide's example line word for word. "Was music asked for" is a yes/no fact about the brief, so it is
// decided here and the model's Music segment is replaced when the answer is no.
//
// Generous on purpose. A false "yes" costs what the app did before this (the
// model writes a score); a false "no" deletes music somebody asked for. So
// "rock" and "beat" count even though they are often not about music.

export const MUSIC_WORDS = /\b(music|musical|score|soundtrack|ost|bgm|song|songs|singing|sings|sung|melody|melodies|tune|tunes|lullaby|anthem|piano|guitar|violin|cello|strings|orchestra|orchestral|synth|synths|drums?|percussion|bass ?line|beat|beats|jazz|lo-?fi|hip-?hop|rap|rock|metal|edm|techno|chiptune|choir|chant|hymn|instrumental)\b/i;

/** True when the brief asks for, or plainly implies, music. */
export function briefWantsMusic(brief = '') {
  return MUSIC_WORDS.test(String(brief));
}

/**
 * Set the Music segment to N/A when the brief never mentions music, on a
 * model whose registry entry has `music_only_when_asked`. Returns true when
 * it replaced something.
 */
export function musicOnlyWhenAsked(model, brief, segments = []) {
  if (!model?.music_only_when_asked || briefWantsMusic(brief)) return false;
  const seg = segments.find((s) => s.label === 'Music');
  if (!seg || /^\s*(?:non_diegetic_music:\s*)?N\/A\s*$/i.test(seg.body)) return false;
  seg.body = 'N/A';
  return true;
}
