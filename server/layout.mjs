// MOSS-Image layout JSON: the canvas its boxes are measured on, the boxes the
// person drew in the Layout Studio, and the mechanical half of the format.
//
// The boxes are absolute pixels with the origin at the canvas centre, so a
// layout only means something at one output size — and the JSON does not say
// which. The size comes from the studio when it is open (its canvas is what
// the person sees), else from the registry per aspect (`layout_canvas`). It
// reaches the model as a Canvas line and is enforced here: fixed fields set,
// boxes rounded, ordered and kept inside the canvas. Judgement — what gets a
// box and where — stays in the prompt file.
//
// When the person drew boxes, those boxes are the layout. The model only
// writes the words; tidyLayout puts every box back exactly as drawn, so a
// model that moves one changes nothing.

export const LAYOUT_SEGMENT = 'Layout JSON';

const MAX_ITEMS = 100;

/** A studio canvas from the request, or null when it is not a usable size. */
function studioSize(layout) {
  const w = Number(layout?.width);
  const h = Number(layout?.height);
  const ok = (v) => Number.isInteger(v) && v >= 128 && v <= 8192 && v % 16 === 0;
  return ok(w) && ok(h) ? [w, h] : null;
}

/** True when this request's mode asks for the layout segment. */
export function wantsLayout(model, controls = {}) {
  return (model?.segments_by_mode?.[controls.mode] ?? model?.segments ?? []).includes(LAYOUT_SEGMENT);
}

/**
 * [width, height] for this request, or null on a model without a layout, or
 * in a mode that does not write one.
 */
export function canvasFor(model, controls = {}) {
  const table = model?.layout_canvas;
  if (!table || !wantsLayout(model, controls)) return null;
  const fromStudio = studioSize(controls.layout);
  if (fromStudio) return fromStudio;
  const size = table[controls.aspect_ratio] ?? table['N/A'];
  return Array.isArray(size) && size.length === 2 ? size : null;
}

/** The person's boxes, cleaned, or [] when they drew none. */
export function drawnItems(model, controls = {}) {
  const size = canvasFor(model, controls);
  const items = controls.layout?.items;
  if (!size || !Array.isArray(items)) return [];
  return items.slice(0, MAX_ITEMS).flatMap((i) => {
    if (!Array.isArray(i?.bbox) || i.bbox.length !== 4) return [];
    return [{
      name: String(i.name ?? '').slice(0, 200),
      label: i.label === 'text' ? 'text' : 'object',
      caption: String(i.caption ?? '').slice(0, 4000),
      ...(i.label === 'text' ? { text: String(i.text ?? '').slice(0, 4000) } : {}),
      bbox: clampBox(i.bbox, size),
    }];
  });
}

function clampBox(bbox, [w, h]) {
  const clamp = (v, lim) => Math.max(-lim, Math.min(lim, Math.round(Number(v) || 0)));
  const [y0, y1] = [clamp(bbox[0], h / 2), clamp(bbox[2], h / 2)].sort((a, b) => a - b);
  const [x0, x1] = [clamp(bbox[1], w / 2), clamp(bbox[3], w / 2)].sort((a, b) => a - b);
  return [y0, x0, y1, x1];
}

/**
 * The lines buildUserMessage sends: the canvas, and the person's boxes when
 * they drew some. [] on a model without a layout.
 */
export function layoutLines(model, controls = {}) {
  const size = canvasFor(model, controls);
  if (!size) return [];
  const [w, h] = size;
  const lines = [
    `Canvas: ${w}×${h} — measure every Layout JSON bbox on this canvas: x from -${w / 2} to ${w / 2}, y from -${h / 2} to ${h / 2}, origin at the centre.`,
  ];
  const drawn = drawnItems(model, controls);
  if (drawn.length) {
    lines.push(
      'The person drew this layout in the Layout Studio. It is the composition: keep every item, in this order, with its label, bbox and text exactly as given, and add none. ' +
        '`name` is what they called the box. Write each caption for its box; where they wrote one, it is their direction — keep what it says and only tighten it. ' +
        'The prose prompt describes this same arrangement.\n' +
        drawn.map((i) => JSON.stringify(i)).join('\n')
    );
  }
  return lines;
}

