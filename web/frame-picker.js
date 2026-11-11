// The frame picker, on Image Analysis (2 Nov 2026).
//
// Drop a video on Tab 3 and every frame of it is laid out as a strip to
// scroll through: step frame by frame, pick one, use it as the picture to
// analyse or save it. Several can be picked and saved at once.
//
// **The video never leaves the browser.** The owner's question was where an
// upload would live on the server and when it would be cleared, and the
// answer is that it does not go there at all. The <video> plays an object URL
// for the dropped File, which the browser reads from the person's own disk as
// it needs it; frames are drawn to a canvas on their machine. Closing the
// picker, dropping another file or leaving the page revokes every URL and the
// memory goes with it. Nothing to upload over the tailnet, nothing written on
// the box, nothing to sweep up, and no ffmpeg needed — which the Docker image
// does not have.
//
// **The cost is that a browser seeks by time, not by frame.** So frame i is
// shown at the middle of its slot, (i + 0.5) / fps, which for a constant-rate
// clip — everything ComfyUI writes — lands on the exact frame. The rate and
// the frame count come from the file itself for MP4 and MOV (the sample table
// in the header, read without decoding anything). WebM has no such table, so
// there the rate is measured by playing the clip muted for a moment, and that
// measurement is not reliable everywhere: requestVideoFrameCallback barely
// fires in some embedded browsers. Either way the rate sits in an editable
// box, so a clip it gets wrong can be corrected rather than trusted.
//
// And only what this browser can play can be picked from. MP4 (H.264), WebM
// and most of what ComfyUI writes play everywhere; ProRes does not, and the
// picker says so rather than showing black.

// The strip holds a thumbnail per frame up to this many. Past it, every k-th
// frame gets one so a ten-minute clip does not spend minutes seeking; the
// arrows still step one frame at a time.
const MAX_THUMBS = 2000;
const THUMB_HEIGHT = 90;

