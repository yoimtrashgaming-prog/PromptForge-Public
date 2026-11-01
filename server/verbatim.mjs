// Kept as written (22 Oct 2026): the builder's Custom positive, Custom
// negative and Camera tags arrive in the output exactly as typed, whatever
// the model did with them.
//
// Until now both boxes said "kept verbatim" and only asked: the model was
// told the text must appear, and nothing checked. Worse, the negative cap
// (capExtras in server/negative.mjs, `extra_max: 0` on Illustrious and MOSS)
// counted what a person typed as the model's own additions and cut it, so a
// custom negative on those two never reached the output at all. A rule this
// mechanical is code's job ([[script-it-dont-prompt-it]]).
//
// Runs last, after every pass that edits text, so none of them touches it.

// A new line separates tags too: a model that puts a trigger word on its own
// line has still kept it.
const split = (s) => String(s ?? '').split(/[,\n]/).map((t) => t.trim()).filter(Boolean);
// The same tag spelled with spaces or underscores, or with its parentheses
// escaped by server/parens.mjs, is the same tag.
const norm = (t) => t.toLowerCase().replace(/\\([()])/g, '$1').replace(/[_\s]+/g, ' ').trim();

/** The camera picks' payloads in this model's dialect: Angle, How close, Light from. */
export function cameraPicks(model, controls = {}) {
  const dialect = model.tag_style ? 'tags' : 'prose';
  return [
    model.camera_angles?.[controls.camera_angle]?.[dialect],
    model.camera_shots?.[controls.camera_shot]?.[dialect],
    model.camera_lights?.[controls.camera_light]?.[dialect],
  ].filter(Boolean);
}

/** For a tag model: the tags, spelled the way its tag_style asks. */
function spell(model, tag) {
  return model.tag_style === 'underscore' ? tag.replace(/ /g, '_') : tag;
}

/**
 * Put back what the person typed and the model left out. Edits the segments
 * in place and returns what was added, for the log.
 */
export function keepAsWritten(model, controls = {}, segments = []) {
  const added = [];

  const pos = segments.find((s) => s.label === 'Positive prompt' || s.label === 'Enhanced prompt');
  const positive = String(controls.positive ?? '').trim();
  if (pos && model.tag_style) {
    // Tag by tag: a trigger word the model kept but moved is still there.
    const want = [...split(positive), ...cameraPicks(model, controls).flatMap(split).map((t) => spell(model, t))];
    const have = new Set(split(pos.body).map(norm));
    const missing = want.filter((t) => !have.has(norm(t)) && have.add(norm(t)));
    if (missing.length) {
      pos.body = [pos.body.trim().replace(/,\s*$/, ''), ...missing].filter(Boolean).join(', ');
      added.push(...missing);
    }
  } else if (pos && positive && !pos.body.toLowerCase().includes(positive.toLowerCase())) {
    // Prose: the text as one piece, at the end, where a trigger word goes.
    pos.body = `${pos.body.trim()} ${positive}`.trim();
    added.push(positive);
  }

  const negative = String(controls.negative ?? '').trim();
  if (negative && model.has_negative) {
    const neg = segments.find((s) => s.label === 'Negative prompt');
    if (!neg) {
      // Negative prompt switched off: nothing was asked of the model, so the
      // custom negative is the whole negative.
      segments.push({ label: 'Negative prompt', body: negative });
      added.push(negative);
    } else {
      const have = new Set(split(neg.body).map(norm));
      const missing = split(negative).filter((t) => !have.has(norm(t)) && have.add(norm(t)));
      if (missing.length) {
        neg.body = [neg.body.trim().replace(/,\s*$/, ''), ...missing].filter(Boolean).join(', ');
        added.push(...missing);
      }
    }
  }
  return added;
}
