// The LTX Director timeline, on a canvas.
//
// A deliberate, close port of WhatDreamsCost's `js/ltx_director.js` — the
// MAIN track of it. The owner's ask, 10 Sep 2026: "copy it as much as
// possible to make it as similar as possible for what i need", and the reason
// is not laziness. His group already uses that node; a builder that behaves
// like it is one they can already drive, and one that merely resembles it is
// worse than either.
//
// **What could not be copied.** His file opens with
//
//     const { app } = window.comfyAPI.app;
//
// and carries ~140 more references to ComfyUI internals: LiteGraph widget
// hiding, node serialization, `this.node.properties`. It also persists every
// bit of state into hidden widgets — `timeline_data`, `local_prompts`,
// `segment_lengths`, `guide_strength`, `audio_data` and five others. None of
// that exists here, so the state layer is ours and the drawing is his.
//
// **What was cut**, at his instruction — MAIN only: the AUDIO track, the
// Motion Guide track, IC-LoRA Input, Retake Mode, playback and the playhead,
// video and audio segments, Guide Strength. PromptForge does not emit
// `timeline_data`, so a control it cannot honour is worse than one it does
// not offer.
//
// **What was copied verbatim**, because these are what make it feel like his
// node rather than like a timeline someone wrote from a screenshot:
//
//   - the geometry constants below, his values and his comment on BLOCK_HEIGHT
//   - frames as the unit, and `x = (frame / totalFrames) * width`
//   - the image fit: letterbox to the block, then TILE horizontally when the
//     picture is narrower than its block, clipped to the segment bounds
//   - the IMAGE badge — 42x16 at 60% black, bold 10px, centred at x+21 — and
//     the filename chip beside it at x+43, 50% black, ellipsised to fit
//   - the ruler's major/minor tick ladder and its 3px/6px tick heights
//   - the gap "+" buttons: 18x18, radius 4, hidden under 32px of room
//   - edge hit-testing at 14px with a 4px core, so a shared edge between two
//     touching segments grabs the JOINT and moves both
//   - the drop ghost: a one-second block centred on the cursor, previewed
//     live while the file is still in the air
//
// Frames in here, seconds at the edges. The server contract is seconds and
// the prompt tells the model seconds, because "0s to 2s" is context a model
// can use and frame 48 is not. `toSeconds()` is the only crossing point.

/* Lifted from his file, values and all. BLOCK_HEIGHT carries his own comment:
   "Increased to make the image timeline area much taller". */
const RULER_HEIGHT = 24;
const BLOCK_HEIGHT = 160;
const HANDLE_HIT_PX = 14;
const HANDLE_CORE = 4;
const MIN_SEGMENT_LENGTH = 6;   // frames
const MAX_THUMBNAIL_DIM = 512;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * A decoded picture, downscaled once for drawing.
 *
 * His node keeps `imgObj` per segment and draws it straight. Ours holds the
 * same thing but capped at MAX_THUMBNAIL_DIM — his constant — because the
 * canvas redraws on every mouse move during a drag and a 4000px source is
 * rescaled on each one.
 */
async function decodeThumbnail(dataUri) {
  const img = new Image();
  img.src = dataUri;
  try {
    await img.decode();
  } catch {
    return null;
  }
  const scale = Math.min(1, MAX_THUMBNAIL_DIM / Math.max(img.naturalWidth, img.naturalHeight));
  if (scale === 1) return img;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * scale));
  c.height = Math.max(1, Math.round(img.naturalHeight * scale));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  // A canvas draws like an image and reports naturalWidth through width/height,
  // so the draw path below does not care which it got.
  c.naturalWidth = c.width;
  c.naturalHeight = c.height;
  return c;
}

/**
 * The timeline.
 *
 * `segments` are `{ id, start, length, image, imageName, brief, _img }` with
 * start and length in FRAMES — his shape, plus our per-segment brief.
 *
 * @param {HTMLElement} host      element to build the canvas into
 * @param {object} opts
 * @param {() => number} opts.frameRate
 * @param {() => number} opts.durationSeconds
 * @param {(segments) => void} opts.onChange   any edit, including selection
 * @param {(index) => void} opts.onSelect
 * @param {() => boolean} opts.acceptsImages   false hides every drop affordance
 * @param {(file) => Promise<{image:string,name:string}|null>} opts.readFile
 */
