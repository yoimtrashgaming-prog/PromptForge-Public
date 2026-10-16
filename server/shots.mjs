// h3: how many shots, when the person picks a number (2 Oct 2026).
//
// Reported by a user: "single shot" in the brief still came back as two
// shots. The brief is one voice among several that talk about shots - the
// detail ladder ("One or two shots" at notch 2), the guide's worked example
// with its [Shot 2] - and a phrase in the brief lost to them. A number picked
// on a control is a setting, so it goes out as one, worded to override the
// rest, and the count is checked in code afterwards because the model can
// still miss it.
//
// "Auto" (or no control at all) sends nothing and checks nothing: the model
// decides, as before.

/** The picked count as a number, or null for Auto / nothing picked. */
function pickedShots(controls = {}) {
  const n = Number(controls.shots);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * The count the model is held to: the picked one, or 1 in FL2VA on Auto
 * (11 Oct 2026). MiniMax's guide: "FL2VA generally favors a single shot so the
 * model can interpolate continuously from the first frame to the last frame.
 * Use multiple shots only when they are explicitly specified." Left to itself
 * the 4B cut every FL2VA in two and jumped to the last frame halfway through
 * (3 of 3); told one shot, it wrote the path between the frames (3 of 3).
 */
export function shotCount(controls = {}) {
  return pickedShots(controls) ?? (controls.mode === 'FL2VA' ? 1 : null);
}

/**
 * The per-shot boxes (3 Oct 2026). People were already writing "shot 1 this
 * happens, shot 2 that" into the brief, so picking a number now shows one box
 * per shot. What they type joins the brief as "Shot N: ..." lines, here, before
 * anything reads it - the character lookup and the candidate tags see a name
 * typed into shot 2 the same as one typed into the brief. Empty boxes are
 * skipped, boxes past the picked count are dropped, and Auto folds nothing.
 */
export function foldShotBriefs(brief = '', controls = {}) {
  const text = String(brief ?? '').trim();
  const n = pickedShots(controls);
  const rows = Array.isArray(controls.shot_briefs) ? controls.shot_briefs.slice(0, n ?? 0) : [];
  const lines = rows
    .map((row, i) => [i + 1, String(row ?? '').trim()])
    .filter(([, row]) => row)
    .map(([i, row]) => `Shot ${i}: ${row}`);
  return [text, ...lines].filter(Boolean).join('\n');
}

/** The settings line for the user message, or null when nothing was picked. */
export function shotsLine(controls = {}) {
  const n = shotCount(controls);
  if (!n) return null;
  const override = 'This overrides any shot count in the detail level, the brief or the guide\'s examples.';
  return n === 1
    ? `Shots: 1 — one continuous shot. Write only [Shot 1]: no cuts and no later timestamps. ${override}`
    : `Shots: ${n} — exactly ${n} shots, [Shot 1] to [Shot ${n}], no more and no fewer. ${override}`;
}

const CUT = /(\[Shot\s+\d+\]\s*At\s+)(\d+):(\d+(?:\.\d+)?)/gi;

const stamp = (s) => {
  const t = Math.round(s * 10) / 10;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(3).padStart(6, '0')}`;
};

/**
 * Move cut times that cannot play: at or past the end of the clip, or not
 * after the cut before them. Measured 2 Oct 2026 across eight models at 4 and
 * 5 shots: the 8B and both 4Bs put the last cut ON the final second
 * ("At 00:10.000" in a 10 s clip) in 6 of 24 runs, a shot that never plays;
 * the four large models never did. Arithmetic about its own output is not
 * something a small model does reliably, so code does it.
 *
 * A bad cut goes evenly between the last good one and the next good one (or
 * the end of the clip): [1.8, 4.2, 7.6, 10] in 10 s becomes [..., 7.6, 8.8].
 * Only the timestamp changes; what the shot says is left exactly as written.
 * Edits the segment in place and returns the [from, to] pairs it moved.
 */
export function repairCutTimes(controls = {}, segments = []) {
  const end = Number(controls.duration ?? controls.duration_seconds);
  const seg = segments.find((s) => s.label === 'Detailed description');
  if (!seg || !(end > 0)) return [];
  const cuts = [...seg.body.matchAll(CUT)].map((m) => Number(m[2]) * 60 + Number(m[3]));
  const fixed = [...cuts];
  let prev = 0;
  for (let i = 0; i < cuts.length; ) {
    if (cuts[i] > prev && cuts[i] < end) { prev = cuts[i]; i++; continue; }
    // A run of bad cuts, up to the next one that is good where it stands.
    let j = i;
    while (j < cuts.length && !(cuts[j] > prev && cuts[j] < end)) j++;
    const upper = j < cuts.length ? cuts[j] : end;
    for (let k = i; k < j; k++) fixed[k] = prev + ((upper - prev) * (k - i + 1)) / (j - i + 1);
    prev = fixed[j - 1];
    i = j;
  }
  const moved = cuts.map((c, i) => [c, fixed[i]]).filter(([a, b]) => stamp(a) !== stamp(b));
  if (!moved.length) return [];
  let i = 0;
  seg.body = seg.body.replace(CUT, (whole, head, mm, ss) => {
    const was = Number(mm) * 60 + Number(ss);
    const now = fixed[i++];
    return stamp(was) === stamp(now) ? whole : `${head}${stamp(now)}`;
  });
  return moved.map(([a, b]) => [stamp(a), stamp(b)]);
}

/** The distinct [Shot N] numbers a description uses. */
export function shotsWritten(description = '') {
  return new Set([...String(description).matchAll(/\[Shot\s+(\d+)\]/gi)].map((m) => Number(m[1]))).size;
}

/**
 * A warning when the model wrote a different number of shots than was
 * picked, or null. Only Detailed description carries shots.
 */
export function shotCountWarning(controls = {}, segments = []) {
  // Only a number someone picked: "You asked for 1 shot" would be news to
  // a person who left FL2VA on Auto.
  const n = pickedShots(controls);
  if (!n) return null;
  const seg = segments.find((s) => s.label === 'Detailed description');
  if (!seg) return null;
  const got = shotsWritten(seg.body);
  if (got === n) return null;
  return `You asked for ${n} shot${n === 1 ? '' : 's'} and the model wrote ${got}. Regenerate, or edit the description before you use it.`;
}