/**
 * Tidy the Layout JSON segment in place. Returns a warning message when it is
 * not a JSON object, so the person is told rather than handed a block their
 * workflow will reject; otherwise null.
 */
export function tidyLayout(model, controls, segments) {
  const size = canvasFor(model, controls ?? {});
  const seg = segments.find((s) => s.label === LAYOUT_SEGMENT);
  if (!size || !seg) return null;

  const raw = String(seg.body ?? '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let obj;
  try {
    obj = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  } catch {
    obj = null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return 'The Layout JSON did not come back as valid JSON — regenerate, or use the prose prompt on its own.';
  }

  const written = (Array.isArray(obj.items) ? obj.items : []).slice(0, MAX_ITEMS).filter((i) => i && typeof i === 'object');
  const drawn = drawnItems(model, controls ?? {});
  let items;
  if (drawn.length) {
    // The person's boxes, every one, as drawn; the model's words by position.
    items = drawn.map((d, n) => {
      const caption = typeof written[n]?.caption === 'string' && written[n].caption.trim() ? written[n].caption.trim() : d.caption;
      return { label: d.label, caption, ...(d.label === 'text' ? { text: d.text } : {}), bbox: d.bbox };
    });
  } else {
    items = written
      .filter((i) => Array.isArray(i.bbox) && i.bbox.length === 4)
      .map((i) => {
        const label = i.label === 'text' ? 'text' : 'object';
        return {
          label,
          caption: String(i.caption ?? ''),
          ...(label === 'text' ? { text: String(i.text ?? '') } : {}),
          bbox: clampBox(i.bbox, size),
        };
      });
  }

  const { meta, caption, ...rest } = obj.summary && typeof obj.summary === 'object' ? obj.summary : {};
  const summary = {
    meta: Array.isArray(meta) ? meta.map(String) : meta ? [String(meta)] : [],
    ...rest,
    canvas: 'single',
    caption: String(caption ?? ''),
  };
  // Each box on one line, as the guide prints them.
  seg.body = JSON.stringify(
    { summary, items, bbox_coord_space: 'abs_centralized', bbox_format: 'yxyx' },
    null,
    2
  ).replace(/("bbox": )\[\s*([^\]]*?)\s*\]/g, (_, key, nums) => `${key}[${nums.split(/,\s*/).join(', ')}]`);
  return null;
}

/**
 * The studio's Rewrite: one section at a time, the whole scene as context.
 * `base` is prompts/image/moss-rewrite.md, the studio's own instruction; the
 * task line is appended exactly as the studio did it. Throws a message the
 * person can read when the request is not one.
 */
export function rewriteMessages(base, body) {
  const task = body?.task;
  if (task !== 'scene' && task !== 'item') throw new Error('Only prompt rewriting is supported. Geometry cannot be generated or changed.');
  const layout = body.layout;
  if (!layout || typeof layout !== 'object' || !Array.isArray(layout.items)) throw new Error('Global scene context is required.');
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (!description) throw new Error('Write a prompt first.');
  const system =
    base.trim() +
    ' ' +
    (task === 'item'
      ? 'Rewrite ONLY the selected element prompt; do not rewrite other elements or the scene.'
      : 'Rewrite ONLY the global scene prompt; individual element prompts are context and must not be rewritten.');
  const context = {
    section_to_rewrite: description.slice(0, 20000),
    global_scene: layout.summary ?? null,
    all_elements: layout.items.slice(0, MAX_ITEMS),
    selected_element: body.element ?? null,
    canvas_size: { width: body.width, height: body.height },
  };
  return { system, user: JSON.stringify(context) };
}