export function createDirectorTimeline(host, opts) {
  const canvas = document.createElement('canvas');
  canvas.className = 'dt-canvas';
  host.replaceChildren(canvas);
  const ctx = canvas.getContext('2d');

  let segments = [];
  let selected = -1;
  let hoveredGap = -1;
  let drag = null;       // { type, index, dir, grabFrame, initial }
  let ghost = null;      // { start, length } while a file is over the track

  const frameRate = () => Math.max(1, Number(opts.frameRate?.()) || 24);
  const totalFrames = () => Math.max(1, Math.round((Number(opts.durationSeconds?.()) || 5) * frameRate()));
  const width = () => canvas.clientWidth || 1;

  const xOf = (frame) => (frame / totalFrames()) * width();
  const frameOf = (x) => x * (totalFrames() / width());

  /** Seconds, for everything outside this file. */
  const toSeconds = (frames) => Math.round((frames / frameRate()) * 100) / 100;

  // ── layout ───────────────────────────────────────────────────
  const CANVAS_HEIGHT = RULER_HEIGHT + BLOCK_HEIGHT;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = host.clientWidth || 1;
    canvas.style.width = '100%';
    canvas.style.height = `${CANVAS_HEIGHT}px`;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(CANVAS_HEIGHT * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    render();
  }

  // ── the pieces his file draws, in his order ──────────────────

  /** Seconds as his ruler writes them: whole numbers bare, else two decimals. */
  const formatTime = (frames) => {
    const s = frames / frameRate();
    return Number.isInteger(s) ? String(s) : s.toFixed(2);
  };

  function drawRuler() {
    const total = totalFrames();
    const fr = frameRate();
    const w = width();

    // His ladder: pick a major step in seconds that leaves the labels legible,
    // then a minor step under it.
    const seconds = total / fr;
    const majorStep = seconds <= 3 ? 0.5 : seconds <= 8 ? 0.5 : seconds <= 20 ? 1 : seconds <= 60 ? 5 : 10;
    const minorStep = majorStep <= 0.5 ? 0.1 : majorStep <= 1 ? 0.25 : majorStep / 5;
    const majorFrames = majorStep * fr;
    const minorFrames = minorStep * fr;

    ctx.fillStyle = '#444';
    for (let i = 0; i <= Math.floor(total / minorFrames); i++) {
      const frameVal = i * minorFrames;
      if (Math.abs(frameVal % majorFrames) < 0.1) continue;
      ctx.fillRect(Math.floor(xOf(frameVal)), RULER_HEIGHT - 3, 1, 3);
    }

    ctx.font = '9px sans-serif';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= Math.floor(total / majorFrames); i++) {
      const frameVal = i * majorFrames;
      const x = xOf(frameVal);
      ctx.fillStyle = '#aaa';
      ctx.fillRect(Math.floor(x), RULER_HEIGHT - 6, 1, 6);
      if (frameVal > 0 && frameVal < total) {
        ctx.textAlign = 'center';
        ctx.fillText(formatTime(frameVal), x, RULER_HEIGHT / 2);
      }
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = '#aaa';
    ctx.fillText('0', 4, RULER_HEIGHT / 2);

    // His dividers.
    ctx.fillStyle = '#111';
    ctx.fillRect(0, RULER_HEIGHT - 1, w, 1);
    ctx.fillRect(0, RULER_HEIGHT + BLOCK_HEIGHT - 1, w, 1);
  }

  /**
   * One segment block.
   *
   * The fit is his, and it is the thing that makes a block look like his
   * block: letterbox into the box, and when the picture is NARROWER than its
   * block, tile it left and right to fill rather than leaving bars. Clipped to
   * the segment so a tile cannot bleed into its neighbour.
   */
  function drawBlock(seg, isSelected) {
    const startX = xOf(seg.start);
    const pxWidth = xOf(seg.length);
    const src = seg._img;

    ctx.fillStyle = seg.brief?.trim() ? '#232a3a' : '#1c2029';
    ctx.fillRect(startX, RULER_HEIGHT + 1, pxWidth, BLOCK_HEIGHT - 2);

    if (src && src.naturalWidth > 0) {
      const imgRatio = src.naturalWidth / src.naturalHeight;
      const boxRatio = pxWidth / BLOCK_HEIGHT;
      let drawW, drawH, drawX, drawY;
      if (imgRatio > boxRatio) {
        drawW = pxWidth; drawH = pxWidth / imgRatio;
        drawX = startX; drawY = RULER_HEIGHT + (BLOCK_HEIGHT - drawH) / 2;
      } else {
        drawH = BLOCK_HEIGHT; drawW = BLOCK_HEIGHT * imgRatio;
        drawY = RULER_HEIGHT; drawX = startX + (pxWidth - drawW) / 2;
      }

      ctx.save();
      ctx.beginPath();
      ctx.rect(startX, RULER_HEIGHT + 1, pxWidth, BLOCK_HEIGHT - 2);
      ctx.clip();
      ctx.drawImage(src, drawX, drawY, drawW, drawH);
      if (imgRatio <= boxRatio) {
        let leftX = drawX - drawW;
        while (leftX + drawW > startX) { ctx.drawImage(src, leftX, drawY, drawW, drawH); leftX -= drawW; }
        let rightX = drawX + drawW;
        while (rightX < startX + pxWidth) { ctx.drawImage(src, rightX, drawY, drawW, drawH); rightX += drawW; }
      }
      ctx.restore();

      // The IMAGE badge and the filename chip, at his sizes and offsets.
      ctx.save();
      ctx.beginPath();
      ctx.rect(startX, RULER_HEIGHT, pxWidth, BLOCK_HEIGHT);
      ctx.clip();
      ctx.fillStyle = 'rgba(0, 0, 0, 0.60)';
      ctx.fillRect(startX, RULER_HEIGHT + 1, 42, 16);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('IMAGE', startX + 21, RULER_HEIGHT + 9);

      if (seg.imageName && pxWidth > 46) {
        let fname = String(seg.imageName).split(/[/\\]/).pop() || '';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'left';
        const maxW = pxWidth - 42 - 10;
        if (ctx.measureText(fname).width > maxW) {
          while (fname.length > 0 && ctx.measureText(`${fname}…`).width > maxW) fname = fname.slice(0, -1);
          fname += '…';
        }
        const textW = ctx.measureText(fname).width;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.50)';
        ctx.fillRect(startX + 43, RULER_HEIGHT + 1, textW + 8, 16);
        ctx.fillStyle = '#fff';
        ctx.fillText(fname, startX + 47, RULER_HEIGHT + 9);
      }
      ctx.restore();
    }

    // The segment's own line, along the bottom. Not from his node — his puts
    // the prompt only in the textarea below. It is here because ours is the
    // half a person is actually writing, and a timeline of eight identical
    // pictures with no text is unreadable.
    if (seg.brief?.trim()) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(startX, RULER_HEIGHT, pxWidth, BLOCK_HEIGHT);
      ctx.clip();
      let line = seg.brief.trim().replace(/\s+/g, ' ');
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const maxW = pxWidth - 12;
      if (ctx.measureText(line).width > maxW) {
        while (line.length > 0 && ctx.measureText(`${line}…`).width > maxW) line = line.slice(0, -1);
        line += '…';
      }
      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.fillRect(startX, RULER_HEIGHT + BLOCK_HEIGHT - 19, pxWidth, 18);
      ctx.fillStyle = '#e8e8e8';
      ctx.fillText(line, startX + 6, RULER_HEIGHT + BLOCK_HEIGHT - 10);
      ctx.restore();
    }

    // Selection: his white border.
    ctx.strokeStyle = isSelected ? '#fff' : 'rgba(255,255,255,0.18)';
    ctx.lineWidth = isSelected ? 2 : 1;
    ctx.strokeRect(
      startX + ctx.lineWidth / 2,
      RULER_HEIGHT + ctx.lineWidth / 2,
      Math.max(0, pxWidth - ctx.lineWidth),
      BLOCK_HEIGHT - ctx.lineWidth
    );
  }

  /** The empty stretches, and where his "+" goes in each. */
  function gapRegions() {
    const total = totalFrames();
    const w = width();
    const gaps = [];
    let cursor = 0;
    for (const seg of [...segments].sort((a, b) => a.start - b.start)) {
      if (seg.start > cursor) {
        const x0 = (cursor / total) * w;
        const x1 = (seg.start / total) * w;
        gaps.push({ frameStart: cursor, frameEnd: seg.start, centerX: (x0 + x1) / 2, widthPx: x1 - x0 });
      }
      cursor = Math.max(cursor, seg.start + seg.length);
    }
    if (cursor < total) {
      const x0 = (cursor / total) * w;
      gaps.push({ frameStart: cursor, frameEnd: total, centerX: (x0 + w) / 2, widthPx: w - x0 });
    }
    return gaps;
  }

  function drawGaps() {
    if (drag) return;
    const BTN_W = 18;
    const BTN_H = 18;
    const regions = gapRegions();
    for (const [i, gap] of regions.entries()) {
      if (gap.widthPx < BTN_W + 14) continue;
      const hov = hoveredGap === i;
      const cy = RULER_HEIGHT + BLOCK_HEIGHT / 2;
      ctx.beginPath();
      ctx.roundRect(gap.centerX - BTN_W / 2, cy - BTN_H / 2, BTN_W, BTN_H, 4);
      ctx.fillStyle = hov ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.05)';
      ctx.fill();
      ctx.fillStyle = hov ? '#fff' : '#888';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('+', gap.centerX, cy + 1);
    }
  }

  function render() {
    const w = width();
    ctx.clearRect(0, 0, w, CANVAS_HEIGHT);
    ctx.fillStyle = '#141414';
    ctx.fillRect(0, RULER_HEIGHT, w, BLOCK_HEIGHT);

    drawRuler();

    // Selected last, so its border is never drawn under a neighbour — his
    // sort, for his reason.
    const order = segments
      .map((s, i) => ({ s, i }))
      .sort((a, b) => (a.i === selected ? 1 : 0) - (b.i === selected ? 1 : 0));
    for (const { s, i } of order) drawBlock(s, i === selected);

    if (ghost) {
      const startX = xOf(ghost.start);
      const pxWidth = xOf(ghost.length);
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 2;
      ctx.strokeRect(startX + 1, RULER_HEIGHT + 1, Math.max(0, pxWidth - 2), BLOCK_HEIGHT - 2);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(startX, RULER_HEIGHT + 1, pxWidth, BLOCK_HEIGHT - 2);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Drop to Place', startX + pxWidth / 2, RULER_HEIGHT + BLOCK_HEIGHT / 2);
      ctx.restore();
    }

    drawGaps();
  }

  // ── hit testing, his rules ───────────────────────────────────

  const mousePos = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  /**
   * What is under the cursor.
   *
   * His edge logic, including the part that is easy to miss: where two
   * segments TOUCH, the shared edge is a joint. Within 4px of it you grab
   * both and slide the boundary; outside that core but inside 14px you grab
   * whichever segment's side you are on.
   */
  function hitTest(x) {
    const sorted = segments.map((s, i) => ({ ...s, idx: i })).sort((a, b) => a.start - b.start);

    for (let i = 0; i < sorted.length; i++) {
      const seg = sorted[i];
      const startX = xOf(seg.start);
      const endX = startX + xOf(seg.length);
      const prev = sorted[i - 1];
      const next = sorted[i + 1];

      const leftIsJoint = prev && prev.start + prev.length === seg.start;
      if (!leftIsJoint && Math.abs(x - startX) <= HANDLE_HIT_PX) {
        return { type: 'edge', index: seg.idx, dir: 'left' };
      }

      const rightIsJoint = next && next.start === seg.start + seg.length;
      if (rightIsJoint) {
        const dx = x - endX;
        if (Math.abs(dx) <= HANDLE_HIT_PX) {
          if (dx < -HANDLE_CORE) return { type: 'edge', index: seg.idx, dir: 'right' };
          if (dx > HANDLE_CORE) return { type: 'edge', index: next.idx, dir: 'left' };
          return { type: 'joint', leftIndex: seg.idx, rightIndex: next.idx };
        }
      } else if (Math.abs(x - endX) <= HANDLE_HIT_PX) {
        return { type: 'edge', index: seg.idx, dir: 'right' };
      }
    }

    for (const seg of sorted) {
      const startX = xOf(seg.start);
      if (x >= startX && x <= startX + xOf(seg.length)) return { type: 'center', index: seg.idx };
    }
    return null;
  }

  // ── editing ──────────────────────────────────────────────────

  const nextId = () => `seg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  /** Room a segment may occupy without overlapping its neighbours. */
  function boundsFor(index) {
    const me = segments[index];
    let lo = 0;
    let hi = totalFrames();
    for (const [i, s] of segments.entries()) {
      if (i === index) continue;
      if (s.start + s.length <= me.start) lo = Math.max(lo, s.start + s.length);
      else if (s.start >= me.start + me.length) hi = Math.min(hi, s.start);
    }
    return { lo, hi };
  }

  /**
   * Keep `segments` in time order, and keep `selected` pointing at the same
   * block it pointed at before.
   *
   * Load-bearing, not tidiness. The mirror handed to app.js is sorted, and
   * `selected` indexes into this array — so if the two orders ever differ,
   * the segment editor below the track shows a different block from the one
   * with the white border. Dragging a segment past its neighbour is all it
   * takes. Sorting in one place and re-finding by id closes it.
   */
  function reorder() {
    const id = segments[selected]?.id ?? null;
    segments.sort((a, b) => a.start - b.start);
    selected = id == null ? -1 : segments.findIndex((s) => s.id === id);
  }

  function commit() {
    reorder();
    opts.onChange?.(publicSegments());
    opts.onSelect?.(selected);
    render();
  }

  /** The timeline as the rest of the app reads it: seconds, in time order. */
  function publicSegments() {
    return segments
      .map((s) => ({
        id: s.id,
        start: toSeconds(s.start),
        end: toSeconds(s.start + s.length),
        brief: s.brief ?? '',
        image: s.image ?? null,
        imageName: s.imageName ?? null,
      }));
  }

  function addAt(frameStart, frameEnd) {
    const fr = frameRate();
    const length = Math.max(MIN_SEGMENT_LENGTH, Math.min(fr, frameEnd - frameStart));
    segments.push({ id: nextId(), start: Math.round(frameStart), length: Math.round(length), brief: '' });
    selected = segments.length - 1;
    opts.onSelect?.(selected);
    commit();
  }

  // ── events ───────────────────────────────────────────────────

  canvas.addEventListener('mousedown', (e) => {
    const { x, y } = mousePos(e);
    if (y < RULER_HEIGHT) return;

    const regions = gapRegions();
    for (const gap of regions) {
      if (gap.widthPx < 32) continue;
      if (Math.abs(x - gap.centerX) <= 9 && Math.abs(y - (RULER_HEIGHT + BLOCK_HEIGHT / 2)) <= 9) {
        addAt(gap.frameStart, gap.frameEnd);
        return;
      }
    }

    const hit = hitTest(x);
    if (!hit) return;
    const index = hit.type === 'joint' ? hit.leftIndex : hit.index;
    selected = index;
    opts.onSelect?.(selected);
    drag = {
      ...hit,
      grabFrame: frameOf(x),
      initial: segments.map((s) => ({ ...s })),
    };
    render();
  });

  // On the window, not the canvas: a drag that leaves the track still has to
  // track the pointer, and a mouseup outside it still has to end the drag.
  // Named so destroy() can take them off again.
  const onMove = (e) => {
    const { x, y } = mousePos(e);

    if (!drag) {
      // Hover: the "+" highlight and the cursor shape, which is the only
      // thing that says an edge is grabbable before you grab it.
      const regions = gapRegions();
      let g = -1;
      for (const [i, gap] of regions.entries()) {
        if (gap.widthPx < 32) continue;
        if (Math.abs(x - gap.centerX) <= 9 && Math.abs(y - (RULER_HEIGHT + BLOCK_HEIGHT / 2)) <= 9) g = i;
      }
      if (g !== hoveredGap) { hoveredGap = g; render(); }
      if (y >= RULER_HEIGHT && y <= RULER_HEIGHT + BLOCK_HEIGHT) {
        const hit = hitTest(x);
        canvas.style.cursor = !hit ? 'default'
          : hit.type === 'center' ? 'grab'
            : 'ew-resize';
      }
      return;
    }

    e.preventDefault();
    const delta = frameOf(x) - drag.grabFrame;
    const total = totalFrames();

    if (drag.type === 'center') {
      const init = drag.initial[drag.index];
      segments[drag.index] = { ...segments[drag.index], start: init.start };
      const { lo, hi } = boundsFor(drag.index);
      segments[drag.index].start = clamp(
        Math.round(init.start + delta),
        lo,
        Math.min(hi, total) - segments[drag.index].length
      );
    } else if (drag.type === 'edge') {
      const init = drag.initial[drag.index];
      segments[drag.index] = { ...segments[drag.index], start: init.start, length: init.length };
      const { lo, hi } = boundsFor(drag.index);
      if (drag.dir === 'left') {
        const right = init.start + init.length;
        const start = clamp(Math.round(init.start + delta), lo, right - MIN_SEGMENT_LENGTH);
        segments[drag.index].start = start;
        segments[drag.index].length = right - start;
      } else {
        const length = clamp(Math.round(init.length + delta), MIN_SEGMENT_LENGTH, hi - init.start);
        segments[drag.index].length = length;
      }
    } else if (drag.type === 'joint') {
      // Both sides move together, so the two stay touching — the behaviour
      // his 4px core exists to give.
      const L = drag.initial[drag.leftIndex];
      const R = drag.initial[drag.rightIndex];
      const lo = L.start + MIN_SEGMENT_LENGTH;
      const hi = R.start + R.length - MIN_SEGMENT_LENGTH;
      const boundary = clamp(Math.round(L.start + L.length + delta), lo, hi);
      segments[drag.leftIndex] = { ...segments[drag.leftIndex], length: boundary - L.start };
      segments[drag.rightIndex] = { ...segments[drag.rightIndex], start: boundary, length: R.start + R.length - boundary };
    }
    render();
  };

  const onUp = () => {
    if (!drag) return;
    drag = null;
    canvas.style.cursor = 'default';
    commit();
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);

  // ── dropping a picture ───────────────────────────────────────
  //
  // His ghost, and it is worth the code: a one-second block appears under the
  // cursor while the file is still in the air, so you place it by looking
  // rather than by dropping and then fixing.

  canvas.addEventListener('dragover', (e) => {
    if (!opts.acceptsImages?.()) return;
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    const { x } = mousePos(e);
    const total = totalFrames();
    const length = Math.max(MIN_SEGMENT_LENGTH, frameRate());
    const start = clamp(Math.round(frameOf(x) - length / 2), 0, Math.max(0, total - length));
    // Onto an existing block, the drop replaces its picture rather than
    // inserting — so no ghost, and the block highlights instead.
    const over = hitTest(x);
    ghost = over && over.type === 'center' ? null : { start, length };
    if (over && over.type === 'center') selected = over.index;
    render();
  });

  canvas.addEventListener('dragleave', () => {
    if (!ghost) return;
    ghost = null;
    render();
  });

  canvas.addEventListener('drop', async (e) => {
    if (!opts.acceptsImages?.()) return;
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    const placing = ghost;
    ghost = null;

    const { x } = mousePos(e);
    const over = hitTest(x);
    const files = [...e.dataTransfer.files];

    if (over && over.type === 'center') {
      // Replace this block's picture. One file — a second would have nowhere
      // to go that the person aimed at.
      if (files.length > 1) opts.toast?.('One picture per segment — using the first.');
      const read = await opts.readFile(files[0]);
      if (!read) return render();
      const seg = segments[over.index];
      if (!seg) return render();
      seg.image = read.image;
      seg.imageName = read.name;
      seg._img = await decodeThumbnail(read.image);
      selected = over.index;
      opts.onSelect?.(selected);
      return commit();
    }

    // A new block per file, laid end to end from where you dropped, so a
    // multi-select from a folder of stills builds the timeline in one gesture.
    let cursor = placing?.start ?? clamp(Math.round(frameOf(x)), 0, totalFrames());
    const length = placing?.length ?? Math.max(MIN_SEGMENT_LENGTH, frameRate());
    for (const file of files) {
      const read = await opts.readFile(file);
      if (!read) continue;
      const total = totalFrames();
      if (cursor >= total) break;
      const seg = {
        id: nextId(),
        start: cursor,
        length: Math.min(length, total - cursor),
        brief: '',
        image: read.image,
        imageName: read.name,
      };
      seg._img = await decodeThumbnail(read.image);
      segments.push(seg);
      cursor += seg.length;
    }
    selected = segments.length - 1;
    opts.onSelect?.(selected);
    commit();
  });

  // Delete and Backspace, his binding — `ltx_director.js` line 2081:
  //
  //     if ((e.key === "Delete" || e.key === "Backspace")
  //         && this.selectedIndex !== -1 && this._isHovering) {
  //
  // The hover gate is the whole thing, and it is why this is bound to the
  // window rather than to the canvas. The canvas takes no focus — you select
  // a block by clicking, and the click does not leave keyboard focus on it —
  // so a canvas-only keydown would never fire. Bound to the window and
  // ungated, Backspace while typing a segment's line would delete the
  // segment. Hovering the track is what says the timeline is what you are
  // aiming at.
  let hovering = false;
  canvas.addEventListener('mouseenter', () => { hovering = true; });
  canvas.addEventListener('mouseleave', () => { hovering = false; });

  const onKey = (e) => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    if (!hovering || selected < 0) return;
    // Belt and braces over the hover gate: a text field can be focused while
    // the pointer happens to rest over the track, and eating that Backspace
    // would delete a segment mid-sentence.
    const el = document.activeElement;
    if (el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName))) return;
    e.preventDefault();
    segments.splice(selected, 1);
    selected = Math.min(selected, segments.length - 1);
    commit();
  };
  window.addEventListener('keydown', onKey);

  const ro = new ResizeObserver(() => resize());
  ro.observe(host);
  resize();

  return {
    /** Replace the whole timeline. Seconds in, frames held internally. */
    async load(list = []) {
      const fr = frameRate();
      segments = list.map((s) => ({
        id: s.id ?? nextId(),
        start: Math.round((Number(s.start) || 0) * fr),
        length: Math.max(MIN_SEGMENT_LENGTH, Math.round(((Number(s.end) || 0) - (Number(s.start) || 0)) * fr)),
        brief: s.brief ?? '',
        image: s.image ?? null,
        imageName: s.imageName ?? null,
      }));
      for (const seg of segments) if (seg.image) seg._img = await decodeThumbnail(seg.image);
      segments.sort((a, b) => a.start - b.start);
      selected = segments.length ? 0 : -1;
      opts.onSelect?.(selected);
      opts.onChange?.(publicSegments());
      render();
    },
    segments: publicSegments,
    count: () => segments.length,
    selectedIndex: () => selected,
    select(i) { selected = i; render(); },
    /** Edit the selected segment's line, from the textarea below. */
    setBrief(text) {
      const seg = segments[selected];
      if (!seg) return;
      seg.brief = text;
      render();
      opts.onChange?.(publicSegments());
    },
    async setImage(file) {
      const seg = segments[selected];
      if (!seg) return false;
      const read = await opts.readFile(file);
      if (!read) return false;
      seg.image = read.image;
      seg.imageName = read.name;
      seg._img = await decodeThumbnail(read.image);
      commit();
      return true;
    },
    clearImage() {
      const seg = segments[selected];
      if (!seg) return;
      delete seg.image;
      delete seg.imageName;
      delete seg._img;
      commit();
    },
    add() {
      const gaps = gapRegions();
      const gap = gaps.find((g) => g.frameEnd - g.frameStart >= MIN_SEGMENT_LENGTH);
      if (!gap) { opts.toast?.('No room left on the timeline — raise the duration first.'); return; }
      addAt(gap.frameStart, gap.frameEnd);
    },
    remove() {
      if (selected < 0) return;
      segments.splice(selected, 1);
      selected = Math.min(selected, segments.length - 1);
      opts.onSelect?.(selected);
      commit();
    },
    /** The duration changed under us: drop anything past the new end. */
    reflow() {
      const total = totalFrames();
      segments = segments.filter((s) => s.start < total);
      for (const s of segments) s.length = Math.min(s.length, total - s.start);
      segments = segments.filter((s) => s.length >= MIN_SEGMENT_LENGTH);
      selected = Math.min(selected, segments.length - 1);
      commit();
    },
    render,
    destroy() {
      ro.disconnect();
      // All three go, or switching models a few times leaves a stack of dead
      // listeners, each holding a detached canvas and its own segment list.
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    },
  };
}