// Common rates, so a measurement of 23.98 or 29.96 reads as what the file
// really is. Only snapped when within 1%.
const KNOWN_RATES = [8, 10, 12, 15, 16, 20, 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const once = (target, type) => new Promise((resolve, reject) => {
  const ok = () => { target.removeEventListener('error', bad); resolve(); };
  const bad = () => { target.removeEventListener(type, ok); reject(target.error ?? new Error('media error')); };
  target.addEventListener(type, ok, { once: true });
  target.addEventListener('error', bad, { once: true });
});

/** Seek and wait until the frame at `t` is the one a canvas would draw. */
async function seekTo(video, t) {
  if (Math.abs(video.currentTime - t) < 1e-6 && video.readyState >= 2) return;
  const done = once(video, 'seeked');
  video.currentTime = t;
  await done;
}

// The CLOSEST known rate, not the first within 1%: 30 is within 1% of 29.97,
// and a first-match snap turned a 30 fps clip into 29.97.
function snapRate(fps) {
  let best = null;
  for (const r of KNOWN_RATES) {
    if (Math.abs(fps - r) / r < 0.01 && (best == null || Math.abs(fps - r) < Math.abs(fps - best))) best = r;
  }
  return best ?? Math.round(fps * 100) / 100;
}

/**
 * The clip's frame rate, from the browser's own frame callbacks while it plays
 * muted. The median gap between presented frames is one frame; a dropped
 * frame makes one gap double and the median ignores it. Null when this
 * browser has no requestVideoFrameCallback or nothing played.
 */
async function measureRate(video) {
  if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return null;
  const times = [];
  const wanted = 14;
  await new Promise((resolve) => {
    const stop = setTimeout(resolve, 2500);
    const tick = (_now, meta) => {
      times.push(meta.mediaTime);
      if (times.length >= wanted) { clearTimeout(stop); resolve(); return; }
      video.requestVideoFrameCallback(tick);
    };
    video.requestVideoFrameCallback(tick);
    video.play().catch(() => { clearTimeout(stop); resolve(); });
  });
  video.pause();
  const gaps = [];
  for (let i = 1; i < times.length; i++) {
    const g = times[i] - times[i - 1];
    if (g > 0.001) gaps.push(g);
  }
  if (gaps.length < 3) return null;
  gaps.sort((a, b) => a - b);
  return snapRate(1 / gaps[Math.floor(gaps.length / 2)]);
}

/**
 * Frame count and rate of the first video track of an MP4 or MOV, from its
 * sample table: mdhd's timescale and stts's sample durations. Exact, and
 * costs reading the moov box and nothing else. Null for anything it cannot
 * read — fragmented MP4 (empty stts), a moov past 64 MB, not MP4 at all.
 */
async function mp4Timing(file) {
  const read = async (start, len) => new DataView(await file.slice(start, start + len).arrayBuffer());
  const fourcc = (dv, at) => String.fromCharCode(dv.getUint8(at), dv.getUint8(at + 1), dv.getUint8(at + 2), dv.getUint8(at + 3));

  function* boxes(dv, start, end) {
    let off = start;
    while (off + 8 <= end) {
      let size = dv.getUint32(off);
      let header = 8;
      if (size === 1) { size = Number(dv.getBigUint64(off + 8)); header = 16; }
      else if (size === 0) size = end - off;
      if (size < header || off + size > end) return;
      yield { type: fourcc(dv, off + 4), start: off + header, end: off + size };
      off += size;
    }
  }
  const child = (dv, box, type) => {
    for (const b of boxes(dv, box.start, box.end)) if (b.type === type) return b;
    return null;
  };

  try {
    let off = 0;
    let moov = null;
    while (off + 16 <= file.size) {
      const h = await read(off, 16);
      let size = h.getUint32(0);
      if (size === 1) size = Number(h.getBigUint64(8));
      else if (size === 0) size = file.size - off;
      if (size < 8) return null;
      if (fourcc(h, 4) === 'moov') {
        if (size > 64 * 1024 * 1024) return null;
        const dv = await read(off, size);
        moov = { dv, box: { start: 8, end: size } };
        break;
      }
      off += size;
    }
    if (!moov) return null;
    const { dv } = moov;

    for (const trak of boxes(dv, moov.box.start, moov.box.end)) {
      if (trak.type !== 'trak') continue;
      const mdia = child(dv, trak, 'mdia');
      const hdlr = mdia && child(dv, mdia, 'hdlr');
      if (!hdlr || fourcc(dv, hdlr.start + 8) !== 'vide') continue;
      const mdhd = child(dv, mdia, 'mdhd');
      const stbl = child(dv, child(dv, mdia, 'minf') ?? { start: 0, end: 0 }, 'stbl');
      const stts = stbl && child(dv, stbl, 'stts');
      if (!mdhd || !stts) return null;
      const timescale = dv.getUint8(mdhd.start) === 1
        ? dv.getUint32(mdhd.start + 20)
        : dv.getUint32(mdhd.start + 12);
      const entries = dv.getUint32(stts.start + 4);
      let frames = 0;
      let main = { count: 0, delta: 0 };
      for (let i = 0; i < entries; i++) {
        const count = dv.getUint32(stts.start + 8 + i * 8);
        const delta = dv.getUint32(stts.start + 12 + i * 8);
        frames += count;
        if (count > main.count) main = { count, delta };
      }
      if (!frames || !main.delta || !timescale) return null;
      return { frames, fps: snapRate(timescale / main.delta) };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Frame rate of the first video track of a WebM or MKV, from its TrackEntry's
 * DefaultDuration (nanoseconds per frame). ffmpeg writes it whenever it knows
 * the rate, which covers what ComfyUI saves. There is no frame count in the
 * header, so the caller multiplies out the duration. Null when the field is
 * absent or the file is not Matroska. Reads the first megabyte only — Tracks
 * comes before the first Cluster.
 */
async function webmRate(file) {
  try {
    const bytes = new Uint8Array(await file.slice(0, 1024 * 1024).arrayBuffer());
    const vint = (at, keepMarker) => {
      const first = bytes[at];
      let len = 1;
      while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
      if (len > 8) return null;
      let value = keepMarker ? first : first & (0xff >> len);
      let allOnes = value === (0xff >> len);
      for (let i = 1; i < len; i++) {
        value = value * 256 + bytes[at + i];
        if (bytes[at + i] !== 0xff) allOnes = false;
      }
      return { value, len, unknown: !keepMarker && allOnes };
    };
    const uint = (at, len) => { let v = 0; for (let i = 0; i < len; i++) v = v * 256 + bytes[at + i]; return v; };

    const SEGMENT = 0x18538067, TRACKS = 0x1654ae6b, ENTRY = 0xae, CLUSTER = 0x1f43b675;
    const TYPE = 0x83, DEFAULT_DURATION = 0x23e383;
    if (uint(0, 4) !== 0x1a45dfa3) return null;

    // Walk, stepping INTO the three masters on the way to a TrackEntry and
    // over everything else.
    let at = 0;
    let entry = null;
    while (at < bytes.length - 8) {
      const id = vint(at, true);
      if (!id) return null;
      const size = vint(at + id.len, false);
      if (!size) return null;
      const body = at + id.len + size.len;
      if (id.value === CLUSTER) break;
      if (id.value === SEGMENT || id.value === TRACKS) { at = body; continue; }
      if (id.value === ENTRY) {
        entry = { type: null, ns: null, end: body + size.value };
        at = body;
        continue;
      }
      if (entry && body <= entry.end) {
        if (id.value === TYPE) entry.type = uint(body, size.value);
        if (id.value === DEFAULT_DURATION) entry.ns = uint(body, size.value);
        // Video is TrackType 1. An audio track has a DefaultDuration too
        // (20 ms for Opus), which is why the type has to match.
        if (entry.type === 1 && entry.ns) return snapRate(1e9 / entry.ns);
      }
      if (size.unknown) return null;
      at = body + size.value;
    }
    return null;
  } catch {
    return null;
  }
}

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not encode the frame'))), type, quality));
}

const pad = (n, width) => String(n).padStart(width, '0');
const clock = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;

/**
 * @param {{
 *   mount: HTMLElement,
 *   onUse: (file: File) => void,
 *   sends?: () => {label: string, title?: string, many?: boolean, run: (files: File[]) => void}[],
 *   makeZip: (files: {name: string, data: Uint8Array}[]) => Blob,
 *   toast: (msg: string) => void,
 * }} opts
 *
 * `sends` are the "send this frame to a builder" buttons, asked for each time
 * a clip opens so they follow the model list. A `many` send takes the picked
 * frames, or the current one when nothing is picked.
 */
export function createFramePicker({ mount, onUse, sends = () => [], makeZip, toast }) {
  let state = null; // everything belonging to the open clip, dropped whole on close

  function close() {
    if (!state) return;
    state.cancelled = true;
    for (const url of state.thumbUrls.values()) URL.revokeObjectURL(url);
    for (const v of [state.view, state.scan]) {
      v.pause();
      v.removeAttribute('src');
      v.load(); // releases the decoder and whatever it buffered
    }
    URL.revokeObjectURL(state.url);
    state = null;
    mount.replaceChildren();
    mount.hidden = true;
  }

  function frameTime(i) {
    const t = (i + 0.5) / state.fps;
    // Never past the end: the last frame's middle can fall beyond a duration
    // the container rounded down.
    return Math.min(t, Math.max(0, state.duration - 0.001));
  }

  function baseName() {
    return state.file.name.replace(/\.[^.]+$/, '') || 'video';
  }

  function frameName(i) {
    return `${baseName()}-f${pad(i + 1, String(state.count).length)}.png`;
  }

  /** Frame i at full size, as a PNG File. Drawn from the visible video so the
   *  pixels are the decoder's own, not the thumbnail scaled back up. */
  async function frameFile(i) {
    const v = state.view;
    await seekTo(v, frameTime(i));
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    const blob = await canvasBlob(c, 'image/png');
    // Put the view back where the person was looking.
    if (i !== state.index) await seekTo(v, frameTime(state.index));
    return new File([blob], frameName(i), { type: 'image/png' });
  }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ── Rendering ────────────────────────────────────────────

  function renderShell() {
    const s = state;
    const head = el('div', 'fp-head');
    const title = el('div', 'panel-title', 'Frame picker');
    title.style.margin = '0';
    s.metaEl = el('span', 'fp-meta');
    const fpsLabel = el('label', 'fp-fps');
    fpsLabel.append('fps ');
    s.fpsInput = el('input');
    s.fpsInput.type = 'number';
    s.fpsInput.min = '1';
    s.fpsInput.max = '240';
    s.fpsInput.step = 'any';
    s.fpsInput.title = 'Measured from the clip. Change it if the frame count looks wrong.';
    fpsLabel.append(s.fpsInput);
    const closeBtn = el('button', 'ghost', 'Close');
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', close);
    head.append(title, s.metaEl, fpsLabel, closeBtn);

    const stage = el('div', 'fp-stage');
    s.prevImg = el('img', 'fp-side');
    s.prevImg.alt = 'Previous frame';
    s.nextImg = el('img', 'fp-side');
    s.nextImg.alt = 'Next frame';
    const centre = el('div', 'fp-centre');
    centre.append(s.view);
    s.badge = el('span', 'fp-picked-badge', '✓ Picked');
    s.badge.hidden = true;
    centre.append(s.badge);
    stage.append(s.prevImg, centre, s.nextImg);
    s.prevImg.addEventListener('click', () => go(s.index - 1));
    s.nextImg.addEventListener('click', () => go(s.index + 1));

    const nav = el('div', 'fp-nav');
    const back = el('button', 'ghost', '‹');
    back.type = 'button';
    back.title = 'Previous frame (←, Shift+← for 10)';
    back.addEventListener('click', () => go(s.index - 1));
    const fwd = el('button', 'ghost', '›');
    fwd.type = 'button';
    fwd.title = 'Next frame (→, Shift+→ for 10)';
    fwd.addEventListener('click', () => go(s.index + 1));
    s.posEl = el('span', 'fp-pos');
    nav.append(back, s.posEl, fwd);

    s.strip = el('div', 'fp-strip');
    s.strip.setAttribute('role', 'listbox');
    s.strip.setAttribute('aria-label', 'Frames');
    s.strip.setAttribute('aria-multiselectable', 'true');

    s.progressEl = el('p', 'field-note fp-progress');

    const actions = el('div', 'fp-actions');
    s.useBtn = el('button', 'primary', 'Use this frame');
    s.useBtn.type = 'button';
    s.useBtn.title = 'Make it the picture to analyse (Enter)';
    s.useBtn.addEventListener('click', useCurrent);
    s.pickBtn = el('button', 'ghost', 'Pick');
    s.pickBtn.type = 'button';
    s.pickBtn.title = 'Add or remove this frame from the picked set (Space). Ctrl-click or Shift-click frames in the strip too.';
    s.pickBtn.addEventListener('click', () => togglePick(s.index));
    s.saveBtn = el('button', 'ghost', 'Download frame');
    s.saveBtn.type = 'button';
    s.saveBtn.addEventListener('click', saveCurrent);
    s.savePickedBtn = el('button', 'ghost', 'Download picked');
    s.savePickedBtn.type = 'button';
    s.savePickedBtn.addEventListener('click', savePicked);
    s.clearBtn = el('button', 'ghost', 'Clear picks');
    s.clearBtn.type = 'button';
    s.clearBtn.addEventListener('click', () => { s.picked.clear(); refresh(); });
    actions.append(s.useBtn, s.pickBtn, s.saveBtn, s.savePickedBtn, s.clearBtn);

    // Send to a builder: Wan's first or last frame, h3's pictures.
    s.sendBtns = [];
    const sendRow = el('div', 'fp-actions fp-sends');
    for (const send of sends()) {
      const b = el('button', 'ghost', send.label);
      b.type = 'button';
      if (send.title) b.title = send.title;
      b._send = send;
      b.addEventListener('click', () => sendFrames(b));
      s.sendBtns.push(b);
      sendRow.append(b);
    }

    const note = el('p', 'field-note',
      'The video stays in your browser. Nothing is uploaded, and closing this clears it.');

    mount.replaceChildren(head, stage, nav, s.strip, s.progressEl, actions, ...(s.sendBtns.length ? [sendRow] : []), note);
    mount.hidden = false;
    mount.tabIndex = 0;
  }

  function buildStrip() {
    const s = state;
    s.stride = Math.max(1, Math.ceil(s.count / MAX_THUMBS));
    s.cells = new Map();
    const frag = document.createDocumentFragment();
    for (let i = 0; i < s.count; i += s.stride) {
      const cell = el('button', 'fp-cell');
      cell.type = 'button';
      cell.dataset.index = String(i);
      cell.setAttribute('role', 'option');
      cell.title = `Frame ${i + 1}`;
      cell.style.aspectRatio = `${s.width} / ${s.height}`;
      cell.append(el('span', 'fp-cell-num', String(i + 1)));
      frag.append(cell);
      s.cells.set(i, cell);
    }
    s.strip.replaceChildren(frag);
  }

  function refresh() {
    const s = state;
    if (!s) return;
    s.metaEl.textContent = `${s.file.name} · ${s.width}×${s.height} · ${s.count} frames · ${clock(s.duration)}`;
    s.posEl.textContent = `Frame ${s.index + 1} / ${s.count} · ${clock(frameTime(s.index))}`;
    // A neighbour shows once its thumbnail exists; before that, an empty
    // slot rather than a broken-image icon.
    for (const [img, i] of [[s.prevImg, s.index - 1], [s.nextImg, s.index + 1]]) {
      const url = s.thumbUrls.get(i);
      if (url) img.src = url;
      img.style.visibility = url ? 'visible' : 'hidden';
    }

    const isPicked = s.picked.has(s.index);
    s.badge.hidden = !isPicked;
    s.pickBtn.textContent = isPicked ? 'Unpick' : 'Pick';
    s.savePickedBtn.textContent = `Download picked (${s.picked.size})`;
    s.savePickedBtn.disabled = s.picked.size === 0;
    s.clearBtn.disabled = s.picked.size === 0;
    for (const b of s.sendBtns) {
      if (b._send.many) b.textContent = s.picked.size > 1 ? `${b._send.label} (${s.picked.size})` : b._send.label;
    }

    const near = Math.floor(s.index / s.stride) * s.stride;
    for (const [i, cell] of s.cells) {
      cell.classList.toggle('current', i === near);
      cell.classList.toggle('picked', s.picked.has(i));
      cell.setAttribute('aria-selected', String(s.picked.has(i)));
    }
  }

  async function go(i, { scroll = true } = {}) {
    const s = state;
    if (!s) return;
    s.index = Math.max(0, Math.min(s.count - 1, i));
    refresh();
    if (scroll) {
      const near = Math.floor(s.index / s.stride) * s.stride;
      s.cells.get(near)?.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
    // Held arrow keys queue seeks; a newer one simply replaces the last.
    await seekTo(s.view, frameTime(s.index)).catch(() => {});
  }

  function togglePick(i) {
    const s = state;
    if (s.picked.has(i)) s.picked.delete(i); else s.picked.add(i);
    s.lastPicked = i;
    refresh();
  }

  async function busy(btn, fn) {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Working…';
    try { await fn(); }
    catch (err) { toast(`Could not read that frame: ${err.message}`); }
    finally {
      if (state) { btn.disabled = false; btn.textContent = label; refresh(); }
    }
  }

  function useCurrent() {
    return busy(state.useBtn, async () => onUse(await frameFile(state.index)));
  }

  function sendFrames(btn) {
    const s = state;
    const order = btn._send.many && s.picked.size ? [...s.picked].sort((a, b) => a - b) : [s.index];
    return busy(btn, async () => {
      const files = [];
      for (const i of order) files.push(await frameFile(i));
      btn._send.run(files);
    });
  }

  function saveCurrent() {
    return busy(state.saveBtn, async () => {
      const f = await frameFile(state.index);
      download(f, f.name);
    });
  }

  function savePicked() {
    const s = state;
    if (!s.picked.size) return;
    return busy(s.savePickedBtn, async () => {
      const order = [...s.picked].sort((a, b) => a - b);
      if (order.length === 1) {
        const f = await frameFile(order[0]);
        return download(f, f.name);
      }
      const files = [];
      for (const i of order) {
        if (!state) return;
        const f = await frameFile(i);
        files.push({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) });
      }
      download(makeZip(files), `${baseName()}-frames.zip`);
    });
  }

  // ── Thumbnails, in the background on a second video ─────

  async function scanThumbs(run) {
    const s = state;
    const v = s.scan;
    const c = document.createElement('canvas');
    c.height = THUMB_HEIGHT;
    c.width = Math.max(1, Math.round((THUMB_HEIGHT * s.width) / s.height));
    const ctx = c.getContext('2d');
    const total = s.cells.size;
    let done = 0;
    const started = performance.now();
    for (const [i, cell] of s.cells) {
      if (run.cancelled || s.cancelled || state !== s) return;
      try {
        await seekTo(v, frameTime(i));
        ctx.drawImage(v, 0, 0, c.width, c.height);
        const url = URL.createObjectURL(await canvasBlob(c, 'image/jpeg', 0.8));
        if (run.cancelled || s.cancelled) { URL.revokeObjectURL(url); return; }
        s.thumbUrls.set(i, url);
        const img = el('img');
        img.alt = '';
        img.src = url;
        cell.prepend(img);
      } catch {
        cell.classList.add('failed');
      }
      done++;
      // The frames either side of the one on show appear the moment they exist.
      if (Math.abs(i - s.index) === 1) refresh();
      if (done % 10 === 0 || done === total) {
        s.progressEl.textContent = done === total
          ? (s.stride > 1
            ? `Long clip: the strip shows every ${s.stride}th frame. The arrows still step one at a time.`
            : '')
          : `Reading frames… ${done} / ${total}`;
        if (Math.abs(i - s.index) <= s.stride) refresh();
      }
    }
    s.scanMs = Math.round(performance.now() - started);
    refresh();
  }

  // ── Input ────────────────────────────────────────────────

  function onStripClick(e) {
    const cell = e.target.closest('.fp-cell');
    if (!cell || !state) return;
    const i = Number(cell.dataset.index);
    const s = state;
    if (e.shiftKey && s.lastPicked != null) {
      const [a, b] = [Math.min(s.lastPicked, i), Math.max(s.lastPicked, i)];
      for (let k = a; k <= b; k += s.stride) s.picked.add(k);
      s.lastPicked = i;
      go(i, { scroll: false });
    } else if (e.ctrlKey || e.metaKey) {
      togglePick(i);
      go(i, { scroll: false });
    } else {
      go(i, { scroll: false });
    }
  }

  function onKey(e) {
    if (!state || e.target.closest('input, select, textarea')) return;
    const step = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(state.index - step); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(state.index + step); }
    else if (e.key === 'Home') { e.preventDefault(); go(0); }
    else if (e.key === 'End') { e.preventDefault(); go(state.count - 1); }
    else if (e.key === ' ' && !e.target.closest('button')) { e.preventDefault(); togglePick(state.index); }
    else if (e.key === 'Enter' && !e.target.closest('button')) { e.preventDefault(); useCurrent(); }
  }

  mount.addEventListener('keydown', onKey);
  mount.addEventListener('click', (e) => {
    if (e.target.closest('.fp-strip')) onStripClick(e);
  });

  // ── Open ─────────────────────────────────────────────────

  function setRate(fps) {
    const s = state;
    s.fps = fps;
    // The header's own count when the rate is the header's; a rate typed in
    // by hand can only be multiplied out.
    s.count = s.timing && s.timing.fps === fps
      ? s.timing.frames
      : Math.max(1, Math.round(s.duration * fps));
    s.index = Math.min(s.index, s.count - 1);
    s.picked.clear();
    s.fpsInput.value = String(fps);
    for (const url of s.thumbUrls.values()) URL.revokeObjectURL(url);
    s.thumbUrls.clear();
    buildStrip();
    refresh();
    // A fresh scan per rate. The old one is told to stop and waited for, so
    // two loops never seek the same video at once.
    if (s.scanRun) s.scanRun.cancelled = true;
    const run = { cancelled: false };
    s.scanRun = run;
    const prior = s.scanDone;
    s.scanDone = (async () => {
      await prior?.catch(() => {});
      if (!run.cancelled) await scanThumbs(run);
    })();
    go(s.index);
  }

  async function open(file) {
    close();
    const url = URL.createObjectURL(file);
    const view = document.createElement('video');
    view.className = 'fp-view';
    const scan = document.createElement('video');
    for (const v of [view, scan]) {
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.src = url;
    }
    state = {
      file, url, view, scan,
      fps: 0, count: 0, index: 0, duration: 0, width: 0, height: 0,
      stride: 1, cells: new Map(), thumbUrls: new Map(), picked: new Set(),
      lastPicked: null, cancelled: false, scanRun: null, scanDone: null, timing: null,
    };
    const s = state;
    renderShell();
    s.metaEl.textContent = `${file.name} · loading…`;
    s.useBtn.disabled = true;

    try {
      await Promise.all([once(view, 'loadeddata'), once(scan, 'loadedmetadata')]);
    } catch {
      if (state !== s) return;
      mount.replaceChildren(
        el('div', 'panel-title', 'Frame picker'),
        el('p', 'error-box',
          `This browser cannot play ${file.name}. MP4 (H.264) and WebM work everywhere; ` +
          'ProRes and some HEVC files do not. Re-save it as MP4 and drop it again.'),
      );
      const closeBtn = el('button', 'ghost', 'Close');
      closeBtn.type = 'button';
      closeBtn.addEventListener('click', close);
      mount.append(closeBtn);
      return;
    }
    if (state !== s) return;
    if (!view.videoWidth || !Number.isFinite(view.duration)) {
      mount.replaceChildren(el('p', 'error-box', `${file.name} has no picture this browser can read.`));
      return;
    }
    s.duration = view.duration;
    s.width = view.videoWidth;
    s.height = view.videoHeight;

    s.timing = await mp4Timing(file);
    if (state !== s) return;
    let measured = s.timing?.fps ?? await webmRate(file);
    if (state !== s) return;
    if (measured == null) {
      s.metaEl.textContent = `${file.name} · measuring frame rate…`;
      measured = await measureRate(view);
      if (state !== s) return;
      // A throttled embedded browser delivers about one callback a second and
      // "measures" 1 fps. Nothing anyone renders is that slow.
      if (measured != null && measured < 6) measured = null;
    }
    await seekTo(view, 0).catch(() => {});
    s.useBtn.disabled = false;
    s.fpsInput.addEventListener('change', () => {
      const v = Number(s.fpsInput.value);
      if (state === s && v >= 1 && v <= 240 && v !== s.fps) setRate(v);
    });
    if (measured == null) {
      toast('Could not measure the frame rate — assuming 24. Correct it in the fps box.');
    }
    setRate(measured ?? 24);
    mount.focus({ preventScroll: true });
  }

  return { open, close, isOpen: () => state != null };
}
