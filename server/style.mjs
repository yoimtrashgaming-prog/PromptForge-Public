// A style that is pasted, not written.
//
// Krea2's styles are a user's catalogue, each one a block of prose
// tested on real renders and written to be reused with any subject. Handed to
// the LLM as direction, the block came back paraphrased - and the wording is
// the part that was tested. So on a model with `style_placement: "append"`
// the block goes onto the end of the prompt in code, word for word, where
// Krea2 reads a style anyway. The owner's call, 18 Oct 2026.
//
// The LLM still sees the block, so the scene it writes can agree with it (a
// pebble-mosaic style is not a woman standing in a garden); it is told not to
// restate it. See styleInstruction.

/** The chosen style's block, or null when this model does not paste styles. */
export function pastedStyle(model, controls = {}) {
  if (model?.style_placement !== 'append') return null;
  const value = controls.style ?? model.default_style;
  if (!value || value === 'None') return null;
  const block = Array.isArray(model.styles) ? null : model.styles?.[value];
  return typeof block === 'string' && block.trim() ? block.trim() : null;
}

/** The line buildUserMessage sends in place of the usual Style setting. */
export function styleInstruction(name, block) {
  return (
    `Style: ${name}. This style block is added to the end of your prompt word for word, after you finish:\n` +
    `"${block}"\n` +
    'Write the scene so it agrees with that style, but do not restate, paraphrase or end on it - it is already there.'
  );
}

/** The segment the block is pasted onto: the first that is not commentary. */
function promptSegment(model, segments) {
  const meta = new Set(model.meta_segments ?? []);
  const label = (model.segments ?? []).find((l) => !meta.has(l));
  return segments.find((s) => s.label === label) ?? null;
}

/** `text` without a copy of `block` already in it, tidied at the seam. */
export function stripStyle(text, block) {
  const t = String(text ?? '');
  if (!block || !t.includes(block)) return t;
  return t.split(block).join('').replace(/[ \t]{2,}/g, ' ').replace(/\s+$/, '').replace(/\n{3,}/g, '\n\n');
}

/**
 * Paste the chosen style onto the prompt segment, once. Safe to run again on
 * a result that already carries it - Refine hands the draft back with the
 * block on the end, and the revision gets it re-pasted, never doubled.
 *
 * Returns true when it pasted.
 */
export function pasteStyle(model, controls, segments) {
  const block = pastedStyle(model, controls);
  if (!block) return false;
  const seg = promptSegment(model, segments ?? []);
  if (!seg) return false;
  const body = stripStyle(seg.body, block).trim();
  seg.body = body ? `${body}${/[.!?"')\]]$/.test(body) ? '' : '.'} ${block}` : block;
  return true;
}
