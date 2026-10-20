// PromptForge frontend.
//
// The hard rule this file exists to honour: nothing here names a model.
// Selectors, badges, templates, quality presets, counters and button labels
// all derive from GET /api/models. Adding a model to config/models.yaml plus
// a prompt file and a template file must require no change in this file.
//
// Translation is deliberately NOT threaded through this file. web/i18n.js
// runs a MutationObserver over the document, so every string here and in the
// templates is translated where it lands rather than at the site that writes
// it — which is why adding two languages changed four lines below and nothing
// else. See that file for what it will not translate and why.
import {
  startI18n, setLanguage, uiLanguage, uiLanguages,
} from './i18n.js';
// Which tags are about the character and which are about the photograph. The
// server strips the second kind out of the prompt off this same list — see
// server/imagerefs.mjs and characterCanon — so what is greyed here is exactly
// what does not travel, and a chip cannot be greyed for one reason and dropped
// for another.
import { tagClass, tagFacet, isAppearanceTag, isRoleTag, isGarment, isProp, CLASS_REASON, ROLE_CARRIES_CHARACTER }
  from './appearance.js';
// The LTX Director's MAIN track, ported from WhatDreamsCost's node. Its own
// file because it is a canvas renderer with its own coordinate system and
// hit-testing, and because keeping the ported drawing in one place is what
// makes it checkable against his original.
import { createDirectorTimeline } from './director-timeline.js';
import { startTour } from './tour.js';
import { makeZip, readZip } from './zip.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let REGISTRY = null;      // { defaults, models: [] }
let currentType = 'image';
let currentModel = null;
let templateCache = new Map();
let lastResult = null;    // { segments: [...], referenceRead, simple }
// Structured or Simple, for models that declare `simple_prompt`. Per browser,
// like the node persists it per workflow. See setupPromptStyle().
const PROMPT_STYLE_KEY = 'pf.promptStyle';
let promptStyle = (() => {
  try {
    return localStorage.getItem(PROMPT_STYLE_KEY) === 'simple' ? 'simple' : 'structured';
  } catch {
    return 'structured';
  }
})();
let history = [];         // for undo
// A continued story: every part in order and the one on screen. Null until
// Continue story makes a second part. lastResult is always parts[at].
let story = null;
let generating = false;

// ── toast ────────────────────────────────────────────────────
let toastTimer;
function toast(message, ms = 1700) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// ── a picture, full size ─────────────────────────────────────
// Over the page, from any thumbnail of a picture the person added (12 Oct
// 2026: the tiles are too small to tell which picture is which). A click
// anywhere, the close button or Escape puts it away.
function openPicture(src, caption = '') {
  if (!src) return;
  let view = $('#picture-view');
  if (!view) {
    view = document.createElement('figure');
    view.id = 'picture-view';
    view.className = 'picture-view';
    view.setAttribute('role', 'dialog');
    view.setAttribute('aria-modal', 'true');
    view.setAttribute('aria-label', 'Picture, full size');
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close');
    const img = document.createElement('img');
    img.alt = '';
    const cap = document.createElement('figcaption');
    view.append(close, img, cap);
    view.addEventListener('click', () => { view.hidden = true; });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !view.hidden) view.hidden = true; });
    document.body.appendChild(view);
  }
  $('img', view).src = src;
  $('img', view).alt = caption;
  $('figcaption', view).textContent = caption;
  view.hidden = false;
  $('button', view).focus();
}

function execCommandCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  return ok;
}

async function copyText(text, label = 'Copied') {
  // The async clipboard API needs both a secure context and a focused
  // document, and rejects rather than falling back on its own. Plain http://
  // over the tailnet fails the first condition; a click landing while the
  // window is unfocused fails the second. execCommand covers both, so it is
  // the fallback rather than the alternative branch.
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return toast(label);
    } catch {
      /* fall through */
    }
  }
  try {
    if (execCommandCopy(text)) return toast(label);
  } catch {
    /* fall through */
  }
  toast('Copy failed — select the text and copy manually');
}

// ── status badge ─────────────────────────────────────────────

/**
 * The failure table's UI response for a /api/status payload, returned as data
 * rather than written straight to the DOM, so every row can be checked in
 * scripts/test-app.mjs without a browser. The spec calls these responses
 * required rather than optional; until now they were only ever read.
 *
 * `generate` is deliberately not just `llm.ok`. The model-loading row says
 * requests **queue rather than fail**, and server.mjs implements exactly that
 * — a model_loading error before the first token becomes wait, retry, ceiling
 * 90s. Disabling the button in that state would deny the user the queue that
 * was built for them. Ollama never reports loading through health(), because
 * health() only asks whether the model is installed; a backend whose /models
 * rejects during a load does, and that is the case this covers.
 */
/**
 * What the topbar chip says after the backend name.
 *
 * It used to say `llm.model` — the model named in config/server.yaml — which
 * never changes, so the chip read the same whether the card was empty, holding
 * that model, or holding a different one somebody picked in chat. Reported as
 * "even after unloading or changing model this doesn't change", which was
 * exactly right.
 *
 * Now it reports what is actually resident, because that is the question a
 * status chip is being asked. Ollama reports residency; other backends do not,
 * and for them the configured name is still the true answer since they load
 * one model at start and hold it.
 *
 * "idle" rather than "nothing loaded" for the empty case: it is not a fault,
 * the next request loads a model on its own, and the chip has no room to say
 * so. The On the GPU panel carries the longer explanation.
 */
export function loadedLabel(llm) {
  const resident = llm?.resident;
  // null means this backend cannot report residency, which is different from
  // an empty array meaning nothing is loaded.
  if (!Array.isArray(resident)) return llm?.model ?? 'unknown';
  if (!resident.length) return 'idle';
  if (resident.length === 1) return resident[0].model ?? 'unknown';
  // More than one fits on this card. Naming them all would push the queue
  // depth off the chip, and the panel lists them properly.
  return `${resident.length} models`;
}

export function statusView(s) {
  const llm = s?.llm ?? {};
  const q = s?.queue?.depth ? ` · queue ${s.queue.depth}` : '';
  if (llm.ok) {
    return {
      dot: 'status-dot',
      text: `${llm.backend}${llm.backend === 'mock' ? '' : ` · ${loadedLabel(llm)}`}${q}`,
      title: '',
      generate: true,
    };
  }
  if (llm.code === 'model_loading') {
    return { dot: 'status-dot loading', text: 'Loading model…', title: '', generate: true };
  }
  if (llm.code === 'model_not_installed') {
    // Backend is up; the tag just is not pulled. Say so, rather than sending
    // the user to debug Ollama.
    return {
      dot: 'status-dot error',
      text: `${llm.model} not pulled`,
      title: llm.detail ?? '',
      generate: false,
    };
  }
  return {
    dot: 'status-dot error',
    // Spec wording, and the spec names Ollama. Left alone deliberately: this
    // is only reached when the server sent no detail at all, and health() now
    // always sends one that names the actual backend. Changing it would fail
    // the failure-table conformance test for a string nobody sees.
    text: llm.detail ?? 'Model offline — check Ollama',
    title: '',
    generate: false,
  };
}

/**
 * The offload countdown for the topbar: how long until the card is given back.
 *
 * Everything this needs was already on the wire — `server/llm.mjs` computes
 * `expires_in_seconds` from Ollama's `/api/ps` and `/api/status` has carried
 * it all along. It was only ever rendered in the GPU panel, which is owner-
 * gated admin surface, so the people who actually wanted to know whether the
 * next generate would pay a thirty-second reload could not see it. Moved to
 * the topbar on 26 Aug 2026 on the owner's ask; `residentLine` still shows the
 * longer form in the panel, where there is room for it.
 *
 * A pure function returning data, for the same reason `statusView` is one:
 * every branch below is a state somebody has to be able to assert on without
 * a browser, and the version of this that wrote straight to the DOM had the
 * model-loading row silently wrong for days.
 *
 * Returns { text, title } or null for "say nothing", which is the right answer
 * more often than it looks:
 *
 *   - the backend cannot report residency at all (`resident` is null on
 *     llama.cpp and vLLM, which load one model at start and hold it)
 *   - nothing is loaded, so there is nothing to count down
 *   - the number is missing or nonsensical
 *
 * The clock is NOT read here. The caller passes `now` so the same second can
 * be painted from a fresh poll and from the local tick between polls without
 * the two disagreeing, and so a test can pin it.
 */
const OFFLOAD_PINNED = '-1';
// Beyond this, a countdown is not telling anyone anything they can act on, and
// it is usually Ollama's way of spelling "pinned" — `keep_alive: -1` comes
// back as an expiry years out rather than as a flag.
const OFFLOAD_MAX_SECONDS = 24 * 60 * 60;

export function offloadView(llm, keepAlive, queue, now = Date.now()) {
  const resident = llm?.resident;
  if (!Array.isArray(resident) || !resident.length) return null;

  // While the card is working the countdown is meaningless: Ollama restarts
  // the clock when the request finishes, so a number here would tick toward a
  // moment that is not going to arrive. Say what is true instead.
  if (Number(queue?.running) > 0) {
    return { text: 'in use', title: 'The countdown restarts when the current job finishes.' };
  }

  if (String(keepAlive?.value ?? '') === OFFLOAD_PINNED) {
    return {
      text: 'held',
      title: 'keep_alive is -1, so this model is never unloaded on its own.',
    };
  }

  // The soonest, when more than one model is resident: that is the next time
  // anything changes, and it is the one a person is waiting on.
  let soonest = Infinity;
  for (const entry of resident) {
    const secs = Number(entry?.expires_in_seconds);
    if (Number.isFinite(secs) && secs > 0 && secs < soonest) soonest = secs;
  }
  if (!Number.isFinite(soonest)) return null;
  if (soonest > OFFLOAD_MAX_SECONDS) {
    return { text: 'held', title: 'This model is not scheduled to unload.' };
  }

  return {
    text: formatCountdown(soonest),
    // Deliberately does NOT restate the number. The tooltip is written once
    // per poll and the text ticks every second, so a number in here would be
    // up to ten seconds behind the digits beside it — which is exactly what
    // it did when first written, and reads as two different answers to the
    // same question. It explains the consequence; the text carries the count.
    title: 'Unloads from VRAM when this reaches zero, unless something uses it first. The next generate after that pays a full model load.',
    // So the local tick knows what it is counting toward without re-deriving
    // it from a payload it does not have.
    deadline: now + soonest * 1000,
  };
}

/** m:ss under an hour, h:mm over it. Never a bare number of seconds. */
export function formatCountdown(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s >= 3600) {
    return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}h`;
  }
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Not a backend failure but a page that cannot reach its own server. */
export const SERVER_UNREACHABLE = {
  dot: 'status-dot offline',
  text: 'Server unreachable',
  title: '',
  generate: false,
};

// ── the offload countdown, on screen ─────────────────────────
//
// The poll runs every 10 seconds. A countdown that only moved on the poll
// would sit still for ten seconds and then jump ten, which reads as broken
// rather than as slow. So the number is ticked locally every second and
// RE-SYNCED to the server's on every poll: the local clock never accumulates
// drift, because it is never the source of truth for longer than one poll.
let offloadState = null;

function setOffload(view) {
  offloadState = view;
  paintOffload();
}

function paintOffload() {
  const el = $('#offload-timer');
  if (!el) return;
  if (!offloadState) {
    el.hidden = true;
    el.textContent = '';
    el.title = '';
    return;
  }
  el.hidden = false;
  el.title = offloadState.title ?? '';
  if (!offloadState.deadline) {
    // A word rather than a number — "in use", "held". Nothing to tick.
    el.textContent = offloadState.text;
    el.classList.remove('offload-soon');
    return;
  }
  const left = Math.max(0, (offloadState.deadline - Date.now()) / 1000);
  el.textContent = formatCountdown(left);
  // Under a minute the reload is about to become somebody's problem. Amber,
  // matching every other "you chose this and here is the consequence" state.
  el.classList.toggle('offload-soon', left < 60);
  // At zero, stop counting and wait for the poll to say what actually
  // happened. Ollama may have unloaded, or a request may have arrived in the
  // last second and reset the clock — this cannot tell which, and guessing
  // would put "0:00" on screen next to a model that is still resident.
  if (left <= 0) offloadState = { ...offloadState, deadline: null, text: '—' };
}

async function refreshStatus() {
  const dot = $('#status-dot');
  const text = $('#status-text');
  let view = SERVER_UNREACHABLE;
  let presence;
  let statusPayload;
  try {
    const s = await fetch('/api/status').then((r) => r.json());
    view = statusView(s);
    presence = s.presence;
    statusPayload = s;
    paintLoraTab(s.training?.enabled);
    // The reference vocabulary rides on the poll that already runs rather
    // than costing its own fetch. It is effectively constant, so this is a
    // first-poll fill that keeps working if the server is restarted with
    // ffmpeg newly installed.
    if (s.references?.stream_modes?.length) REFERENCE_STREAM_MODES = s.references.stream_modes;
    if (s.references?.lane_limits) REFERENCE_LANE_LIMITS = s.references.lane_limits;
    if (s.references?.mode_limits) REFERENCE_MODE_LIMITS = s.references.mode_limits;
    if (s.references?.clip_seconds) REFERENCE_CLIP_SECONDS = s.references.clip_seconds;
    if (s.references?.role_labels) REFERENCE_ROLE_LABELS = s.references.role_labels;
    // Assigned unconditionally: "the instruction file went missing" has to be
    // able to travel, or the toggle would linger after the reason for it did.
    SECOND_PASS_AVAILABLE = s.second_pass === true;
    // Assigned unconditionally for the same reason as the two around it: the
    // reader's instruction file being deleted after boot has to be able to
    // travel, or the upload lingers after the thing that reads it is gone.
    DIRECTOR_KEYFRAMES = s.director_keyframes?.enabled === true;
    // Assigned unconditionally, not guarded on truthiness: null means the doc
    // is not on this box, and "not here" has to be able to travel or a doc
    // deleted after boot leaves the help button pointing at nothing.
    REFERENCE_DIRECTOR_DOC = s.references?.director_doc ?? null;
    if (s.media) REFERENCE_MEDIA = s.media;
  } catch {
    // Leave the view as SERVER_UNREACHABLE.
  }
  dot.className = view.dot;
  text.textContent = view.text;
  // Always assigned, so a tooltip from a previous state does not linger.
  text.title = view.title;
  if (presence !== undefined) renderPresence(presence);
  renderPeople(presence, statusPayload?.queue, statusPayload?.llm, statusPayload?.comfyui);
  renderKeepAlive(statusPayload?.keep_alive);
  setRenderPending(statusPayload?.render_pending ?? 0);
  setOffload(
    statusPayload
      ? offloadView(statusPayload.llm, statusPayload.keep_alive, statusPayload.queue)
      : null
  );
  // A server older than the checked-out code. Only ever shown when both
  // commits are known and differ, so it can always be cleared by restarting.
  const stale = $('#stale-warning');
  if (stale) {
    const v = statusPayload?.version;
    stale.hidden = !v?.stale;
    if (v?.stale) {
      stale.title =
        `Running ${v.boot_commit}, but ${v.disk_commit} is checked out. ` +
        'Stop the server and run npm start again to pick up the change.';
    }
  }
  // The chat selector rides on the poll that already runs. It has to: which
  // models are resident changes on its own as Ollama expires an idle one, and
  // a selector that only told the truth at page load would say "loaded" about
  // a model that dropped out of VRAM twenty minutes ago.
  renderChatModels(statusPayload?.llm);
  renderPromptLlm(statusPayload?.llm);
  renderDescribeLlm(statusPayload?.llm);
  renderCaptionLlm(statusPayload?.llm);
  renderEditLlm(statusPayload?.llm);
  setGenerateEnabled(view.generate);
}

/**
 * Who else has the app open, from the status poll that was already running.
 *
 * Deliberately shows other people only — you know whether you are here, and
 * with five users a list that always contains yourself wastes the space. The
 * element hides entirely when nobody else is around rather than saying
 * "0 others", which would be a permanent reminder of being alone.
 */
function renderPresence(presence) {
  const host = $('#presence');
  if (!host) return;
  const others = (presence?.online ?? []).filter((u) => u.username !== presence?.you);
  if (!others.length) {
    host.hidden = true;
    host.innerHTML = '';
    return;
  }
  host.hidden = false;
  host.title = `Also signed in right now: ${others.map((u) => u.username).join(', ')}`;
  host.innerHTML =
    '<span class="presence-dot"></span>' +
    others
      .map((u) => `<span class="presence-name">${escHtml(u.display_name || u.username)}</span>`)
      .join('');
}

/**
 * How recently someone was seen, in words.
 *
 * The server sends `seconds_ago` and counts anyone inside a two-minute window
 * as present, so every number here is small. "Active now" covers the first
 * minute because a person who made a request 40 seconds ago is, for any
 * purpose this list serves, here.
 */
export function lastSeenLabel(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return 'Active now';
  if (n < 60) return 'Active now';
  const minutes = Math.floor(n / 60);
  return `${minutes} min${minutes === 1 ? '' : 's'} ago`;
}

/**
 * The presence payload as rows, ready to render.
 *
 * You come first and are marked, which is the difference between this and the
 * topbar chip: the chip deliberately shows other people only, because it is
 * answering "is anyone else here". A panel headed "Active now" that omitted
 * you would be describing a room you are standing in.
 */
export function presenceRows(presence) {
  const you = presence?.you ?? null;
  const rows = (presence?.online ?? []).map((u) => ({
    username: u.username,
    name: u.display_name || u.username,
    you: u.username === you,
    owner: Boolean(u.is_owner),
    seen: lastSeenLabel(u.seconds_ago),
  }));
  // The server sorts alphabetically; only your own row moves.
  rows.sort((a, b) => (a.you === b.you ? 0 : a.you ? -1 : 1));
  return rows;
}

/**
 * What each person is doing right now, from the inference queue.
 *
 * The queue reports jobs with a username attached, so a row can say "generating
 * an h3 prompt" instead of the panel saying "1 running" and leaving everyone to
 * guess whose. Someone can legitimately have two: one running, one queued
 * behind it. Running wins, because that is the one holding the GPU.
 */
export function jobsByUser(queue) {
  const out = new Map();
  for (const job of queue?.jobs ?? []) {
    if (!job?.user) continue;
    const held = out.get(job.user);
    if (!held || (held.state === 'waiting' && job.state === 'running')) out.set(job.user, job);
  }
  return out;
}

/** Bytes as GB, one decimal. Ollama reports model sizes in bytes. */
export function gb(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `${(n / 1e9).toFixed(1)} GB`;
}

/**
 * How a resident model reads in the panel.
 *
 * `expires_in_seconds` counts down while nobody generates — keep_alive is 15m
 * here — so this is live rather than static. A partial offload is called out
 * because it is the difference between fast and unusably slow, and it is
 * otherwise invisible.
 */
export function residentLine(entry) {
  const bits = [];
  const size = gb(entry?.size_bytes);
  const vram = gb(entry?.vram_bytes);
  if (size) bits.push(size);
  if (size && vram && entry.vram_bytes < entry.size_bytes * 0.95) {
    bits.push(`${vram} on the card — partly on CPU`);
  }
  const secs = Number(entry?.expires_in_seconds);
  if (Number.isFinite(secs) && secs > 0) {
    // Same ceiling and the same reasoning as offloadView: past a day this is
    // not a countdown, it is Ollama spelling "pinned" as an expiry centuries
    // out. Rendered raw it reads "unloads in 153722861 min", which is not
    // wrong so much as meaningless — and it is alarming, because it looks
    // like a number that got away rather than a model that was asked to stay.
    bits.push(
      secs > OFFLOAD_MAX_SECONDS
        ? 'held — not scheduled to unload'
        : secs < 60
          ? `unloads in ${secs}s`
          : `unloads in ${Math.round(secs / 60)} min`
    );
  }
  return bits.join(' · ');
}

/**
 * The line under someone's name when they are holding or waiting on the GPU.
 *
 * Chat and prompt generation share one queue because they share one card, so
 * this has to say which it is — "Generating" against a conversation reads as a
 * prompt nobody asked for. `label` is the registry's display name for a
 * prompt job; a chat job carries the LLM tag it is being answered on, which
 * has no registry entry and falls through to the raw name. That is the point:
 * since the chat model became selectable, "Chatting" without saying on what
 * leaves the panel unable to explain why the card is busy.
 */
export function doingLabel(job, label) {
  if (!job) return null;
  const what = label ? ` · ${label}` : '';
  if (job.state === 'running') {
    const verb = job.kind === 'chat' ? 'Chatting' : job.kind === 'render' ? 'Rendering' : 'Generating';
    return { text: `${verb}${what} · ${job.seconds}s`, waiting: false };
  }
  return { text: `Waiting for the GPU${what}`, waiting: true };
}

// Initials for the avatar. Two words give two letters, one gives one — no
// slicing into the middle of a name, which produces things like "AN" for
// "Anna" and reads as a different person's initials.
function initialsOf(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * The right-edge panel. Fed by the same /api/status poll as everything else,
 * so it is at most ten seconds stale and costs no extra request.
 */
function renderPeople(presence, queue, llm, comfy) {
  const list = $('#people-list');
  const note = $('#people-note');
  const count = $('#people-tab-count');
  if (!list || !note || !count) return;

  const doing = jobsByUser(queue);
  const rows = presenceRows(presence);
  const others = rows.filter((r) => !r.you).length;

  count.textContent = String(others);
  count.classList.toggle('alone', others === 0);

  list.innerHTML = rows
    .map(
      (r) => `
      <div class="people-row${r.you ? ' you' : ''}">
        <div class="people-avatar">${escHtml(initialsOf(r.name))}</div>
        <div class="people-who">
          <div class="people-name">
            <span>${escHtml(r.name)}</span>
            ${r.you ? '<span class="people-chip">you</span>' : ''}
            ${r.owner ? '<span class="people-chip owner">owner</span>' : ''}
          </div>
          <div class="people-seen">${escHtml(r.seen)}</div>
          ${(() => {
            const job = doing.get(r.username);
            if (!job) return '';
            // The registry's label rather than the raw key, and joined with
            // a middot rather than read as "a … prompt": that phrasing needs
            // an article the keys cannot supply, and the first version said
            // "a" in front of a key starting with a vowel.
            const label = job.model
              ? REGISTRY?.models.find((m) => m.key === job.model)?.label ?? job.model
              : null;
            const doingText = doingLabel(job, label);
            if (!doingText) return '';
            return `<div class="people-doing${doingText.waiting ? ' waiting' : ''}">${escHtml(doingText.text)}</div>`;
          })()}
        </div>
      </div>`
    )
    .join('');

  // Three different empty states, because they mean three different things and
  // "nobody here" would be wrong for two of them.
  if (!rows.length) {
    note.hidden = false;
    note.textContent = presence
      ? 'Accounts are off, so nobody is being tracked.'
      : 'Waiting for the server.';
  } else if (others === 0) {
    note.hidden = false;
    note.textContent = 'Just you right now. Anyone who signs in appears here within 10 seconds.';
  } else {
    note.hidden = true;
    note.textContent = '';
  }

  renderMachine(queue, llm, comfy);
  renderQueue(queue);
}

/** Set by applyIdentity. Drives whether the queue rows carry controls. */
let IS_OWNER = false;
// Offload is the one admin action the owner can hand out per account, so it
// gets its own flag rather than riding on IS_OWNER. Courtesy only: the server
// checks the grant on /api/admin/models/unload itself.
let CAN_OFFLOAD = false;
// Tab 2 (TrainFlow): the owner, or an account granted `train` (26 Sep 2026).
let CAN_TRAIN = false;
// Render from PromptForge: the owner, or an account given `render`.
let CAN_RENDER = false;
// LoRA captions: the owner, or an account given `caption` (17 Oct 2026).
let CAN_CAPTION = false;

/**
 * The waiting line, in order, with the owner's controls beside it.
 *
 * Everyone sees the line for the same reason the GPU block exists: five
 * people share one card, and knowing you are third behind a 27B h3 job is the
 * answer to "why is this slow". Only the owner gets the buttons.
 *
 * Deliberately not a priority system. FIFO is right almost always, and this
 * is the override for the case it is not — someone three deep who needs one
 * quick prompt. The alternative to a control is asking people to stop working.
 */
/**
 * The line under the waiting list.
 *
 * Exists because of how this feature was first reported broken: one job
 * waiting, all three controls correctly disabled, and nothing on screen saying
 * why. Reordering a queue of one is meaningless, and a running job cannot be
 * moved at all - it is already on the GPU - so both of those states need a
 * sentence rather than a dead button.
 */
export function queueNote(waitingCount, runningCount, isOwner) {
  if (!waitingCount) return '';
  if (!isOwner) {
    return runningCount
      ? 'Waiting for the job on the GPU to finish.'
      : 'Waiting for the GPU.';
  }
  if (waitingCount === 1) {
    return runningCount
      ? 'Only one job waiting, so there is nothing to reorder. It starts when the job on the GPU finishes - a running job cannot be moved.'
      : 'Only one job waiting, so there is nothing to reorder.';
  }
  return 'Top and the arrows reorder the waiting line. The job already on the GPU cannot be moved.';
}

function renderQueue(queue) {
  const block = $('#queue-block');
  const list = $('#queue-list');
  const note = $('#queue-note');
  if (!block || !list) return;

  const jobs = queue?.jobs ?? [];
  const waiting = jobs.filter((j) => j.state === 'waiting');
  const running = jobs.filter((j) => j.state === 'running');
  if (!waiting.length) {
    block.hidden = true;
    list.replaceChildren();
    if (note) note.hidden = true;
    return;
  }
  block.hidden = false;

  // Why the controls are inert, when they are. Three greyed buttons with no
  // explanation read as broken - which is exactly how this was reported, on a
  // line with one job in it where there is genuinely nowhere to move it.
  if (note) {
    const text = queueNote(waiting.length, running.length, IS_OWNER);
    note.textContent = text;
    note.hidden = !text;
  }

  // Built as nodes rather than an innerHTML string: these rows carry a
  // username and a model key, and this file has already had three innerHTML
  // sites interpolating text the project does not author. Nodes cannot have
  // that bug.
  list.replaceChildren(
    ...waiting.map((job, i) => {
      const row = document.createElement('div');
      row.className = 'queue-row';

      const place = document.createElement('span');
      place.className = 'queue-place';
      place.textContent = String(i + 1);
      row.appendChild(place);

      const who = document.createElement('div');
      who.className = 'queue-who';
      const name = document.createElement('div');
      name.className = 'queue-name';
      name.textContent = job.user ?? 'someone';
      who.appendChild(name);
      // The registry's label rather than the raw key, same as the people rows.
      const label = job.model
        ? REGISTRY?.models.find((m) => m.key === job.model)?.label ?? job.model
        : null;
      const detail = document.createElement('div');
      detail.className = 'queue-detail';
      detail.textContent = [job.kind === 'chat' ? 'chat' : label, `${job.seconds}s`]
        .filter(Boolean)
        .join(' · ');
      who.appendChild(detail);
      row.appendChild(who);

      if (IS_OWNER) {
        const controls = document.createElement('div');
        controls.className = 'queue-controls';
        for (const [direction, glyph, title] of [
          ['front', 'Top', 'Move to the front of the line'],
          ['up', '↑', 'Move up one place'],
          ['down', '↓', 'Move down one place'],
        ]) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'queue-move';
          btn.textContent = glyph;
          btn.title = title;
          // Disabled where it would do nothing. The server clamps rather than
          // erroring, so this is only about not offering a dead click.
          btn.disabled =
            (direction !== 'down' && i === 0) || (direction === 'down' && i === waiting.length - 1);
          // A disabled button with no tooltip is indistinguishable from a
          // broken one. Say which it is.
          if (btn.disabled) {
            btn.title =
              waiting.length === 1
                ? 'Nothing to reorder - this is the only job waiting'
                : direction === 'down'
                  ? 'Already last in the line'
                  : 'Already first in the line';
          }
          btn.addEventListener('click', () => moveQueued(job.id, direction, note));
          controls.appendChild(btn);
        }
        row.appendChild(controls);
      }
      return row;
    })
  );
}

/**
 * Ask the server to move a job. The panel repaints from the response rather
 * than from what it thinks its own click did, because the line can move under
 * it between render and click — that race is the normal case here, not an
 * edge one.
 */
async function moveQueued(id, direction, note) {
  try {
    const res = await rawFetch('/api/admin/queue/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, direction }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // 409 means it started or finished while the panel was open. That is
      // not an error worth a toast — the next poll shows the truth anyway.
      if (note) {
        note.hidden = false;
        note.textContent = data.message ?? `Could not move that job (${res.status}).`;
      }
      return;
    }
    if (note) {
      note.hidden = true;
      note.textContent = '';
    }
    renderQueue(data.queue);
  } catch (err) {
    if (note) {
      note.hidden = false;
      note.textContent = `Could not reach the server — ${err.message}`;
    }
  }
}

/**
 * What is actually in VRAM, and anything queued behind the people above.
 *
 * `resident` is null on every backend except Ollama — llama.cpp and vLLM load
 * one model at start and hold it, so there is nothing to ask and nothing
 * honest to show. The block hides itself rather than inventing a row.
 */
/**
 * What ComfyUI is making, as one line for the On the GPU panel, or null to
 * say nothing (rendering off, or ComfyUI asleep). Asked for 4 Oct 2026: the
 * panel showed the LLM and nothing about the other half of the card's work,
 * so an MMH3 video started in ComfyUI looked like an idle GPU.
 */
export function comfyLine(c) {
  if (!c?.up) return null;
  const b = c.busy;
  if (!b) return { text: 'ComfyUI · idle', busy: false };
  const what = [b.model, b.kind ?? 'picture'].filter(Boolean).join(' ');
  // By sound: "an Illustrious", and "an MMH3" / "an LTX" / "an SDXL", whose
  // first letter is said with a vowel; "a Krea2", "a Flux".
  const article = /^[aeiou]/i.test(what) || /^[FHLMNRSX][A-Z0-9]/.test(what) ? 'an' : 'a';
  const mins = b.seconds >= 60 ? `${Math.floor(b.seconds / 60)} min ${b.seconds % 60}s` : `${b.seconds ?? 0}s`;
  return {
    text: [
      `Generating ${article} ${what} in ComfyUI${b.source === 'promptforge' && b.user ? ` for ${b.user}` : ''}`,
      b.node,
      b.step ? `step ${b.step.value} of ${b.step.max}` : null,
      mins,
      b.source === 'outside' ? 'started in ComfyUI' : null,
      c.pending ? `${c.pending} more queued there` : null,
    ].filter(Boolean).join(' · '),
    busy: true,
  };
}

function renderMachine(queue, llm, comfy) {
  const host = $('#people-machine');
  const out = $('#gpu-resident');
  if (!host || !out) return;

  const resident = llm?.resident;
  if (!Array.isArray(resident)) {
    host.hidden = true;
    return;
  }
  host.hidden = false;

  // Offload everything, for the owner and anyone they have granted it. Sits
  // above the list because it acts on all of it; the per-model X below acts on
  // one row. Hidden rather than disabled when nothing is loaded - a button to
  // unload nothing is noise.
  const all = $('#gpu-offload-all');
  if (all) all.hidden = !CAN_OFFLOAD || !resident.length;

  if (!resident.length) {
    // Not an error state. Ollama drops an idle model on purpose, and the next
    // generate loads it again — the only cost is the wait, which is what the
    // Warm up button is for.
    out.innerHTML =
      '<div class="gpu-empty">Nothing loaded. The next generate will load it, ' +
      'or use Warm up.</div>';
  } else {
    out.innerHTML = resident
      .map((m) => {
        const detail = residentLine(m);
        const name = escHtml(m.model ?? 'unknown');
        // The X needs the offload permission. Hiding it is courtesy — the
        // server checks the grant on /api/admin/models/unload itself.
        const x = CAN_OFFLOAD
          ? `<button class="gpu-offload" data-offload="${name}" type="button"
                     title="Offload this model, freeing its VRAM now">&times;</button>`
          : '';
        return `<div class="gpu-row">
          <div class="gpu-model">${name}</div>
          ${x}
          ${detail ? `<div class="gpu-detail">${escHtml(detail)}</div>` : ''}
        </div>`;
      })
      .join('');
  }

  // Anyone in the queue with no name on them — a probe, a script, a signed-out
  // path. Counted rather than hidden, or the panel disagrees with the depth.
  const anon = (queue?.jobs ?? []).filter((j) => !j.user).length;
  if (anon) {
    out.innerHTML += `<div class="gpu-detail">${anon} job${anon === 1 ? '' : 's'} with no account attached</div>`;
  }

  // The other half of the card's work: ComfyUI, whoever started the job.
  const line = comfyLine(comfy);
  if (line) {
    out.innerHTML += `<div class="gpu-row gpu-comfy${line.busy ? ' busy' : ''}"><div class="gpu-model">${escHtml(line.text)}</div></div>`;
  }
}

/**
 * Offloading, owner only.
 *
 * Delegated on the container, because these rows are rebuilt every ten seconds
 * by the status poll and per-row listeners would be re-bound each time.
 *
 * Both paths confirm first. keep_alive is 15m here because ComfyUI shares the
 * card, so this is usually pressed to take the GPU back — and taking it back
 * while somebody else is mid-generation is exactly the case worth naming
 * before the click rather than after.
 */
// ── how long a model stays in VRAM ───────────────────────────
//
// Owner only, and enforced on /api/admin/models/keep-alive rather than by
// hiding the control. Presets come from /api/status so the labels and the
// server's validator cannot drift apart.

let keepAliveSignature = '';

function renderKeepAlive(keepAlive) {
  const host = $('#gpu-keepalive');
  const sel = $('#gpu-keepalive-select');
  const note = $('#gpu-keepalive-note');
  if (!host || !sel) return;

  host.hidden = !IS_OWNER || !keepAlive;
  if (host.hidden) return;

  const presets = keepAlive.presets ?? [];
  const signature = presets.map((p) => p.value).join(',');
  if (signature !== keepAliveSignature) {
    keepAliveSignature = signature;
    sel.replaceChildren();
    for (const p of presets) {
      const opt = document.createElement('option');
      opt.value = p.value;
      opt.textContent = p.label;
      sel.appendChild(opt);
    }
    // A value set by typing rather than picking - 90s, say - is not in the
    // preset list and would otherwise select the first entry, which would read
    // as the setting having reverted.
    const custom = document.createElement('option');
    custom.value = '__custom__';
    custom.textContent = 'Custom';
    sel.appendChild(custom);
  }

  const current = String(keepAlive.value ?? '');
  const known = presets.some((p) => p.value === current);
  sel.value = known ? current : '__custom__';
  if (!known) {
    sel.options[sel.options.length - 1].textContent = keepAlive.label || current;
  }

  // Only ever explains; never restates the dropdown. The one thing worth
  // saying is what it does NOT do, because that is the surprising part.
  if (note && !note.dataset.dirty) {
    note.className = 'gpu-keepalive-note';
    note.textContent = keepAlive.overridden
      ? 'Set here, and kept across restarts. Applies to the next request - it does not evict what is already loaded.'
      : 'From config/server.yaml. Changing it here keeps across restarts, and applies to the next request rather than evicting what is loaded.';
  }
}

function initKeepAlive() {
  const sel = $('#gpu-keepalive-select');
  const custom = $('#gpu-keepalive-custom');
  const note = $('#gpu-keepalive-note');
  if (!sel) return;

  const say = (text, kind) => {
    if (!note) return;
    note.className = `gpu-keepalive-note${kind ? ` ${kind}` : ''}`;
    note.textContent = text;
    // Held so the next status poll does not wipe the answer half a second
    // after it appears.
    note.dataset.dirty = '1';
    setTimeout(() => delete note.dataset.dirty, 6000);
  };

  const save = async (value) => {
    try {
      const res = await rawFetch('/api/admin/models/keep-alive', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // The server's own words: it is the thing that knows what it accepts.
        say(data.message ?? `Could not set that (${res.status}).`, 'bad');
        return;
      }
      say(`Models now unload after ${data.label.toLowerCase()}.`, 'ok');
      toast(`Unload after ${data.label.toLowerCase()}`);
      if (custom) custom.value = '';
      refreshStatus();
    } catch (err) {
      say(`Could not reach the server - ${err.message}`, 'bad');
    }
  };

  sel.addEventListener('change', () => {
    if (sel.value === '__custom__') {
      // Picking "Custom" is not itself a setting; it points at the box.
      custom?.focus();
      say('Type a duration in the box, then press Enter.', null);
      return;
    }
    save(sel.value);
  });

  custom?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const value = custom.value.trim();
    if (value) save(value);
  });
  // Leaving the box with something typed and unsent is a silent loss, so
  // commit on blur too.
  custom?.addEventListener('blur', () => {
    const value = custom.value.trim();
    if (value) save(value);
  });
}

const BREAK = String.fromCharCode(10, 10);

function initOffload() {
  const out = $('#gpu-resident');
  const all = $('#gpu-offload-all');

  const send = async (body, describe) => {
    try {
      const res = await rawFetch('/api/admin/models/unload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // The backend's own words. A refusal here is Ollama's to explain.
        toast(data.detail || data.message || `Offload failed (${res.status})`);
        return;
      }
      toast(describe(data));
    } catch (err) {
      toast(`Could not reach the server — ${err.message}`);
    } finally {
      // Straight from Ollama rather than from what this click assumed.
      refreshStatus();
    }
  };

  out?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-offload]');
    if (!btn) return;
    const model = btn.dataset.offload;
    if (!confirm(`Offload ${model}?${BREAK}It leaves VRAM now. Anything generating with it finishes first, and the next request loads it again.`)) {
      return;
    }
    btn.disabled = true;
    send({ model }, () => `${model} offloaded`);
  });

  all?.addEventListener('click', () => {
    if (!confirm(`Offload every loaded model?${BREAK}The card is handed back immediately. Anything mid-generation finishes first, and the next request reloads what it needs.`)) {
      return;
    }
    all.disabled = true;
    send({ all: true }, (data) => {
      all.disabled = false;
      const n = data.unloaded?.length ?? 0;
      if (!n) return data.detail === 'nothing was loaded' ? 'Nothing was loaded' : 'Nothing offloaded';
      return `Offloaded ${n} model${n === 1 ? '' : 's'}`;
    });
  });
}

function togglePeople(open) {
  const panel = $('#people-panel');
  const tab = $('#people-tab');
  if (!panel || !tab) return;
  const next = open ?? panel.hidden;
  panel.hidden = !next;
  tab.setAttribute('aria-expanded', String(next));
}

function setGenerateEnabled(ok) {
  const btn = $('[data-bind="generate"]');
  if (btn) btn.disabled = !ok || generating;
}

// ── registry-driven UI ───────────────────────────────────────
function modelsOfType(type) {
  return REGISTRY.models.filter((m) => m.type === type);
}

// The quality preset, remembered across model switches and starting at None.
//
// Session state rather than a saved preference: it follows you while you work
// and starts clean next time. The registry's default_quality_preset is still
// what a preset MEANS for each model; this is only which one is selected.
let qualityPreset = '';
// Where that choice sat in its own model's list, captured at selection time.
let qualityPresetIndex = -1;
let QUALITY_PRESET_KEYS = [];

/**
 * Which preset to select after a model switch.
 *
 * fillSelect has just marked the registry's default as selected, which is
 * right on a first visit and wrong every time after: switching from
 * Illustrious to Pony would put a ladder back even though you had turned it
 * off.
 *
 * Three rules, in order:
 *
 * 1. **None stays None.** Never turn a deliberate "no quality tags" into tags.
 * 2. **The same name wins** where the new model has it. Illustrious, SDXL and
 *    Anima share masterpiece / standard, so most switches are exact.
 * 3. **Otherwise, the same position.** Pony's presets are score ladders with
 *    their own names - `standard_ladder`, `extended_ladder` - so nothing
 *    matches by name, and falling to None would mean picking a ladder again on
 *    every switch. Position carries the intent that survives translation:
 *    second in the list is the stronger option in both vocabularies.
 *
 * `hasRegistryNone` is SDXL, which declares its own empty preset called
 * `none`; there the empty value is spelled `none` instead of ''.
 */
export function presetForModel(remembered, rememberedIndex, keys, hasRegistryNone = false) {
  const noneValue = hasRegistryNone ? 'none' : '';
  if (!remembered || remembered === 'none') return noneValue;
  if (keys.includes(remembered)) return remembered;

  // Same position. The index is captured when the choice is MADE, not read off
  // the current model - by the time this runs the key list has already been
  // replaced with the new model's, so looking the name up here would always
  // miss. That was a real bug in the first cut of this function.
  if (Number.isInteger(rememberedIndex) && rememberedIndex >= 0 && keys[rememberedIndex]) {
    return keys[rememberedIndex];
  }
  return noneValue;
}

function fillSelect(el, values, selected, labelFn = String) {
  if (!el) return;
  el.innerHTML = '';
  for (const v of values) {
    const opt = document.createElement('option');
    opt.value = String(v);
    opt.textContent = labelFn(v);
    if (String(v) === String(selected)) opt.selected = true;
    el.appendChild(opt);
  }
}

const prettify = (s) =>
  String(s).replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

async function loadTemplate(name) {
  if (templateCache.has(name)) return templateCache.get(name);
  const html = await fetch(`/templates/${name}.html`).then((r) => {
    if (!r.ok) throw new Error(`template ${name} failed to load (${r.status})`);
    return r.text();
  });
  templateCache.set(name, html);
  return html;
}

// ── what the person set up, per model ────────────────────────
//
// The brief is carried to whatever model comes next (see renderBuilder); this
// is the rest of the builder, and it is carried back only to the SAME model.
// Reported 11 Sep 2026 by a user: pictures in the h3 Director, a detour to
// an image model, and back to h3 with an empty panel — "the brief is the only
// part that is saved". Per model, because a Director setup means nothing to
// Anima. Output still clears on every switch; this is input only. Held in
// memory for the life of the tab, not saved: a File cannot go into
// localStorage, and a reload starting clean is the expected thing.
const builderStash = new Map();

// The Cast list's cards, per model like builderStash: Map(model key -> Map(character number -> card)).
// See the Cast list in setupReferences.
const castStash = new Map();
const CAST_MAX = 600;
function castStateFor(key) {
  if (!castStash.has(key)) castStash.set(key, new Map());
  return castStash.get(key);
}

function stashBuilder(key, mount) {
  // Controls by data-bind, counted first so a name used more than once (one
  // per card) is skipped rather than restored into the wrong card. The clip
  // editor and the tiles are left out: the editor's fields write into
  // whichever tile is selected, and the tiles carry their own values below.
  const els = $$('input[data-bind], select[data-bind], textarea[data-bind]', mount)
    .filter((el) => el.type !== 'file' && el.dataset.bind !== 'brief' &&
      !el.closest('.mmd-tile, [data-bind="clip_editor"]'));
  const count = new Map();
  for (const el of els) count.set(el.dataset.bind, (count.get(el.dataset.bind) ?? 0) + 1);
  const controls = {};
  for (const el of els) {
    if (count.get(el.dataset.bind) !== 1) continue;
    controls[el.dataset.bind] =
      el.type === 'checkbox' || el.type === 'radio' ? { checked: el.checked } : { value: el.value };
  }

  // Director tiles. The File is what makes one rebuildable. Previews are
  // released here because the rebuild drops these nodes, and a blob URL
  // outlives its element.
  const refs = [];
  for (const t of $$('.mmd-tile', mount)) {
    if (t._file) {
      refs.push({ file: t._file, data: { ...t.dataset }, encoded: t._encoded ?? null });
    }
    releasePreviews(t);
  }
  builderStash.set(key, { controls, refs });
}

/** Put the stashed controls back. Only where the value differs, so a control
 *  that is already right (a preset carried globally, a segment toggle read
 *  from the account) fires nothing, and a select only takes a value it still
 *  offers. The events are what lets each control's own handler catch up. */
function restoreControls(mount, stash) {
  for (const [bind, saved] of Object.entries(stash?.controls ?? {})) {
    const els = $$(`[data-bind="${bind}"]`, mount);
    if (els.length !== 1) continue;
    const el = els[0];
    if ('checked' in saved) {
      if (el.checked === saved.checked) continue;
      el.checked = saved.checked;
    } else {
      if (el.value === saved.value) continue;
      if (el.tagName === 'SELECT' && ![...el.options].some((o) => o.value === saved.value)) continue;
      el.value = saved.value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

// The per-shot boxes (3 Oct 2026). People were writing "shot 1 this happens,
// shot 2 that" into the brief, so a template with a shot_briefs block shows one
// box per picked shot, and none on Auto. The server folds them into the brief -
// see foldShotBriefs() in server/shots.mjs. Kept here rather than in the DOM so
// changing the count, or switching model and back, does not lose what was typed.
let shotBriefs = [];

function renderShotBriefs(mount) {
  const block = $('[data-bind="shot_briefs"]', mount);
  const select = $('[data-bind="shots"]', mount);
  if (!block || !select) return;
  const n = Number(select.value);
  const count = Number.isInteger(n) && n > 0 ? n : 0;
  block.replaceChildren();
  block.hidden = !count;
  for (let i = 0; i < count; i++) {
    const label = document.createElement('label');
    label.className = 'field shot-brief';
    const name = document.createElement('span');
    name.textContent = `Shot ${i + 1}`;
    const box = document.createElement('textarea');
    box.rows = 2;
    box.placeholder = count === 1 ? 'What happens in the shot' : `What happens in shot ${i + 1}`;
    box.value = shotBriefs[i] ?? '';
    box.addEventListener('input', () => { shotBriefs[i] = box.value; });
    label.append(name, box);
    block.append(label);
  }
}

/** What is typed in the visible shot boxes, in order; empty when there are none. */
function readShotBriefs() {
  const block = $('[data-bind="shot_briefs"]', $('#builder-mount'));
  return block && !block.hidden ? $$('textarea', block).map((el) => el.value) : [];
}

async function renderBuilder(model) {
  const mount = $('#builder-mount');

  // What the person has typed, carried across the rebuild.
  //
  // Each model has its own template, so switching one replaces this whole
  // subtree and the <textarea> goes with it. Reported 27 Aug 2026: type a
  // brief, switch model, lose the brief. Clearing the OUTPUT on a switch is
  // deliberate and required — "a user must never see one model's result
  // sitting under another model's name" — but the brief is not output. It is
  // the thing they came to write, and switching target is the most ordinary
  // reason to want it kept: the same idea, aimed at a different model.
  //
  // Read before the innerHTML assignment, because after it the old node is
  // gone. Empty on first render, which restores to empty and changes nothing.
  const carried = $('[data-bind="brief"]', mount)?.value ?? '';

  // Everything else, kept per model — see builderStash.
  if (mount.dataset.model) stashBuilder(mount.dataset.model, mount);
  const stash = builderStash.get(model.key) ?? null;

  mount.innerHTML = await loadTemplate(model.template);
  mount.dataset.model = model.key;

  if (carried) {
    const brief = $('[data-bind="brief"]', mount);
    if (brief) {
      brief.value = carried;
      // Anything keyed to the brief — the generate button's enabled state, a
      // counter — listens for input rather than reading on a timer, and a
      // programmatic assignment fires nothing on its own.
      brief.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  $('#builder-title').textContent = `Build · ${model.label}`;
  // Image models only — owner's call, 5 Sep 2026. Gated on `type` from the
  // registry, so this names no model and a seventh image model inherits it.
  // The video models want timed shots and camera moves, which a bag of
  // Danbooru appearance tags is the wrong shape for.
  const rbtn = $('#btn-randomizer');
  if (rbtn) rbtn.hidden = model.type !== 'image';
  const badge = $('#format-badge');
  badge.textContent = model.format_label;
  badge.className = `badge ${model.badge ?? ''}`;

  // Buttons and selects, all from the registry entry.
  const gen = $('[data-bind="generate"]', mount);
  if (gen) {
    gen.textContent = model.gen_button ?? 'Generate';
    gen.className = 'primary';
    gen.addEventListener('click', () => {
      // The panel gives the slot back before the first token arrives. The
      // read-back has done its job by the time somebody presses this, and
      // watching a prompt stream in is the thing they pressed it for.
      closeReadback();
      generate();
    });
  }

  QUALITY_PRESET_KEYS = Object.keys(model.quality_presets ?? {});
  if (model.quality_presets) {
    fillSelect(
      $('[data-bind="quality_preset"]', mount),
      Object.keys(model.quality_presets),
      model.default_quality_preset,
      prettify
    );
    // "None", added 22 Aug 2026. Not a registry preset - it is the absence of
    // one - so it is added here rather than invented in models.yaml, and its
    // empty value means collectControls sends quality_preset: false. The
    // server turns that into an explicit instruction, because a model asked
    // for a prompt with no guidance about quality tags adds its own.
    const q = $('[data-bind="quality_preset"]', mount);
    if (q) {
      // SDXL already declares a registry preset called `none`, an empty tag
      // list. Appending a second entry labelled None would put two of them in
      // one dropdown, so the registry's own wins where it exists - it means
      // the same thing and it is the model's own vocabulary.
      const hasRegistryNone = QUALITY_PRESET_KEYS.includes('none');
      if (!hasRegistryNone) {
        const none = document.createElement('option');
        none.value = '';
        none.textContent = 'None';
        q.appendChild(none);
      }

      q.value = presetForModel(qualityPreset, qualityPresetIndex, QUALITY_PRESET_KEYS, hasRegistryNone);
      if (!q.dataset.bound) {
        q.addEventListener('change', () => {
          qualityPreset = q.value;
          qualityPresetIndex = QUALITY_PRESET_KEYS.indexOf(q.value);
        });
        q.dataset.bound = '1';
      }
    }
  }
  fillSelect($('[data-bind="source_tag"]', mount), model.source_tags ?? [], model.default_source_tag);
  // `styles` is a label -> tag-list map on the models that carry tags (anima),
  // a label -> prose block map on krea2 (pasted by server/style.mjs), and may
  // be a plain array of labels. The selector
  // only ever shows the labels, so both shapes collapse to the same list here
  // - exactly how quality_presets is read a few lines up. The tags do reach
  // the client in the registry payload, same as the quality ladders; nothing
  // renders them, and it is the server that expands the chosen one.
  const styleOptions = Array.isArray(model.styles)
    ? model.styles
    : Object.keys(model.styles ?? {});
  fillSelect($('[data-bind="style"]', mount), styleOptions, model.default_style);
  fillSelect($('[data-bind="aspect_ratio"]', mount), model.aspect_ratios ?? [], model.default_aspect_ratio);
  fillSelect($('[data-bind="mode"]', mount), model.modes ?? [], model.default_mode);
  fillSelect($('[data-bind="duration"]', mount), model.durations ?? [], model.default_duration, (d) => `${d} sec`);
  fillSelect($('[data-bind="shots"]', mount), model.shot_counts ?? [], model.default_shots);
  $('[data-bind="shots"]', mount)?.addEventListener('change', () => renderShotBriefs(mount));
  renderShotBriefs(mount);
  fillSelect($('[data-bind="quality_mode"]', mount), model.quality_modes ?? [], model.default_quality_mode);
  fillSelect($('[data-bind="i2v_mode"]', mount), model.i2v_modes ?? [], model.default_i2v_mode);
  fillSelect($('[data-bind="director_frame_rate"]', mount),
    model.director_frame_rates ?? [], model.director_default_frame_rate, (f) => `${f} fps`);
  fillSelect($('[data-bind="model_size"]', mount), model.model_sizes ?? [], model.default_model_size);
  fillSelect($('[data-bind="frame_count"]', mount), model.frame_counts ?? [], model.default_frame_count);
  renderSliders(mount, model);
  // Template fields the registry switches on and off. Hidden is enough to
  // stop them being sent: collectControls skips anything inside [hidden].
  const audioField = $('[data-bind="audio"]', mount)?.closest('label');
  if (audioField) audioField.hidden = !model.supports_audio;
  for (const trait of ['keep', 'drop']) {
    const field = $(`[data-bind="${trait}"]`, mount)?.closest('label');
    if (field) field.hidden = !(model.reference_traits ?? []).includes(trait);
  }

  const neg = $('[data-bind="negative"]', mount);
  if (neg) neg.value = model.negative_defaults ?? '';

  const thinking = $('[data-bind="thinking"]', mount);
  if (thinking) thinking.checked = Boolean(model.thinking);

  setupTagBuilder(mount, model);

  const layerHints = $('[data-bind="layer_hints"]', mount);
  if (layerHints && model.layers) {
    layerHints.innerHTML = model.layers.map((l) => `<li>${l}</li>`).join('');
  }

  // H3 reference roles. The row lives inside a <template>, whose content is
  // a separate document fragment — querySelectorAll on the mount does not
  // reach it, so populate the fragment itself and every already-cloned row.
  // h3's clip tiles hold no role select of their own — the Director panel has
  // one shared editor — so the only host left is the mount. The template lookup
  // stays for any model that still uses a per-row select.
  const roleHosts = [
    ...$$('template[data-bind="reference_row"]', mount).map((t) => t.content),
    mount,
  ];
  for (const host of roleHosts) {
    for (const sel of host.querySelectorAll('[data-bind="role"]')) {
      fillSelect(sel, model.reference_roles ?? [], null, prettify);
    }
  }

  setupReferences(mount, model, stash?.refs);
  setupImageReference(mount, model);
  // Tab 3's "send as reference" selectors read the same registry vocabulary,
  // and its button's enabled state depends on whether THIS template has a
  // reference list — so both follow the model switch rather than being set
  // once at boot.
  fillAnalysisReferenceControls();
  analysisSetEnabled();
  setupI2vReference(mount, model);
  setupDirector(mount, model);
  setupPromptStyle(mount, model);

  // Tips panel, derived from registry flags rather than named models.
  const tips = $('[data-bind="tips"]', mount);
  if (tips) {
    const lines = [];
    if (model.photographic_language) {
      lines.push('This model follows camera facts more reliably than style adjectives — focal length, aperture and light direction beat "cinematic".');
    }
    // No word target is advertised here. The ceilings came out of
    // prompts/image/*.md on 26 Aug 2026 — "screw limits, we have a manual
    // override" — so a tip naming a band was describing a rule the model is
    // never told and nothing enforces.
    if (model.expands_character_tags) lines.push('Character names get expanded into feature descriptions — this base model has no danbooru character knowledge.');
    if (!model.has_negative) lines.push('No negative prompt on this model; exclude things by describing what is there instead.');
    tips.innerHTML = lines.map((l) => `<p>${l}</p>`).join('');
  }
  setupFormatToggle(mount);
  setupLayoutStudio(mount, model);

  // data-show="field" hides a block when the registry value is absent/false.
  for (const el of $$('[data-show]', mount)) {
    const key = el.getAttribute('data-show');
    const val = model[key];
    if (!val || (Array.isArray(val) && !val.length)) el.hidden = true;
  }

  // After data-show, never before: a model with has_negative:false has already
  // had its negative field hidden by the loop above, and this only ever hides.
  applySegmentPrefs(mount, model);

  // Counters.
  //
  // There used to be a word counter here too, scoring the brief against
  // `model.word_target`. It was removed on 26 Aug 2026 because it was measuring
  // the wrong text: `word_target` is the band for the model's OUTPUT, and the
  // counter applied it to the person's INPUT — so a normal twelve-word brief
  // on wan painted red against 80–120, asserting a rule that does not exist.
  // Nothing truncated; the UI was simply lying.
  //
  // `word_target` itself stays. It feeds the tips line above, which is
  // advisory and accurate, and `npm run dialect` measures against it. What
  // replaced the counter is the Length control in renderSliders, which is off
  // by default and is about the output, where a length rule belongs.
  const brief = $('[data-bind="brief"]', mount);
  const charCounter = $('[data-bind="char_counter"]', mount);
  const forbidden = $('[data-bind="forbidden_words"]', mount);

  const updateCounters = () => {
    const text = brief?.value ?? '';
    if (charCounter && model.max_output_chars) {
      const n = text.length;
      charCounter.textContent = `${n.toLocaleString()} / ${model.max_output_chars.toLocaleString()} characters`;
      charCounter.className = `counter ${n > model.max_output_chars ? 'over' : n > model.max_output_chars * 0.9 ? 'out-band' : ''}`;
    }
    if (forbidden && model.forbidden_words) {
      const hits = model.forbidden_words.filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(text));
      forbidden.hidden = hits.length === 0;
      forbidden.textContent = hits.length
        ? `Avoid on this model: ${hits.join(', ')} — each nudges it toward static or discontinuous framing.`
        : '';
    }
  };
  brief?.addEventListener('input', updateCounters);
  updateCounters();

  // Last, so every control is filled and wired before its old value lands.
  restoreControls(mount, stash);

  setGenerateEnabled(true);
  refreshStatus();
}

// ── tag builder (booru / hybrid templates) ───────────────────
//
// Tags are held per model. Switching models clears them along with the
// output, because a tag list built for Illustrious is in the wrong syntax
// for Pony anyway — the variant differs (underscore vs space).
let selectedTags = [];      // [{ tag, category_name, weight }]
let activeTagIndex = -1;

function renderTagPills(mount, model) {
  const host = $('[data-bind="tag_pills"]', mount);
  if (!host) return;
  host.innerHTML = '';

  selectedTags.forEach((t, i) => {
    const pill = document.createElement('span');
    pill.className = `pill ${t.category_name}${i === activeTagIndex ? ' active' : ''}`;
    pill.title = 'Click to select for weighting · × to remove';

    const label = document.createElement('span');
    label.textContent = t.weight === 1 ? t.tag : `(${t.tag}:${t.weight.toFixed(2)})`;
    label.addEventListener('click', () => {
      activeTagIndex = i;
      renderTagPills(mount, model);
      const w = $('[data-bind="weight"]', mount);
      if (w) {
        w.value = String(t.weight);
        w.dispatchEvent(new Event('input'));
      }
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'pill-remove';
    del.textContent = '×';
    del.setAttribute('aria-label', `Remove ${t.tag}`);
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      selectedTags.splice(i, 1);
      if (activeTagIndex >= selectedTags.length) activeTagIndex = selectedTags.length - 1;
      renderTagPills(mount, model);
    });

    pill.append(label, del);
    host.appendChild(pill);
  });

  // The header carries the count and Clear all, and only exists when there is
  // something to clear — an always-visible Clear all on an empty list is a
  // button that does nothing.
  const head = $('[data-bind="pills_head"]', mount);
  const count = $('[data-bind="pills_count"]', mount);
  if (head) head.hidden = selectedTags.length === 0;
  if (count) {
    count.textContent = `${selectedTags.length} tag${selectedTags.length === 1 ? '' : 's'}`;
  }
}

// Set by showTraits so clearing the pills can grey the chips back in. The
// chips' added state is derived from selectedTags, so it has to be redrawn
// whenever that changes from outside the trait block.
let refreshTraitChips = () => {};

// The same, for each reference image's detected tags — one redraw PER
// reference, keyed by its id, because there can be several on screen at once
// and a single shared handle would leave every card but the last painting
// stale "added" states. Cleared wholesale on model switch.
const imgrefRedraws = new Map();

// "Applies to" offers the characters named on OTHER cards, so naming one has
// to repaint every card's list rather than only its own. Keyed by reference id
// alongside the chip redraws, and cleared with them on model switch.
const imgrefAppliesRepaint = new Map();
function paintAppliesEverywhere() {
  for (const paint of imgrefAppliesRepaint.values()) paint();
}

function clearTags(mount, model) {
  selectedTags = [];
  activeTagIndex = -1;
  renderTagPills(mount, model);
  refreshTraitChips();
  for (const redraw of imgrefRedraws.values()) redraw();
}

// ── visual references (H3) ───────────────────────────────────
//
// The server has always accepted controls.references and formatted them into
// the prompt as "<Picture N> role: … keep: … drop: …". Nothing ever sent them.
//
// The reason this stalled is that the LLM is text-only — an uploaded image
// tells it nothing. The CPU tagger from Tab 3 closes that: the image is
// described locally, and the description is what reaches the model. The file
// itself never leaves this machine and is never sent to the LLM.
//
// Video and audio landed 21 Aug. A video is described the same way, one step
// removed: ffmpeg samples frames from inside the clip and the tagger reads
// those. Audio is not described at all — nothing here listens to audio, and
// the panel says so rather than leaving an empty field looking broken.

/** How many detected tags to offer as keep-traits. The whole prompt has a
 *  7,000 character budget and Subject definitions is not the place to spend
 *  it — a long tag dump crowds out the shot blocks. */
const REFERENCE_TAG_LIMIT = 10;

/** Which lane a picked file belongs to, from the server's own allowlists.
 *  Returns null for a type no lane accepts. */
function laneForFile(file, limits) {
  const type = (file.type ?? '').toLowerCase();
  if ((limits?.allowed_image_types ?? []).includes(type)) return 'image';
  if ((limits?.allowed_video_types ?? []).includes(type)) return 'video';
  if ((limits?.allowed_audio_types ?? []).includes(type)) return 'audio';
  return null;
}
// A labelled picture is any mix of kinds (dataset.kinds, "character,place")
// and the people in it, in tap order (dataset.who, "1,2"), 6 Oct 2026.
// dataset.pictureLabel is the first kind in the old single-label form, kept
// for the server's older path. See kindsOf in server/picture-labels.mjs.
// Pose (12 Oct 2026) stands alone and is not offered in a frame mode, where
// every picture is a frame. See server/picture-labels.mjs.
const KIND_ORDER = ['character', 'place', 'style', 'first-frame', 'last-frame', 'pose'];
const isFrame = (kind) => kind === 'first-frame' || kind === 'last-frame';
// The frame modes label their pictures too (9 Oct 2026), and every picture
// there is a frame whatever else it is: I2VA's is the first, L2VA's the
// last, and FL2VA's first picture the first frame and its second the last.
// FL2VA's ends are its position, not a choice (11 Oct 2026): the Director
// takes FL2VA images by slot, so a First/Last picker that stuck to a picture
// said the opposite of the video once the two were dragged round.
// dataset.frameKinds is stamped from position by renumber(); dataset.kinds
// (character, place, style) is shared with REF2VA, since what is in the
// picture does not change with the mode.
const FRAME_MODES = ['I2VA', 'FL2VA', 'L2VA'];
// Who's in it: six buttons to start, and one more each time the highest is in
// use, up to ten - the owner's call for a ten-character animation (12 Oct
// 2026). Counted across every picture, so Character 7 can have its own.
// server/picture-labels.mjs MAX_CHARACTERS is the same ten.
const WHO_SHOWN = 6;
// Then "can we make it keep going", to a final cap of 70, with a word on the
// way up (the owner's, 12 Oct 2026). Said when that number is tapped.
const WHO_MAX = 70;
const WHO_NOTES = {
  20: 'Really? Do you really have 20 people in a single image, or are you trying to find the limit?',
  32: 'Are we really doing this?',
  45: 'I guess we are doing this.',
  69: 'Nice.',
  70: "I'm putting a cap on this now.",
};
function frameEndsOf(tile) {
  const mode = tile.dataset.frameMode;
  if (mode === 'I2VA') return ['first-frame'];
  if (mode === 'L2VA') return ['last-frame'];
  return [tile.dataset.frameKinds === 'last-frame' ? 'last-frame' : 'first-frame'];
}
function kindsOf(tile) {
  const kinds = (tile.dataset.kinds || 'character').split(',');
  if (tile.dataset.frameMode) {
    const ends = frameEndsOf(tile);
    return KIND_ORDER.filter((k) => k !== 'pose' && (isFrame(k) ? ends.includes(k) : kinds.includes(k)));
  }
  if (kinds.includes('pose')) return ['pose'];
  const known = KIND_ORDER.filter((k) => kinds.includes(k));
  return known.length ? known : ['character'];
}
/** Who is in a picture, in tap order, as numbers. People boxes, when the
 *  picture has them, say it instead: left to right by where each box sits. */
function whoOf(tile) {
  const boxes = peopleBoxesOf(tile);
  if (boxes.length) return [...boxes].sort((a, b) => (a.box[0] + a.box[2]) - (b.box[0] + b.box[2])).map((b) => b.n);
  return (tile.dataset.who || '').split(',').filter(Boolean).map(Number);
}
/** A picture's people boxes: [{ n, box: [x1, y1, x2, y2] }], fractions of the picture. */
function peopleBoxesOf(tile) {
  try {
    const list = JSON.parse(tile?.dataset?.boxes || '[]');
    return Array.isArray(list) ? list.filter((b) => Number.isInteger(b?.n) && Array.isArray(b?.box) && b.box.length === 4) : [];
  } catch { return []; }
}
/** Whether Who's in it means anything on this picture. */
// On a pose the numbers say who takes it, not who is in the picture.
const takesWho = (tile) => kindsOf(tile).some((k) => k === 'character' || k === 'pose' || isFrame(k));

function setupReferences(mount, model, restore = []) {
  const wrap = $('[data-bind="reference_list"]', mount);
  const tpl = $('template[data-bind="clip_tile"]', mount);
  const input = $('[data-bind="reference_upload"]', mount);
  const modeSel = $('[data-bind="mode"]', mount);
  if (!wrap || !tpl || !input) return;

  const limits = TAGGERS?.limits;
  const typesFor = {
    visual: [...(limits?.allowed_image_types ?? []), ...(limits?.allowed_video_types ?? [])],
    audio: [...(limits?.allowed_audio_types ?? [])],
  };

  const lane = {
    visual: {
      el: $('[data-bind="lane_visual"]', mount),
      slots: $('[data-bind="slots_visual"]', mount),
      add: $('[data-bind="add_visual"]', mount),
      cap: $('[data-bind="cap_visual"]', mount),
    },
    audio: {
      el: $('[data-bind="lane_audio"]', mount),
      slots: $('[data-bind="slots_audio"]', mount),
      add: $('[data-bind="add_audio"]', mount),
      cap: $('[data-bind="cap_audio"]', mount),
    },
  };

  const editor = $('[data-bind="clip_editor"]', mount);
  const removeBtn = $('[data-bind="remove_selected"]', mount);
  const clearBtn = $('[data-bind="clear"]', mount);
  const scanBtn = $('[data-bind="scan_pictures"]', mount);

  let selectedLane = 'visual';
  let selected = null;      // the selected tile, or null
  let pickingFor = 'visual';

  const tiles = (which) =>
    $$('.mmd-tile', which ? lane[which].slots : wrap);

  // A tile's picture, full size. Caught before the tile's own click, so
  // looking does not select it; one listener for every tile, restored ones too.
  wrap.addEventListener('click', (e) => {
    const zoom = e.target.closest?.('[data-bind="zoom_btn"]');
    if (!zoom) return;
    e.stopPropagation();
    const tile = zoom.closest('.mmd-tile');
    const img = $('[data-bind="preview"]', tile);
    openPicture(img?.src, tile?.dataset.filename || img?.alt || '');
  }, true);

  // ── mode pills ───────────────────────────────────────────────
  //
  // The node shows every mode as a pill and highlights the active one. The
  // hidden select stays the source of truth: fillSelect() has already filled
  // it from the registry, so this reads the options rather than a list of its
  // own, and the frontend still hardcodes no mode.
  const pillWrap = $('[data-bind="mode_pills"]', mount);
  const pills = new Map();
  if (pillWrap && modeSel) {
    pillWrap.replaceChildren();
    for (const opt of [...modeSel.options]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mmd-pill';
      b.textContent = opt.value;
      b.setAttribute('aria-pressed', String(opt.value === modeSel.value));
      b.addEventListener('click', () => {
        if (b.disabled) return;
        modeSel.value = opt.value;
        modeSel.dispatchEvent(new Event('change', { bubbles: true }));
      });
      pills.set(opt.value, b);
      pillWrap.appendChild(b);
    }
  }

  /** Limits for the mode now selected, falling back to the loosest set. */
  const activeLimits = () =>
    (modeSel?.value && REFERENCE_MODE_LIMITS?.[modeSel.value]) || REFERENCE_LANE_LIMITS || null;

  // ── what a tile will be called in the prompt ─────────────────
  //
  // The badge is the actual label, so it has to follow the server's rule
  // exactly: labelsFor() in server/references.mjs maps role to class, a video
  // emits whatever its stream mode emits, and each class counts from 1
  // independently in document order. Both the map and the emits lists come
  // off the status poll, so this counts but never decides.
  // Numbered by what the file IS, as the Director's own badges are — every
  // image is `Picture N` whatever its role (18 Sep 2026, see ROLE_LABEL in
  // server/references.mjs for what the old role-based labels broke).
  function labelsForTile(tile) {
    if (tile.dataset.kind === 'video') {
      const m = REFERENCE_STREAM_MODES.find((x) => x.key === (tile.dataset.stream || 'video'));
      if (m?.emits?.length) return m.emits;
      return ['Video'];
    }
    if (tile.dataset.kind === 'audio') return ['Audio'];
    if (tile.dataset.kind === 'image') return ['Picture'];
    return [REFERENCE_ROLE_LABELS?.[tile.dataset.role] ?? 'Picture'];
  }

  /** Mark each picture with the frame mode it is in, if any. FL2VA's ends
   *  are first then last by order, every time, as the Director's slots are. */
  function stampFrames() {
    const mode = modeSel?.value;
    let at = 0;
    for (const t of tiles('visual')) {
      if (t.dataset.kind !== 'image') continue;
      if (FRAME_MODES.includes(mode)) {
        t.dataset.frameMode = mode;
        if (mode === 'FL2VA') t.dataset.frameKinds = at === 0 ? 'first-frame' : 'last-frame';
      } else {
        delete t.dataset.frameMode;
      }
      if (!t.hidden) at += 1;
      syncLabel(t);
    }
  }

  /**
   * Which visual tiles this mode sends. Hidden, never dropped: they come back
   * on a switch to a mode that takes them.
   *
   * Pictures by the same rule as video (11 Oct 2026). T2VA takes none, and
   * pictures added in another mode stayed on screen in a lane marked disabled
   * and were sent anyway, each as a subject the model was told to keep. The
   * frame modes take as many as MiniMax's guide gives them frames (one for
   * I2VA and L2VA, two for FL2VA), the first ones in panel order: a third
   * picture in FL2VA went to the model as a second last frame.
   */
  function gateVisual() {
    const lim = activeLimits();
    if (!lim) return;
    const cap = FRAME_MODES.includes(modeSel?.value) ? lim.image : Infinity;
    let pictures = 0;
    for (const t of tiles('visual')) {
      const isImage = t.dataset.kind === 'image';
      t.hidden = (!lim.video && t.dataset.kind === 'video') || (isImage && (!lim.image || pictures >= cap));
      if (isImage && !t.hidden) pictures += 1;
    }
  }

  function renumber() {
    gateVisual();
    stampFrames();
    const counters = { Picture: 0, Video: 0, Audio: 0, Subject: 0 };
    for (const tile of tiles()) {
      const shown = labelsForTile(tile).map((l) => {
        counters[l] = (counters[l] ?? 0) + 1;
        return `${l} ${counters[l]}`;
      });
      const badge = $('[data-bind="badge"]', tile);
      if (badge) badge.textContent = shown.join(' + ');
    }
    describeLanes(mount);
    refreshCaps();
    for (const tile of tiles()) stampMeta(tile);
    if (selected) fillEditor(selected);
    syncScanButton();
    if (castReady) renderCast();
  }

  // Scan pictures: REF2VA only (Auto becomes REF2VA with pictures), and only
  // with two or more, which is when Generate scans them too.
  function syncScanButton() {
    if (!scanBtn || scanBtn.dataset.busy) return;
    const pictures = tiles('visual').filter((t) => !t.hidden && t.dataset.kind === 'image').length;
    // Labelled pictures are never scanned: the labels say who is who.
    scanBtn.hidden = labelsOn() || !['REF2VA', 'Auto detect'].includes(modeSel?.value) || pictures < 2;
  }
  scanBtn?.addEventListener('click', async () => {
    if (scanBtn.dataset.busy) return;
    scanBtn.dataset.busy = '1';
    scanBtn.disabled = true;
    const label = scanBtn.textContent;
    try {
      await scanPictures({
        onProgress: (text) => { scanBtn.textContent = text; },
      });
    } catch (err) {
      toast(err.message);
    } finally {
      delete scanBtn.dataset.busy;
      scanBtn.disabled = false;
      scanBtn.textContent = label;
      syncScanButton();
    }
  });

  function refreshCaps() {
    const lim = activeLimits();
    if (!lim) return;
    // What will be sent: a tile this mode hides is kept, not counted.
    const imgs = tiles('visual').filter((t) => t.dataset.kind === 'image' && !t.hidden).length;
    const vids = tiles('visual').filter((t) => t.dataset.kind === 'video' && !t.hidden).length;
    const auds = tiles('audio').filter((t) => !t.hidden).length;
    // Over the cap is stated on the lane itself, not only in the note below —
    // the node refuses past these and the lane is where the eye already is.
    const over = (n, max) => (n > max ? ' — over' : '');
    // Said, so a picture this mode hides does not look lost.
    const aside = tiles('visual').filter((t) => t.hidden).length;
    if (lane.visual.cap) {
      lane.visual.cap.textContent =
        `${imgs}/${lim.image} images · ${vids}/${lim.video} video${over(imgs, lim.image) || over(vids, lim.video)}` +
        (aside ? ` · ${aside} set aside in this mode` : '');
    }
    if (lane.audio.cap) lane.audio.cap.textContent = `${auds}/${lim.audio} audio${over(auds, lim.audio)}`;
  }

  // ── lane availability per mode ───────────────────────────────
  //
  // "Going to FL2VA hides non-image references but keeps them in memory so
  // they reappear when you switch back." Hidden, never dropped: a mode switch
  // that silently deleted four uploads would be the worst thing this panel
  // could do. A hidden tile is also skipped by the control serialiser, which
  // reads only what is visible — same rule the i2v last-frame control uses.
  function applyMode() {
    const lim = activeLimits();
    for (const [key, b] of pills) b.setAttribute('aria-pressed', String(key === modeSel?.value));
    if (!lim) return;

    const audioOff = !lim.audio;
    lane.audio.el?.setAttribute('data-disabled', String(audioOff));
    if (lane.audio.el) lane.audio.el.hidden = false;
    for (const t of tiles('audio')) t.hidden = audioOff;

    const videoOff = !lim.video;
    const imagesOff = !lim.image;

    lane.visual.el?.setAttribute('data-disabled', String(imagesOff && videoOff));
    if (lane.visual.add) lane.visual.add.hidden = imagesOff && videoOff;
    if (lane.audio.add) lane.audio.add.hidden = audioOff;

    if (audioOff && selectedLane === 'audio') selectLane('visual');
    if (selected?.hidden) select(null);
    renumber();
  }

  function selectLane(which) {
    selectedLane = which;
    for (const [key, l] of Object.entries(lane)) {
      l.el?.setAttribute('data-selected', String(key === which));
    }
  }

  // ── the selected clip, and the editor that edits it ──────────
  const roleSel = $('[data-bind="role"]', editor);
  const groupSel = $('[data-bind="subject_group"]', editor);
  const groupField = $('[data-bind="subject_group_field"]', editor);
  const streamSel = $('[data-bind="stream"]', editor);
  const streamField = $('[data-bind="stream_field"]', editor);
  const cropField = $('[data-bind="crop_field"]', editor);
  const cropStart = $('[data-bind="crop_start"]', editor);
  const cropEnd = $('[data-bind="crop_end"]', editor);
  const keepIn = $('[data-bind="keep"]', editor);
  const dropIn = $('[data-bind="drop"]', editor);
  const editHead = $('[data-bind="editor_head"]', editor);
  const editNote = $('[data-bind="editor_note"]', editor);
  // Pictures in REF2VA and Auto detect get one "This picture is" picker in
  // place of Role and grouping: Character 1 on two pictures is what a group
  // was. Video and audio keep their Role, and a base mode's pictures are frames.
  // See server/picture-labels.mjs.
  // What the picture is, any mix of kinds, and who is in it: number buttons
  // tapped left to right (6 Oct 2026). See kindsOf above.
  const kindSeg = $('[data-bind="picture_kind"]', editor);
  const kindField = $('[data-bind="picture_kind_field"]', editor);
  const whoChips = $('[data-bind="picture_who"]', editor);
  const whoField = $('[data-bind="picture_who_field"]', editor);
  const whoOrder = $('[data-bind="picture_who_order"]', editor);
  const whoAxis = $('[data-bind="picture_who_axis"]', editor);
  const whoHints = $('[data-bind="picture_who_hints"]', editor);
  const keepLabel = $('[data-bind="keep_label"]', editor);
  const dropField = $('[data-bind="drop_field"]', editor);
  const KIND_TEXT = { place: 'Place', style: 'Style', 'first-frame': 'First frame', 'last-frame': 'Last frame', pose: 'Pose' };
  function syncLabel(tile) {
    const [first] = kindsOf(tile);
    const who = whoOf(tile);
    tile.dataset.pictureLabel = first !== 'character' ? first
      : who.length > 1 ? `group-${who.join('')}` : `character-${who[0] ?? 1}`;
  }
  function setWho(tile, who) {
    // A character picture always shows somebody: the last number cannot be untapped.
    if (kindsOf(tile).includes('character') && !who.length) return;
    if (who.length) tile.dataset.who = who.join(',');
    else delete tile.dataset.who;
    syncLabel(tile);
  }
  const roleField = $('[data-bind="role_field"]', editor);
  const groupNote = $('[data-bind="group_note"]', editor);
  const labelNote = $('[data-bind="picture_label_note"]', editor);
  // Declarations, not consts: stampMeta and renumber can run before this line.
  function labelsOn() { return ['REF2VA', 'Auto detect', ...FRAME_MODES].includes($('[data-bind="mode"]', mount)?.value); }
  const labelNoteText = labelNote?.textContent ?? '';
  const FRAME_NOTE = 'Say what is in the frame and tap who is in it. With two or more, you can also say where each one stands. '
    + 'In the brief, write "Character 1", "Character 2".';
  /** The first Character number no other picture uses: a new picture is its own subject. */
  function nextFreeCharacter() {
    const used = new Set();
    for (const t of tiles('visual')) {
      if (t.dataset.kinds && kindsOf(t).includes('character')) for (const n of whoOf(t)) used.add(n);
    }
    let n = 1;
    while (used.has(n) && n < WHO_MAX) n += 1;
    return n;
  }
  /** "Characters 1 + 2 + Place", "First frame · Character 1". */
  function pictureLabelText(tile) {
    const kinds = kindsOf(tile);
    const who = whoOf(tile);
    const names = who.length === 1 ? `Character ${who[0]}` : who.length ? `Characters ${who.join(' + ')}` : '';
    const text = kinds.map((k) => (k === 'character' ? names || 'Character 1' : KIND_TEXT[k])).join(' + ');
    return !kinds.includes('character') && names && takesWho(tile) ? `${text} · ${names}` : text;
  }
  function buildWhoChips(tile) {
    if (!whoChips) return;
    let highest = 0;
    for (const t of tiles('visual')) for (const n of whoOf(t)) highest = Math.max(highest, n);
    for (const n of whoOf(tile)) highest = Math.max(highest, n);
    const count = Math.min(WHO_MAX, Math.max(WHO_SHOWN, highest + 1));
    if ($$('.who-chip', whoChips).length === count) return;
    whoChips.replaceChildren(...Array.from({ length: count }, (_, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'who-chip';
      b.dataset.who = String(i + 1);
      b.setAttribute('aria-pressed', 'false');
      b.textContent = String(i + 1);
      return b;
    }));
  }
  /** The person's few words per character, keyed by number. */
  function hintsOf(tile) {
    try { return JSON.parse(tile.dataset.whoHints || '{}') ?? {}; } catch { return {}; }
  }
  // A box per character once two or more are tapped: "red hair, guitar". Told
  // only "the one in the middle left", a 4B described the wrong girl in three
  // places out of four on a band picture; told what to look for, it got all
  // four (12 Oct 2026).
  function paintHints(tile, who) {
    if (!whoHints) return;
    whoHints.hidden = who.length < 2;
    if (who.length < 2) { whoHints.replaceChildren(); return; }
    const hints = hintsOf(tile);
    const focused = document.activeElement?.closest?.('[data-hint-for]')?.dataset.hintFor;
    if ($$('input', whoHints).map((i) => i.dataset.hintFor).join(',') === who.join(',')) return;
    whoHints.replaceChildren(...who.map((n) => {
      const row = document.createElement('label');
      row.className = 'who-hint';
      const num = document.createElement('span');
      num.textContent = String(n);
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 80;
      input.dataset.hintFor = String(n);
      // Looks, not props: hinted "blue hair, bass", a 27B handed her the bass
      // in a scene with no instruments in it (12 Oct 2026).
      input.placeholder = 'how they look, e.g. red hair, side ponytail';
      input.value = hints[n] ?? '';
      row.append(num, input);
      return row;
    }));
    if (focused) $(`input[data-hint-for="${focused}"]`, whoHints)?.focus();
  }
  function paintWho(tile) {
    buildWhoChips(tile);
    const who = whoOf(tile);
    // A pose's numbers are who takes it: nobody in it to tell apart or place.
    const pose = kindsOf(tile).includes('pose');
    paintHints(tile, pose ? [] : who);
    // No order unless one is picked (7 Oct 2026): then the numbers only say who is in it.
    const axis = ['x', 'y', 'z'].includes(tile.dataset.whoAxis) ? tile.dataset.whoAxis : null;
    for (const b of $$('.who-chip', whoChips ?? editor)) {
      const at = who.indexOf(Number(b.dataset.who));
      b.setAttribute('aria-pressed', String(at >= 0));
      b.dataset.order = axis && who.length > 1 && at >= 0 ? String(at + 1) : '';
    }
    if (whoAxis) {
      whoAxis.hidden = who.length < 2 || pose;
      for (const b of $$('button', whoAxis)) b.setAttribute('aria-pressed', String(b.dataset.axis === axis));
    }
    const way = { x: 'left to right', y: 'top to bottom', z: 'front to back' }[axis];
    if (whoOrder) whoOrder.textContent = who.length > 1 && way ? `${way}: ${who.join(', ')}` : '';
  }

  // ── People boxes (13 Oct 2026; server/people-boxes.mjs) ──
  // A box round each character on the picture itself. Find people asks the
  // model that reads this model's pictures to box everyone; Add character
  // drops one to drag over someone. Either way every box moves, resizes and
  // renumbers, so a wrong guess from the model is one drag to fix. With boxes,
  // who is in it and where they stand come from the boxes, and the server
  // reads each person from their own crop.
  const peopleField = $('[data-bind="people_field"]', editor);
  const peopleStage = $('[data-bind="people_stage"]', editor);
  const peopleNote = $('[data-bind="people_note"]', editor);
  const PEOPLE_NOTE = peopleNote?.textContent ?? '';
  // The box the person last clicked: its label sits on top. Its description
  // is that character's card in the Cast list, which a click scrolls to.
  let activeBox = null;
  const BOX_MIN = 0.04;
  // Under this many pixels wide a box shows its number alone, so neighbours'
  // labels do not run into each other.
  const BOX_LABEL_FULL = 84;
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  function setPeopleBoxes(tile, boxes) {
    if (boxes.length) {
      tile.dataset.boxes = JSON.stringify(boxes.map((b) => ({ n: b.n, box: b.box.map((v) => Number(clamp01(v).toFixed(4))) })));
    } else {
      delete tile.dataset.boxes;
    }
    syncLabel(tile);
    // Who the reader is told to look at changed, so what it saw is stale.
    clearTileReading(tile);
    renumber();
    fillEditor(tile);
  }
  function placeBox(el, [x1, y1, x2, y2]) {
    el.style.left = `${x1 * 100}%`;
    el.style.top = `${y1 * 100}%`;
    el.style.width = `${(x2 - x1) * 100}%`;
    el.style.height = `${(y2 - y1) * 100}%`;
  }
  function paintPeople(tile) {
    if (!peopleStage || !peopleField) return;
    const boxes = peopleBoxesOf(tile);
    $('[data-people="clear"]', peopleField).hidden = !boxes.length;
    $('[data-people="scan"]', peopleField).hidden = !whoOf(tile).length;
    let img = $('img', peopleStage);
    if (!img) {
      img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      peopleStage.replaceChildren(img);
    }
    if (tile._encoded && img.getAttribute('src') !== tile._encoded) {
      // Label widths are measured on the drawn picture: draw them again once
      // it has a size, or every label starts out as a bare number.
      img.addEventListener('load', () => { if (selected === tile) paintPeople(tile); }, { once: true });
      img.setAttribute('src', tile._encoded);
    }
    for (const el of $$('.people-box', peopleStage)) el.remove();
    if (!boxes.some((b) => b.n === activeBox)) activeBox = null;
    // Numbers offered on each box: the usual six, more as they are used.
    let highest = 0;
    for (const t of tiles('visual')) for (const n of whoOf(t)) highest = Math.max(highest, n);
    const offered = Math.min(WHO_MAX, Math.max(WHO_SHOWN, highest + 1));
    const width = $('img', peopleStage)?.getBoundingClientRect().width || 0;
    for (const b of boxes) peopleStage.append(boxEl(tile, b, offered, width * (b.box[2] - b.box[0]) >= BOX_LABEL_FULL));
  }
  function boxEl(tile, b, offered, full) {
    const el = document.createElement('div');
    el.className = 'people-box';
    el.dataset.n = String(b.n);
    if (b.n === activeBox) el.classList.add('active');
    placeBox(el, b.box);
    // The label is a plain tag sized to its text, with the picker laid over it
    // unseen: a <select> is as wide as its longest option whatever it shows,
    // so used as the label it ran past a narrow box (13 Oct 2026).
    const tag = document.createElement('span');
    tag.className = 'people-tag';
    // A narrow box shows its number alone; the list still says "Character N".
    tag.textContent = full ? `Character ${b.n}` : String(b.n);
    const pick = document.createElement('select');
    pick.className = 'people-pick';
    pick.setAttribute('aria-label', `Which character this box is (Character ${b.n})`);
    pick.title = `Character ${b.n}`;
    for (let n = 1; n <= Math.max(offered, b.n); n += 1) pick.append(new Option(`Character ${n}`, String(n)));
    tag.append(pick);
    pick.append(new Option('Remove box', 'remove'));
    pick.value = String(b.n);
    pick.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (activeBox !== b.n) { activeBox = b.n; markActive(); }
    });
    pick.addEventListener('change', () => {
      const boxes = peopleBoxesOf(tile);
      if (pick.value === 'remove') return setPeopleBoxes(tile, boxes.filter((x) => x.n !== b.n));
      const to = Number(pick.value);
      if (WHO_NOTES[to]) toast(WHO_NOTES[to], 4000);
      // Picking a number another box has swaps the two, hints and all.
      const hints = hintsOf(tile);
      const [mine, theirs] = [hints[b.n], hints[to]];
      if (mine) hints[to] = mine; else delete hints[to];
      if (theirs) hints[b.n] = theirs; else delete hints[b.n];
      tile.dataset.whoHints = JSON.stringify(hints);
      // The cards go with the people, when nobody else's pictures hold either number.
      swapCastCards(tile, b.n, to);
      activeBox = to;
      setPeopleBoxes(tile, boxes.map((x) => (x.n === b.n ? { ...x, n: to } : x.n === to ? { ...x, n: b.n } : x)));
    });
    const handle = document.createElement('span');
    handle.className = 'people-resize';
    handle.setAttribute('aria-hidden', 'true');
    el.append(tag, handle);
    el.addEventListener('pointerdown', (e) => dragBox(e, tile, el, b, e.target === handle ? 'resize' : 'move'));
    return el;
  }
  /** Which box is selected, marked without redrawing the boxes. */
  function markActive() {
    for (const el of $$('.people-box', peopleStage)) el.classList.toggle('active', Number(el.dataset.n) === activeBox);
  }
  /** Move a box, or resize it from its corner; saved when the pointer lets go.
   *  Pressing a box also selects it; a click without a drag shows its card. */
  function dragBox(e, tile, el, b, how) {
    if (e.button !== 0) return;
    e.preventDefault();
    if (activeBox !== b.n) {
      activeBox = b.n;
      markActive();
    }
    const rect = peopleStage.getBoundingClientRect();
    const [x1, y1, x2, y2] = b.box;
    const sx = e.clientX, sy = e.clientY;
    let next = b.box;
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    const move = (ev) => {
      const dx = (ev.clientX - sx) / rect.width, dy = (ev.clientY - sy) / rect.height;
      if (how === 'move') {
        const ox = Math.min(1 - x2, Math.max(-x1, dx)), oy = Math.min(1 - y2, Math.max(-y1, dy));
        next = [x1 + ox, y1 + oy, x2 + ox, y2 + oy];
      } else {
        next = [x1, y1, Math.max(x1 + BOX_MIN, clamp01(x2 + dx)), Math.max(y1 + BOX_MIN, clamp01(y2 + dy))];
      }
      placeBox(el, next);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.classList.remove('dragging');
      if (next !== b.box) setPeopleBoxes(tile, peopleBoxesOf(tile).map((x) => (x.n === b.n ? { ...x, box: next } : x)));
      else focusCastCard(b.n);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }
  $('[data-bind="scan_picture"]', editor)?.addEventListener('click', () => {
    if (selected) scanCards(sceneKeysOf(selected));
  });
  peopleField?.addEventListener('click', async (e) => {
    const act = e.target.closest('button[data-people]')?.dataset.people;
    if (!act || !selected) return;
    const tile = selected;
    const boxes = peopleBoxesOf(tile);
    // Scan people (14 Oct 2026, the owner's call): read everyone in this
    // picture again from their boxes as they stand. Find people boxes the
    // picture afresh, which undid a person's resized boxes.
    if (act === 'scan') return scanCards(whoOf(tile));
    if (act === 'clear') {
      activeBox = null;
      return setPeopleBoxes(tile, []);
    }
    if (act === 'add') {
      // The lowest number not boxed yet in this picture: Character 1, 2, 3...
      const used = new Set(boxes.map((b) => b.n));
      let n = 1;
      while (used.has(n) && n < WHO_MAX) n += 1;
      const off = (boxes.length % 5) * 0.06;
      // The new box is selected.
      activeBox = n;
      return setPeopleBoxes(tile, [...boxes, { n, box: [0.3 + off, 0.15, 0.6 + off, 0.95].map(clamp01) }]);
    }
    if (act === 'find') {
      const btn = e.target.closest('button');
      if (!tile._encoded || !currentModel) return;
      btn.disabled = true;
      if (peopleNote) peopleNote.textContent = 'Looking for people…';
      try {
        const res = await fetch('/api/people', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: currentModel.key, image: tile._encoded }),
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(out.message || `HTTP ${res.status}`);
        if (!out.people?.length) {
          if (peopleNote) peopleNote.textContent = 'Nobody was found. Use Add character to box them yourself.';
          return;
        }
        // Numbers the person already tapped carry over, left to right, when
        // the count matches; otherwise Character 1, 2, 3... left to right.
        const tapped = (tile.dataset.who || '').split(',').filter(Boolean).map(Number);
        const numbers = tapped.length === out.people.length ? tapped : out.people.map((_, i) => i + 1);
        // Find people again is how a card is read again (the owner's call, 14
        // Oct 2026: no Redo on the cards). Everyone it boxes is read fresh,
        // cards the person edited included: pressing it is the ask.
        for (const n of numbers) {
          const card = castEntry(n);
          card.force = true;
          card.failedSig = null;
        }
        setPeopleBoxes(tile, out.people.map((p, i) => ({ n: numbers[i], box: p.box })));
        if (peopleNote) peopleNote.textContent = `Found ${out.people.length} ${out.people.length === 1 ? 'person' : 'people'} in ${Math.round((out.ms ?? 0) / 1000)}s. Drag, resize or renumber any box that is off.`;
      } catch (err) {
        if (peopleNote) peopleNote.textContent = PEOPLE_NOTE;
        toast(err.message);
      } finally {
        btn.disabled = false;
      }
    }
  });

  // ── The Cast list (13 Oct 2026; server/picture-labels.mjs, /api/cast) ──
  // One card per character in the pictures: a thumbnail from their box, and
  // what they look like, read from all their pictures and editable. The text
  // is used at Generate as written; an empty card is read then, as before.
  // Per character, not per box: the reader already reads a character from
  // all their pictures together, and this is that reading made visible.
  // A card the person never touched is read again when their pictures or box
  // change; one they edited is only marked out of date, never overwritten.
  //
  // The place, the style and each Pose picture have a card too (14 Oct 2026,
  // the owner's call, built in the H3 Forge first): read from their own
  // pictures, editable, used as written. Card keys: a character's number,
  // then "place", "style" and "pose:<castId>" (a pose belongs to its tile,
  // which keeps its id when pictures move). The server names a pose by its
  // picture number, "pose@3" (requestKey).
  const castWrap = $('[data-bind="cast_list"]', mount);
  const castCards = $('[data-bind="cast_cards"]', mount);
  const castEls = new Map();
  // A var, so renumber() can ask before this line has run.
  var castReady = true;
  /** The characters in the pictures sent in this mode, by number. */
  function castNumbers() {
    if (!labelsOn()) return [];
    const nums = new Set();
    for (const t of castTiles()) for (const n of whoOf(t)) nums.add(n);
    return [...nums].sort((a, b) => a - b);
  }
  const isScene = (key) => typeof key === 'string';
  /** Scene cards only where there are Subject definitions: REF2VA, and Auto detect, which is REF2VA with these. */
  function sceneOn() { return ['REF2VA', 'Auto detect'].includes($('[data-bind="mode"]', mount)?.value); }
  /** Visible pictures, in the order they are sent: <Picture N> is the N-th. */
  function pictureTiles() {
    return $$('[data-bind="reference_list"] .mmd-tile', mount).filter((t) => !t.hidden && t.dataset.kind === 'image');
  }
  /** Every card in order: the characters, then the place, the style and each pose. */
  function castKeys() {
    const keys = castNumbers();
    if (!labelsOn() || !sceneOn()) return keys;
    const shown = pictureTiles();
    for (const kind of ['place', 'style']) if (shown.some((t) => !kindsOf(t).includes('pose') && kindsOf(t).includes(kind))) keys.push(kind);
    for (const t of shown) if (kindsOf(t).includes('pose')) keys.push(`pose:${t.dataset.castId}`);
    return keys;
  }
  /** The pictures a card is read from. */
  function cardTiles(key) {
    if (!isScene(key)) return castTiles(key);
    if (key.startsWith('pose:')) return pictureTiles().filter((t) => t.dataset.castId === key.slice(5) && kindsOf(t).includes('pose'));
    return pictureTiles().filter((t) => !kindsOf(t).includes('pose') && kindsOf(t).includes(key));
  }
  /** What the server calls a card: 2, "place", "style", "pose@3". */
  function requestKey(key) {
    if (!isScene(key) || !key.startsWith('pose:')) return key;
    const tile = cardTiles(key)[0];
    return tile ? `pose@${pictureTiles().indexOf(tile) + 1}` : null;
  }
  function cardLabel(key) {
    if (!isScene(key)) return `Character ${key}`;
    if (key.startsWith('pose:')) {
      const r = requestKey(key);
      return `Pose (Picture ${r ? r.slice(5) : '?'})`;
    }
    return key === 'place' ? 'The place' : 'The style';
  }
  const kindOfKey = (key) => (!isScene(key) ? 'character' : key.startsWith('pose:') ? 'pose' : key);
  const CARD_PLACEHOLDER = {
    character: 'What they look like: hair, eyes, build, clothes. Read from their pictures, or write it yourself.',
    place: 'The setting: where it is, its landmarks, the light and the time of day.',
    style: 'The medium (photo, semi-real, anime, oil painting…), then the linework, shading and colours.',
    pose: 'The pose only: the stance, where the arms and legs are, the gesture, which way they face. Looks and clothes are left out.',
  };
  /** A picture's scene cards, for Scan picture: its pose, or its place and style. */
  function sceneKeysOf(tile) {
    if (kindsOf(tile).includes('pose')) return [`pose:${tile.dataset.castId}`];
    return ['place', 'style'].filter((k) => kindsOf(tile).includes(k));
  }
  /** Read cards again, edited ones included: pressing the button is the ask. */
  function scanCards(keys) {
    for (const key of keys) {
      const card = castEntry(key);
      card.force = true;
      card.failedSig = null;
    }
    renderCast();
    clearTimeout(castTimer);
    runCastQueue();
  }
  /** Visible pictures that show people: characters and frames, never a pose. */
  function castTiles(n = null) {
    return tiles('visual').filter((t) => !t.hidden && t.dataset.kind === 'image'
      && !kindsOf(t).includes('pose') && kindsOf(t).some((k) => k === 'character' || isFrame(k))
      && (n == null || whoOf(t).includes(n)));
  }
  /** Everything the reader is told about character n, so a change shows as out of date.
   *  Not the frame kinds: a mode switch makes a picture a frame, and their look is the same. */
  function castSig(n) {
    // A scene card: its pictures, what they are, how many take a pose, and their notes.
    if (isScene(n)) {
      return JSON.stringify(cardTiles(n).map((t) => [t.dataset.castId, kindsOf(t).filter((k) => !isFrame(k)).join(','),
        n.startsWith('pose:') ? whoOf(t).length : 0, t.dataset.keep ?? '', t.dataset.drop ?? '']));
    }
    return JSON.stringify(castTiles(n).map((t) => {
      const who = whoOf(t);
      return [t.dataset.castId, kindsOf(t).filter((k) => !isFrame(k)).join(','), peopleBoxesOf(t).find((b) => b.n === n)?.box ?? null,
        who.indexOf(n), who.length, t.dataset.whoAxis ?? '', hintsOf(t)[n] ?? '', t.dataset.keep ?? '', t.dataset.drop ?? ''];
    }));
  }
  function castEntry(n) {
    const state = castStateFor(model.key);
    if (!state.has(n)) state.set(n, { text: '', sig: null, edited: false, reading: false, error: null, failedSig: null, force: false });
    return state.get(n);
  }
  /** Does this card need a read: asked for by Find people, empty and untouched, or out of date and never edited. */
  function castNeedsRead(n) {
    const e = castEntry(n);
    const sig = castSig(n);
    if (e.reading || !cardTiles(n).some((t) => t._encoded)) return false;
    if (e.force) return true;
    if (e.edited || e.failedSig === sig) return false;
    return !e.text || e.sig !== sig;
  }
  let castTimer = null;
  let castBusy = false;
  /** Draw the cards, and start reading any that need it once the person stops changing things. */
  function renderCast() {
    // Gone with a model switch: a late picture encode must not start reads for it.
    if (!castWrap?.isConnected || !castCards) return;
    const nums = castKeys();
    castWrap.hidden = !nums.length;
    for (const [n, el] of castEls) if (!nums.includes(n)) { el.remove(); castEls.delete(n); }
    nums.forEach((n, i) => {
      const el = castEls.get(n) ?? castCardEl(n);
      if (castCards.children[i] !== el) castCards.insertBefore(el, castCards.children[i] ?? null);
      paintCastCard(n);
    });
    clearTimeout(castTimer);
    if (nums.some(castNeedsRead)) castTimer = setTimeout(runCastQueue, 1500);
  }
  async function runCastQueue() {
    if (castBusy || !castEls.size || !castWrap?.isConnected) return;
    const n = castKeys().find(castNeedsRead);
    if (n == null) return;
    castBusy = true;
    try {
      await readCastCard(n, castEntry(n).force);
    } finally {
      castBusy = false;
    }
    if (!castWrap?.isConnected) return;
    renderCast();
    // The wait is for the person to stop changing boxes, not between reads:
    // the next card in line is read straight away.
    if (castKeys().some(castNeedsRead)) {
      clearTimeout(castTimer);
      runCastQueue();
    }
  }
  /** The request for one card: the pictures it is not read from go without their image. */
  function castPayload(n) {
    const controls = collectControls();
    delete controls.cast;
    const rows = $$('[data-bind="reference_list"] .mmd-tile', mount).filter((t) => !t.hidden);
    const own = isScene(n) ? new Set(cardTiles(n)) : null;
    (controls.references ?? []).forEach((ref, i) => {
      const row = rows[i];
      if (!row || row.dataset.kind !== 'image') return;
      if (own ? !own.has(row) : !whoOf(row).includes(n) && !kindsOf(row).some(isFrame)) delete ref.image;
    });
    const which = isScene(n) ? { subject: requestKey(n) } : { character: n };
    return { model: model.key, brief: $('[data-bind="brief"]', mount)?.value ?? '', controls, ...which };
  }
  async function readCastCard(n, redo) {
    const e = castEntry(n);
    const sig = castSig(n);
    e.reading = true;
    e.typedDuring = false;
    e.error = null;
    paintCastCard(n);
    try {
      const res = await fetch('/api/cast', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...castPayload(n), redo }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.message || `HTTP ${res.status}`);
      // Typed into while it was being read: what they typed stays.
      if (e.typedDuring) return;
      e.text = String(out.text ?? '').slice(0, CAST_MAX);
      e.edited = false;
      e.sig = sig;
      e.failedSig = null;
    } catch (err) {
      e.error = err.message;
      e.failedSig = sig;
    } finally {
      e.reading = false;
      e.force = false;
      e.typedDuring = false;
      paintCastCard(n);
    }
  }
  function castCardEl(n) {
    const el = document.createElement('div');
    el.className = 'cast-card';
    el.dataset.n = String(n);
    const thumb = document.createElement('div');
    thumb.className = 'cast-thumb';
    const img = document.createElement('img');
    img.alt = '';
    thumb.append(img);
    const body = document.createElement('div');
    body.className = 'cast-body';
    const top = document.createElement('div');
    top.className = 'cast-top';
    const name = document.createElement('span');
    name.className = 'cast-name';
    name.textContent = cardLabel(n);
    const status = document.createElement('span');
    status.className = 'cast-status';
    top.append(name, status);
    const box = document.createElement('textarea');
    box.rows = 4;
    box.maxLength = CAST_MAX;
    box.placeholder = CARD_PLACEHOLDER[kindOfKey(n)];
    box.setAttribute('aria-label', `${cardLabel(n)}: description`);
    const count = document.createElement('span');
    count.className = 'cast-count';
    box.addEventListener('input', () => {
      const e = castEntry(n);
      e.text = box.value;
      e.edited = true;
      // What they type wins over a read still on its way, and over a Find people still waiting.
      e.force = false;
      if (e.reading) e.typedDuring = true;
      e.sig = castSig(n);
      e.error = null;
      paintCastCard(n);
    });
    body.append(top, box, count);
    el.append(thumb, body);
    castEls.set(n, el);
    return el;
  }
  function paintCastCard(n) {
    const el = castEls.get(n);
    if (!el) return;
    const e = castEntry(n);
    const box = $('textarea', el);
    if (document.activeElement !== box && box.value !== e.text) box.value = e.text;
    box.disabled = e.reading;
    $('.cast-count', el).textContent = `${e.text.length}/${CAST_MAX}`;
    const stale = Boolean(e.text) && e.sig !== castSig(n);
    const state = e.reading ? 'reading' : e.error ? 'error' : stale && e.edited ? 'stale' : '';
    el.dataset.state = state;
    // A pose's picture number moves with the pictures.
    $('.cast-name', el).textContent = cardLabel(n);
    const scene = isScene(n);
    $('.cast-status', el).textContent = e.reading ? (scene ? 'Reading the picture…' : 'Reading their pictures…')
      : e.error ? e.error
        : stale && e.edited ? (scene
          ? 'Out of date: its picture or notes changed. Your text is used as it is; Scan picture reads it again.'
          : 'Out of date: their pictures or box changed. Your text is used as it is; Scan people on their picture reads them again.')
          : !e.text ? (castNeedsRead(n) ? 'Waiting to read…' : 'Empty: read when you Generate.')
            : e.edited ? 'Edited by you' : scene ? 'From the picture' : 'From their pictures';
    paintCastThumb(n, $('img', el));
  }
  /** Their face for the card: their box in the first picture that has one, else the first picture. */
  function paintCastThumb(n, img) {
    const shown = cardTiles(n);
    const tile = (!isScene(n) && shown.find((t) => peopleBoxesOf(t).some((b) => b.n === n))) || shown[0];
    const src = tile?._encoded || $('[data-bind="preview"]', tile ?? document.createElement('div'))?.src;
    if (!src) { img.removeAttribute('src'); return; }
    const box = peopleBoxesOf(tile).find((b) => b.n === n)?.box ?? [0, 0, 1, 1];
    const key = `${tile.dataset.castId}:${box.join(',')}`;
    if (img.dataset.key === key) return;
    img.dataset.key = key;
    const pic = new Image();
    pic.onload = () => {
      if (img.dataset.key !== key) return;
      const [x1, y1, x2, y2] = box;
      const sw = Math.max(1, (x2 - x1) * pic.naturalWidth), sh = Math.max(1, (y2 - y1) * pic.naturalHeight);
      const scale = Math.min(1, 192 / sh, 144 / sw);
      const c = document.createElement('canvas');
      c.width = Math.round(sw * scale);
      c.height = Math.round(sh * scale);
      c.getContext('2d').drawImage(pic, x1 * pic.naturalWidth, y1 * pic.naturalHeight, sw, sh, 0, 0, c.width, c.height);
      img.src = c.toDataURL('image/jpeg', 0.85);
    };
    pic.src = src;
  }
  /** A click on a box: their card, scrolled to and lit for a moment. */
  function focusCastCard(n) {
    const el = castEls.get(n);
    if (!el || castWrap?.hidden) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1200);
  }
  /** Renumbering a box swaps its card with the other number's, when only this picture holds them. */
  function swapCastCards(tile, a, b) {
    const elsewhere = castTiles().some((t) => t !== tile && (whoOf(t).includes(a) || whoOf(t).includes(b)));
    if (elsewhere) return;
    const state = castStateFor(model.key);
    const [ea, eb] = [state.get(a), state.get(b)];
    if (ea) state.set(b, ea); else state.delete(b);
    if (eb) state.set(a, eb); else state.delete(a);
  }

  // roleSel is already populated: the generic pass over [data-bind="role"] in
  // renderBuilder() fills it from model.reference_roles. Not repeated here.
  if (streamSel) {
    fillSelect(streamSel, REFERENCE_STREAM_MODES.map((m) => m.key), 'video',
      (k) => REFERENCE_STREAM_MODES.find((m) => m.key === k)?.label ?? k);
  }

  function select(tile) {
    selected = tile && !tile.hidden ? tile : null;
    for (const t of tiles()) t.setAttribute('data-selected', String(t === selected));
    if (editor) editor.hidden = !selected;
    if (removeBtn) removeBtn.hidden = !selected;
    if (selected) {
      selectLane(selected.closest('[data-lane]')?.dataset.lane ?? 'visual');
      fillEditor(selected);
    }
  }

  function fillEditor(tile) {
    if (!editor || tile !== selected) return;
    if (editHead) {
      editHead.textContent =
        `${$('[data-bind="badge"]', tile)?.textContent || '—'} · ${tile.dataset.filename || ''}`;
    }
    if (roleSel) roleSel.value = tile.dataset.role || roleSel.options[0]?.value || '';
    const labelledPicture = labelsOn() && tile.dataset.kind === 'image';
    const frameMode = tile.dataset.frameMode;
    if (kindField) kindField.hidden = !labelledPicture;
    if (whoField) whoField.hidden = true;
    if (peopleField) peopleField.hidden = true;
    if (labelledPicture && kindSeg) {
      const kinds = kindsOf(tile);
      for (const b of $$('button', kindSeg)) {
        // A frame mode decides the ends itself (FL2VA by position), so no frame buttons.
        b.hidden = Boolean(frameMode) && (isFrame(b.dataset.kind) || b.dataset.kind === 'pose');
        b.setAttribute('aria-pressed', String(kinds.includes(b.dataset.kind)));
      }
      // Place and style alone have nobody to pick.
      if (whoField) whoField.hidden = !takesWho(tile);
      const scanPicture = $('[data-bind="scan_picture"]', editor);
      if (scanPicture) scanPicture.hidden = !sceneOn() || !tile._encoded || !sceneKeysOf(tile).length;
      const whoTitle = whoField?.querySelector(':scope > span');
      if (whoTitle) whoTitle.textContent = kinds.includes('pose') ? 'Who takes this pose' : "Who's in it";
      paintWho(tile);
      // People boxes on a character picture in REF2VA, and on any frame in
      // I2VA, FL2VA and L2VA (13 Oct 2026): with boxes on it, they say who is
      // in it, so the number buttons step aside. Not on a pose.
      const canBox = (Boolean(frameMode) || kinds.includes('character')) && !kinds.includes('pose') && Boolean(tile._encoded);
      if (peopleField) peopleField.hidden = !canBox;
      if (canBox) {
        if (whoField && peopleBoxesOf(tile).length) whoField.hidden = true;
        paintPeople(tile);
      }
    }
    // One box on a labelled picture: what to use it for. Empty means all of it.
    if (keepLabel) keepLabel.textContent = labelledPicture ? 'Use it for' : 'Traits to keep';
    if (keepIn) keepIn.placeholder = labelledPicture ? 'everything, or e.g. "just her haircut"' : '';
    if (dropField) dropField.hidden = labelledPicture && !(tile.dataset.drop ?? '').trim();
    if (roleField) roleField.hidden = labelledPicture;
    if (groupNote) groupNote.hidden = labelsOn();
    if (labelNote) {
      labelNote.hidden = !labelsOn();
      labelNote.textContent = !frameMode ? labelNoteText
        : frameMode === 'FL2VA' ? `The first picture is the first frame and the second the last: drag them to swap. ${FRAME_NOTE}` : FRAME_NOTE;
    }
    const canGroup = !labelledPicture && tile.dataset.kind === 'image' && roleSel?.value === 'subject'
      && ['REF2VA', 'Auto detect'].includes(modeSel?.value);
    if (groupField) groupField.hidden = !canGroup;
    if (groupSel) groupSel.value = canGroup ? (tile.dataset.subjectGroup || '') : '';
    const isVideo = tile.dataset.kind === 'video';
    const isClip = isVideo || tile.dataset.kind === 'audio';
    if (streamField) streamField.hidden = !isVideo;
    if (streamSel && isVideo) {
      streamSel.value = tile.dataset.stream || 'video';
      streamSel.disabled = tile.dataset.hasAudio === 'false';
    }
    if (cropField) cropField.hidden = !isClip;
    if (cropStart) cropStart.value = tile.dataset.cropStart || '';
    if (cropEnd) cropEnd.value = tile.dataset.cropEnd || '';
    // A labelled picture shows its keep field empty while it holds only the
    // tagger's guess, because that guess is not sent. Normal mode shows it.
    const taggerOnly = labelledPicture && tile.dataset.keepAuto === '1';
    if (keepIn) keepIn.value = taggerOnly ? '' : tile.dataset.keep || '';
    if (dropIn) dropIn.value = tile.dataset.drop || '';
    if (editNote) {
      editNote.textContent = taggerOnly
        ? 'Leave it empty to use the whole picture, or say what it is for, like "just her haircut".'
        : tile.dataset.note || '';
    }
  }

  // Writing back. Each control edits the selected tile and nothing else, so a
  // stale selection cannot bleed into the wrong clip.
  // What the reader was told about a picture: changing it makes the reading
  // on the tile stale, and the next Generate reads it again.
  const READ_INPUTS = new Set(['role', 'subjectGroup', 'keep', 'drop']);
  const writeBack = (el, key, after) =>
    el?.addEventListener('input', () => {
      if (!selected) return;
      selected.dataset[key] = el.value;
      if (READ_INPUTS.has(key)) clearTileReading(selected);
      after?.();
      if (READ_INPUTS.has(key)) renderCast();
    });
  writeBack(roleSel, 'role', renumber);
  writeBack(groupSel, 'subjectGroup', () => stampMeta(selected));
  writeBack(streamSel, 'stream', renumber);
  writeBack(keepIn, 'keep', () => { delete selected.dataset.keepAuto; });
  writeBack(dropIn, 'drop');
  writeBack(cropStart, 'cropStart', updateCropDuration);
  writeBack(cropEnd, 'cropEnd', updateCropDuration);
  roleSel?.addEventListener('change', () => { if (selected) { selected.dataset.role = roleSel.value; renumber(); } });
  // What the picture is; Character picks a number no other picture uses.
  // Every button toggles on its own, so any mix can be on; the last one on
  // cannot be turned off.
  kindSeg?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-kind]');
    if (!b || !selected) return;
    const kind = b.dataset.kind;
    const kinds = kindsOf(selected);
    const next = kinds.includes(kind) ? kinds.filter((k) => k !== kind) : [...kinds, kind];
    if (!next.length) return;
    // In a frame mode the picture is always a frame, and which end is the
    // mode's (no frame buttons show); Character, place and style may all be
    // off. REF2VA's own frame kinds are left as they were.
    if (selected.dataset.frameMode) {
      if (isFrame(kind)) return;
      const ref2vaFrames = (selected.dataset.kinds || '').split(',').filter(isFrame);
      const kept = KIND_ORDER.filter((k) => !isFrame(k) && next.includes(k)).concat(ref2vaFrames);
      selected.dataset.kinds = kept.length ? kept.join(',') : 'none';
      if (kind === 'character' && next.includes(kind) && !whoOf(selected).length) selected.dataset.who = String(nextFreeCharacter());
      syncLabel(selected);
      clearTileReading(selected);
      renumber();
      return;
    }
    // Pose stands alone: picking it clears the rest, picking anything else
    // clears it. Its numbers mean who takes it, so the old ones go.
    let kindsNext = next;
    if (kind === 'pose' && next.includes('pose')) {
      kindsNext = ['pose'];
      delete selected.dataset.who;
      delete selected.dataset.whoAxis;
      delete selected.dataset.whoHints;
    } else if (kind !== 'pose' && kinds.includes('pose')) {
      kindsNext = next.filter((k) => k !== 'pose');
      delete selected.dataset.who;
    }
    // Character picks a number no other picture uses, unless people are
    // already tapped (a frame's).
    if (kind === 'character' && kindsNext.includes(kind) && !whoOf(selected).length) selected.dataset.who = String(nextFreeCharacter());
    selected.dataset.kinds = KIND_ORDER.filter((k) => kindsNext.includes(k)).join(',');
    if (!takesWho(selected)) delete selected.dataset.who;
    syncLabel(selected);
    clearTileReading(selected);
    renumber();
    fillEditor(selected);
  });
  // Which way the tap order runs, if any: none until one is picked, and
  // tapping the picked one again takes it off.
  whoAxis?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-axis]');
    if (!b || !selected) return;
    if (selected.dataset.whoAxis === b.dataset.axis) delete selected.dataset.whoAxis;
    else selected.dataset.whoAxis = b.dataset.axis;
    clearTileReading(selected);
    paintWho(selected);
    renumber();
  });
  // Who's in it: a tap adds that number at the right-hand end, a second tap
  // takes it out. The order of taps is where they stand, if an order is picked.
  whoChips?.addEventListener('click', (e) => {
    const b = e.target.closest('.who-chip');
    if (!b || !selected) return;
    const n = Number(b.dataset.who);
    const who = whoOf(selected);
    if (!who.includes(n) && WHO_NOTES[n]) toast(WHO_NOTES[n], 4000);
    setWho(selected, who.includes(n) ? who.filter((x) => x !== n) : [...who, n]);
    clearTileReading(selected);
    paintWho(selected);
    renumber();
  });
  whoHints?.addEventListener('input', (e) => {
    const input = e.target.closest('input[data-hint-for]');
    if (!input || !selected) return;
    const hints = hintsOf(selected);
    const text = input.value.trim();
    if (text) hints[input.dataset.hintFor] = text;
    else delete hints[input.dataset.hintFor];
    selected.dataset.whoHints = JSON.stringify(hints);
    // What the reader is told to look for changed, so what it saw is stale.
    clearTileReading(selected);
    renderCast();
  });
  streamSel?.addEventListener('change', () => { if (selected) { selected.dataset.stream = streamSel.value; renumber(); } });

  /** The crop is what actually gets sent, so it is what the 2-15s check must
   *  see. An empty or nonsensical crop falls back to the source duration. */
  function updateCropDuration() {
    if (!selected) return;
    const src = Number(selected.dataset.sourceDuration);
    const a = Number(selected.dataset.cropStart);
    const b = Number(selected.dataset.cropEnd);
    const span = Number.isFinite(a) && Number.isFinite(b) && b > a ? b - a : src;
    if (Number.isFinite(span) && span > 0) selected.dataset.duration = String(span);
    else delete selected.dataset.duration;
    stampMeta(selected);
    describeLanes(mount);
  }

  function stampMeta(tile) {
    const meta = $('[data-bind="meta"]', tile);
    if (!meta) return;
    const bits = [];
    const d = Number(tile.dataset.duration);
    if (Number.isFinite(d) && d > 0) bits.push(`${d.toFixed(1)}s`);
    const src = Number(tile.dataset.sourceDuration);
    if (Number.isFinite(src) && src > 0 && Math.abs(src - d) > 0.05) bits.push(`of ${src.toFixed(1)}s`);
    if (labelsOn() && tile.dataset.kind === 'image') {
      bits.push(pictureLabelText(tile));
    } else if (tile.dataset.kind === 'image' && tile.dataset.role === 'subject'
      && tile.dataset.subjectGroup && ['REF2VA', 'Auto detect'].includes(modeSel?.value)) {
      bits.push(`Group ${tile.dataset.subjectGroup}`);
    }
    meta.textContent = bits.join(' ');
  }

  // ── drag to reorder ──────────────────────────────────────────
  //
  // Not decoration: the badge number comes from position, so dragging a tile
  // is how someone decides which picture is <Picture 1>. Within a lane only —
  // moving a still into the audio lane would be a lie about what the file is.
  let dragging = null;
  function wireDrag(tile) {
    tile.addEventListener('dragstart', (e) => {
      dragging = tile;
      tile.setAttribute('data-dragging', 'true');
      e.dataTransfer.effectAllowed = 'move';
      // Firefox will not start a drag without data on the transfer.
      e.dataTransfer.setData('text/plain', '');
    });
    tile.addEventListener('dragend', () => {
      dragging?.removeAttribute('data-dragging');
      for (const t of tiles()) t.removeAttribute('data-dropbefore');
      dragging = null;
      renumber();
    });
    tile.addEventListener('dragover', (e) => {
      if (!dragging || dragging === tile) return;
      if (dragging.parentElement !== tile.parentElement) return;
      e.preventDefault();
      tile.setAttribute('data-dropbefore', 'true');
    });
    tile.addEventListener('dragleave', () => tile.removeAttribute('data-dropbefore'));
    tile.addEventListener('drop', (e) => {
      if (!dragging || dragging === tile) return;
      if (dragging.parentElement !== tile.parentElement) return;
      e.preventDefault();
      // Stopped here, or the drop bubbles to the lane's "files from the OS"
      // handler below — and Chrome attaches a dragged <img> to the transfer
      // as a file, so a reorder also added the picture again. Reported by
      // A user 11 Sep 2026: "when trying to move an image it duplicates it",
      // 5 pictures became 13.
      e.stopPropagation();
      tile.removeAttribute('data-dropbefore');
      tile.parentElement.insertBefore(dragging, tile);
      renumber();
    });
  }

  // ── adding files ─────────────────────────────────────────────
  for (const which of ['visual', 'audio']) {
    lane[which].el?.addEventListener('click', () => selectLane(which));
    lane[which].add?.addEventListener('click', (e) => {
      e.stopPropagation();
      pickingFor = which;
      input.accept = typesFor[which].join(',');
      input.click();
    });
    // Drag a file from the OS onto the lane it belongs in.
    //
    // A tile being reordered is NOT a file from the OS, whatever the transfer
    // says: Chrome puts a dragged thumbnail on it as a file, which is how a
    // reorder became an upload (11 Sep 2026). While `dragging` is set, the
    // lane only accepts it as a move — onto empty lane space, to the end —
    // and never reads the transfer's files.
    lane[which].el?.addEventListener('dragover', (e) => {
      if (dragging) {
        if (dragging.parentElement === lane[which].slots) e.preventDefault();
        return;
      }
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      lane[which].el.setAttribute('data-dropping', 'true');
    });
    lane[which].el?.addEventListener('dragleave', () =>
      lane[which].el.removeAttribute('data-dropping'));
    lane[which].el?.addEventListener('drop', async (e) => {
      if (dragging) {
        e.preventDefault();
        if (dragging.parentElement === lane[which].slots) {
          lane[which].slots.insertBefore(dragging, lane[which].add);
          renumber();
        }
        return;
      }
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      lane[which].el.removeAttribute('data-dropping');
      selectLane(which);
      pickingFor = which;
      for (const f of [...e.dataTransfer.files]) await addReference(f);
    });
  }

  input.addEventListener('change', async () => {
    const files = [...(input.files ?? [])];
    input.value = '';                     // so the same file can be re-picked
    for (const file of files) await addReference(file);
  });

  // Paste into the selected lane, which is what lane selection is FOR in the
  // node. Bound to the panel rather than the document so a Ctrl+V in the brief
  // box stays a text paste.
  wrap.addEventListener('paste', async (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    pickingFor = selectedLane;
    for (const f of files) await addReference(f);
  });

  removeBtn?.addEventListener('click', () => {
    if (!selected) return;
    releasePreviews(selected);
    selected.remove();
    select(null);
    renumber();
  });

  clearBtn?.addEventListener('click', () => {
    const all = tiles();
    if (!all.length) {
      toast('Nothing to clear.');
      return;
    }
    for (const t of all) {
      releasePreviews(t);
      t.remove();
    }
    select(null);
    renumber();
  });

  // "press Delete/Backspace while a tile is selected". Ignored while the focus
  // is in a text field, or this would eat a backspace in Traits to keep.
  wrap.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    if (!selected) return;
    const t = e.target?.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return;
    e.preventDefault();
    releasePreviews(selected);
    selected.remove();
    select(null);
    renumber();
  });

  modeSel?.addEventListener('change', applyMode);

  // The help button's address comes off the status poll and points at this
  // box, never off the tailnet. Shown only when the doc is really present, so
  // a checkout that has not run fetch-h3-refs is simply missing a button
  // rather than offering a link into a 404.
  // Where to get a ComfyUI workflow for this prompt, when the registry names
  // one (config/models.yaml, comfyui_workflow). Off the tailnet on purpose,
  // by the owner's call: the workflow is someone else's to hand out.
  const workflowLink = $('[data-bind="workflow_link"]', mount);
  const wf = model?.comfyui_workflow;
  if (workflowLink) {
    const ok = wf && /^https:\/\//.test(String(wf.url ?? ''));
    workflowLink.hidden = !ok;
    if (ok) {
      workflowLink.href = wf.url;
      workflowLink.textContent = wf.label || 'Workflow';
      workflowLink.title = wf.title || wf.url;
    }
  }

  const help = $('[data-bind="help"]', mount);
  if (help) {
    if (REFERENCE_DIRECTOR_DOC) {
      help.href = REFERENCE_DIRECTOR_DOC;
      help.hidden = false;
    } else {
      help.removeAttribute('href');
      help.hidden = true;
    }
  }

  // A fresh panel, or this model's own tiles back from builderStash. Another
  // model's never arrive here — a reference list built for one model means
  // nothing to the next — but leaving h3 and coming back used to empty it as
  // well, which was the wrong half (11 Sep 2026).
  for (const t of tiles()) {
    releasePreviews(t);
    t.remove();
  }
  for (const saved of restore ?? []) restoreReference(saved);
  select(null);
  selectLane('visual');
  applyMode();

  /** A tile for a file, placed in its lane and wired, with no analysis.
   *  Shared by a fresh add and by a restore, so the two cannot drift. */
  function buildTile(file, kind, which) {
    const tile = tpl.content.firstElementChild.cloneNode(true);
    // Kept so the tile can be rebuilt after a model switch. On the element,
    // not the dataset, for the reason _encoded gives in addReference.
    tile._file = file;
    // Which picture this is to the Cast list, kept across a model switch (restore copies the dataset over it).
    tile.dataset.castId = Math.random().toString(36).slice(2, 10);
    tile.dataset.kind = kind ?? 'image';
    tile.dataset.filename = file.name;
    // An audio clip's only job is `voice`; the list's first role, `subject`,
    // means nothing on a sound file.
    const roles = model.reference_roles ?? [];
    tile.dataset.role = kind === 'audio' && roles.includes('voice') ? 'voice' : roles[0] ?? '';
    if (kind === 'video') tile.dataset.stream = 'video';
    if ((kind ?? 'image') === 'image') {
      tile.dataset.who = String(nextFreeCharacter());
      tile.dataset.kinds = 'character';
      syncLabel(tile);
    }

    const previewFor = { image: 'preview', video: 'preview_video', audio: 'preview_wave' };
    const preview = $(`[data-bind="${previewFor[kind ?? 'image']}"]`, tile);
    if (preview) {
      if (preview.tagName === 'IMG' || preview.tagName === 'VIDEO') {
        preview.src = URL.createObjectURL(file);
        if (preview.tagName === 'IMG') preview.alt = file.name;
      }
      preview.hidden = false;
    }

    const nameEl = $('[data-bind="name"]', tile);
    if (nameEl) nameEl.textContent = file.name;

    // The V / A / V+A buttons the node puts in a video tile's corner. Built
    // from the server's stream modes so the labels and the keys cannot drift.
    const streams = $('[data-bind="streams"]', tile);
    if (kind === 'video' && streams) {
      streams.hidden = false;
      const short = { video: 'V', audio: 'A', both: 'V+A' };
      for (const m of REFERENCE_STREAM_MODES) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'mmd-stream';
        b.textContent = short[m.key] ?? m.key;
        b.title = m.label;
        b.dataset.stream = m.key;
        b.setAttribute('aria-pressed', String(m.key === 'video'));
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          if (b.disabled) return;
          tile.dataset.stream = m.key;
          for (const other of $$('.mmd-stream', streams)) {
            other.setAttribute('aria-pressed', String(other === b));
          }
          renumber();
        });
        streams.appendChild(b);
      }
    }

    const readBtn = $('[data-bind="read_btn"]', tile);
    readBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleReadingCard(tile, readBtn);
    });

    tile.addEventListener('click', () => select(tile));
    wireDrag(tile);

    lane[which].slots.insertBefore(tile, lane[which].add);
    return tile;
  }

  /** One tile back from builderStash, exactly as it was left: role, keep,
   *  drop, crop, stream and the picture the model will be shown. Not
   *  re-described — the traits are already on it, and may be hand-edited. */
  function restoreReference(saved) {
    const kind = saved.data.kind;
    const which = kind === 'audio' ? 'audio' : 'visual';
    if (!lane[which].slots) return;
    const tile = buildTile(saved.file, kind, which);
    for (const [k, v] of Object.entries(saved.data)) {
      if (k !== 'selected' && k !== 'dragging' && k !== 'dropbefore') tile.dataset[k] = v;
    }
    const stream = tile.dataset.stream || 'video';
    for (const b of $$('.mmd-stream', tile)) {
      b.setAttribute('aria-pressed', String(b.dataset.stream === stream));
      if (tile.dataset.hasAudio === 'false' && b.dataset.stream !== 'video') b.disabled = true;
    }
    stampMeta(tile);
    syncReadingButton(tile);
    // Left while it was still being described: the answer went to the old
    // tile, which is gone. Say so rather than "Describing…" forever.
    if ((tile.dataset.note ?? '').endsWith('…')) {
      tile.dataset.note = 'The model was switched before this was described. Type the traits yourself, or remove it and add it again.';
    }
    tile._encoded = saved.encoded;
    if (!tile._encoded && kind === 'image') {
      encodeForModel(saved.file).then((e) => { tile._encoded = e; renderCast(); }).catch(() => {});
    }
  }

  async function addReference(file) {
    const kind = laneForFile(file, limits);
    if (limits && !kind) {
      toast(`${file.type || 'That file'} is not an accepted reference type`);
      return;
    }
    const which = kind === 'audio' ? 'audio' : 'visual';
    if (which !== pickingFor && limits) {
      // Dropped on the wrong lane. Put it where it belongs rather than
      // refusing it — the node routes by type too.
      pickingFor = which;
    }
    if (limits) {
      const maxMb =
        kind === 'image' ? limits.max_image_mb
        : kind === 'video' ? limits.max_video_mb
        : limits.max_audio_mb;
      // Checked here as well as on the server so a 500MB video is refused
      // before it goes over the tailnet, not after.
      if (maxMb && file.size > maxMb * 1024 * 1024) {
        toast(`${file.name} is over the ${maxMb} MB limit for ${kind}`);
        return;
      }
    }

    const tile = buildTile(file, kind, which);
    renumber();
    select(tile);

    // The picture, for the model to look at — 9 Sep 2026. A tile used to
    // reach the prompt writer as role, keep, drop and length, which describes
    // what a file is FOR in the Director's pipeline and not one thing about
    // what is in it. <Subject 1> with no picture is a placeholder.
    //
    // Stills only. A video or an audio clip cannot be handed to a projector,
    // and those two lanes stay exactly as they were: their traits come from
    // sampled frames and the analyzer, which is the right tool for them.
    // Kept off the dataset for the reason wireFrame gives — this is ~100KB of
    // base64 and the dataset puts it in an HTML attribute.
    if (kind === 'image') tile._encoded = await encodeForModel(file);
    // The Cast list can read them now.
    if (kind === 'image') renderCast();

    // Describe it. The tile is already usable by hand if this fails or is slow.
    tile.dataset.note =
      kind === 'video' ? 'Sampling frames…'
      : kind === 'audio' ? 'Reading the clip…'
      : 'Describing the image…';
    fillEditor(tile);

    try {
      const res = await fetch('/api/references/analyze', {
        method: 'POST',
        headers: { 'content-type': file.type },
        body: file,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        tile.dataset.note = `Could not describe it (${body.message ?? body.error ?? res.status}). Type the traits yourself.`;
        fillEditor(tile);
        return;
      }
      const data = await res.json();

      // Duration and the stream facts ride on the tile and go up with the
      // generate request — the model can use how long a source clip runs when
      // it is asked to edit or continue one. The crop defaults to the whole
      // clip, which is what the node shows before anyone drags a marker.
      if (data.duration_seconds) {
        tile.dataset.sourceDuration = String(data.duration_seconds);
        tile.dataset.duration = String(data.duration_seconds);
        if (kind !== 'image') {
          tile.dataset.cropStart = '0';
          tile.dataset.cropEnd = String(data.duration_seconds);
        }
        stampMeta(tile);
      }

      // A video with no sound cannot offer the audio modes honestly.
      if (kind === 'video' && data.has_audio === false) {
        tile.dataset.stream = 'video';
        tile.dataset.hasAudio = 'false';
        for (const b of $$('.mmd-stream', tile)) {
          if (b.textContent !== 'V') b.disabled = true;
          b.setAttribute('aria-pressed', String(b.textContent === 'V'));
        }
        tile.dataset.note = 'This clip has no audio track.';
      }

      if (!data.described) {
        tile.dataset.note = data.reason ?? 'Not described. Type the traits yourself.';
        fillEditor(tile);
        renumber();
        return;
      }

      const detected = [...(data.character ?? []), ...(data.general ?? [])]
        .slice(0, REFERENCE_TAG_LIMIT)
        .map((t) => tagForModel(t.tag, model));

      if (!detected.length) {
        tile.dataset.note = 'Nothing detected above the thresholds. Type the traits yourself.';
        fillEditor(tile);
        renumber();
        return;
      }
      const from =
        (data.sampled_at?.length ? `${data.model}, ${data.sampled_at.length} frames` : data.model) +
        // Said here as well as on the image reference cards: the preference
        // asked for the model and the taggers stood in. Two words about why
        // beats a tile that looks exactly like a working one.
        (data.fell_back_from === 'llm' ? ` (the model could not: ${data.fallback_reason})` : '');
      // Never overwrite what the user typed. If they got there first, offer
      // the detection instead of replacing it.
      if (!(tile.dataset.keep ?? '').trim()) {
        tile.dataset.keep = detected.join(', ');
        // Marked as the tagger's, so a labelled picture can leave it out: H3 sees the
        // picture, and tags like "solo" or "pixel art" steered the whole
        // video wrong (1 Oct 2026). Typing in the field clears the mark.
        tile.dataset.keepAuto = '1';
        tile.dataset.note = `Detected by ${from} — edit freely.`;
      } else {
        tile.dataset.note = `Detected: ${detected.join(', ')}`;
      }
      fillEditor(tile);
      renumber();
    } catch (err) {
      tile.dataset.note = `Could not describe it (${err.message}). Type the traits yourself.`;
      fillEditor(tile);
    }
  }
}

/** Object URLs are held until revoked, and a row can carry any of three
 *  preview elements. Missing one leaks the whole file for the session. */
function releasePreviews(root) {
  // The audio lane's tile has no <audio> element any more — it is a painted
  // band, which holds no object URL — so preview_wave is not listed here. A
  // root that IS a tile has to be considered as well as its descendants, since
  // removing a single tile passes the tile itself.
  const sel = '[data-bind="preview"], [data-bind="preview_video"], [data-bind="preview_audio"]';
  // $$, not $. This read [...$(sel, root)] — and $ is querySelector, which
  // returns one element or null, neither of them iterable — so every call
  // threw before revoking anything. Every caller runs this BEFORE removing the
  // tile, so the h3 Director's Remove, Clear and Delete key all died on it:
  // a user's "after inserting an image, I cannot remove it, the
  // buttons do not work", 11 Sep 2026. Found in a real browser that day.
  const els = [...$$(sel, root), ...(root.matches?.(sel) ? [root] : [])];
  for (const el of els) {
    if (el.src?.startsWith('blob:')) URL.revokeObjectURL(el.src);
  }
}

/** The stream vocabulary and the lane limits, both served by /api/status so
 *  the labels shown and the keys the server honours cannot drift. Filled at
 *  boot; the fallback is the picture-only mode, which is the safe default. */
let REFERENCE_STREAM_MODES = [{ key: 'video', label: 'Video only' }];
let REFERENCE_LANE_LIMITS = null;
/** The Director's caps per mode. REFERENCE_LANE_LIMITS is the loosest set and
 *  stays the fallback for a model or a mode this has nothing for. */
let REFERENCE_MODE_LIMITS = null;
let REFERENCE_CLIP_SECONDS = null;
/** role -> label class, from server/references.mjs. The tile badges show the
 *  label the prompt will really use, so this must never be a local copy. */
let REFERENCE_ROLE_LABELS = null;
/** Where this box serves the Director documentation, or null when it has not
 *  been fetched. The panel's help button stays hidden while this is null. */
let REFERENCE_DIRECTOR_DOC = null;
/** Whether the server has the second-pass instruction loaded. The toggle is
 *  not rendered at all while this is false. */
let SECOND_PASS_AVAILABLE = false;
/** Whether this box can read a keyframe off the LTX Director's timeline — the
 *  reader's instruction file has to be on disk. The upload is hidden rather
 *  than disabled while this is false: a control that silently does nothing is
 *  worse than one that is not offered. */
let DIRECTOR_KEYFRAMES = false;
let REFERENCE_MEDIA = null;

/** Say what may be attached and how many, under the picker. The Director's
 *  limits are worth stating up front — it refuses past them, and finding that
 *  out in ComfyUI is a long way from here.
 *
 *  Per mode since 4 Sep 2026. This used to state REF2VA's numbers whatever was
 *  selected, and REF2VA's are the loosest of the three: it told people nine
 *  images and three videos were fine in T2VA, where the Director accepts no
 *  video at all. Re-runs on every mode change, which is why setupReferences
 *  wires the Mode select to it. */
function describeLanes(mount) {
  const el = $('[data-bind="reference_limits"]', mount);
  if (!el) return;
  const mode = $('[data-bind="mode"]', mount)?.value ?? null;
  const lim = (mode && REFERENCE_MODE_LIMITS?.[mode]) || REFERENCE_LANE_LIMITS;
  const parts = [];
  if (lim) {
    // A mode that takes nothing but stills reads better as a sentence about
    // stills than as a list with two zeroes in it.
    const named = mode ? `In ${mode} the Director accepts` : 'The Director accepts';
    if (!lim.image && !lim.video && !lim.audio) {
      parts.push(`${named} no references — ${mode} is the text-only mode.`);
    } else if (!lim.video && !lim.audio) {
      parts.push(
        `${named} ${lim.image} image${lim.image === 1 ? '' : 's'} and no video or audio.`
      );
    } else {
      parts.push(
        `${named} ${lim.image} images, ${lim.video} videos and ${lim.audio} audio clips, ${lim.total} files in total.`
      );
    }
  }
  if (REFERENCE_CLIP_SECONDS && lim && (lim.video || lim.audio)) {
    parts.push(
      `Clips run ${REFERENCE_CLIP_SECONDS.min}–${REFERENCE_CLIP_SECONDS.max} seconds each.`
    );
  }
  if (REFERENCE_MEDIA && !REFERENCE_MEDIA.available) {
    parts.push(REFERENCE_MEDIA.reason ?? 'ffmpeg is not available, so video is not described automatically.');
  } else if (REFERENCE_MEDIA) {
    parts.push('Video is described by sampling frames; audio is never described automatically.');
  }
  el.textContent = parts.join(' ');
}

/**
 * The segments that belong in a copied prompt.
 *
 * "Copy all" used to join every segment body, which put the model's own
 * Reasoning paragraph — and any N/A placeholders — into text headed for a
 * prompt box. For h3 that is measurable: the DaSiWa Director assembles a
 * base-mode prompt from three official fields, and a copy carrying three bare
 * "N/A" lines plus a paragraph of the model explaining its own choices is not
 * that. Verified against a real generation on 21 Aug.
 *
 * Two exclusions, both read from the registry rather than from any name this
 * file knows: segments the model declares as `meta_segments`, and segments
 * whose body is exactly N/A — which by SKILL.md's own rule means "nothing to
 * say here", so there is nothing to paste.
 *
 * Download is deliberately left alone. It writes label + body and is the
 * archive of what was generated, where the reasoning is the point.
 */
export function promptSegments(segments, model) {
  const meta = new Set(model?.meta_segments ?? []);
  return (segments ?? []).filter(
    (s) => !meta.has(s.label) && !/^n\/a$/i.test((s.body ?? '').trim())
  );
}

/**
 * The segments the output panel shows for a result, given the prompt style.
 *
 * Structured is the result as generated. Simple swaps every prompt segment for
 * one card holding the whole assembled prompt the server sent as
 * `simple_prompt` — the Director node's Simple box sends its text verbatim,
 * so the alignment line and field names have to be in it — and keeps the meta
 * segments below it, since the Reasoning is still worth reading.
 *
 * Falls back to the fields whenever there is no Simple text: a model without
 * `simple_prompt`, a refusal, or a result recorded before this existed. Never
 * a blank panel, and never the fields under a "Simple prompt" label.
 */
export function shownSegments(result, model, style) {
  const segments = result?.segments ?? [];
  if (style !== 'simple' || !model?.simple_prompt || !result?.simple) return segments;
  const meta = new Set(model.meta_segments ?? []);
  return [{ label: 'Simple prompt', body: result.simple }, ...segments.filter((s) => meta.has(s.label))];
}

/** Re-render the result's cards in place, leaving notes and the reading be. */
function repaintSegments() {
  const mount = $('#output-mount');
  if (!mount || !lastResult?.segments?.length) return;
  const old = $$('.segment', mount);
  const frag = document.createDocumentFragment();
  for (const seg of shownSegments(lastResult, currentModel, promptStyle)) {
    frag.appendChild(segmentEl(currentModel, seg));
  }
  if (old.length) old[0].before(frag);
  else mount.appendChild(frag);
  for (const el of old) el.remove();
}

/**
 * The Structured / Simple toggle in the h3 Director toolbar.
 *
 * Changes what is shown and copied, never what is generated — the server
 * sends both forms with every result, so switching is instant and needs no
 * second generation. Shown only for a model that declares `simple_prompt`.
 */
function setupPromptStyle(mount, model) {
  const wrap = $('[data-bind="prompt_style"]', mount);
  if (!wrap) return;
  wrap.hidden = !model.simple_prompt;
  if (wrap.hidden) return;
  const buttons = $$('[data-style]', wrap);
  const paint = () => {
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.style === promptStyle));
  };
  paint();
  for (const b of buttons) {
    b.addEventListener('click', () => {
      promptStyle = b.dataset.style === 'simple' ? 'simple' : 'structured';
      try {
        localStorage.setItem(PROMPT_STYLE_KEY, promptStyle);
      } catch {
        // Private window or blocked storage: the switch still works this visit.
      }
      paint();
      if (promptStyle === 'simple' && lastResult?.segments?.length && !lastResult.simple) {
        toast('This result has no Simple version — generate it again to get one.');
      }
      repaintSegments();
    });
  }
}

// ── first frame (image-to-video) ─────────────────────────────
//
// Separate from the H3 path above and deliberately not a copy of it. wan.md
// is explicit: a supplied reference image *is the first frame*, and the model
// must not re-describe what is already visible in it — the subject layer stays
// brief and points at what carries forward, while the words go to motion and
// camera, "which is all the model has to invent". Feeding it H3's ten detected
// tags would push it to do the opposite of what its own prompt file asks.
//
// So this sends a short list: enough for the subject layer to name what
// carries forward, and no more. As with H3, the image never leaves this
// machine — only the description reaches the LLM.
/**
 * LTX Director mode: a timeline, mirroring the node's arrangement.
 *
 * The state is a flat list of {start, end, brief}. Blocks are positioned as
 * percentages of the clip duration, so the track reflows with the panel and
 * there is no pixel-per-second scale to keep in sync.
 *
 * Only the controls that change the prompt are here. The node's AUDIO track,
 * IC-LoRA track, Guide Strength and Retake Mode are its own features — this
 * app cannot produce any of them, and a control that silently does nothing is
 * the failure this project has a rule about.
 */
/**
 * A clip duration held to its range.
 *
 * Exported and pure because the same clamp is needed in three places — the
 * live redraw, the commit handler, and the request the timeline is sent with
 * — and those disagreeing is precisely the bug this fixes: typing 200 drew a
 * 60-second timeline and told the model the clip was 200 seconds long.
 *
 * Anything unparseable becomes the floor rather than 0, since a zero-length
 * clip has no timeline to draw.
 */
export function clampDuration(value, max, min = 0.5) {
  const ceiling = Number(max) || Infinity;
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), ceiling);
}

/** The timeline as the request reads it — seconds, in time order. Mirrored
 *  out of the canvas on every edit; nothing writes back into the canvas from
 *  here, so the two cannot drift. */
let directorSegments = [];
let directorSelected = -1;
/** The live canvas, or null when no Director model is mounted. Held so a
 *  model switch can tear its ResizeObserver down. */
let directorTimeline = null;

function setupDirector(mount, model) {
  const panel = $('[data-bind="director_panel"]', mount);
  if (!panel) return;

  const modeSel = $('[data-bind="mode"]', mount);
  const durEl = $('[data-bind="director_duration"]', mount);
  const canvasHost = $('[data-bind="director_canvas"]', mount);
  const note = $('[data-bind="director_note"]', mount);
  const readout = $('[data-bind="director_readout"]', mount);
  const briefEl = $('[data-bind="director_brief"]', mount);
  const segLabel = $('[data-bind="director_seg_label"]', mount);
  const briefLabel = $('[data-bind="brief_label"]', mount);
  const addBtn = $('[data-bind="director_add"]', mount);
  const delBtn = $('[data-bind="director_delete"]', mount);
  const keyEl = $('[data-bind="director_keyframe"]', mount);
  const keyField = $('[data-bind="director_keyframe_field"]', mount);
  const keyNote = $('[data-bind="director_keyframe_note"]', mount);
  const keyClear = $('[data-bind="director_keyframe_clear"]', mount);
  const keyThumb = $('[data-bind="director_keyframe_thumb"]', mount);
  keyThumb?.addEventListener('click', (e) => {
    e.preventDefault();
    openPicture(keyThumb.src, keyThumb.alt);
  });

  const maxSegments = model.director_max_segments ?? 8;
  const maxDuration = model.director_max_duration ?? 60;

  // Switching models resets the timeline, like every other piece of
  // per-model state.
  directorSegments = [];
  directorSelected = -1;
  directorTimeline?.destroy();
  directorTimeline = null;

  if (durEl) {
    durEl.value = String(model.director_default_duration ?? 5);
    // The ceiling comes from the registry rather than the markup, so the
    // number the browser enforces and the number the timeline is drawn at
    // cannot disagree — and collectControls reads it back off the element,
    // which is why it has to be set here rather than only known in JS.
    durEl.max = String(maxDuration);
    durEl.min = '0.5';
  }

  const duration = () => clampDuration(durEl?.value, maxDuration);
  const isDirector = () => /director/i.test(modeSel?.value ?? '');
  const fpsEl = () => $('[data-bind="director_frame_rate"]', mount);

  /**
   * One file, validated and encoded, or null.
   *
   * The same limits and the same downscale as every other picture lane —
   * TAGGERS.limits is the server's own answer about what it accepts, so a
   * file rejected here is one the upload would have refused anyway.
   *
   * No tagger call. The owner's call, and the stronger reason is that a
   * tagger reports STATES where this needs the DELTA: `standing` in one
   * frame and `standing` in the next says nothing changed when she turned
   * and stepped forward. The server reads each picture with a vision model
   * once instead, cached by content hash.
   */
  const readFile = async (file) => {
    if (!file) return null;
    const limits = TAGGERS?.limits;
    if (limits) {
      const allowed = limits.allowed_image_types ?? [];
      if (allowed.length && !allowed.includes(file.type)) {
        toast(`${file.type || 'That file'} is not an accepted image type`);
        return null;
      }
      if (file.size > (limits.max_image_mb ?? 20) * 1024 * 1024) {
        toast(`${file.name} is over the ${limits.max_image_mb} MB limit`);
        return null;
      }
    }
    const image = await encodeForModel(file);
    if (!image) {
      toast(`${file.name} could not be read.`);
      return null;
    }
    return { image, name: file.name };
  };

  const paintReadout = () => {
    const segs = directorSegments;
    const i = directorSelected;
    const seg = segs[i];
    if (readout) {
      readout.textContent = seg
        ? `Start: ${seg.start.toFixed(2)} | End: ${seg.end.toFixed(2)} | Length: ${(seg.end - seg.start).toFixed(2)}`
        : 'Start: - | End: - | Length: -';
    }
    if (segLabel) segLabel.textContent = seg ? `SEGMENT ${i + 1} PROMPT` : 'SEGMENT PROMPT';
    if (briefEl) {
      briefEl.disabled = !seg;
      if (briefEl.value !== (seg?.brief ?? '')) briefEl.value = seg?.brief ?? '';
    }
    if (delBtn) delBtn.disabled = !seg;
    if (addBtn) addBtn.disabled = segs.length >= maxSegments;

    if (keyField) keyField.hidden = !DIRECTOR_KEYFRAMES || !seg;
    if (keyEl) keyEl.value = '';
    if (keyClear) keyClear.hidden = !seg?.image;
    // The selected segment's picture, small, and full size on a click.
    if (keyThumb) {
      keyThumb.hidden = !seg?.image;
      if (seg?.image) {
        keyThumb.src = seg.image;
        keyThumb.alt = seg.imageName ?? 'Keyframe';
      } else {
        keyThumb.removeAttribute('src');
      }
    }
    if (keyNote) {
      keyNote.textContent = !seg
        ? ''
        : seg.image
          ? `${seg.imageName ?? 'Picture'} — read once when you generate.`
          : 'Drag a picture onto a block, or browse.';
    }

    if (note) {
      note.textContent = !segs.length
        ? 'No segments yet — drag a picture onto the track, or press + on an empty stretch.'
        : segs.length >= maxSegments
          ? `${segs.length} segments — the maximum for this model.`
          : `${segs.length} segment${segs.length === 1 ? '' : 's'}. The node joins them into one prompt, so each continues the last.`;
    }
  };

  const timeline = createDirectorTimeline(canvasHost, {
    frameRate: () => Number(fpsEl()?.value) || model.director_default_frame_rate || 24,
    durationSeconds: duration,
    acceptsImages: () => DIRECTOR_KEYFRAMES,
    readFile,
    toast,
    onChange: (segs) => {
      // The canvas owns the timeline; this mirror is what collectControls
      // reads. One direction only — nothing writes back into the canvas from
      // here, so the two cannot drift.
      if (segs.length > maxSegments) {
        toast(`${maxSegments} segments is the maximum for this model.`);
      }
      directorSegments = segs.slice(0, maxSegments);
      paintReadout();
    },
    onSelect: (i) => {
      directorSelected = i;
      paintReadout();
    },
  });
  directorTimeline = timeline;

  const sync = () => {
    const on = isDirector();
    panel.hidden = !on;
    if (briefLabel) briefLabel.textContent = on ? 'GLOBAL PROMPT' : 'Brief';
    if (on) timeline.render();
    paintReadout();
  };

  addBtn?.addEventListener('click', () => {
    if (directorSegments.length >= maxSegments) return;
    timeline.add();
  });
  delBtn?.addEventListener('click', () => timeline.remove());

  briefEl?.addEventListener('input', () => timeline.setBrief(briefEl.value));

  keyEl?.addEventListener('change', async () => {
    const file = keyEl.files?.[0];
    if (!file) return;
    await timeline.setImage(file);
  });
  keyClear?.addEventListener('click', () => timeline.clearImage());

  // Paste, for a frame that is on the clipboard and never became a file.
  panel.addEventListener('paste', async (e) => {
    if (!DIRECTOR_KEYFRAMES) return;
    const file = [...(e.clipboardData?.files ?? [])][0];
    if (!file) return;
    if (timeline.selectedIndex() < 0) {
      toast('Select a segment first, then paste.');
      return;
    }
    e.preventDefault();
    await timeline.setImage(file);
  });

  // Shrinking the clip must not leave segments hanging past its end — and
  // must not leave zero-length ones behind either. The timeline drops what no
  // longer fits rather than clamping it to nothing, since a row saying
  // nothing happens between 3s and 3s is not a segment.
  durEl?.addEventListener('input', () => timeline.reflow());
  durEl?.addEventListener('change', () => {
    const clamped = clampDuration(durEl.value, maxDuration);
    if (String(clamped) !== durEl.value) {
      durEl.value = String(clamped);
      durEl.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  fpsEl()?.addEventListener('change', () => timeline.render());

  modeSel?.addEventListener('change', sync);
  sync();
}

const round1 = (n) => Math.round(n * 10) / 10;

const I2V_TAG_LIMIT = 5;

/**
 * The first frame, and optionally the last.
 *
 * Wan takes one image or a first/last pair, and `i2v_modes` in the registry
 * says which. Two is the ceiling. The mode is the only thing that decides
 * whether a last frame exists, so switching back to a single image clears the
 * second field rather than merely hiding it — a hidden-but-armed frame would
 * travel with the next generate and the user would never see why.
 */
function setupI2vReference(mount, model) {
  const first = $('[data-bind="i2v_image"]', mount);
  if (!first) return;
  const last = $('[data-bind="i2v_last_image"]', mount);
  const lastField = $('[data-bind="i2v_last_field"]', mount);
  const modeSel = $('[data-bind="i2v_mode"]', mount);
  const firstNote = $('[data-bind="i2v_note"]', mount);
  const lastNote = $('[data-bind="i2v_last_note"]', mount);
  // A Remove beside each frame. Reported 11 Sep 2026 by a user: once
  // a picture was in, a bare file input offers no way to take it out again,
  // and the only escape was a page refresh. Shown only while a file is set.
  const firstClear = $('[data-bind="i2v_clear"]', mount);
  const lastClear = $('[data-bind="i2v_last_clear"]', mount);
  const paintClears = () => {
    if (firstClear) firstClear.hidden = !first?.files?.length;
    if (lastClear) lastClear.hidden = !last?.files?.length;
  };

  const clear = (input, note) => {
    if (!input) return;
    input.value = '';
    showFrameThumb(input, null);
    // The encoded picture too, or Generate would still send a frame the
    // panel says is gone.
    input._encoded = null;
    delete input.dataset.description;
    delete input.dataset.filename;
    if (note) note.textContent = '';
    paintClears();
  };

  // Switching models clears both, like every other piece of per-model state.
  clear(first, firstNote);
  clear(last, lastNote);

  const wantsPair = () => /last/i.test(modeSel?.value ?? '');

  const syncMode = () => {
    if (!lastField) return;
    const showLast = wantsPair();
    lastField.hidden = !showLast;
    if (!showLast) clear(last, lastNote);
  };

  if (modeSel) modeSel.addEventListener('change', syncMode);
  syncMode();

  wireFrame(first, firstNote, 'First frame', model);
  wireFrame(last, lastNote, 'Last frame', model);

  // After wireFrame, so its synchronous refusals (wrong type, too big) have
  // already emptied the input by the time the button is painted.
  first.addEventListener('change', paintClears);
  last?.addEventListener('change', paintClears);
  firstClear?.addEventListener('click', () => clear(first, firstNote));
  lastClear?.addEventListener('click', () => clear(last, lastNote));
}

/**
 * The small picture beside a frame's file box, and the full-size view behind
 * it (12 Oct 2026: a bare file box never showed which picture went in). The
 * thumbnail sits inside the field's <label>, so its click is kept from
 * opening the file picker. null hides it.
 */
function showFrameThumb(input, file) {
  const thumb = input?.parentElement?.querySelector('[data-bind="frame_thumb"]');
  if (!thumb) return;
  if (thumb.src.startsWith('blob:')) URL.revokeObjectURL(thumb.src);
  if (!file) {
    thumb.hidden = true;
    thumb.removeAttribute('src');
    return;
  }
  thumb.src = URL.createObjectURL(file);
  thumb.alt = file.name;
  thumb.hidden = false;
  if (!thumb.dataset.wired) {
    thumb.dataset.wired = '1';
    thumb.addEventListener('click', (e) => {
      e.preventDefault();
      openPicture(thumb.src, thumb.alt);
    });
  }
}

/**
 * One file input: validate it, encode it for the model, describe it with the
 * tagger, label the note.
 *
 * **The picture goes to the model now** — 9 Sep 2026. Until then this frame
 * reached wan's prompt writer as a comma-separated tagger list and nothing
 * else, which is the auto-inject the image models were taken off a day
 * earlier. A first frame is a composition, a palette and a light direction,
 * and `1girl, long_hair, outdoors` is none of those.
 *
 * The tagger still runs and its list still travels, because the server is the
 * side that knows whether the chosen LLM can see: it uses the picture when
 * there is one to use and falls back to the list when there is not. The note
 * under the field is also the only feedback that the upload worked at all.
 */
function wireFrame(input, note, label, model) {
  if (!input) return;
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    delete input.dataset.description;
    delete input.dataset.filename;
    // A property rather than a dataset entry, unlike everything else on these
    // inputs: this is 100KB of base64 and the dataset writes it into the DOM
    // as an attribute, where it shows up in every inspector and every
    // innerHTML this file has ever been bitten by.
    input._encoded = null;
    if (!file) {
      if (note) note.textContent = '';
      showFrameThumb(input, null);
      return;
    }

    const limits = TAGGERS?.limits;
    if (limits) {
      const allowed = limits.allowed_image_types ?? [];
      if (allowed.length && !allowed.includes(file.type)) {
        toast(`${file.type || 'That file'} is not an accepted image type`);
        input.value = '';
        return;
      }
      if (file.size > (limits.max_image_mb ?? 20) * 1024 * 1024) {
        toast(`${file.name} is over the ${limits.max_image_mb} MB limit`);
        input.value = '';
        return;
      }
    }

    // The reference counts even if describing it fails. "There is a first
    // frame" is most of the signal; wan.md does the rest.
    input.dataset.filename = file.name;
    showFrameThumb(input, file);
    if (note) note.textContent = `Describing the ${label.toLowerCase()}…`;

    // Before the tagger call, not after: encoding is local and fast, the
    // tagger is a round trip that can fail, and the picture is the part that
    // matters most. Awaited rather than fired off, so a Generate pressed the
    // instant the file lands cannot read a half-set property.
    input._encoded = await encodeForModel(file);

    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'content-type': file.type },
        body: file,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (note) note.textContent = `${label} set — could not describe it (${body.error ?? res.status}).`;
        return;
      }
      const data = await res.json();
      const detected = [...(data.character ?? []), ...(data.general ?? [])]
        .slice(0, I2V_TAG_LIMIT)
        .map((t) => tagForModel(t.tag, model));
      if (!detected.length) {
        if (note) note.textContent = `${label} set — nothing detected above the thresholds.`;
        return;
      }
      input.dataset.description = detected.join(', ');
      if (note) note.textContent = `${label}: ${detected.join(', ')}`;
    } catch (err) {
      if (note) note.textContent = `${label} set — could not describe it (${err.message}).`;
    }
  });
}

/**
 * The longest side a reference picture is sent to the model at.
 *
 * Not a quality setting — a cost one. Every pixel here is prefill on a Pascal
 * card, paid on every generation and every re-roll, and the projector
 * downsamples to its own grid regardless of what it is handed. 1024 is enough
 * for the things a reference is attached FOR: a face, a garment, the
 * direction the light comes from.
 *
 * **Not measured on the P40 yet.** Written down as a guess deliberately,
 * same as the two confidence floors in server/visiontags.mjs — a number
 * pretending to be a measurement is worse than one admitting it is not.
 */
const REFERENCE_SEND_PX = 1024;

/**
 * A file, downscaled and encoded for the model, or null.
 *
 * In the browser rather than on the server because the server would have to
 * be handed the full-size original first, which is the round trip this
 * avoids: the bytes go up once, already the size they will be used at.
 *
 * JPEG, and not the original format, for the same reason — a 4MB PNG
 * screenshot base64s to 5.5MB of request body for a picture the projector is
 * about to reduce anyway. The exception is a picture already small enough,
 * which is passed through untouched rather than re-encoded, since re-encoding
 * a small JPEG only loses to it.
 */
// ── What the model saw in each h3 reference picture ──────────────────────
//
// The server reads each picture on its own before writing (server/
// picture-readings.mjs) and sends the readings as `picture_readings`. They
// live on the tile, not the number, so dragging tiles around cannot attach a
// reading to the wrong picture. The eye button on the tile opens one shared
// card over it; nothing shows until asked.

/** h3's picture tiles in the order collectControls sends them, which is the
 *  order the server numbers <Picture N> in. */
function currentPictureTiles() {
  return $$('#builder-mount [data-bind="reference_list"] .mmd-tile')
    .filter((t) => !t.hidden && (t.dataset.kind || 'image') === 'image');
}

/** A description onto the tiles its labels name ("<Picture 1>, <Picture 3>"). */
function placeReading(tiles, labels, text) {
  if (!text) return;
  for (const n of String(labels ?? '').match(/\d+/g) ?? []) {
    const tile = tiles[Number(n) - 1];
    if (tile) setTileReading(tile, labels, text);
  }
}

/**
 * Have the model look at the pictures now (POST /api/references/scan).
 * Pictures that already have a description are skipped unless `force`;
 * `pictures` narrows it to those numbers. Descriptions land on the tiles as
 * they arrive. Throws with a readable message on failure.
 */
async function scanPictures({ pictures = null, force = false, onProgress = () => {} } = {}) {
  if (!currentModel) return;
  const tiles = currentPictureTiles();
  onProgress('Waiting…');
  const res = await fetch('/api/references/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: currentModel.key, controls: collectControls(), pictures, force }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
    throw new Error(err.message ?? 'The scan failed.');
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let result = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (.+)$/m.exec(frame)?.[1];
      const da = /^data: (.+)$/m.exec(frame)?.[1];
      if (!ev || !da) continue;
      const data = JSON.parse(da);
      if (ev === 'queued') onProgress(`Queued (${data.position})…`);
      else if (ev === 'status') {
        const total = Number(data.total) || 0;
        onProgress(total > 1 ? `Scanning ${(Number(data.done) || 0) + 1} of ${total}…` : 'Scanning…');
      } else if (ev === 'reading') placeReading(tiles, data.labels, data.text);
      else if (ev === 'warning') toast(data.message);
      else if (ev === 'error') throw new Error(data.message ?? 'The scan failed.');
      else if (ev === 'done') result = data;
    }
  }
  return result;
}

function syncReadingButton(tile) {
  const btn = $('[data-bind="read_btn"]', tile);
  if (btn) btn.hidden = !tile.dataset.reading;
}

function setTileReading(tile, labels, text, { edited = false } = {}) {
  tile.dataset.reading = text;
  tile.dataset.readingLabels = labels;
  if (edited) tile.dataset.readingEdited = '1';
  else delete tile.dataset.readingEdited;
  syncReadingButton(tile);
}

function clearTileReading(tile) {
  if (!tile?.dataset.reading) return;
  delete tile.dataset.reading;
  delete tile.dataset.readingLabels;
  delete tile.dataset.readingEdited;
  syncReadingButton(tile);
  if (readingCard?.tile === tile) closeReadingCard();
}

/** The tiles that share this tile's description: its subject group, as scanned. */
function readingSiblings(tile) {
  const labels = tile.dataset.readingLabels;
  return currentPictureTiles().filter((t) => t === tile || (labels && t.dataset.readingLabels === labels));
}

let readingCard = null; // { el, tile }

function closeReadingCard() {
  if (!readingCard) return;
  readingCard.el.remove();
  $('[data-bind="read_btn"]', readingCard.tile)?.setAttribute('aria-expanded', 'false');
  readingCard = null;
  document.removeEventListener('pointerdown', onReadingOutside, true);
  document.removeEventListener('keydown', onReadingKey, true);
  window.removeEventListener('scroll', onReadingScroll, true);
  window.removeEventListener('resize', closeReadingCard);
}

function onReadingOutside(e) {
  if (!readingCard) return;
  if (readingCard.el.contains(e.target)) return;
  // The eye button toggles on its own click; closing here first would reopen it.
  if (e.target.closest?.('[data-bind="read_btn"]') && readingCard.tile.contains(e.target)) return;
  closeReadingCard();
}

// A long reading scrolls inside the card; only a page scroll moves the tile.
function onReadingScroll(e) {
  if (readingCard?.el.contains(e.target)) return;
  closeReadingCard();
}

function onReadingKey(e) {
  if (e.key === 'Escape') closeReadingCard();
}

function toggleReadingCard(tile, anchor) {
  if (readingCard?.tile === tile) return closeReadingCard();
  closeReadingCard();
  const text = tile.dataset.reading;
  if (!text) return;

  const el = document.createElement('div');
  el.className = 'mmd-reading-card';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'What the model saw');
  const head = document.createElement('div');
  head.className = 'mmd-reading-head';
  const title = document.createElement('span');
  const setTitle = () => {
    const labels = tile.dataset.readingLabels ?? '';
    title.textContent = (labels.includes(',') ? `What the model saw · ${labels}, read together` : 'What the model saw') +
      (tile.dataset.readingEdited ? ' · edited' : '');
  };
  setTitle();
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'mmd-reading-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '×';
  close.addEventListener('click', closeReadingCard);
  head.append(title, close);
  const body = document.createElement('p');
  body.className = 'mmd-reading-text';
  body.textContent = text;

  // Rescan this picture (its whole group, if it has one), or fix the words.
  const foot = document.createElement('div');
  foot.className = 'mmd-reading-foot';
  const button = (label, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mmd-btn';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  };
  const rescan = button('Rescan', async () => {
    const n = currentPictureTiles().indexOf(tile) + 1;
    if (!n) return;
    rescan.disabled = edit.disabled = true;
    try {
      await scanPictures({ pictures: [n], force: true, onProgress: (t) => { rescan.textContent = t; } });
    } catch (err) {
      toast(err.message);
    } finally {
      rescan.textContent = 'Rescan';
      rescan.disabled = edit.disabled = false;
      if (readingCard?.tile === tile) {
        body.textContent = tile.dataset.reading ?? '';
        setTitle();
      }
    }
  });
  const edit = button('Edit', () => {
    const box = document.createElement('textarea');
    box.className = 'mmd-reading-edit';
    box.value = tile.dataset.reading ?? '';
    box.rows = 7;
    const save = button('Save', () => {
      const next = box.value.trim();
      for (const t of readingSiblings(tile)) {
        if (next) setTileReading(t, tile.dataset.readingLabels ?? '', next, { edited: true });
        else clearTileReading(t);
      }
      if (!next) return closeReadingCard();
      body.textContent = next;
      setTitle();
      box.replaceWith(body);
      editFoot.replaceWith(foot);
    });
    const cancel = button('Cancel', () => {
      box.replaceWith(body);
      editFoot.replaceWith(foot);
    });
    const editFoot = document.createElement('div');
    editFoot.className = 'mmd-reading-foot';
    editFoot.append(cancel, save);
    body.replaceWith(box);
    foot.replaceWith(editFoot);
    box.focus();
  });
  foot.append(rescan, edit);
  el.append(head, body, foot);
  document.body.appendChild(el);

  // Over the tile, kept inside the window.
  const r = tile.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  const top = Math.max(8, Math.min(r.top, window.innerHeight - h - 8));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;

  readingCard = { el, tile };
  document.addEventListener('pointerdown', onReadingOutside, true);
  document.addEventListener('keydown', onReadingKey, true);
  window.addEventListener('scroll', onReadingScroll, true);
  window.addEventListener('resize', closeReadingCard);
  close.focus({ preventScroll: true });
  anchor?.setAttribute('aria-expanded', 'true');
}

async function encodeForModel(file) {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, REFERENCE_SEND_PX / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    // 0.85 rather than 0.92: the difference is invisible at this size and
    // roughly halves the body.
    return canvas.toDataURL('image/jpeg', 0.85);
  } catch (err) {
    // Never fatal. A reference whose picture could not be encoded still
    // travels on its role, its note and whatever was picked off it — which
    // is exactly the state every reference was in before today.
    console.warn(`[image-references] could not encode ${file?.name} for the model: ${err.message}`);
    return null;
  }
}

/**
 * The read-back panel: open it, stream into it, close it.
 *
 * One panel shared by every card, because two references analysed side by
 * side is two long prose blocks competing for the same column and neither
 * readable. The text lives on the reference (`ref.analysis`), so switching
 * cards and coming back shows what that card actually got rather than
 * re-spending a generation on it.
 *
 * **A read-back is a confirmation of the instructions it ran under.** Role,
 * fidelity and note go into the question, so when any of the three changes
 * afterwards the answer on screen is describing a reference that no longer
 * exists. That is not a small staleness — it is the model saying it will
 * ignore the pose under a card that has since been switched to Pose. So the
 * panel says so, loudly, rather than quietly showing prose that reads fine.
 */
/**
 * Which reference surface the builder is showing: 'analysis' or 'tags'.
 *
 * A front-end mode, stored per account so it is where you left it. NOT the
 * same setting as the account panel's "who reads a reference" — that one
 * decides who produces the tags at upload, this one decides what you look at.
 * They are independent because the taggers are free: their list is still on
 * the card in analysis mode, one click away, already fetched.
 */
let imgrefMode = 'analysis';

const REFANALYSIS = {
  panel: () => document.getElementById('refanalysis-panel'),
  output: () => document.getElementById('output-panel'),
  body: () => document.getElementById('refanalysis-body'),
  open: null,   // the ref currently on screen
  abort: null,  // the in-flight read, if any
};

/** What the read-back was generated under, as a comparable string. */
function refAnalysisKey(ref) {
  return `${ref.role}\u0000${ref.fidelity}\u0000${ref.note ?? ''}`;
}

/**
 * Model prose into nodes. Bold runs and list bullets, nothing else.
 *
 * Built as text nodes rather than assigned as innerHTML. This file has had
 * three innerHTML incidents already — the note on the session list says so —
 * and this is the one place in the app where a MODEL's free text is put on
 * screen with any formatting at all.
 */
function renderReadback(host, text) {
  host.replaceChildren();
  for (const block of String(text).split(/\n{2,}/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    for (const rawLine of trimmed.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const bullet = /^[-*•]\s+/.test(line);
      const el = document.createElement(bullet ? 'li' : 'p');
      // `**bold**` becomes <strong>; the delimiters go. Odd trailing runs
      // stay literal, which is what a model mid-sentence would have meant.
      const parts = (bullet ? line.replace(/^[-*•]\s+/, '') : line).split(/\*\*/);
      parts.forEach((part, i) => {
        if (!part) return;
        if (i % 2 === 1) {
          const b = document.createElement('strong');
          b.textContent = part;
          el.appendChild(b);
        } else {
          el.appendChild(document.createTextNode(part));
        }
      });
      host.appendChild(el);
    }
  }
}

/** Draw whatever state the open reference is in. */
function paintReadback() {
  const ref = REFANALYSIS.open;
  const panel = REFANALYSIS.panel();
  if (!panel) return;
  if (!ref) {
    panel.hidden = true;
    if (REFANALYSIS.output()) REFANALYSIS.output().hidden = false;
    return;
  }
  panel.hidden = false;
  // The Output panel gives up the slot rather than being pushed down it.
  if (REFANALYSIS.output()) REFANALYSIS.output().hidden = true;

  const thumb = document.getElementById('refanalysis-thumb');
  if (thumb) thumb.src = ref.previewUrl;

  const roles = REGISTRY?.defaults?.image_reference_roles ?? {};
  const fidelities = REGISTRY?.defaults?.reference_fidelity ?? {};
  const what = document.getElementById('refanalysis-what');
  if (what) {
    what.textContent =
      `${roles[ref.role]?.label ?? ref.role} reference · ${fidelities[ref.fidelity]?.label ?? ref.fidelity}`;
  }
  const note = document.getElementById('refanalysis-note');
  if (note) {
    note.textContent = ref.note
      ? `You asked for: ${ref.note}`
      : 'You have not said what to take from it, so this is the role’s own reading.';
  }

  const again = document.getElementById('btn-refanalysis-again');
  if (again) again.hidden = !ref.analysis || Boolean(REFANALYSIS.abort);

  // Stale, and specific about it. "Something changed" would send someone
  // hunting; naming the three fields does not.
  const stale = document.getElementById('refanalysis-stale');
  if (stale) {
    const changed = ref.analysis && ref.analysis.key !== refAnalysisKey(ref);
    stale.hidden = !changed;
    if (changed) {
      stale.textContent =
        'This was written for a different set of instructions — the role, how closely to follow it, or what to take from it has changed since. Analyze again, or read it knowing that.';
    }
  }
}

/** Run the read-back for one reference, streaming into the panel. */
async function analyzeReference(ref) {
  REFANALYSIS.abort?.abort();
  REFANALYSIS.open = ref;
  paintReadback();

  const host = REFANALYSIS.body();
  if (!host) return;
  host.replaceChildren();
  const waiting = document.createElement('p');
  waiting.className = 'refanalysis-waiting';
  waiting.textContent = 'Looking at the picture…';
  host.appendChild(waiting);

  const abort = new AbortController();
  REFANALYSIS.abort = abort;

  const params = new URLSearchParams({
    role: ref.role,
    fidelity: ref.fidelity,
    ...(ref.note ? { note: ref.note } : {}),
  });
  // The instructions this answer will be a confirmation OF, captured before
  // the request rather than after it — the person can keep typing while it
  // streams, and what it confirms is what it was asked under.
  const key = refAnalysisKey(ref);

  let text = '';
  try {
    const res = await fetch(`/api/references/readback?${params}`, {
      method: 'POST',
      headers: { 'content-type': ref.file.type },
      body: ref.file,
      signal: abort.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      waiting.classList.remove('refanalysis-waiting');
      waiting.textContent = `Could not read it — ${body.message ?? body.error ?? res.status}`;
      return;
    }

    // The same SSE shape everything else on this page streams, read inline
    // rather than through the shared reader: this one writes into a panel
    // instead of into segments, and has no queue position of its own to show
    // beyond the one event below.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        let event = 'message';
        let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        let payload;
        try { payload = JSON.parse(data); } catch { continue; }

        if (event === 'queued') {
          waiting.textContent = `Waiting for the card — ${payload.position} ahead…`;
        } else if (event === 'token') {
          text += payload.text ?? '';
          renderReadback(host, text);
        } else if (event === 'error') {
          renderReadback(host, text);
          const err = document.createElement('p');
          err.className = 'refanalysis-waiting';
          err.textContent = `Stopped — ${payload.message ?? payload.error}`;
          host.appendChild(err);
        }
      }
    }

    if (text.trim()) {
      ref.analysis = { text, key, at: Date.now() };
    } else if (host.contains(waiting)) {
      waiting.textContent = 'The model returned nothing. Try again, or pick a different one.';
    }
  } catch (err) {
    if (abort.signal.aborted) return;
    host.replaceChildren();
    const failed = document.createElement('p');
    failed.className = 'refanalysis-waiting';
    failed.textContent = `Could not read it — ${err.message}`;
    host.appendChild(failed);
  } finally {
    if (REFANALYSIS.abort === abort) REFANALYSIS.abort = null;
    paintReadback();
  }
}

/** Show what a reference was already told, without spending a generation. */
function showReadback(ref) {
  REFANALYSIS.abort?.abort();
  REFANALYSIS.abort = null;
  REFANALYSIS.open = ref;
  paintReadback();
  const host = REFANALYSIS.body();
  if (host && ref.analysis) renderReadback(host, ref.analysis.text);
}

/**
 * Apply the mode to the reference block, and remember it.
 *
 * The class does the work — see the two rules in styles.css. Nothing is
 * destroyed or refetched: a card in analysis mode still holds its chips and
 * its picks, so switching is instant and reversible, which is the property
 * that lets this be a toggle rather than a decision.
 */
function paintImgrefMode(mount) {
  const block = $('.imgref', mount);
  if (block) {
    block.classList.toggle('mode-analysis', imgrefMode === 'analysis');
    block.classList.toggle('mode-tags', imgrefMode === 'tags');
  }
  for (const btn of $$('[data-bind="imgref_mode"] button', mount)) {
    btn.setAttribute('aria-pressed', btn.dataset.mode === imgrefMode ? 'true' : 'false');
  }
  // Leaving analysis mode takes the panel with it. A read-back on screen
  // under a card showing chips is the two modes contradicting each other.
  if (imgrefMode !== 'analysis') closeReadback();
}

function wireImgrefMode(mount) {
  const seg = $('[data-bind="imgref_mode"]', mount);
  if (!seg) return;
  imgrefMode = ['analysis', 'tags'].includes(PREFS?.reference_mode)
    ? PREFS.reference_mode
    : 'analysis';
  seg.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-mode]');
    if (!btn || btn.dataset.mode === imgrefMode) return;
    imgrefMode = btn.dataset.mode;
    paintImgrefMode(mount);
    // Optimistic, like the segment toggles: PREFS is what the builder reads,
    // and a round trip between clicking and switching would read as a stuck
    // control. A failed save costs the stickiness, not the mode.
    PREFS = { ...(PREFS ?? {}), reference_mode: imgrefMode };
    try {
      await rawFetch('/api/account', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ preferences: { reference_mode: imgrefMode } }),
      });
    } catch {
      // Deliberately quiet. The mode is applied either way and saying so
      // would be a toast about a preference nobody asked to persist.
    }
  });
  paintImgrefMode(mount);
}

function closeReadback() {
  REFANALYSIS.abort?.abort();
  REFANALYSIS.abort = null;
  REFANALYSIS.open = null;
  paintReadback();
}

// ── a reference image, on the image models ───────────────────
//
// "Make me something like this" is the commonest thing anyone does with a
// picture, and until 26 Aug 2026 it took two tabs: analyse in Tab 3, press
// Use in Prompt Builder, come back. Tab 3 is still the right place to *study*
// an image — ratings, confidences, per-category copy — and it keeps that job.
// This is the same tagger reached from where the prompt is being written.
//
// **The picture never leaves this machine and never reaches the LLM.** WD v3
// runs on the CPU here and only its tags travel, which is the same contract
// H3's references have had since they were built, and the reason this needs
// no vision model and no VRAM.
//
// Two things it does that Tab 3's hand-off does not:
//
//   - the detected tags are VISIBLE and individually clickable, rather than
//     being pushed into the pills wholesale. A tagger reading `1girl, solo,
//     long_hair, indoors, cup` for a reference is right about all five and
//     you probably wanted two.
//   - a detected CHARACTER opens the traits panel. That is the Frieren case
//     the owner asked for: the tagger says `frieren`, and what appears is not
//     just the word but what she actually looks like, from danbooru. Both
//     halves already existed and had never been connected — see showTraits.
//
// Present only where the template carries the block, which is the three image
// templates. That is the same switch reference_upload uses in video-h3.html,
// and it means no model is named here to decide it.
// Every reference currently attached, in upload order. Read by
// collectControls and cleared on model switch — a reference list built for one
// model means nothing to the next, exactly as the H3 list does not survive one.
let imageReferences = [];

/** Freed on removal and on model switch. An object URL held after its <img>
 *  is gone keeps the whole file in memory, and these are photographs. */
function releaseImageReference(ref) {
  if (ref?.previewUrl) URL.revokeObjectURL(ref.previewUrl);
}

/**
 * How Tab 3 hands a configured reference to Tab 1.
 *
 * Set by setupImageReference and reset to a refusal when the current template
 * has no reference list — the video templates carry H3's own uploader, which
 * is a different contract this must not pretend to satisfy. Returns false
 * rather than throwing so the caller can leave the user where they are.
 */
let adoptImageReference = () => false;

function setupImageReference(mount, model) {
  const host = $('[data-bind="image_reference"]', mount);
  const input = $('[data-bind="imgref_upload"]', mount);
  const list = $('[data-bind="imgref_list"]', mount);
  const tpl = $('template[data-bind="imgref_row"]', mount);
  const status = $('[data-bind="imgref_status"]', mount);
  // A template with no reference list must not silently accept one from Tab 3
  // and drop it. Reset before the early return, so switching from an image
  // model to a video one takes the handle with it.
  adoptImageReference = () => false;
  // Before the early return, for the same reason the handle above is: a video
  // model has no reference cards, so this is exactly the switch that would
  // leave a read-back of an image model's picture on screen with no card
  // under it. Same rule the output panels follow.
  closeReadback();
  // And the list itself, for the same reason. This sat after the early return
  // until 11 Sep 2026, so anima -> h3 kept anima's pictures in memory, and
  // collectControls sends image_references whenever the list is non-empty:
  // one model's references rode along with another model's generation.
  for (const ref of imageReferences) releaseImageReference(ref);
  imageReferences = [];
  if (!host || !input || !list || !tpl) return;

  list.replaceChildren();

  const limits = TAGGERS?.limits;
  // From the server rather than the template, so the picker and the validator
  // cannot disagree about what may be attached.
  if (limits?.allowed_image_types?.length) input.accept = limits.allowed_image_types.join(',');

  const roles = REGISTRY.defaults?.image_reference_roles ?? {};
  const fidelities = REGISTRY.defaults?.reference_fidelity ?? {};
  const maxRefs = REGISTRY.defaults?.max_image_references ?? 6;

  // ── the two selectors, before there is anything to select them for ──
  //
  // Reported 27 Aug 2026: "you can't select 'this picture is for' and 'how
  // closely to follow it' till image is uploaded". True, and it had the
  // ordering backwards — a person knows what they want a picture FOR before
  // they go and find it, and the role is the setting that decides whether the
  // tagger's output is even worth reading.
  //
  // So the pair lives beside the file input too, and sets what the next
  // upload arrives as. Every card keeps its own pair; this one does not
  // reach back and change a card that already exists, because that would
  // silently rewrite a decision already made about a different picture.
  const defaultRoleSel = $('[data-bind="imgref_default_role"]', mount);
  const defaultFidelitySel = $('[data-bind="imgref_default_fidelity"]', mount);
  let nextRole = REGISTRY.defaults?.default_image_reference_role ?? Object.keys(roles)[0];
  let nextFidelity = REGISTRY.defaults?.default_reference_fidelity ?? Object.keys(fidelities)[0];
  if (defaultRoleSel) {
    fillSelect(defaultRoleSel, Object.keys(roles), nextRole, (k) => roles[k]?.label ?? k);
    // The role's ⓘ beside this label too (26 Sep 2026): this is where the
    // choice is made, before any card exists to carry it.
    const labelText = defaultRoleSel.closest('label')?.querySelector('span');
    const paintDefaultInfo = () => {
      labelText?.querySelector('.role-info')?.remove();
      const info = roles[defaultRoleSel.value]?.info;
      if (!labelText || !info) return;
      const more = document.createElement('details');
      more.className = 'role-info';
      const tip = document.createElement('summary');
      tip.textContent = 'ⓘ';
      tip.title = 'What is this one for?';
      const body = document.createElement('div');
      body.className = 'role-info-body';
      body.textContent = info;
      more.append(tip, body);
      labelText.append(' ', more);
    };
    paintDefaultInfo();
    defaultRoleSel.addEventListener('change', () => { nextRole = defaultRoleSel.value; paintDefaultInfo(); });
  }
  if (defaultFidelitySel) {
    fillSelect(defaultFidelitySel, Object.keys(fidelities), nextFidelity, (k) => fidelities[k]?.label ?? k);
    defaultFidelitySel.addEventListener('change', () => { nextFidelity = defaultFidelitySel.value; });
  }
  wireImgrefMode(mount);

  const paintStatus = () => {
    if (!status) return;
    if (!imageReferences.length) {
      // This said "the pictures are never sent to the model" until 8 Sep
      // 2026, and it was the accurate description of a feature that did not
      // do what it was for. It is now false in the good way — but it stays
      // true that nothing leaves this box, and that is the half people
      // actually care about, so that is the half this line keeps.
      status.textContent =
        'Read on this machine, and shown to the model that writes your prompt. Nothing leaves this box.';
      status.classList.remove('over-limit');
      return;
    }
    const over = imageReferences.length > maxRefs;
    status.textContent = over
      ? `${imageReferences.length} references, and ${maxRefs} is the ceiling — past that they start contradicting each other.`
      : `${imageReferences.length} of ${maxRefs}. The pictures never leave this machine.`;
    status.classList.toggle('over-limit', over);
  };
  paintStatus();

  input.addEventListener('change', async () => {
    const files = [...(input.files ?? [])];
    input.value = '';                     // so the same file can be re-picked
    for (const file of files) await addImageReference(file);
  });

  // Tab 3's hand-off. Fire and forget: the card appears immediately and fills
  // itself in, which is the same thing the file picker does, and the caller
  // wants to switch tabs now rather than wait on a tagger pass.
  adoptImageReference = ({ file, role, fidelity, analysis }) => {
    if (!file) return false;
    addImageReference(file, { role, fidelity, analysis });
    return true;
  };

  /**
   * @param opts.role      preselected, from Tab 3's hand-off
   * @param opts.fidelity  likewise
   * @param opts.analysis  an /api/analyze result for this exact file, so a
   *                       picture already read in Tab 3 is not read twice —
   *                       ~2.5s on the EVA02 weights, which reads as the
   *                       button having done nothing.
   */
  async function addImageReference(file, opts = {}) {
    const maxMb = limits?.max_image_mb;
    // Refused here as well as on the server, so an oversized file is stopped
    // before it goes over the tailnet rather than after.
    if (maxMb && file.size > maxMb * 1024 * 1024) {
      toast(`${file.name} is ${(file.size / 1048576).toFixed(1)} MB. The limit is ${maxMb} MB.`);
      return;
    }
    if (limits?.allowed_image_types?.length && !limits.allowed_image_types.includes(file.type)) {
      toast(`${file.type || 'That file'} is not an accepted image type`);
      return;
    }

    const ref = {
      id: `ref_${Math.random().toString(36).slice(2, 10)}`,
      file,
      previewUrl: URL.createObjectURL(file),
      // Tab 3's hand-off names both explicitly and wins; otherwise the pair
      // beside the file input decides, which is what it is for.
      role: roles[opts.role] ? opts.role : nextRole,
      fidelity: fidelities[opts.fidelity] ? opts.fidelity : nextFidelity,
      note: '',
      tags: [],          // [{ raw, tag, confidence, category_name }]
      character: null,   // the raw danbooru tag, when one was recognised
      // The tags the person actually clicked, by raw danbooru spelling.
      //
      // Empty on purpose, and it stays empty until somebody picks something.
      // Until 8 Sep 2026 the whole of `tags` went up with every generation
      // and the server filtered it by role — which made a reference exactly
      // as good as a class filter over Danbooru vocabulary, and is the thing
      // the owner objected to: "the whole point was that the llm sees the
      // reference image, not the tagger auto inject". The picture goes to the
      // model now; these are an optional hint on top of it.
      picked: new Set(),
      // The read-back, once Analyze has been pressed. Held on the reference
      // rather than in the panel because the panel is one shared surface and
      // this must survive looking at another card and coming back.
      analysis: null,    // { text, role, fidelity, note, model, at }
    };
    imageReferences.push(ref);

    const row = tpl.content.firstElementChild.cloneNode(true);
    row.dataset.refId = ref.id;
    list.appendChild(row);
    paintStatus();

    const preview = $('[data-bind="imgref_preview"]', row);
    if (preview) {
      preview.src = ref.previewUrl;
      preview.alt = file.name;
      preview.title = 'See the picture';
      preview.addEventListener('click', () => openPicture(preview.src, file.name));
    }

    const roleSel = $('[data-bind="imgref_role"]', row);
    const fidelitySel = $('[data-bind="imgref_fidelity"]', row);
    const hint = $('[data-bind="imgref_role_hint"]', row);
    const noteInput = $('[data-bind="imgref_note"]', row);
    const title = $('[data-bind="imgref_title"]', row);
    const chips = $('[data-bind="imgref_chips"]', row);
    const addAll = $('[data-bind="imgref_add_all"]', row);
    const analyzeBtn = $('[data-bind="imgref_analyze"]', row);
    const remove = $('[data-bind="imgref_remove"]', row);

    // Wired first, before anything below that can throw. Reported 11 Sep
    // 2026 by a user: an inserted image that could not be removed,
    // "the buttons do not work", fixed only by a refresh. This was wired
    // after paintRole() ran, so any throw in the card's setup left a picture
    // with no way out. Removing must never depend on the rest working.
    remove?.addEventListener('click', () => {
      // Take the panel down with the card. A read-back of a picture that is
      // no longer attached is the stalest thing this screen could show.
      if (REFANALYSIS.open === ref) closeReadback();
      releaseImageReference(ref);
      imageReferences = imageReferences.filter((r) => r !== ref);
      imgrefRedraws.delete(ref.id);
      imgrefAppliesRepaint.delete(ref.id);
      row.remove();
      paintStatus();
      // Removing a character changes what every other card may bind to, and
      // may take the "applies to" field away entirely by dropping the count
      // back to one.
      paintAppliesEverywhere();
    });

    // Both selectors are built from the registry, so the wording stays the
    // owner's and adding a role is a config edit. `rule` is what reaches the
    // model; only `label` is ever shown.
    fillSelect(roleSel, Object.keys(roles), ref.role, (k) => roles[k]?.label ?? k);
    fillSelect(fidelitySel, Object.keys(fidelities), ref.fidelity, (k) => fidelities[k]?.label ?? k);

    // ── the character field ──
    //
    // The tagger recognises a great many characters and misses plenty: an OC,
    // anyone recent, anyone drawn rarely. A user's build lets you type the
    // name and looks it up in the catalog, and that is the difference between
    // a reference that carries an identity and one that carries "1girl,
    // long_hair". Autocompleted against category 4 — the danbooru character
    // category — so what lands is a real tag rather than a spelling of one.
    const charField = $('[data-bind="imgref_character_field"]', row);
    const charInput = $('[data-bind="imgref_character"]', row);
    const charList = $('[data-bind="imgref_character_suggestions"]', row);

    const setCharacter = (rawTag) => {
      ref.character = rawTag || null;
      if (charInput) charInput.value = rawTag ? tagForModel(rawTag, model) : '';
      if (charList) charList.hidden = true;
      // Only when this reference is about the character. An outfit reference
      // that happens to name her should not reopen her appearance panel.
      if (ref.character && ROLE_CARRIES_CHARACTER.has(ref.role)) showTraits(mount, model, ref.character);
      paintAppliesEverywhere();
    };

    let charTimer;
    charInput?.addEventListener('input', () => {
      // Typed text stands on its own until a suggestion is taken. Someone
      // naming an OC the catalog has never heard of still gets their name
      // into the prompt, which is the case the whole field exists for.
      ref.character = charInput.value.trim() || null;
      paintAppliesEverywhere();
      clearTimeout(charTimer);
      charTimer = setTimeout(async () => {
        const q = charInput.value.trim();
        if (!charList) return;
        if (q.length < 2) { charList.hidden = true; return; }
        try {
          // `variant=underscore` deliberately, not `model=`. What is needed
          // here is the RAW danbooru tag — it is what /api/traits is keyed on
          // and what the request carries — and asking for the model's variant
          // would mean converting a spaced result back, which is guesswork on
          // any name with real punctuation in it. The list is spelled for the
          // model on the way out instead, by tagForModel.
          const res = await fetch(
            `/api/tags/search?q=${encodeURIComponent(q)}&category=4&limit=8&variant=underscore`
          );
          const data = await res.json();
          const hits = data.results ?? [];
          charList.replaceChildren();
          if (!hits.length) { charList.hidden = true; return; }
          for (const hit of hits) {
            const li = document.createElement('li');
            li.dataset.noI18n = '';
            // Shown in the model's spelling, stored in danbooru's.
            li.textContent = tagForModel(hit.tag, model);
            if (hit.post_count) {
              const n = document.createElement('span');
              n.className = 'ac-count';
              n.textContent = Number(hit.post_count).toLocaleString();
              li.appendChild(n);
            }
            // mousedown, not click: blur fires first on a click and would hide
            // the list before the handler ran.
            li.addEventListener('mousedown', (e) => {
              e.preventDefault();
              setCharacter(hit.tag);
            });
            charList.appendChild(li);
          }
          charList.hidden = false;
        } catch {
          charList.hidden = true;      // search is a convenience, never a gate
        }
      }, 180);
    });
    charInput?.addEventListener('blur', () => setTimeout(() => { if (charList) charList.hidden = true; }, 120));

    // ── "applies to" ──
    //
    // In a two-character scene an outfit reference is ambiguous: the model has
    // no way to know whose coat it is. Naming the character it belongs to is
    // the whole of the fix, and it only makes sense for the roles that attach
    // to a person — a background does not belong to anybody.
    const appliesField = $('[data-bind="imgref_applies_field"]', row);
    const appliesSel = $('[data-bind="imgref_applies"]', row);
    const ATTACHABLE = new Set(['outfit', 'pose', 'object']);

    const paintApplies = () => {
      if (!appliesField || !appliesSel) return;
      const named = imageReferences
        .filter((r) => ROLE_CARRIES_CHARACTER.has(r.role) && r.character)
        .map((r) => r.character);
      // Offered only when there is more than one character to be confused
      // between. With one, or none, the question has no useful answer and the
      // field would be a control that never changes anything.
      const useful = ATTACHABLE.has(ref.role) && named.length > 1;
      appliesField.hidden = !useful;
      if (!useful) { ref.applies_to = null; return; }
      const kept = appliesSel.value;
      fillSelect(appliesSel, ['', ...named], kept, (k) => (k ? tagForModel(k, model) : 'The whole scene'));
      ref.applies_to = appliesSel.value || null;
    };
    // Every card's list changes when any card names a character, so all of
    // them repaint rather than only this one.
    appliesSel?.addEventListener('change', () => { ref.applies_to = appliesSel.value || null; });
    imgrefAppliesRepaint.set(ref.id, paintApplies);

    // Assigned once the tagger has answered. Held as a mutable handle because
    // paintRole runs immediately — long before the tags exist — and has to be
    // able to redraw them later without knowing whether they have arrived.
    let renderChips = () => {};

    const paintRole = () => {
      ref.role = roleSel.value;
      if (hint) paintRoleHint(hint, roles[ref.role]);
      if (charField) charField.hidden = !ROLE_CARRIES_CHARACTER.has(ref.role);
      // The other half of the 27 Aug report: "when you change either it
      // doesn't reload tags". The tagger's output does not change — the same
      // picture reads the same either way, and re-running it would cost 2.5s
      // to arrive at the identical list. What changes is which of those tags
      // COUNT, and that was being decided once at upload and never revisited.
      // Switch a card from Background to Character and `brick_wall` has to
      // grey out; switch it back and it has to come in again.
      renderChips();
      // The role is half of what a read-back was a confirmation OF, so
      // changing it is the loudest reason for the stale banner to appear.
      if (REFANALYSIS.open === ref) paintReadback();
      // The traits panel belongs to the character role and nothing else. A
      // background reference that happens to contain a recognisable character
      // should not drag her hair colour into the prompt.
      if (ROLE_CARRIES_CHARACTER.has(ref.role) && ref.character) {
        showTraits(mount, model, ref.character);
      }
      paintAppliesEverywhere();
    };
    // Analyze, and Analyze-again once there is something to replace. A card
    // that already has a read-back opens it rather than re-running: the
    // second press of a button that costs 20-60s of the card should not be
    // the accidental one.
    analyzeBtn?.addEventListener('click', () => {
      if (ref.analysis && ref.analysis.key === refAnalysisKey(ref)) showReadback(ref);
      else analyzeReference(ref);
    });

    roleSel.addEventListener('change', paintRole);
    fidelitySel.addEventListener('change', () => {
      ref.fidelity = fidelitySel.value;
      // Repaint if this card's read-back is the one on screen — the stale
      // banner turns on here, and silently letting it not is the whole
      // failure this feature is built to avoid.
      if (REFANALYSIS.open === ref) paintReadback();
    });
    noteInput?.addEventListener('input', () => {
      ref.note = noteInput.value.trim();
      if (REFANALYSIS.open === ref) paintReadback();
    });
    paintRole();

    // Encode it for the model, alongside the tagger rather than after it —
    // this is canvas work on the client and owes nothing to the round trip.
    encodeForModel(file).then((encoded) => { ref.encoded = encoded; });

    // Describe it. The row is usable by hand the moment it appears, so a slow
    // or failed tagger costs the detected tags and nothing else.
    let data = opts.analysis ?? null;
    if (!data) {
      if (title) title.textContent = 'Reading the image…';
      try {
        const res = await fetch('/api/references/analyze', {
          method: 'POST',
          headers: { 'content-type': file.type },
          body: file,
        });
        data = await res.json();
        if (!res.ok) {
          if (title) title.textContent = `Could not read it — ${data.message ?? data.error ?? res.status}. Say what to take from it instead.`;
          return;
        }
      } catch (err) {
        if (title) title.textContent = `Could not read it — ${err.message}. Say what to take from it instead.`;
        return;
      }
    }

    // Character first, then general, each keeping its raw danbooru spelling
    // alongside the model's. The raw form is what /api/traits is keyed on and
    // what de-duplicates against the pills; the converted form is what a
    // person sees and what travels with the prompt.
    //
    // Ratings are deliberately absent. They are metadata about the source
    // image rather than a description of it, and Tab 3 does not send them
    // either — a reference that happens to be rated `general` should not put
    // the word `general` in anyone's prompt.
    ref.tags = [
      ...(data.character ?? []).map((t) => ({ ...t, category_name: 'character' })),
      ...(data.general ?? []).map((t) => ({ ...t, category_name: 'general' })),
    ].map((t) => ({
      raw: t.tag,
      tag: tagForModel(t.tag, model),
      confidence: t.confidence,
      category_name: t.category_name,
      // Carried through so the chip can say where it came from. A tag the
      // vision pass added was never scored by the tagger and arrives with a
      // null confidence; without this flag the tooltip below renders it as
      // "0% confident", which is not a weaker claim than the truth but a
      // different and false one.
      added_by_vision: t.added_by_vision === true,
    }));

    if (!ref.tags.length) {
      // Two different empties. A tagger returns nothing when everything it
      // scored fell under the floor; the model returns nothing when it read
      // the picture and wrote no tag the danbooru check would accept. Saying
      // "above the thresholds" on the second one names a knob that had no
      // part in it and would send someone to change the wrong number.
      if (title) {
        title.textContent =
          data.read_by === 'llm'
            ? `${data.model ?? 'The model'} read it and produced no usable tags.`
            : `${data.model ?? 'The tagger'} found nothing above the thresholds.`;
      }
      return;
    }

    /**
     * Which of this card's tags are worth anything at the CURRENT role.
     *
     * Every role narrows, each by its own classes — a Background reference
     * wants `brick_wall` and a Pose one wants `looking_at_viewer`, and until
     * 6 Sep 2026 only `character` narrowed at all, so the other seven sent
     * the whole picture. Recomputed on each draw rather than stored, because
     * the role is a dropdown and the answer changes under it.
     *
     * This must agree with splitForRole in server/imagerefs.mjs exactly. It
     * does because it is the same list in the same file — which is the whole
     * reason appearance.js lives under web/ and not under server/.
     */
    const offRole = (t) => !isRoleTag(t.raw, ref.role);

    // Filled in below if the tagger recognised somebody. Held here rather
    // than written straight into the title, because render() owns that line
    // now and a role change redraws it — the name has to survive that.
    let detectedName = null;

    // Off-role chips start collapsed. They used to all render, greyed, and
    // that was right when a reference produced 25 tags — the tagger was not
    // WRONG about `brick_wall` and hiding it would make a true fact about
    // someone's own photograph vanish with no way to ask why.
    //
    // Two taggers at a 0.05 floor produce 70-plus, and 75 greyed chips under
    // a Pose reference's 7 is not a nuance, it is a wall. Reported 7 Sep 2026
    // with a screenshot: "there is so much scrolling".
    //
    // So they are collapsed rather than hidden, behind a control that says
    // how many and why. One click and the old behaviour is back, per card,
    // and the state survives a role change because the question "do I want to
    // see the rest" does not change when the role does.
    let showOffRole = false;

    const render = () => {
      chips.replaceChildren();
      const visible = showOffRole ? ref.tags : ref.tags.filter((t) => !offRole(t));
      for (const t of visible) {
        // Picked ON THIS REFERENCE, not present in the global pill list. The
        // two were the same thing until 8 Sep 2026, when clicking a chip
        // pushed it into the prompt's own tag list and lost which picture it
        // came from — so `applies to` could not apply to it and the role
        // could not describe it. A tag picked off a reference stays with the
        // reference.
        const already = ref.picked.has(t.raw);
        const off = offRole(t);
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `pill imgref-chip${already ? ' added' : ''}` +
          `${t.category_name === 'character' ? ' is-character' : ''}${off ? ' off-role' : ''}`;
        chip.textContent = t.tag;
        chip.dataset.noI18n = '';
        // Not disabled any more. A picked chip has to be clickable to be
        // unpicked, and a selection you cannot undo is not a selection.
        chip.setAttribute('aria-pressed', already ? 'true' : 'false');
        // Greyed, never hidden. The tagger was not WRONG about `brick_wall` —
        // it is genuinely in the picture — and a person who wants it as a
        // background hint can still click it in, which puts it in the pills
        // and out of this filter's reach. Hiding it would make a true fact
        // about their own photograph disappear with no way to ask why.
        chip.title = already
          ? 'Going up with this reference · click to take it back out'
          : off
            // The wording changed with the behaviour. This used to say "left
            // out of the prompt", which was true when the role filter decided
            // what travelled. Nothing is left out now — nothing goes at all
            // until it is clicked — so the grey means "a lighting reference
            // does not usually want this", which is advice, not a gate.
            ? `${CLASS_REASON[tagFacet(t.raw)]} · not what this role usually wants · click to send it anyway`
            : t.added_by_vision
              // No percentage, because there is no number: the tagger never
              // scored this one. It was read off the picture by the model and
              // checked against the danbooru database before it was allowed
              // through, and saying so is more use than a fabricated score.
              ? `${data.vision?.model ?? 'the model'} saw this in the picture · click to add`
              : `${Math.round((t.confidence ?? 0) * 100)}% confident · click to add`;
        chip.addEventListener('click', () => {
          if (ref.picked.has(t.raw)) ref.picked.delete(t.raw);
          else ref.picked.add(t.raw);
          render();
        });
        chips.appendChild(chip);
      }

      // The toggle, last in the strip so it reads as the end of the list
      // rather than a heading over it. Only when there is something behind
      // it — a role that keeps everything must not grow a control that does
      // nothing.
      const hidden = ref.tags.filter(offRole).length;
      if (hidden) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'pill imgref-more';
        more.dataset.noI18n = '';
        more.textContent = showOffRole ? 'show fewer' : `+${hidden} more`;
        more.title = showOffRole
          ? 'Hide the tags this role does not use'
          : `${hidden} tags the tagger found that a ${(roles[ref.role]?.label ?? ref.role).toLowerCase()} reference does not use. They are still clickable.`;
        more.addEventListener('click', () => { showOffRole = !showOffRole; render(); });
        chips.appendChild(more);
      }

      // Say what the role cost, so a shrinking list is explained rather than
      // just smaller. "27 tags from animetimm" was the reported wording and
      // it was true and unhelpful — the complaint was about the seven of them
      // that had nothing to do with her.
      //
      // Named after the role rather than hardcoded to "the character", since
      // every role narrows now. The label is the owner's word from the
      // registry, so this line rewords itself when he rewords a role.
      const roleWord = (roles[ref.role]?.label ?? ref.role).toLowerCase();
      // Where the tags came from. Two sources now: the CPU tagger, and the
      // model looking at the picture — which on this box is what supplies the
      // lighting and framing the tagger is blind to. Naming both beats
      // crediting animetimm with a tag it never returned.
      const seen = ref.tags.filter((t) => t.added_by_vision).length;
      const source =
        // The whole list came from the model looking at the picture, so
        // crediting it per tag ("+ 41 the model saw") would be counting the
        // same fact forty-one times.
        data.read_by === 'llm'
          ? `${data.model}, looking at it`
          : seen
            ? `${data.model} + ${seen} the model saw`
            : data.model;
      // The preference said the model should read this one and something
      // stopped it — no vision on that model, or the vision backend has never
      // heard of it. The taggers stood in, which is why there are tags at
      // all, and this is the only place that says so. Silence here is the
      // exact failure this route has already been bitten by twice.
      const stoodIn = data.fell_back_from === 'llm'
        ? ` — the model could not read it (${data.fallback_reason}), so the taggers did`
        : '';
      const dropped = ref.tags.filter(offRole).length;
      const kept = ref.tags.length - dropped;
      if (title) {
        title.textContent =
          (detectedName ? `${detectedName} · ` : '') +
          (!dropped
            ? `${ref.tags.length} tags from ${source}`
            : kept
              ? `${ref.tags.length} tags from ${source} — ${kept} describe the ${roleWord}`
              // Both ways to reach zero say the same thing to the person
              // holding the picture: the tags are not going to carry this
              // one, so the note has to. An Object reference is always here.
              : `${ref.tags.length} tags from ${source}, none describing the ${roleWord} — say what to take in the note`) +
          stoodIn;
      }

      // Bulk pick, and bulk unpick once everything is on — the same button,
      // because "select all" that cannot be undone in one click is a trap
      // when the list is seventy tags long.
      //
      // Still only the on-role ones. Picking the greyed ones in bulk would
      // put back by hand exactly what the role is advising against, and
      // anyone who wants one can click it.
      const bulk = ref.tags.filter((t) => !offRole(t));
      if (addAll) {
        const allOn = bulk.length > 0 && bulk.every((t) => ref.picked.has(t.raw));
        addAll.hidden = !bulk.length;
        addAll.textContent = allOn ? 'Clear picked' : 'Pick all';
        addAll.title = allOn
          ? 'Takes them all back out of this reference.'
          : dropped
            ? `Sends the ${bulk.length} that describe the ${roleWord} with this reference. The greyed ones stay out.`
            : 'Sends all of them with this reference.';
        addAll.onclick = () => {
          if (allOn) for (const t of bulk) ref.picked.delete(t.raw);
          else for (const t of bulk) ref.picked.add(t.raw);
          render();
        };
      }
    };
    // So a later role change can redraw these. See paintRole.
    renderChips = render;
    render();
    // So clearing the pills greys these back in. Every reference registers its
    // own redraw, and all of them run — one shared handle would leave every
    // card but the last stale.
    imgrefRedraws.set(ref.id, render);

    // The Frieren case. A character in the picture is worth far more than the
    // word for it: showTraits turns `frieren` into what she actually looks
    // like, out of danbooru rather than out of the model's memory — which the
    // dialect suite once caught putting black hair on a redhead.
    //
    // The RAW spelling goes to /api/traits: that endpoint is keyed on the
    // danbooru tag, and the converted form would miss on every model that
    // wants spaces.
    const character = ref.tags.find((t) => t.category_name === 'character');
    if (character) {
      detectedName = character.tag;
      render();
      // Through setCharacter rather than by assigning ref.character directly,
      // so the text field shows what was detected, the traits panel opens if
      // the role calls for it, and every other card's "applies to" list picks
      // her up. Three things that were each easy to forget separately.
      setCharacter(character.raw);
    }
  }
}

/**
 * What a character looks like, offered as clickable chips.
 *
 * The model cannot be trusted to know. sdxl.md requires a booru character tag
 * be expanded into plain description because base SDXL has no Danbooru
 * training, and that expansion comes from the LLM's memory — which the dialect
 * suite caught putting black hair on a redhead. These come from danbooru
 * instead, and the user decides which ones they want rather than finding out
 * afterwards.
 *
 * Clicking a chip puts it in the pills above, so it travels with the prompt
 * the same way any hand-picked tag does, weight and all.
 */
async function showTraits(mount, model, characterTag) {
  const block = $('[data-bind="trait_block"]', mount);
  const chips = $('[data-bind="trait_chips"]', mount);
  const title = $('[data-bind="trait_title"]', mount);
  const addAll = $('[data-bind="trait_add_all"]', mount);
  if (!block || !chips) return;

  block.hidden = false;
  chips.innerHTML = '';
  // Sections are laid out as a column; the suggestion chips below are one row.
  chips.classList.remove('trait-sections');
  if (title) title.textContent = `Looking up ${characterTag}…`;
  if (addAll) addAll.hidden = true;

  let data;
  try {
    const res = await fetch(
      `/api/traits?character=${encodeURIComponent(characterTag)}&model=${encodeURIComponent(model.key)}`
    );
    data = await res.json();
  } catch (err) {
    if (title) title.textContent = `Could not look up traits (${err.message})`;
    return;
  }

  // A character nobody has drawn alone, an unknown tag, or no network. Say
  // which — this is a suggestion box, and a silent empty one looks broken.
  if (!data.traits?.length) {
    if (title) title.textContent = `No traits found — ${data.reason ?? 'nothing returned'}`;
    // Usually the name was right and the TAG was not: danbooru disambiguates
    // most characters with a series suffix, so `makima` has no posts while
    // `makima_(chainsaw_man)` has ten thousand. Offered rather than
    // substituted — picking for someone is how the panel ends up showing a
    // stranger's hair colour, and `miku` genuinely does prefix-match a
    // Kancolle ship before it reaches Hatsune.
    if (data.suggestions?.length && chips) {
      chips.replaceChildren();
      for (const s of data.suggestions) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'pill trait-chip';
        chip.dataset.noI18n = '';
        chip.textContent = s.tag;
        chip.title = `${Number(s.post_count).toLocaleString()} posts · look this one up instead`;
        chip.addEventListener('click', () => showTraits(mount, model, s.raw));
        chips.appendChild(chip);
      }
      if (title) title.textContent = `No posts under "${characterTag}" — did you mean:`;
    }
    return;
  }

  if (title) {
    // Who was standing next to them. A character with no solo posts is
    // described by their co-star unless that co-star's own traits are taken
    // back out — Dodoco came back as Klee in every particular — so when that
    // has happened the panel says whose traits went, rather than leaving
    // "may include other characters" to cover a list that no longer does.
    const alongside = String(data.companion ?? '')
      .split(' ')
      .filter(Boolean)
      .map((t) => t.replace(/_\([^()]*\)$/, '').replace(/_/g, ' '))
      .join(', ');

    title.textContent = alongside
      ? `${characterTag} — never drawn alone; from ${data.sampled} posts with ${alongside}, whose traits are removed`
      : data.source === 'table'
        ? `${characterTag} — from danbooru's character table`
        : data.source === 'live+table'
          ? `${characterTag} — from ${data.sampled} posts, filled in from danbooru's character table`
          : data.mixed
            ? `${characterTag} — from ${data.sampled} posts, may include other characters`
            : `${characterTag} — from ${data.sampled} posts`;
  }

  // danbooru's ranking is a tally over posts, so it promotes what the
  // character was DOING as readily as what she looks like — Frieren's list
  // carries `holding`, `holding_staff` and `closed_mouth`. Those no longer
  // reach the prompt (see characterCanon), and the panel greys them to match:
  // this list and the one the model is handed have to agree, or the panel is
  // showing something that is quietly not being used.
  //
  // Still clickable. Sampling says she is usually drawn with a staff, which
  // is a real and sometimes wanted fact — it just is not a fact about her
  // face, and it must not arrive as one.
  const offRole = (t) => !isAppearanceTag(t.raw ?? t.tag);

  // Split the way the prompt splits them (characterCanon in server.mjs): how
  // the character looks goes into every prompt that names them; what they
  // usually wear and carry goes in only when someone adds it. One mixed list
  // put Gran's hood and sword in among his hair colour and left "Add all" to
  // guess which half was wanted — the owner asked for a user's layout instead,
  // physical traits first and the outfit under it, 15 Sep 2026.
  const worn = (t) => isGarment(t.raw ?? t.tag) || isProp(t.raw ?? t.tag);
  const SECTIONS = [
    { label: 'Physical traits', note: 'goes into the prompt with the character', pick: (t) => !offRole(t) && !worn(t), bulk: true },
    { label: 'Common outfit', note: 'only if you add it', pick: (t) => !offRole(t) && worn(t), bulk: true },
    // Greyed as before, and never bulk-added: true about the pictures, silent
    // about the person.
    { label: 'Also in their pictures', note: 'not how they look', pick: offRole, bulk: false },
  ];
  const isAdded = (t) => selectedTags.some((s) => s.tag === t.tag);

  const addTags = (list) => {
    for (const t of list) {
      if (!isAdded(t)) selectedTags.push({ tag: t.tag, category_name: 'general', weight: 1.0 });
    }
    activeTagIndex = selectedTags.length - 1;
    renderTagPills(mount, model);
    render();
  };

  const chipFor = (t) => {
    const already = isAdded(t);
    const off = offRole(t);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `pill trait-chip${already ? ' added' : ''}${off ? ' off-role' : ''}`;
    chip.textContent = t.tag;
    chip.title = already
      ? 'Already in the prompt'
      : off
        ? `${CLASS_REASON[tagClass(t.raw ?? t.tag)]} · left out of the prompt · click to add it anyway`
        : t.share != null
          ? `On ${Math.round(t.share * 100)}% of this character's posts · click to add`
          : `From danbooru's character table${t.sources?.length ? ` (${t.sources.join(' + ')})` : ''} · click to add`;
    chip.disabled = already;
    chip.addEventListener('click', () => addTags([t]));
    return chip;
  };

  const render = () => {
    chips.replaceChildren();
    chips.classList.add('trait-sections');
    for (const s of SECTIONS) {
      const items = data.traits.filter(s.pick);
      if (!items.length) continue;
      const section = document.createElement('div');
      section.className = 'trait-section';
      const head = document.createElement('div');
      head.className = 'trait-section-head';
      const label = document.createElement('span');
      label.className = 'trait-section-label';
      label.textContent = s.label;
      const note = document.createElement('span');
      note.className = 'trait-section-note';
      note.textContent = s.note;
      head.append(label, note);
      if (s.bulk) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ghost';
        btn.textContent = 'Add all';
        btn.title = `Adds these ${items.length} to the prompt.`;
        btn.hidden = items.every(isAdded);
        btn.addEventListener('click', () => addTags(items));
        head.appendChild(btn);
      }
      const row = document.createElement('div');
      row.className = 'pills';
      for (const t of items) row.appendChild(chipFor(t));
      section.append(head, row);
      chips.appendChild(section);
    }
    // Each section carries its own now.
    if (addAll) addAll.hidden = true;
  };
  refreshTraitChips = render;
  render();
}

// The page-wide listeners setupTagBuilder adds, dropped on the next render.
// It runs on every model switch, and until 11 Sep 2026 each run left its
// document click listener behind: harmless one at a time (each only closes
// its own detached suggestion list) but one more per switch for the life of
// the tab, every one holding a whole old template in memory. Aborted at the
// top, before any early return, so a switch to a template with no tag
// builder takes the old one down too.
let tagBuilderListeners = null;

function setupTagBuilder(mount, model) {
  tagBuilderListeners?.abort();
  tagBuilderListeners = new AbortController();
  selectedTags = [];
  activeTagIndex = -1;
  // Switching models clears the trait block with everything else, and drops
  // the stale redraw with it — the old one closes over the previous model's
  // chips and would repaint them into the new template.
  const traitBlock = $('[data-bind="trait_block"]', mount);
  if (traitBlock) traitBlock.hidden = true;
  refreshTraitChips = () => {};
  // Same reasoning, once per reference: each redraw closes over that card's
  // chips, converted to the previous model's tag_style, and would repaint
  // purple_hair into a template that wants purple hair.
  imgrefRedraws.clear();
  imgrefAppliesRepaint.clear();

  $('[data-bind="clear_tags"]', mount)?.addEventListener('click', () => clearTags(mount, model));

  const weight = $('[data-bind="weight"]', mount);
  const weightOut = $('[data-bind="weight_value"]', mount);
  if (weight && model.weight_range) {
    Object.assign(weight, {
      min: model.weight_range.min,
      max: model.weight_range.max,
      step: model.weight_range.step,
      value: model.weight_range.default,
    });
    const sync = () => {
      if (weightOut) weightOut.textContent = Number(weight.value).toFixed(2);
      // The slider adjusts the selected tag, per the spec.
      if (activeTagIndex >= 0 && selectedTags[activeTagIndex]) {
        selectedTags[activeTagIndex].weight = Number(weight.value);
        renderTagPills(mount, model);
      }
    };
    weight.addEventListener('input', sync);
    sync();
  }

  const input = $('[data-bind="tag_search"]', mount);
  const list = $('[data-bind="tag_suggestions"]', mount);
  if (!input || !list) return;

  function closeList() {
    list.hidden = true;
    list.innerHTML = '';
  }

  function addTag(t) {
    if (!selectedTags.some((s) => s.tag === t.tag)) {
      // Tag click adds it at weight 1.0.
      selectedTags.push({ tag: t.tag, category_name: t.category_name, weight: 1.0 });
      activeTagIndex = selectedTags.length - 1;
      renderTagPills(mount, model);
    }
    input.value = '';
    closeList();
    // Picking a character offers what that character looks like. Only for
    // characters: nothing else has a design to look up.
    if (t.category_name === 'character') showTraits(mount, model, t.tag);
  }

  let debounce;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    const q = input.value.trim();
    if (!q) return closeList();

    debounce = setTimeout(async () => {
      try {
        const r = await fetch(
          `/api/tags/search?q=${encodeURIComponent(q)}&model=${model.key}&limit=12`
        );
        const data = await r.json();

        if (!data.ok) {
          // Degrade visibly rather than silently doing nothing.
          list.replaceChildren();
          const li = document.createElement('li');
          li.className = 'muted';
          li.textContent = data.error ?? 'tag database not loaded';
          list.appendChild(li);
          list.hidden = false;
          return;
        }
        if (!data.results.length) return closeList();

        list.innerHTML = '';
        for (const t of data.results) {
          const li = document.createElement('li');
          li.className = `suggestion ${t.category_name}`;
          // Built as nodes rather than markup: tag names come from the
          // danbooru list that `npm run update-tags` downloads from a
          // third-party repo, so they are not ours and should not be trusted
          // as HTML.
          const name = document.createElement('span');
          name.className = 's-tag';
          name.textContent = t.tag;
          const count = document.createElement('span');
          count.className = 's-count';
          count.textContent = t.post_count.toLocaleString();
          li.append(name, count);
          // Retired on danbooru. These sort below every live match already —
          // see the note in server/tags.mjs — but they still have to LOOK
          // different, because the count beside them is from our snapshot and
          // is often enormous. `black_footwear` reads as a 284,000-post tag
          // and is one nothing has used since it was split.
          if (t.deprecated) {
            li.classList.add('retired');
            const mark = document.createElement('span');
            mark.className = 's-retired';
            mark.textContent = 'retired';
            li.append(mark);
            li.title = 'Danbooru retired this tag. The count is from our snapshot, taken before it was.';
          }
          if (t.matched_alias) li.title = `matched alias — also known as ${t.aliases.join(', ')}`;
          li.addEventListener('click', () => addTag(t));
          list.appendChild(li);
        }
        list.hidden = false;
      } catch {
        closeList();
      }
    }, 140);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeList();
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = list.querySelector('.suggestion');
      if (first) first.click();
    }
  });

  document.addEventListener('click', (e) => {
    if (!mount.contains(e.target)) closeList();
  }, { signal: tagBuilderListeners.signal });
}

// ── Details + Creativity sliders ─────────────────────────────
//
// These replaced a single Creativity dropdown on 25 Aug 2026. Two axes rather
// than one because the two were being conflated: someone who wanted a denser
// prompt reached for "wild" and got an invented scene instead of a longer one.
//
// **Neither slider's range is hardcoded.** Creativity's notches ARE the keys
// of the model's creativity_presets, in registry order, and the value sent to
// the server is still the preset NAME - prompts/video/h3/SKILL.md teaches the
// model what "Precise" and "Wild" mean by name, so sending a bare number would
// leave that section of the prompt file describing values that never arrive.
// Both ladders were widened to ten notches on 4 Sep 2026 and nothing here
// changed to allow it, which is the property worth keeping: adding an
// eleventh preset to config/models.yaml (and, for creativity, a line in h3's
// SKILL.md, which teaches the names) makes it eleven here on its own.
//
// The one thing this file does read out of the rule text is which notches
// break the model's own format rules — see WARNS below. It used to be "the
// last one", which was true of a five-notch ladder and is wrong on a ten.
//
// What each slider currently sends, by name for creativity and by number for
// detail. Set by renderSliders, read by collectControls.
const sliderValues = { detail: [], creativity: [], lighting: [] };

// Which notches license the model to break its own format rules, and what to
// say beside them when one is chosen.
//
// Read from the rule text the notch will actually send, rather than from its
// position. Position was the test until 4 Sep 2026 — "the top notch" — which
// held while detail had five levels and exactly one of them overrode anything.
// At ten there are four: the bottom two override the model's MINIMUM length
// and the top two its MAXIMUM, and a warning fixed to the last notch would
// have missed three of them and mislabelled one.
//
// The phrasing these match is the same phrasing scripts/test-controls.mjs
// asserts on, so it is already a contract rather than incidental wording. A
// reworded rule that stops matching loses the warning, not the behaviour.
const WARNS = [
  [/overrides any maximum/i, "may run past this model's usual length limit"],
  [/overrides any minimum/i, "may come in under this model's usual length limit"],
];

/** The warning for a notch's rule text, or null when it breaks nothing. */
function warnFor(rule) {
  for (const [re, message] of WARNS) if (re.test(String(rule ?? ''))) return message;
  return null;
}

function renderSliders(mount, model) {
  const block = $('[data-bind="slider_block"]', mount);
  if (!block) return;
  block.innerHTML = '';
  // The Length field is rendered into the SELECT row rather than into this
  // block — see renderLength — so emptying the block does not take a previous
  // render's copy with it, and a model switch would otherwise leave two.
  $('.field.length', mount)?.remove();
  sliderValues.detail = [];
  sliderValues.creativity = [];
  sliderValues.lighting = [];

  const detailLevels = model.detail_levels ?? REGISTRY.defaults.detail_levels ?? {};
  const detailKeys = Object.keys(detailLevels).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const creativityKeys = Object.keys(
    model.creativity_presets ?? REGISTRY.defaults.creativity_presets ?? {}
  );

  const specs = [];
  if (detailKeys.length) {
    specs.push({
      name: 'detail',
      title: 'Details',
      values: detailKeys,
      labels: detailKeys.map((k) => detailLevels[k]?.label ?? String(k)),
      selected: Math.max(0, detailKeys.indexOf(
        Number(model.default_detail ?? REGISTRY.defaults.default_detail)
      )),
      // The number shown in the readout. Identical to index+1 here, because
      // this ladder starts at 1 - stated anyway so the lighting ladder, which
      // starts at 0, is not a special case bolted onto an assumption.
      numbers: detailKeys,
      warns: detailKeys.map((k) => warnFor(detailLevels[k]?.rule)),
    });
  }
  if (creativityKeys.length) {
    specs.push({
      name: 'creativity',
      title: 'Creativity',
      values: creativityKeys,
      labels: creativityKeys.map(prettify),
      selected: Math.max(0, creativityKeys.indexOf(
        model.default_creativity ?? REGISTRY.defaults.default_creativity
      )),
      // Resolves to all-null today: a creativity preset is a temperature and
      // a licence to invent, and neither has length semantics. Asked the same
      // question as detail rather than hardcoded to none, so a preset that
      // ever does claim an override gets the warning without a code edit.
      warns: creativityKeys.map(
        (k) => warnFor((model.creativity_presets ?? REGISTRY.defaults.creativity_presets ?? {})[k]?.rule)
      ),
      // Named presets, not a numbered ladder, so the readout counts positions.
      numbers: creativityKeys.map((_, i) => i + 1),
    });
  }

  // Lighting. A user's scale, and the third axis: creativity is how much may
  // be invented, detail is how much gets written down, this is how bright the
  // picture is.
  //
  // **The ladder starts at 0 and 0 means off**, which is why this one carries
  // `numbers` that are not index+1. The video models declare
  // `lighting_levels: {}` and produce no keys here, so they render two sliders
  // and this block adds nothing — no model is named to make that happen.
  //
  // Full width on its own row, under the other two: ten notches with labels
  // like "Near-black" and "Radiant" have nowhere to sit in a 150px column.
  const lightingLevels = model.lighting_levels ?? REGISTRY.defaults.lighting_levels ?? {};
  const lightingKeys = Object.keys(lightingLevels).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (lightingKeys.length) {
    specs.push({
      name: 'lighting',
      title: 'Lighting',
      wide: true,
      values: lightingKeys,
      labels: lightingKeys.map((k) => lightingLevels[k]?.label ?? String(k)),
      selected: Math.max(0, lightingKeys.indexOf(
        Number(model.default_lighting ?? REGISTRY.defaults.default_lighting ?? 0)
      )),
      numbers: lightingKeys,
      // Nothing here overrides the model's format — exposure is not length —
      // so this asks the same question the other two do and gets all nulls.
      warns: lightingKeys.map((k) => warnFor(lightingLevels[k]?.rule)),
    });
  }

  for (const spec of specs) {
    sliderValues[spec.name] = spec.values;

    const wrap = document.createElement('label');
    wrap.className = spec.wide ? 'field slider wide' : 'field slider';

    const head = document.createElement('span');
    const title = document.createElement('span');
    title.className = 'slider-title';
    title.textContent = spec.title;
    const readout = document.createElement('output');
    readout.className = 'slider-readout';
    head.append(title, readout);
    wrap.appendChild(head);

    const input = document.createElement('input');
    input.type = 'range';
    input.dataset.bind = spec.name;
    input.min = '0';
    input.max = String(spec.values.length - 1);
    input.step = '1';
    input.value = String(spec.selected);
    wrap.appendChild(input);

    const ends = document.createElement('span');
    ends.className = 'slider-ends';
    const lo = document.createElement('i');
    lo.textContent = spec.labels[0];
    const hi = document.createElement('i');
    hi.textContent = spec.labels[spec.labels.length - 1];
    ends.append(lo, hi);
    wrap.appendChild(ends);

    // The notches allowed to break the model's own length rules say so, both
    // ends of the ladder - see WARNS. Saying it beside the slider is cheaper
    // than a surprise truncation downstream.
    //
    // Keyed to the notch's rule text rather than to its index. It rendered
    // under Creativity too until 29 Aug 2026, where it claimed Wild might run
    // long; wild is temperature 1.10, which changes what the model says and
    // not how much of it. Reported from a screenshot of both sliders at max,
    // showing the same warning twice. Asking the rule text keeps that fixed
    // without the slider needing to know which axis it is.
    const warn = document.createElement('em');
    warn.className = 'slider-warn';
    warn.hidden = true;
    wrap.appendChild(warn);

    const paint = () => {
      const i = Number(input.value);
      // `numbers` and not index+1: the lighting ladder starts at 0, so the
      // notch a person sees has to be the level the server is sent.
      readout.textContent = `${spec.numbers?.[i] ?? i + 1} - ${spec.labels[i]}`;
      const message = spec.warns?.[i] ?? null;
      warn.textContent = message ?? '';
      warn.hidden = !message;
      // Two amber states, deliberately not one. `at-max` is "you are at the
      // end of the ladder"; `breaks-format` is "this notch overrides the
      // model's own rules". They coincided on a five-notch detail slider and
      // do not on a ten - notch 9 breaks the format without being the end,
      // and Wild is the end without breaking anything.
      wrap.classList.toggle('at-max', i === spec.values.length - 1);
      wrap.classList.toggle('breaks-format', Boolean(message));
    };
    input.addEventListener('input', paint);
    paint();

    block.appendChild(wrap);
  }

  renderLength(block, model);
  renderSegmentToggles(mount, model);
}

// ── the manual length control ────────────────────────────────
//
// Added 26 Aug 2026, replacing the word counter that used to sit under the
// brief. That counter scored the person's INPUT against `model.word_target`,
// which is the band for the model's OUTPUT — see the note in the counters
// block. This is the same idea aimed at the right text, and unlike the
// counter it actually reaches the model.
//
// **Off by default, and that matters.** Every dialect measurement in this
// project was taken with no length instruction at all, so a default here
// would quietly invalidate all of them. "Model default" sends nothing.
//
// Rendered from here rather than added to seven templates, because the slider
// block is already in all of them and gives this a reliable place to sit.
//
// It sits in the SELECT row, not among the sliders. Length is a dropdown and
// a number box — it looks and behaves like Quality preset and Aspect, and
// putting it in the slider band made a row of three controls where two of
// them dragged and one did not. Owner's call, 26 Aug: three on top, two
// sliders underneath. So it is inserted as a sibling immediately before the
// slider block, which lands it as the last cell of the select grid without
// touching a single template.
//
// Words and tokens are not two spellings of one thing, and the control says
// so rather than converting silently:
//
//   words  — an instruction. The model is asked for roughly N words and left
//            to finish its segments. Nothing enforces it.
//   tokens — a hard ceiling. num_predict, applied by the backend, which stops
//            generation mid-token. Enforced exactly, and capable of cutting a
//            segment in half; the server explains that specific failure by
//            name rather than letting it read as a format error.
// Bare unit names. They read "words (about)" and "tokens (hard cap)" until
// 26 Aug, which was redundant twice over — the note directly underneath already
// says "Asked for, not enforced" and "Hard cap, roughly N words" — and the
// extra characters pushed the number box narrow enough to clip its last digit.
// "Default" rather than "Model default": the field is already labelled Length
// and the note underneath says what the model does on its own, so the word
// "Model" bought nothing and cost the ~20px that decides whether the number
// box beside it can show four digits.
const LENGTH_UNITS = [
  { value: '', label: 'Default' },
  { value: 'words', label: 'words' },
  { value: 'tokens', label: 'tokens' },
];
const LENGTH_MIN = 10;
const LENGTH_MAX = 4000;

/** Kept so a model switch does not silently drop a limit the person set. */
let lengthChoice = { unit: '', value: '' };

function renderLength(block, model) {
  const wrap = document.createElement('label');
  wrap.className = 'field length';

  const head = document.createElement('span');
  head.className = 'slider-title';
  head.textContent = 'Length';
  wrap.appendChild(head);

  const row = document.createElement('span');
  row.className = 'length-row';

  const unit = document.createElement('select');
  unit.dataset.bind = 'max_length_unit';
  for (const u of LENGTH_UNITS) {
    const opt = document.createElement('option');
    opt.value = u.value;
    opt.textContent = u.label;
    unit.appendChild(opt);
  }
  unit.value = lengthChoice.unit;

  const value = document.createElement('input');
  value.type = 'number';
  value.dataset.bind = 'max_length_value';
  value.min = String(LENGTH_MIN);
  value.max = String(LENGTH_MAX);
  value.step = '10';
  value.value = lengthChoice.value;
  value.placeholder = '—';

  row.append(unit, value);
  wrap.appendChild(row);

  const note = document.createElement('em');
  note.className = 'length-note';
  wrap.appendChild(note);

  const paint = () => {
    const on = unit.value !== '';
    value.disabled = !on;
    // Seeding from word_target rather than from a constant: the point of the
    // control is to override the model's own band, and starting at that band
    // makes the first nudge meaningful instead of arbitrary.
    if (on && !value.value) {
      value.value = String(
        unit.value === 'words'
          ? model.word_target?.max ?? 120
          : Math.round((model.word_target?.max ?? 120) / 0.75)
      );
    }
    lengthChoice = { unit: unit.value, value: value.value };

    if (!on) {
      // Every model gets the same line now. Saying one "aims for 80-250 words
      // on its own" was a claim about a rule that exists in no other place:
      // not in its prompt file, which states a floor and no ceiling since
      // 26 Aug 2026; not in the user turn, which sends a Length line only when
      // someone types one; and not in the dialect suite, which asserts
      // `clears its 80-word floor` and nothing above it.
      note.textContent = 'This model writes to its own format.';
      wrap.classList.remove('length-on');
      return;
    }
    wrap.classList.add('length-on');
    const n = Number(value.value);
    if (!Number.isInteger(n) || n < LENGTH_MIN || n > LENGTH_MAX) {
      note.textContent = `Enter ${LENGTH_MIN}–${LENGTH_MAX}.`;
      note.classList.add('length-bad');
      return;
    }
    note.classList.remove('length-bad');
    note.textContent = unit.value === 'words'
      ? 'Asked for, not enforced — overrides the detail level above.'
      : `Hard cap, roughly ${Math.round(n * 0.75)} words. Can cut a segment off mid-way.`;
  };

  unit.addEventListener('change', paint);
  value.addEventListener('input', paint);
  paint();

  // Before the slider block, so it takes a cell in the select grid rather
  // than a cell in the slider band. The block is always the last child of its
  // row, so "before it" is "last among the selects".
  block.parentElement.insertBefore(wrap, block);
}

function collectControls() {
  const mount = $('#builder-mount');
  const controls = {};
  const read = (name) => $(`[data-bind="${name}"]`, mount);

  // 'creativity' left this list on 25 Aug: it is a range input now, and its
  // raw value is a notch index rather than a preset name. Both sliders are
  // read below.
  for (const key of ['quality_preset', 'source_tag', 'style', 'aspect_ratio',
                     'mode', 'duration', 'shots', 'quality_mode', 'model_size', 'frame_count',
                     'negative', 'positive']) {
    const el = read(key);
    if (el && !el.closest('[hidden]') && el.value !== '') controls[key] = el.value;
  }
  const shotRows = readShotBriefs();
  if (shotRows.some((row) => row.trim())) controls.shot_briefs = shotRows;
  // The sliders. A notch index is meaningless to the server, so each is
  // mapped back through the values renderSliders built it from: a preset name
  // for creativity, a level number for detail and for lighting.
  //
  // Lighting at 0 is still SENT, as the number 0. It resolves to a level with
  // no rule and injects nothing — the server decides that, not this. Dropping
  // it here instead would make "off" and "the control does not exist" the same
  // message, and only one of those should fall back to a default.
  for (const key of ['detail', 'creativity', 'lighting']) {
    const el = read(key);
    if (!el || el.closest('[hidden]')) continue;
    const value = sliderValues[key]?.[Number(el.value)];
    if (value !== undefined) controls[key] = value;
  }

  // The length control. Two inputs, one control: nothing is sent unless a unit
  // was picked, because "Model default" means the server should behave exactly
  // as it did before this control existed. An out-of-range number is sent
  // anyway rather than silently dropped — the server refuses it with a 400
  // naming the limit, and a limit that vanishes without a word is the failure
  // this control was built to stop repeating.
  const lengthUnit = read('max_length_unit');
  const lengthValue = read('max_length_value');
  if (lengthUnit && lengthUnit.value && lengthValue && lengthValue.value !== '') {
    controls.max_length = { unit: lengthUnit.value, value: Number(lengthValue.value) };
  }

  // Reference images. Only what the model can act on travels: the role, the
  // fidelity, the note, the RAW danbooru tags and a recognised character. The
  // File and its object URL stay here — the picture never leaves this machine,
  // which is the property the whole feature rests on.
  //
  // Tags go up in danbooru spelling rather than the model's. The server
  // formats them, and it is the side that knows this model's tag_style; a
  // pre-converted list would be converted twice on any model wanting spaces.
  if (imageReferences.length) {
    controls.image_references = imageReferences.map((ref) => ({
      role: ref.role,
      fidelity: ref.fidelity,
      ...(ref.note ? { note: ref.note } : {}),
      // Sent whatever the role, and the SERVER decides whether to name her.
      // This used to be gated here, which looked safer and was not: the tag
      // categories do not survive this wire — `tags` below is raw strings —
      // so withholding the field left the server unable to tell that
      // `frieren` in an Outfit reference's tag list is a person rather than a
      // hairstyle, and her name went out in the list instead of on its own
      // line. Sending it always is what lets the server strip it.
      ...(ref.character ? { character: ref.character } : {}),
      ...(ref.applies_to ? { applies_to: ref.applies_to } : {}),
      // Only what was clicked. The whole list used to go up and the server
      // filtered it by role — see the header of server/imagerefs.mjs for why
      // that stopped. An unpicked reference sends no tags at all, which is
      // the normal case now: the picture is what carries it.
      tags: ref.tags.filter((t) => ref.picked.has(t.raw)).map((t) => t.raw),
      // Everything the tagger scored, picked or not, with the scores — for
      // the READING pass to check against the photograph, never for the
      // prompt. Two different jobs and they must not be confused:
      //
      //   `tags`     what a person clicked. Goes to the prompt writer as a
      //              choice somebody made, and is used as written.
      //   `detected` what a CPU guessed. Goes to the analyst, which is
      //              looking at the picture and can throw out what is not
      //              there. Filtered and capped server-side — see tagHints.
      //
      // Asked for 9 Sep 2026 because the tagger catches what the vision model
      // will not name: `princess_carry` at 1.00 and `head_wreath` at 0.88 on
      // a reference where the reading kept saying "sitting on lap" and kept
      // dropping the flower crown.
      //
      // Vision-added tags carry a null confidence and are dropped downstream;
      // they are sent anyway rather than filtered here, because which side
      // knows what a null score means should be the side holding the config.
      detected: ref.tags.map((t) => ({ tag: t.raw, confidence: t.confidence })),
      // The picture itself, downscaled, when the model can look at it. This
      // is the feature.
      ...(ref.encoded ? { image: ref.encoded } : {}),
    }));
  }

  // "None" on the quality preset is a choice, not an absent control - the
  // difference between "this template has no preset selector" and "the person
  // asked for no quality tags". Sent as false so the server can tell.
  const quality = read('quality_preset');
  if (quality && !quality.closest('[hidden]') && quality.value === '') {
    controls.quality_preset = false;
  }
  for (const key of ['thinking', 'audio']) {
    const el = read(key);
    if (el) controls[key] = el.checked;
  }
  // Pictures are labelled in REF2VA, Auto detect and the frame modes (see setupReferences).
  if (['REF2VA', 'Auto detect', ...FRAME_MODES].includes(read('mode')?.value)) controls.picture_labels = true;
  // Tags picked from the database, already in this model's syntax, with the
  // weights the user set.
  if (selectedTags.length) {
    controls.tags = selectedTags.map((t) =>
      t.weight === 1 ? t.tag : `(${t.tag}:${t.weight.toFixed(2)})`
    );
  }

  // The first frame, for image-to-video. Presence is the signal the prompt
  // file acts on; the description only helps the subject layer name what
  // carries forward. Gated on the field being visible, so a model whose
  // registry entry drops supports_i2v stops sending it.
  // The Director timeline. Sent only in Director mode; Paragraph mode is the
  // model's ordinary single-paragraph request and must not carry a timeline.
  const dirMode = $('[data-bind="mode"]', mount);
  if (dirMode && /director/i.test(dirMode.value) && directorSegments.length) {
    controls.segments = directorSegments.map((s) => ({
      start: s.start, end: s.end, brief: s.brief.trim(),
      // The keyframe, when this segment has one and this box can read one. The
      // gate matters: a picture attached before the reader was switched off
      // would otherwise ride along to a server with nothing to do with it.
      ...(DIRECTOR_KEYFRAMES && s.image ? { image: s.image } : {}),
    }));
    const dur = $('[data-bind="director_duration"]', mount);
    const fps = $('[data-bind="director_frame_rate"]', mount);
    if (dur?.value) {
      // Held to the element's own max. Sending a duration the timeline was
      // not drawn at would tell the model one clip length while the person
      // was looking at another.
      controls.duration_seconds = clampDuration(dur.value, dur.max);
    }
    if (fps?.value) controls.frame_rate = Number(fps.value);
  }

  const i2vMode = $('[data-bind="i2v_mode"]', mount);
  const i2v = $('[data-bind="i2v_image"]', mount);
  if (i2v && !i2v.closest('[hidden]') && i2v.dataset.filename) {
    controls.i2v_reference = {
      description: i2v.dataset.description || null,
      // The frame itself. The server prefers it over the description and
      // falls back to the description when the chosen LLM cannot see — which
      // is why both travel rather than one replacing the other.
      ...(i2v._encoded ? { image: i2v._encoded } : {}),
    };
    if (i2vMode?.value) controls.i2v_mode = i2vMode.value;
  }

  // The last frame only travels when the mode asks for a pair. The field is
  // hidden otherwise, and closest('[hidden]') is what stops a frame picked
  // before the mode changed from riding along unseen.
  const i2vLast = $('[data-bind="i2v_last_image"]', mount);
  if (i2vLast && !i2vLast.closest('[hidden]') && i2vLast.dataset.filename) {
    controls.i2v_last_reference = {
      description: i2vLast.dataset.description || null,
      ...(i2vLast._encoded ? { image: i2vLast._encoded } : {}),
    };
  }

  // Visual references, in the order they appear — the server numbers them
  // <Picture 1>, <Picture 2>… by position, so order is meaningful.
  // Tiles carry their state on the dataset rather than in inputs inside them:
  // the Director panel has ONE editor shared by every clip, so the tile is the
  // record and the editor is a view onto whichever one is selected.
  //
  // Hidden tiles are skipped, and that is the mode gating doing its job — a
  // mode switch hides the references it cannot use instead of deleting them,
  // so they come back when you switch back, and they must not ride along in
  // the meantime. Same rule as the i2v last-frame control above.
  const rows = $$('[data-bind="reference_list"] .mmd-tile', mount).filter((t) => !t.hidden);
  if (rows.length) {
    controls.references = rows.map((row) => {
      const kind = row.dataset.kind || 'image';
      // A labelled picture leaves its tagger-filled traits out; typed ones go.
      const taggerKeep = controls.picture_labels && kind === 'image' && row.dataset.keepAuto === '1';
      const ref = {
        role: row.dataset.role || null,
        keep: taggerKeep ? null : (row.dataset.keep ?? '').trim() || null,
        drop: (row.dataset.drop ?? '').trim() || null,
        // What the file is, which is how the server counts lanes against the
        // Director's file limits and decides whether a stream mode applies.
        kind,
        ...(kind === 'image' && row.dataset.role === 'subject'
          && ['REF2VA', 'Auto detect'].includes(dirMode?.value) && row.dataset.subjectGroup
          ? { subject_group: row.dataset.subjectGroup } : {}),
        // What the model saw in this picture, scanned earlier or edited by
        // hand. The server uses it instead of scanning the picture again.
        ...(kind === 'image' && row.dataset.reading ? { reading: row.dataset.reading } : {}),
        // The label for this picture: Character 1, Place, First frame…
        ...(kind === 'image' && controls.picture_labels ? { picture_label: row.dataset.pictureLabel || 'character-1' } : {}),
        // Who stands in a first or last frame, from its number buttons.
        // Everything the picture is, and who is in it, from its buttons.
        ...(kind === 'image' && controls.picture_labels ? { picture_kinds: kindsOf(row) } : {}),
        ...(kind === 'image' && controls.picture_labels && takesWho(row) && whoOf(row).length
          ? { who: whoOf(row) } : {}),
        ...(kind === 'image' && controls.picture_labels && ['x', 'y', 'z'].includes(row.dataset.whoAxis)
          ? { who_axis: row.dataset.whoAxis } : {}),
        // A few words per character in a picture of several, for the ones tapped.
        ...(() => {
          if (kind !== 'image' || !controls.picture_labels || whoOf(row).length < 2) return {};
          const given = (() => { try { return JSON.parse(row.dataset.whoHints || '{}'); } catch { return {}; } })();
          const hints = Object.fromEntries(whoOf(row).filter((n) => String(given[n] ?? '').trim()).map((n) => [n, String(given[n]).trim()]));
          return Object.keys(hints).length ? { who_hints: hints } : {};
        })(),
        // People boxes: who is in it and where, and the crop each one is read from.
        ...(kind === 'image' && controls.picture_labels && peopleBoxesOf(row).length ? { boxes: peopleBoxesOf(row) } : {}),
        // The picture, on the image tiles that have one. The server attaches
        // it under the same <Picture N> label this row's line gets, so the
        // model is told which photograph goes with which line.
        ...(row._encoded ? { image: row._encoded } : {}),
      };
      // Only a video carries a stream mode. Sending one on a still would be a
      // field the server ignores, which reads like it should have done
      // something.
      if (kind === 'video') ref.stream = row.dataset.stream || 'video';
      // The CROP duration, not the source's: the crop is what would be sent,
      // so it is what the 2-15s per-clip rule has to be checked against.
      const duration = Number(row.dataset.duration);
      if (Number.isFinite(duration) && duration > 0) ref.duration_seconds = duration;
      return ref;
    });
  }
  // The Cast list's cards with text: used as written, so what they describe is not read again.
  // A pose card goes by its picture's number now ("pose@3"); a pose whose
  // picture is gone or hidden is left out.
  if (controls.picture_labels && currentModel) {
    const pictures = rows.filter((t) => t.dataset.kind === 'image');
    // Only cards for what the pictures show now: a card left from a picture
    // since relabelled (Character 3 that became the place) must not wait in
    // the stash and go in as written once a Character 3 is added.
    const shownNumbers = new Set(pictures.filter((t) => !kindsOf(t).includes('pose') && kindsOf(t).some((k) => k === 'character' || isFrame(k))).flatMap(whoOf));
    const keyOf = (k) => {
      if (typeof k === 'number') return shownNumbers.has(k) ? k : null;
      if (k === 'place' || k === 'style') return pictures.some((t) => !kindsOf(t).includes('pose') && kindsOf(t).includes(k)) ? k : null;
      if (!k.startsWith('pose:')) return null;
      const at = pictures.findIndex((t) => t.dataset.castId === k.slice(5) && kindsOf(t).includes('pose'));
      return at >= 0 ? `pose@${at + 1}` : null;
    };
    const cards = [...castStateFor(currentModel.key)].filter(([, c]) => c.text.trim()).map(([k, c]) => [keyOf(k), c.text.trim()]).filter(([k]) => k != null);
    if (cards.length) controls.cast = Object.fromEntries(cards);
  }
  // MOSS: the studio's canvas, and any boxes drawn on it.
  const studio = wantsLayout(currentModel, mount) ? layoutStudio() : null;
  if (studio) controls.layout = studio.forPrompt();
  // In Layout JSON the studio is the whole input. Tags and reference pictures
  // picked in another format are hidden with the rest, so they stay home.
  if (wantsLayout(currentModel, mount)) {
    delete controls.tags;
    delete controls.image_references;
  }
  return controls;
}

// ── MOSS Layout Studio ───────────────────────────────────────
//
// A user's canvas editor for MOSS layouts (web/layout-studio/), shown in the
// page as the full-width Layout panel under the builder and output, in the
// Layout JSON format only. Full screen pins the same frame over the page
// rather than moving it, because moving an iframe reloads it. One iframe for
// the life of the tab, so a model switch keeps the drawing. Its canvas is the
// canvas: the Aspect control resizes it, Generate sends its size and boxes,
// and the generated layout comes back onto it. The studio autosaves itself,
// as it always has.

function layoutStudioFrame() {
  const host = $('#layout-frame');
  if (host && !$('iframe', host)) {
    host.innerHTML = '<iframe title="Layout Studio" src="/layout-studio/index.html"></iframe>';
    $('iframe', host).addEventListener('load', (e) => {
      paintThemeInto(e.target);
      setLayoutFull($('#layout-panel')?.classList.contains('full'));
      // Once it can be driven: the aspect picked before it loaded applies.
      const aspect = $('#builder-mount [data-bind="aspect_ratio"]');
      if (currentModel?.layout_canvas && aspect && aspect.value !== 'N/A') syncStudioSize(currentModel, aspect.value);
      syncFromStudio();
    });
    window.addEventListener('message', (e) => {
      if (e.origin !== location.origin) return;
      // The studio's own Close button leaves full screen.
      if (e.data?.type === 'layout-studio-close') setLayoutFull(false);
      // Anything changed in the studio: the builder shows its Global prompt,
      // medium and size.
      if (e.data?.type === 'layout-studio-changed') syncFromStudio();
    });
    $('#btn-layout-full')?.addEventListener('click', () => {
      setLayoutFull(!$('#layout-panel').classList.contains('full'));
    });
  }
  return host;
}

/** Full screen on or off. The studio's Close button only means something on. */
function setLayoutFull(on) {
  const panel = $('#layout-panel');
  if (!panel) return;
  panel.classList.toggle('full', Boolean(on));
  document.body.classList.toggle('layout-full', Boolean(on));
  const btn = $('#btn-layout-full');
  if (btn) btn.textContent = on ? 'Exit full screen' : 'Full screen';
  try {
    const close = $('#layout-frame iframe')?.contentDocument?.getElementById('closeStudio');
    if (close) close.hidden = !on;
  } catch { /* mid-load */ }
  // Full screen covers the builder, so the studio's own size and Scene column
  // come back there; beside the builder they are the builder's.
  layoutStudio()?.compact(!on);
  paintStudioSummary();
}

/** The studio's API, or null until its page has loaded. */
function layoutStudio() {
  return $('#layout-frame iframe')?.contentWindow?.MossStudio ?? null;
}

function syncStudioSize(model, aspect) {
  const size = model.layout_canvas?.[aspect] ?? model.layout_canvas?.['N/A'];
  if (size) layoutStudio()?.setSize(size[0], size[1]);
}

/** The size the boxes are measured on: the studio's, else the aspect's. */
function paintStudioSummary() {
  const mount = $('#builder-mount');
  const model = currentModel;
  if (!model?.layout_canvas) return;
  const studio = layoutStudio();
  const aspect = $('[data-bind="aspect_ratio"]', mount)?.value;
  const [w, h] = studio
    ? [studio.size().width, studio.size().height]
    : model.layout_canvas[aspect] ?? model.layout_canvas['N/A'];
  // One line in the builder: the size to generate at, and what Generate will do.
  const summary = $('[data-bind="studio_summary"]', mount);
  if (summary) {
    const n = studio ? studio.getProject().items.length : 0;
    summary.textContent = n
      ? `${w}×${h} · ${n} box${n === 1 ? '' : 'es'} — Generate keeps them and writes their descriptions`
      : `${w}×${h} · no boxes yet — Generate drafts the layout`;
  }
  const note = $('#layout-panel-note');
  if (note && studio) {
    const n = studio.getProject().items.length;
    note.textContent = `${w}×${h} · ${n} box${n === 1 ? '' : 'es'} · generate at this size`;
  }
}

/**
 * The FORMAT row at the top of the builder: one button per option of the
 * template's format select (`.format-source`), which stays the value Generate
 * sends. A click sets the select and fires its change, so everything listening
 * to it — the Layout Studio bar — follows. Hidden on any template without one.
 */
function setupFormatToggle(mount) {
  const bar = $('#format-bar');
  const host = $('#format-toggle');
  const sel = $('.format-source [data-bind="mode"]', mount);
  if (!bar || !host) return;
  const shown = Boolean(sel && sel.options.length && !sel.closest('[hidden]'));
  bar.hidden = !shown;
  host.replaceChildren();
  if (!shown) return;
  const paint = () => {
    for (const b of host.children) {
      const on = b.dataset.value === sel.value;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
  };
  for (const opt of sel.options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.value = opt.value;
    b.textContent = opt.textContent;
    b.addEventListener('click', () => {
      if (sel.value === opt.value) return;
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    host.append(b);
  }
  sel.addEventListener('change', paint);
  paint();
}

/** True when the format picked writes a layout: the studio exists only then. */
function wantsLayout(model, mount = $('#builder-mount')) {
  if (!model?.layout_canvas) return false;
  const mode = $('[data-bind="mode"]', mount)?.value;
  return (model.segments_by_mode?.[mode] ?? model.segments ?? []).includes('Layout JSON');
}

function setupLayoutStudio(mount, model) {
  const bar = $('[data-bind="layout_studio"]', mount);
  const panel = $('#layout-panel');
  const briefEl = $('[data-bind="brief"]', mount);
  const briefHint = briefEl?.placeholder ?? '';
  // In Layout JSON the studio sits beside this builder, in the Output panel's
  // place (the studio shows the JSON, so Output has nothing to add). The
  // Global prompt, Medium and Rewrite come over from its own left column,
  // which is not drawn, and the Aspect sets its canvas size. The brief stays
  // the person's own: Generate writes the Global prompt, never the brief.
  // What the studio makes redundant — reference pictures, tags, custom
  // positive — is [hidden], so none of it is sent (collectControls); the
  // state each had is put back on the way out, because some are hidden for
  // reasons of their own.
  const layoutHidden = () => $$('[data-layout-hide]', mount);
  // Every model switch lands here, so the panel is hidden for a model with no
  // layout even though it lives outside the builder.
  const show = () => {
    const on = wantsLayout(model, mount);
    if (bar) bar.hidden = !on;
    for (const el of $$('[data-layout-only]', mount)) el.hidden = !on;
    for (const el of layoutHidden()) {
      if (on && el.dataset.layoutWas == null) {
        el.dataset.layoutWas = el.hidden ? '1' : '0';
        el.hidden = true;
      } else if (!on && el.dataset.layoutWas != null) {
        el.hidden = el.dataset.layoutWas === '1';
        delete el.dataset.layoutWas;
      }
    }
    // Only the negative prompt is optional in this format: the JSON is the
    // whole prompt, so "What changed" is not written.
    for (const item of $$('.segment-switches > *', mount)) item.hidden = on && !/negative/i.test(item.textContent);
    if (briefEl) {
      briefEl.placeholder = on ? 'What you want. Generate drafts the layout from this, or describes the boxes you drew — left empty, it works from the Global prompt.' : briefHint;
      // Shorter beside the Global prompt, which holds the long version.
      briefEl.rows = on ? 4 : 7;
    }
    document.body.classList.toggle('layout-mode', on);
    if (panel) panel.hidden = !on;
    if (!on) setLayoutFull(false);
    if (on) {
      layoutStudioFrame();
      syncFromStudio();
      layoutStudio()?.compact(!panel?.classList.contains('full'));
    }
  };
  show();
  if (!bar || !model.layout_canvas) return;
  $('[data-bind="mode"]', mount)?.addEventListener('change', () => {
    show();
    paintStudioSummary();
  });
  // Typing in these is typing in the studio's own boxes.
  $('[data-bind="layout_caption"]', mount)?.addEventListener('input', (e) => {
    layoutStudio()?.setScene({ caption: e.target.value });
  });
  $('[data-bind="layout_meta"]', mount)?.addEventListener('input', (e) => {
    layoutStudio()?.setScene({ meta: e.target.value });
  });
  $('[data-bind="layout_rewrite_scene"]', mount)?.addEventListener('click', () => layoutStudio()?.rewrite('scene'));
  $('[data-bind="layout_rewrite_all"]', mount)?.addEventListener('click', () => layoutStudio()?.rewrite('all'));
  $('[data-bind="aspect_ratio"]', mount)?.addEventListener('change', (e) => {
    syncStudioSize(model, e.target.value);
    paintStudioSummary();
  });
  paintStudioSummary();
}

/**
 * The studio's Global prompt and medium into the builder, when they changed
 * there (an edit, an undo, a Rewrite, a generated layout). A box being typed
 * in is left alone, so the two never fight over the cursor.
 */
function syncFromStudio() {
  const mount = $('#builder-mount');
  const studio = layoutStudio();
  if (!studio || !wantsLayout(currentModel, mount)) return;
  const p = studio.getProject();
  const captionEl = $('[data-bind="layout_caption"]', mount);
  const metaEl = $('[data-bind="layout_meta"]', mount);
  if (captionEl && document.activeElement !== captionEl && captionEl.value !== p.caption) captionEl.value = p.caption;
  if (metaEl && document.activeElement !== metaEl && metaEl.value !== p.meta) metaEl.value = p.meta;
  // A size that is one of the aspects' (an undo, an import) shows as it.
  const aspectEl = $('[data-bind="aspect_ratio"]', mount);
  const match = Object.entries(currentModel.layout_canvas ?? {})
    .find(([k, [w, h]]) => k !== 'N/A' && w === p.w && h === p.h)?.[0];
  if (aspectEl && match && aspectEl.value !== match) aspectEl.value = match;
  paintStudioSummary();
}

/** A finished generation's Layout JSON onto the studio canvas it was written for. */
function applyLayoutToStudio(segments, sent) {
  const studio = layoutStudio();
  const seg = (segments ?? []).find((s) => s.label === 'Layout JSON');
  if (!studio || !sent || !seg) return;
  try {
    studio.applyGenerated(JSON.parse(seg.body), sent.width, sent.height);
  } catch (err) {
    toast(`The layout could not go onto the studio canvas: ${err.message}`);
  }
  paintStudioSummary();
}

// ── chat (Tab 5) ─────────────────────────────────────────────
//
// Prose, not segments: chat/default.md says so itself — "The segment format
// does not apply here" — so this streams straight into a bubble rather than
// through the segment parser.
//
// Web search is absent rather than stubbed. It needs SearXNG in Docker and
// `search.enabled` is false; nothing here pretends otherwise. When it lands,
// the seam is the `searched` and `citations` fields the stored message schema
// already carries.

let chatId = null;           // the open conversation, or null for a fresh one
let chatSending = false;
// Sticky, deliberately: a run of questions about something current should not
// mean pressing the button every time. It is visibly on, so nobody has to
// wonder whether the last answer was searched.
let chatSearchOn = false;

/**
 * Split an answer into text and citation markers.
 *
 * The model is told to write [1], [2] against the numbered results it was
 * given, so those markers are the contract between the search block and the
 * rendered answer. Returned as parts rather than HTML because the answer is
 * untrusted text: the caller builds nodes, and nothing here can inject markup.
 *
 * A marker with no matching source stays as literal text. Models write "[1]"
 * for other reasons — array indices, references to a numbered list they made
 * up — and turning one of those into a dead link is worse than leaving it.
 */
export function citationParts(text, citations = []) {
  const byNumber = new Map((citations ?? []).map((c) => [Number(c.n), c]));
  const parts = [];
  let last = 0;
  const src = String(text ?? '');

  for (const match of src.matchAll(/\[(\d{1,2})\]/g)) {
    const cite = byNumber.get(Number(match[1]));
    if (!cite) continue;
    // Not when it is attached to a word: `layers[1]` and `steps[0]` are code,
    // and a source that happens to be numbered 1 should not turn an array
    // index into a link. Prose citations follow a space or punctuation.
    //
    // The cost of this rule is a citation written tight against the last word
    // — "rank 128[1]" — which is rendered as text instead. That is the safer
    // way to be wrong: a missing link is a citation you can still read, while
    // a linked array index is a claim the answer never made.
    if (match.index > 0 && /[A-Za-z0-9_]/.test(src[match.index - 1])) continue;
    if (match.index > last) parts.push({ type: 'text', value: src.slice(last, match.index) });
    parts.push({ type: 'cite', n: Number(match[1]), url: cite.url, title: cite.title, domain: cite.domain });
    last = match.index + match[0].length;
  }
  if (last < src.length) parts.push({ type: 'text', value: src.slice(last) });
  return parts;
}

function chatMessageEl(role, content, state) {
  const wrap = document.createElement('div');
  wrap.className = `chat-msg ${role}${state ? ` ${state}` : ''}`;
  const who = document.createElement('div');
  who.className = 'chat-role';
  who.textContent = role === 'user' ? 'You' : 'Assistant';
  const body = document.createElement('div');
  body.className = 'chat-body';
  // textContent, never innerHTML. Model output is untrusted text like any
  // other, and this is the surface most likely to carry markup.
  body.textContent = content;
  wrap.append(who, body);
  return wrap;
}

/**
 * Re-render an answer with its citation markers turned into links.
 *
 * Run once when the answer finishes, not per token: a marker can arrive split
 * across two chunks, and rewriting the body mid-stream would make the text
 * jump. Nodes are built one at a time — the answer never touches innerHTML.
 */
function applyCitations(body, text, citations) {
  const parts = citationParts(text, citations);
  if (!parts.some((p) => p.type === 'cite')) return;
  body.textContent = '';
  for (const part of parts) {
    if (part.type === 'text') {
      body.appendChild(document.createTextNode(part.value));
      continue;
    }
    const link = document.createElement('a');
    link.className = 'cite';
    link.href = part.url;
    link.target = '_blank';
    // A local app opening a remote page: deny it the opener handle.
    link.rel = 'noopener noreferrer';
    link.textContent = String(part.n);
    link.title = `${part.title ?? ''}${part.domain ? ` — ${part.domain}` : ''}`.trim();
    body.appendChild(link);
  }
}

/**
 * A picture chat rendered, under the reply that carries its prompt. `source`
 * is what Open in builder loads: the model, the brief, and the prompt as
 * segments. The picture lives on the server for a day; after that the
 * conversation says so instead of showing a broken image.
 */
function chatRenderEl(render, source) {
  const box = document.createElement('div');
  box.className = 'chat-render';
  const link = document.createElement('a');
  link.href = render.url;
  link.target = '_blank';
  link.rel = 'noopener';
  const img = document.createElement('img');
  img.src = render.url;
  img.alt = 'Rendered picture';
  img.onerror = () => {
    box.textContent = 'This picture is gone from the server — renders are kept for a day.';
    box.classList.add('gone');
  };
  link.append(img);
  const actions = document.createElement('div');
  actions.className = 'render-actions';
  const pin = Object.assign(document.createElement('button'), { className: 'ghost', type: 'button', textContent: 'Pin' });
  pin.addEventListener('click', async () => {
    pin.disabled = true;
    try {
      const res = await fetch(`/api/render/${render.id}/pin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...USER_HEADER },
        body: JSON.stringify({ brief: source?.brief ?? '' }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message ?? 'Could not pin it.');
      toast(`Pinned as ${body.name}`);
    } catch (err) {
      toast(err.message);
    } finally {
      pin.disabled = false;
    }
  });
  actions.append(pin);
  if (source?.segments?.length && REGISTRY?.models.some((m) => m.key === source.model)) {
    const open = Object.assign(document.createElement('button'), { className: 'ghost', type: 'button', textContent: 'Open in builder' });
    open.addEventListener('click', async () => {
      $('.main-tab[data-tab="prompt"]')?.click();
      await loadLibraryEntry({
        model: source.model,
        brief: source.brief ?? '',
        segments: source.segments,
        title: sessionTitle(source.brief),
        render: { ...render },
      });
    });
    actions.append(open);
  }
  box.append(link, actions);
  return box;
}

/** A stored chat render's prompt as builder segments, labelled the way its model labels them. */
function chatRenderSegments(m) {
  const model = REGISTRY?.models.find((x) => x.key === m.tool?.model);
  if (!model || !m.tool?.positive) return [];
  const meta = new Set(model.meta_segments ?? []);
  const label = (model.segments ?? []).find((l) => !meta.has(l) && !/negative/i.test(l)) ?? 'Prompt';
  return [
    { label, body: m.tool.positive },
    ...(m.tool.negative ? [{ label: 'Negative prompt', body: m.tool.negative }] : []),
  ];
}

/** The "searched for X" line above an answer that used search. */
function searchedEl(searched) {
  const row = document.createElement('div');
  row.className = `chat-searched${searched.results ? '' : ' failed'}`;
  row.textContent = searched.results
    ? `Searched the web for "${searched.query}" — ${searched.results} result${searched.results === 1 ? '' : 's'}`
    : `Searched for "${searched.query}" — ${searched.detail ?? 'nothing came back'}. Answered from model knowledge.`;
  return row;
}

function chatScrollToEnd() {
  const thread = $('#chat-thread');
  if (thread) thread.scrollTop = thread.scrollHeight;
}

function renderChatEmpty() {
  const thread = $('#chat-thread');
  if (!thread) return;
  thread.innerHTML = `
    <div class="empty-state">
      <strong>No messages yet</strong>
      Ask about training settings, samplers, dataset prep — anything.<br>
      Conversations stay on this machine and are saved to your account.
    </div>`;
}

/**
 * Days left before the retention sweep takes a conversation, or null if
 * nothing will.
 *
 * Counted from the last message, which is what the server counts from. A
 * locked conversation returns null because nothing is coming for it.
 */
export function daysUntilSwept(chat, retentionDays, now = Date.now()) {
  const days = Number(retentionDays);
  if (!Number.isFinite(days) || days <= 0) return null;
  if (chat?.locked) return null;
  const last = Date.parse(chat?.updated_at ?? '');
  if (!Number.isFinite(last)) return null;
  const left = Math.ceil((last + days * 86400000 - now) / 86400000);
  return Math.max(0, left);
}

// ── the sidebar's right-click menu (26 Sep 2026) ──────────────
//
// Rename, pin, lock, delete. Lock and delete reuse the row's own buttons, so
// there is one code path for each whichever way they are reached.
function closeChatMenu() {
  document.querySelector('.chat-menu')?.remove();
}

function openChatMenu(x, y, c, row, { lock, del }) {
  closeChatMenu();
  const menu = document.createElement('div');
  menu.className = 'chat-menu';
  menu.setAttribute('role', 'menu');
  const item = (label, action) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.textContent = label;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      closeChatMenu();
      action();
    });
    menu.appendChild(b);
  };
  item('Rename', () => renameChatInline(c, row));
  item(c.pinned ? 'Unpin' : 'Pin to top', async () => {
    const res = await fetch(`/api/chat/${c.id}/pin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pinned: !c.pinned }),
    });
    if (!res.ok) toast('Could not change the pin');
    refreshChatHistory();
  });
  item(c.locked ? 'Unlock' : 'Lock', () => lock.click());
  item('Delete', () => del.click());
  menu.lastChild.classList.add('danger');

  document.body.appendChild(menu);
  // Kept on screen when the click is near the right or bottom edge.
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
  menu.querySelector('button')?.focus();
}

/** Rename in place: the title becomes a text box; Enter or leaving it saves, Escape cancels. */
function renameChatInline(c, row) {
  const title = row.querySelector('.chat-item-title');
  if (!title) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'chat-item-rename';
  input.value = c.title;
  input.maxLength = 80;
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const next = input.value.trim();
    if (save && next && next !== c.title) {
      const res = await fetch(`/api/chat/${c.id}/rename`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: next }),
      });
      if (!res.ok) toast((await res.json().catch(() => ({}))).message ?? 'Could not rename it');
    }
    refreshChatHistory();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  // Clicking into the box must not open the chat underneath it.
  input.addEventListener('click', (e) => e.stopPropagation());
  title.replaceWith(input);
  input.focus();
  input.select();
}

async function refreshChatHistory() {
  const list = $('#chat-list');
  if (!list) return;
  let chats = [];
  let retentionDays = 0;
  let searchInfo = null;
  try {
    const payload = await fetch('/api/chat/history').then((r) => r.json());
    chats = payload.chats ?? [];
    retentionDays = payload.retention_days ?? 0;
    searchInfo = payload.search ?? null;
  } catch {
    // The sidebar is navigation, not content. An unreachable server is
    // already reported by the status dot.
    return;
  }
  list.innerHTML = '';
  for (const c of chats) {
    const row = document.createElement('div');
    row.className = `chat-item${c.id === chatId ? ' active' : ''}${c.locked ? ' locked' : ''}`;

    const title = document.createElement('div');
    title.className = 'chat-item-title';
    title.textContent = c.title;

    // The tooltip carries the whole story: size, and what is going to happen
    // to it. The row itself only shouts when the answer is "soon".
    const left = daysUntilSwept(c, retentionDays);
    const counted = `${c.message_count} message${c.message_count === 1 ? '' : 's'}`;
    // "deleted in 0 days" is technically true and reads like a bug, so the
    // last day says what actually happens instead of counting to zero.
    title.title = c.locked
      ? `${counted} · locked, so it is never deleted`
      : left === null
        ? counted
        : left === 0
          ? `${counted} · past the window — deleted at the next sweep unless you reply or lock it`
          : `${counted} · deleted in ${left} day${left === 1 ? '' : 's'} unless you reply or lock it`;

    // A warning only when it is close enough to matter. A countdown on every
    // row would be noise on the ones with a fortnight left.
    if (left !== null && left <= 3) {
      const soon = document.createElement('span');
      soon.className = 'chat-item-soon';
      soon.textContent = left === 0 ? 'today' : `${left}d`;
      soon.title = 'This conversation is about to be deleted. Lock it to keep it.';
      title.appendChild(soon);
    }

    const lock = document.createElement('button');
    lock.className = 'chat-item-lock';
    lock.type = 'button';
    // Filled padlock when locked, open one when not, so the state reads at a
    // glance rather than only in the tooltip.
    lock.textContent = c.locked ? '🔒' : '🔓';
    lock.title = c.locked
      ? 'Locked — this conversation is never auto-deleted. Click to unlock.'
      : 'Lock this conversation so it is never auto-deleted';
    lock.addEventListener('click', async (e) => {
      e.stopPropagation();
      await fetch(`/api/chat/${c.id}/lock`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locked: !c.locked }),
      });
      toast(c.locked ? 'Unlocked' : 'Locked — this one is kept');
      refreshChatHistory();
    });

    const del = document.createElement('button');
    del.className = 'chat-item-del';
    del.type = 'button';
    del.textContent = '×';
    del.title = 'Delete this conversation';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      // A locked conversation is one somebody deliberately kept, so deleting
      // it by hand asks first. Unlocked ones go without ceremony — they were
      // going to expire anyway.
      if (c.locked && !confirm(`"${c.title}" is locked. Delete it anyway?`)) return;
      await fetch(`/api/chat/${c.id}`, { method: 'DELETE' });
      if (c.id === chatId) startNewChat();
      refreshChatHistory();
    });

    if (c.pinned) {
      row.classList.add('pinned');
      title.prepend(Object.assign(document.createElement('span'), { className: 'chat-item-pin', textContent: '📌 ' }));
    }

    row.append(title, lock, del);
    row.addEventListener('click', () => openChat(c.id));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openChatMenu(e.clientX, e.clientY, c, row, { lock, del });
    });
    list.appendChild(row);
  }

  // The policy, stated where the conversations are. Nobody should learn the
  // retention window by losing something to it.
  const policy = $('#chat-policy');
  if (policy) {
    policy.textContent =
      retentionDays > 0
        ? `Deleted after ${retentionDays} days without a reply. Lock one to keep it.`
        : 'Kept until you delete them.';
  }

  // The Search button only exists if the server can actually search. A button
  // that cannot work is worse than no button.
  const toggle = $('#chat-search');
  if (toggle) {
    const on = Boolean(searchInfo?.enabled);
    toggle.hidden = !on;
    if (!on) {
      chatSearchOn = false;
      toggle.setAttribute('aria-pressed', 'false');
    }
  }
  const where = $('#chat-info-search-where');
  if (where) {
    where.textContent = !searchInfo?.enabled
      ? 'Web search is switched off, so nothing leaves the machine at all.'
      : searchInfo.backend === 'searxng'
        ? 'Searches go through the local SearXNG instance, which proxies them — the sites you end up citing never see your machine. Everything else about a conversation stays here.'
        : 'Search terms go to DuckDuckGo directly; nothing proxies them. Everything else about a conversation — the questions, the answers, the history — stays on this machine.';
  }

  // The rules panel says the same thing at length. Filled from the server
  // rather than written into the page, so it cannot drift from config.
  const rule = $('#chat-info-retention');
  if (rule) {
    rule.textContent =
      retentionDays > 0
        ? `A conversation is deleted after ${retentionDays} days with no new message in it. ` +
          'The clock runs from the last message, not from when you started it, so one you ' +
          'keep coming back to never expires. Conversations close to the deadline show the ' +
          'days remaining in the list.'
        : 'Nothing automatic — conversations stay until you delete them.';
  }
}

async function openChat(id) {
  const thread = $('#chat-thread');
  if (!thread) return;
  const chat = await fetch(`/api/chat/${id}`).then((r) => (r.ok ? r.json() : null));
  if (!chat) return;
  chatId = chat.id;
  thread.innerHTML = '';
  for (const m of chat.messages) {
    // A reopened conversation shows what it showed the first time: the search
    // line above the answer, and the citations inside it.
    if (m.searched) thread.appendChild(searchedEl(m.searched));
    const el = chatMessageEl(m.role, m.content);
    if (m.pictures) el.insertBefore(chatPicturesEl(null, m.pictures), el.querySelector('.chat-body'));
    if (m.citations?.length) applyCitations(el.querySelector('.chat-body'), m.content, m.citations);
    if (m.render?.url) {
      el.appendChild(chatRenderEl(m.render, { model: m.tool?.model, brief: m.tool?.brief, segments: chatRenderSegments(m) }));
    }
    if (m.edit?.url) el.appendChild(chatEditEl(m.edit));
    thread.appendChild(el);
  }
  if (!chat.messages.length) renderChatEmpty();
  // A conversation remembers what it was held on, so reopening one puts the
  // selector back rather than quietly continuing it on whatever was picked
  // last. A model since removed still shows: the next poll gives it a row
  // saying so, which is why the signature is cleared to force a rebuild.
  if (chat.model) {
    chatModel = chat.model;
    const sel = $('#chat-model');
    if (sel && [...sel.options].some((o) => o.value === chatModel)) sel.value = chatModel;
    chatModelSignature = '';
    paintChatModelNote();
  }
  chatScrollToEnd();
  refreshChatHistory();
}

function startNewChat() {
  chatId = null;
  renderChatEmpty();
  const note = $('#chat-note');
  if (note) note.textContent = '';
  refreshChatHistory();
  $('#chat-input')?.focus();
}

// ── pictures in chat (26 Sep 2026) ────────────────────────────
//
// Held in this page until sent, then in the server's memory only; nothing is
// saved with the conversation (server/chatpictures.mjs). Each is shrunk here
// first: a vision model reads about a megapixel anyway, and a phone photo
// would otherwise be a 10 MB request for nothing.
const CHAT_PICTURE_MAX = 4;
const CHAT_PICTURE_EDGE = 1600;
let chatPictures = [];   // [{ blob, url }] - url is an object URL, RAM only

async function shrinkPicture(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, CHAT_PICTURE_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  // JPEG has no transparency; white behind it rather than black.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not encode'))), 'image/jpeg', 0.9));
}

async function addChatPictures(files) {
  const note = $('#chat-note');
  for (const file of files) {
    if (chatPictures.length >= CHAT_PICTURE_MAX) {
      if (note) note.textContent = `Up to ${CHAT_PICTURE_MAX} pictures per message.`;
      break;
    }
    try {
      const blob = await shrinkPicture(file);
      chatPictures.push({ blob, url: URL.createObjectURL(blob) });
    } catch {
      if (note) note.textContent = `${file.name} could not be read as a picture.`;
    }
  }
  paintChatPictures();
}

function paintChatPictures() {
  const tray = $('#chat-pictures');
  if (!tray) return;
  tray.replaceChildren();
  tray.hidden = !chatPictures.length;
  chatPictures.forEach((p, i) => {
    const chip = document.createElement('div');
    chip.className = 'chat-picture-chip';
    const img = document.createElement('img');
    img.src = p.url;
    img.alt = `Picture ${i + 1}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = 'Remove';
    remove.addEventListener('click', () => {
      URL.revokeObjectURL(p.url);
      chatPictures.splice(i, 1);
      paintChatPictures();
    });
    chip.append(img, remove);
    tray.appendChild(chip);
  });
}

/** Thumbnails inside a message bubble: live ones this session, a note after a reload. */
function chatPicturesEl(urls, count) {
  const row = document.createElement('div');
  row.className = 'chat-msg-pictures';
  if (urls?.length) {
    for (const url of urls) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = 'Picture sent with this message';
      row.appendChild(img);
    }
  } else {
    row.textContent = `${count} picture${count === 1 ? '' : 's'} sent here · not saved`;
    row.classList.add('gone');
  }
  return row;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function sendChat() {
  const input = $('#chat-input');
  const thread = $('#chat-thread');
  const note = $('#chat-note');
  if (!input || !thread || chatSending) return;

  const text = input.value.trim();
  const sending = chatPictures;
  if (!text && !sending.length) return;
  let pictures = [];
  try {
    pictures = await Promise.all(sending.map(async (p) => ({ type: 'image/jpeg', data: await blobToBase64(p.blob) })));
  } catch {
    if (note) note.textContent = 'A picture could not be read. Remove it and try again.';
    return;
  }
  // The tray empties now; the bubble below keeps the object URLs for this session.
  chatPictures = [];
  paintChatPictures();

  // Cleared immediately. Leaving it in the box while the answer streams
  // invites a second Enter, and the queue would happily take both.
  input.value = '';
  input.style.height = 'auto';
  chatSending = true;
  $('#chat-send').disabled = true;

  if (thread.querySelector('.empty-state')) thread.innerHTML = '';
  const mine = chatMessageEl('user', text);
  if (sending.length) mine.insertBefore(chatPicturesEl(sending.map((p) => p.url)), mine.querySelector('.chat-body'));
  thread.appendChild(mine);
  const answer = chatMessageEl('assistant', '', 'streaming');
  thread.appendChild(answer);
  const body = answer.querySelector('.chat-body');
  chatScrollToEnd();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: chatId,
        message: text,
        ...(pictures.length ? { pictures } : {}),
        search: chatSearchOn,
        // Omitted rather than guessed when the status poll has not landed
        // yet, so the server applies its configured default instead of the
        // page inventing one.
        ...(chatModel ? { model: chatModel } : {}),
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message ?? `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let failed = null;
    let cited = [];
    const FRAME_END = String.fromCharCode(10, 10);

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf(FRAME_END)) !== -1) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(frame);
        const da = /^data: (.+)$/m.exec(frame);
        if (!ev || !da) continue;
        const payload = JSON.parse(da[1]);
        if (ev[1] === 'chat') {
          // The id arrives before any token, so a new conversation is
          // navigable the moment it exists rather than once it finishes.
          chatId = payload.id;
          refreshChatHistory();
        } else if (ev[1] === 'queued') {
          note.textContent = `Waiting for the GPU — ${payload.position} ahead of you`;
        } else if (ev[1] === 'searching') {
          // Named, with the query, because "Searching…" on its own leaves
          // people wondering what it decided to look up.
          note.textContent = `Searching the web for "${payload.query}"…`;
        } else if (ev[1] === 'searched') {
          cited = payload.results ?? [];
          note.textContent = '';
          // The line goes above the answer it fed, which means inserting it
          // before the bubble that is already streaming into place.
          thread.insertBefore(
            searchedEl({ query: payload.query, results: cited.length, detail: payload.detail }),
            answer
          );
          chatScrollToEnd();
        } else if (ev[1] === 'status') {
          // render_* are the Render button's own phases, passed through.
          const RENDER = {
            rendering: `Rendering with ${payload.model}…`,
            render_starting: 'Starting ComfyUI — it sleeps when nobody renders…',
            render_freeing_llm: 'Unloading the LLM to make room on the card…',
            render_waiting: 'Queued in ComfyUI…',
            render_loading: `Loading ${payload.model}…`,
            render_saving: 'Saving the picture…',
            // edit_picture's phases, the Edit tab's own.
            editing: 'Editing the picture…',
            edit_writing: 'Looking at the picture and writing the instruction…',
            edit_starting: 'Starting ComfyUI — it sleeps when nobody renders…',
            edit_freeing_llm: 'Unloading the LLM to make room on the card…',
            edit_waiting: 'Queued in ComfyUI…',
            edit_loading: 'Loading the editor…',
            edit_saving: 'Saving the picture…',
          };
          note.textContent = payload.state === 'model_loading' ? 'Loading the model…'
            : payload.state === 'writing_prompt' ? `Writing the ${payload.model} prompt…`
            : RENDER[payload.state] ?? '';
        } else if (ev[1] === 'render_node') {
          note.textContent = `Rendering — ${payload.name}…`;
        } else if (ev[1] === 'render_progress') {
          note.textContent = `Rendering — ${payload.node ? `${payload.node}, ` : ''}step ${payload.value} of ${payload.max}`;
        } else if (ev[1] === 'render') {
          // Under the reply, which is still streaming its text into place.
          answer.appendChild(chatRenderEl(payload, { model: payload.model, brief: payload.brief, segments: payload.segments }));
          chatScrollToEnd();
        } else if (ev[1] === 'edit') {
          answer.appendChild(chatEditEl(payload));
          chatScrollToEnd();
        } else if (ev[1] === 'token') {
          body.textContent += payload.text;
          chatScrollToEnd();
        } else if (ev[1] === 'error') {
          failed = payload;
        }
      }
    }

    if (failed) {
      answer.classList.remove('streaming');
      answer.classList.add('failed');
      // Whatever streamed is kept, with the failure named under it — the same
      // contract prompt generation has.
      body.textContent = (failed.partial || body.textContent || '').trimEnd();
      note.textContent = failed.verbatim || failed.message || 'The answer failed.';
    } else {
      answer.classList.remove('streaming');
      note.textContent = '';
      // Once, at the end. A marker can arrive split across two chunks, and
      // rewriting mid-stream would make the text jump under the reader.
      if (cited.length) applyCitations(body, body.textContent, cited);
    }
  } catch (err) {
    answer.classList.remove('streaming');
    answer.classList.add('failed');
    note.textContent = err.message;
  } finally {
    chatSending = false;
    $('#chat-send').disabled = false;
    refreshChatHistory();
    input.focus();
  }
}

// ── which model answers ──────────────────────────────────────
//
// The spec puts a model selector in Tab 5's top bar, "over whatever is
// installed, grouped by loaded vs. available". Everything here derives from
// /api/status: the installed list from the backend's own /models, what is
// resident from Ollama's /api/ps, and the sizes from /api/tags. Nothing is
// written down in the frontend, so a model pulled after this shipped appears
// without a code change — the same rule the model registry follows in Tab 1.

// The open conversation's model. Null means "whatever the server is
// configured for", which is what a fresh page shows until the first poll
// names it.
let chatModel = null;
let CHAT_MODEL_GROUPS = null;
// What the selector was last built from. Rebuilding a <select> every ten
// seconds would close it under anyone who had it open, so the options are
// only replaced when the set actually changes.
let chatModelSignature = '';

/**
 * The installed models, split by whether they are in VRAM right now.
 *
 * Three sources have to be reconciled and only one of them is guaranteed:
 * `installed` comes from the OpenAI-compatible /models surface every backend
 * has, while `resident` and `catalog` are Ollama-only. On any other backend
 * this degrades to a flat list of names with no sizes, which is correct —
 * those load one model at start and there is nothing to group.
 */
// The vision marker. An <option> cannot hold markup, so this is text - which
// is also why it carries the word and not only the glyph: an emoji alone is
// unreadable to a screen reader and ambiguous at a glance.
const VISION_MARK = '\u{1F441} vision';

export function chatModelGroups(llm) {
  const catalog = new Map((llm?.catalog ?? []).map((e) => [e.model, e]));
  const resident = new Set((llm?.resident ?? []).map((e) => e.model));
  const names = (llm?.installed ?? []).length
    ? llm.installed
    : (llm?.catalog ?? []).map((e) => e.model);
  const rows = names.map((model) => ({
    model,
    size_bytes: catalog.get(model)?.size_bytes ?? null,
    loaded: resident.has(model),
    // null, not false, when the backend could not say - see capabilitiesFor
    // in server/llm.mjs. "Unknown" and "cannot see" are different claims and
    // only one of them earns a badge.
    vision: catalog.get(model)?.vision ?? null,
  }));
  return {
    configured: llm?.model ?? null,
    loaded: rows.filter((r) => r.loaded),
    available: rows.filter((r) => !r.loaded),
  };
}

/**
 * What the current choice costs, said before the click rather than after.
 *
 * The spec's line is "selecting an unloaded model triggers a load, with the
 * VRAM cost shown before the swap". On this box that swap is real — the 27B
 * and the 8B cannot both sit on the card — so the note names what may be
 * dropped rather than only what will be loaded.
 *
 * It deliberately does not promise an unload. Ollama holds as many models as
 * fit, so whether anything is evicted depends on sizes this page cannot add
 * up honestly. "May have to drop" is the true statement.
 */
export function chatModelNote(chosen, groups) {
  const name = chosen || groups?.configured || null;
  if (!name) return { text: '', warm: false };
  const rows = [...(groups?.loaded ?? []), ...(groups?.available ?? [])];
  const row = rows.find((r) => r.model === name);
  if (!row) {
    // A conversation started on a model that has since been removed, or a page
    // left open across a pull. Either way the next message would fail, and
    // saying so here is cheaper than finding out at send time.
    return { text: `${name} is not installed — pick another before sending.`, warm: true };
  }
  if (row.loaded) return { text: 'Loaded and answering now.', warm: false };
  const size = gb(row.size_bytes);
  const holding = (groups?.loaded ?? []).map((r) => r.model);
  return {
    text:
      `Not loaded — the first message waits for it${size ? ` (${size})` : ''}` +
      `${holding.length ? `, and the card may have to drop ${holding.join(', ')}` : ''}.`,
    warm: true,
  };
}

function renderChatModels(llm) {
  const sel = $('#chat-model');
  if (!sel) return;
  const groups = chatModelGroups(llm);
  CHAT_MODEL_GROUPS = groups;

  // Default to what the server is configured for until someone chooses. Named
  // explicitly rather than left blank: "which model am I talking to" is the
  // question this control exists to answer, and "Default" does not answer it.
  if (!chatModel) chatModel = groups.configured;

  const rows = [...groups.loaded, ...groups.available];
  // A model that is gone — removed, or renamed by a pull — stays in the list
  // rather than silently reverting the selection, which would look like the
  // conversation had switched models on its own.
  const missing = chatModel && !rows.some((r) => r.model === chatModel) ? chatModel : null;

  const signature = [
    groups.configured,
    missing,
    groups.loaded.map((r) => `L${r.model}`).join(','),
    groups.available.map((r) => `A${r.model}:${r.size_bytes ?? ''}`).join(','),
    // Capabilities arrive on a later poll than the names do - the first
    // /api/tags answer has no /api/show behind it yet - so the signature has
    // to include them or the badge never appears without a reload.
    [...groups.loaded, ...groups.available].map((r) => (r.vision ? 'v' : '-')).join(''),
  ].join('|');

  if (signature !== chatModelSignature) {
    chatModelSignature = signature;
    sel.replaceChildren();

    const label = (r) =>
      [r.model, gb(r.size_bytes), r.vision ? VISION_MARK : null,
       r.model === groups.configured ? 'default' : null]
        .filter(Boolean)
        .join(' · ');

    const group = (name, list) => {
      if (!list.length) return;
      const g = document.createElement('optgroup');
      g.label = name;
      for (const r of list) {
        const opt = document.createElement('option');
        opt.value = r.model;
        opt.textContent = label(r);
        g.appendChild(opt);
      }
      sel.appendChild(g);
    };

    group('In VRAM', groups.loaded);
    group('Installed', groups.available);

    if (missing) {
      const opt = document.createElement('option');
      opt.value = missing;
      opt.textContent = `${missing} — not installed`;
      sel.appendChild(opt);
    }
    if (!rows.length && !missing) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No model available';
      sel.appendChild(opt);
      sel.disabled = true;
    } else {
      sel.disabled = false;
    }
  }

  if (chatModel) sel.value = chatModel;
  paintChatModelNote();
}

function paintChatModelNote() {
  const note = $('#chat-model-note');
  if (!note) return;
  const { text, warm } = chatModelNote(chatModel, CHAT_MODEL_GROUPS);
  note.textContent = text;
  note.classList.toggle('warm', Boolean(warm));
}

// ── request a model ──────────────────────────────────────────
//
// Anyone can ask, only the owner decides, and the decision is enforced on
// /api/admin/requests rather than by hiding this button. Approving records
// the decision and prints the pull command — it does not start a download.

/**
 * One person's own requests, as they read them back.
 *
 * A form that never says what happened to anything is a suggestion box nobody
 * uses twice, so the answer — including a denial — is shown in the same place
 * the request was made.
 */
function myRequestRow(r) {
  const when = r.created_at ? new Date(r.created_at).toLocaleDateString() : '';
  const decided =
    r.status === 'pending'
      ? 'waiting on the owner'
      : `${r.status} by ${r.decided_by ?? 'the owner'}${
          r.decided_at ? ` on ${new Date(r.decided_at).toLocaleDateString()}` : ''
        }`;
  return `
    <div class="account-row ${r.status === 'pending' ? 'pending' : ''}">
      <div class="account-head">
        <span class="account-handle">${escHtml(r.tag)}</span>
        <span class="account-status ${escHtml(r.status)}">${escHtml(r.status)}</span>
      </div>
      <div class="account-meta">Asked ${escHtml(when)} · ${escHtml(decided)}</div>
      ${r.note ? `<div class="account-referral">${escHtml(r.note)}</div>` : ''}
    </div>`;
}

async function refreshMyRequests() {
  const host = $('#req-mine');
  if (!host) return;
  try {
    const res = await rawFetch('/api/model-requests');
    if (!res.ok) {
      host.innerHTML = `<p class="field-note">Could not load your requests (${res.status}).</p>`;
      return;
    }
    const { requests } = await res.json();
    host.innerHTML = requests.length
      ? requests.map(myRequestRow).join('')
      : '<p class="field-note">Nothing asked for yet.</p>';
  } catch (err) {
    host.innerHTML = `<p class="field-note">Could not reach the server — ${escHtml(err.message)}</p>`;
  }
}

function initModelRequests() {
  const modal = $('#model-request-modal');
  const form = $('#model-request-form');
  if (!modal || !form) return;

  const close = () => {
    modal.hidden = true;
    $('#req-message').hidden = true;
  };

  $('#chat-request-open')?.addEventListener('click', () => {
    modal.hidden = false;
    $('#req-message').hidden = true;
    // Says what is already here, so the owner's attention is not spent on a
    // model five people already have.
    const installed = [
      ...(CHAT_MODEL_GROUPS?.loaded ?? []),
      ...(CHAT_MODEL_GROUPS?.available ?? []),
    ].map((r) => r.model);
    const note = $('#req-tag-note');
    if (note) {
      note.textContent = installed.length
        ? `The tag the backend would pull, if you know it. No spaces. Already here: ${installed.join(', ')}.`
        : 'The tag the backend would pull, if you know it. No spaces.';
    }
    refreshMyRequests();
    $('#req-tag').focus();
  });

  $('#model-request-close')?.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) close();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#req-submit');
    const out = $('#req-message');
    const show = (text, ok = false) => {
      out.hidden = false;
      out.textContent = text;
      out.classList.toggle('ok', ok);
    };
    btn.disabled = true;
    try {
      const res = await rawFetch('/api/model-requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tag: $('#req-tag').value,
          url: $('#req-url').value,
          reason: $('#req-reason').value,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return show(data.message ?? `Something went wrong (${res.status}).`);
      form.reset();
      show('Sent — the owner sees it in the accounts panel.', true);
      toast('Request sent');
      refreshMyRequests();
    } catch (err) {
      show(`Could not reach the server — ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  });
}

// ── which LLM writes the prompt (Tab 1 toolbar) ──────────────
//
// The same `prompt_llm` preference the account panel offers, surfaced where
// the work happens. Not a second setting: changing it here saves immediately
// and both surfaces read the same value, because two controls over one
// preference that disagree is worse than one control in the wrong place.
//
// Distinct from the selector beside it, which chooses what the prompt is
// written FOR. This chooses what writes it. The label and the gap carry that
// difference; nothing else would.

/**
 * The note under the control, and whether the control applies at all.
 *
 * A target that declares `llm_model` in the registry pins its own LLM on
 * measured grounds — h3 fails its base-mode discipline eight times in ten on
 * the 8B — so a personal preference must not quietly override it. Disabled and
 * said out loud, rather than silently ignored, which is the same rule the
 * account panel follows.
 */
export function promptLlmState(modelEntry, chosen, configured) {
  if (modelEntry?.llm_model) {
    return {
      value: modelEntry.llm_model,
      disabled: true,
      note: `${modelEntry.label} always uses ${modelEntry.llm_model} — set in the registry, and measured.`,
    };
  }
  // A soft default (h3): the selector is unlocked and seeded with the default,
  // with a note that says picking something else is allowed but measured to be
  // worse. Only shown until the user makes their own choice.
  if (!chosen && modelEntry?.default_llm_model) {
    return {
      value: modelEntry.default_llm_model,
      disabled: false,
      note: `${modelEntry.label} defaults to ${modelEntry.default_llm_model} — measured. Other models may not hold its format; pick at your own risk.`,
    };
  }
  return {
    value: chosen ?? '',
    disabled: false,
    // Silent when the choice is simply in effect. A note restating the
    // dropdown back at the reader is noise on every single render.
    note: '',
  };
}

let promptLlmSignature = '';
// The last llm block from the status poll. Held because switching target model
// has to repaint this control immediately — h3 pins its own LLM and the
// control must disable the moment you land on it, not up to ten seconds later
// when the next poll happens to arrive.
let LAST_LLM_STATUS = null;

function renderPromptLlm(llm = LAST_LLM_STATUS) {
  if (llm) LAST_LLM_STATUS = llm;
  const sel = $('#prompt-llm-select');
  const note = $('#prompt-llm-note');
  if (!sel) return;

  const groups = chatModelGroups(llm);
  const rows = [...groups.loaded, ...groups.available];
  const chosen = PREFS?.prompt_llm ?? '';
  // A saved choice for a model since removed stays visible rather than
  // silently reverting to the default, or the setting looks like it never
  // saved. Same rule as the account panel.
  const missing = chosen && !rows.some((r) => r.model === chosen) ? chosen : null;

  const signature = [groups.configured, missing, rows.map((r) => r.model).join(','),
                     rows.map((r) => (r.vision ? 'v' : '-')).join('')].join('|');
  if (signature !== promptLlmSignature) {
    promptLlmSignature = signature;
    sel.replaceChildren();

    // Empty value means "no opinion" and is what the preference stores by
    // default — one place decides what the default is, and it is the server.
    //
    // It carries the same badges as every other row. The configured model is
    // collapsed into THIS entry and skipped by the loop below, so anything
    // said only down there is said about every model except the one most
    // people are actually using — reported 8 Sep 2026 as "all but unsloth has
    // an eye", on the day the eyes came back and unsloth was the default.
    const asDefault = document.createElement('option');
    asDefault.value = '';
    // The badge only, not `in VRAM`. Whether a model can see is fixed for the
    // life of the process and is already in the signature above; whether it is
    // resident changes on every swap and is not, so putting it here would show
    // a value that only refreshes when something else happens to change.
    const configuredRow = rows.find((r) => r.model === groups.configured);
    asDefault.textContent = groups.configured
      ? [`Default — ${groups.configured}`, configuredRow?.vision ? VISION_MARK : null]
          .filter(Boolean)
          .join(' · ')
      : 'Default';
    sel.appendChild(asDefault);

    for (const r of rows) {
      if (r.model === groups.configured) continue;   // already the default entry
      const opt = document.createElement('option');
      opt.value = r.model;
      opt.textContent = [r.model, r.loaded ? 'in VRAM' : null, r.vision ? VISION_MARK : null]
        .filter(Boolean)
        .join(' · ');
      sel.appendChild(opt);
    }
    if (missing) {
      const opt = document.createElement('option');
      opt.value = missing;
      opt.textContent = `${missing} — not installed`;
      sel.appendChild(opt);
    }
  }

  const state = promptLlmState(currentModel, chosen, groups.configured);
  // A pinned model may not be in the list at all — it is a registry value, not
  // necessarily something this backend has pulled — so give it a row rather
  // than letting the select fall back to its first option and lie.
  if (state.disabled && ![...sel.options].some((o) => o.value === state.value)) {
    const opt = document.createElement('option');
    opt.value = state.value;
    opt.textContent = state.value;
    sel.appendChild(opt);
    promptLlmSignature = '';   // rebuild on the next poll, once the target changes
  }
  sel.value = state.value;
  sel.disabled = state.disabled;
  if (note) note.textContent = state.note;
}

function initPromptLlm() {
  const sel = $('#prompt-llm-select');
  if (!sel) return;
  sel.addEventListener('change', async () => {
    const wanted = sel.value;
    try {
      const res = await rawFetch('/api/account', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Preferences merge server-side, so sending this one alone cannot
        // clear the others.
        body: JSON.stringify({ preferences: { prompt_llm: wanted } }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data.message ?? 'Could not save that choice');
        return;
      }
      PREFS = data.preferences ?? PREFS;
      // The server drops a model it cannot see rather than storing something
      // that would fail at generate time. Say so rather than leaving the
      // dropdown showing a choice that did not take.
      if ((PREFS.prompt_llm ?? '') !== wanted) {
        sel.value = PREFS.prompt_llm ?? '';
        toast('That model is not installed — left unchanged');
        return;
      }
      toast(wanted ? `Prompts written by ${wanted}` : 'Prompts written by the default model');
    } catch (err) {
      toast(`Could not reach the server — ${err.message}`);
    }
  });
}

function initChat() {
  const input = $('#chat-input');
  const form = $('#chat-compose');
  if (!input || !form) return;

  // Grows with the text, capped in CSS. Reset to auto first, or a deletion
  // never shrinks it back.
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  });

  // Enter sends, Shift+Enter is a newline. The placeholder says so, because
  // guessing wrong costs a half-written message.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    sendChat();
  });

  $('#chat-new')?.addEventListener('click', startNewChat);

  // The choice is sticky across conversations on purpose: someone who has
  // switched to an uncensored model for a reason should not be put back on the
  // default by pressing New chat.
  $('#chat-model')?.addEventListener('change', (e) => {
    chatModel = e.target.value || null;
    paintChatModelNote();
    input.focus();
  });

  initModelRequests();

  // The sidebar's right-click menu closes on any click elsewhere, Escape,
  // or the window losing focus or changing size.
  document.addEventListener('click', closeChatMenu);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeChatMenu(); });
  window.addEventListener('blur', closeChatMenu);
  window.addEventListener('resize', closeChatMenu);

  // Pictures for the next message: the button, or a paste into the box.
  const pictureFile = $('#chat-picture-file');
  $('#chat-picture')?.addEventListener('click', () => pictureFile?.click());
  pictureFile?.addEventListener('change', () => {
    addChatPictures([...pictureFile.files]);
    pictureFile.value = '';
  });
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    addChatPictures(files);
  });

  // Search on or off for the next message, and it stays where you put it.
  $('#chat-search')?.addEventListener('click', (e) => {
    chatSearchOn = !chatSearchOn;
    e.currentTarget.setAttribute('aria-pressed', String(chatSearchOn));
    e.currentTarget.title = chatSearchOn
      ? 'Web search is on — messages are searched before they are answered. Click to turn off.'
      : 'Search the web before answering';
    input.focus();
  });

  // The rules. Same modal pattern as the account and accounts panels, so it
  // closes the same three ways people already know.
  const info = $('#chat-info-modal');
  $('#chat-info')?.addEventListener('click', () => {
    if (info) info.hidden = false;
  });
  $('#chat-info-close')?.addEventListener('click', () => {
    if (info) info.hidden = true;
  });
  info?.addEventListener('click', (e) => {
    // Clicking the dimmed area outside the card closes it; clicking inside
    // does not, or selecting text would dismiss it.
    if (e.target === info) info.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && info && !info.hidden) info.hidden = true;
  });

  renderChatEmpty();
  refreshChatHistory();
}

// ── output panel ─────────────────────────────────────────────
function clearOutput(message) {
  $('#output-mount').innerHTML = `
    <div class="empty-state">
      <strong>${message ?? 'No prompt yet'}</strong>
      Write a brief on the left and press generate.<br>
      Output appears here in the format this model expects.
    </div>`;
  lastResult = null;
  story = null;
  // The picture goes with the prompt it was made from.
  clearRenderResult();
  updateActionButtons();
}

function updateActionButtons() {
  const has = Boolean(lastResult?.segments?.length);
  for (const id of ['#btn-copy-all', '#btn-save', '#btn-download', '#btn-clear', '#btn-refine', '#refine-input']) {
    const el = $(id);
    if (el) el.disabled = !has;
  }
  $('#btn-undo').disabled = history.length === 0;
  // Needs both a result to revise and a server that can revise it. Hidden
  // rather than disabled when the instruction file is missing: a permanently
  // dead button invites clicking, where an absent one asks no questions.
  const second = $('#btn-second-pass');
  if (second) {
    second.hidden = !SECOND_PASS_AVAILABLE;
    second.disabled = !lastResult?.segments?.length;
  }
  paintStory();
  // Render is disabled until a prompt exists, same as the buttons above.
  paintRender();
}

/**
 * The story arrows and the Continue button. Also where a Refine, Second pass
 * or Undo on a part lands in the story: all three replace lastResult and then
 * call updateActionButtons, so this is the one place that sees every change.
 */
function paintStory() {
  if (story && lastResult && story.parts[story.at] !== lastResult) story.parts[story.at] = lastResult;
  const many = Boolean(story && story.parts.length > 1);
  $('#story-nav').hidden = !many;
  if (many) {
    $('#story-part').textContent = `Part ${story.at + 1} of ${story.parts.length}`;
    $('#btn-part-prev').disabled = story.at === 0;
    $('#btn-part-next').disabled = story.at === story.parts.length - 1;
  }
  // A story is a video's. Continued from its last part only: continuing from
  // the middle would have to throw the later parts away or fork them.
  const cont = $('#btn-continue');
  cont.hidden = currentModel?.type !== 'video';
  cont.disabled = !lastResult?.segments?.length || Boolean(story && story.at !== story.parts.length - 1);
}

/** Put a result on screen, the same way every replacement of the output does. */
function showResult(result) {
  const mount = $('#output-mount');
  mount.innerHTML = '';
  for (const seg of shownSegments(result, currentModel, promptStyle)) {
    mount.appendChild(segmentEl(currentModel, seg));
  }
  if (result.referenceRead) mount.prepend(referenceReadEl(result.referenceRead));
  stampElapsed(mount, result.ms);
}

// ── shared notes on the installed LLMs ───────────────────────
//
// A board, one section per installed model, so the five of them can tell each
// other what a model turned out to be good at. Asked for on 25 Aug 2026
// alongside the vision badge, and it sits next to it for a reason: which
// model to reach for is partly a capability question the box can answer, and
// partly a taste question only the people using it can.
//
// Sections come from the installed list, not from the notes file, so a model
// nobody has written about still offers a box to write in - and a note about
// a model since removed stops being listed without being deleted.
let LLM_NOTES = {};

async function refreshLlmNotes() {
  try {
    const data = await fetch('/api/llm-notes', { headers: USER_HEADER }).then((r) => r.json());
    LLM_NOTES = data.notes ?? {};
  } catch {
    LLM_NOTES = {};
  }
  renderLlmNotes();
}

function renderLlmNotes() {
  const host = $('#llm-notes-list');
  if (!host) return;

  const groups = chatModelGroups(LAST_LLM_STATUS);
  const rows = [...(groups.loaded ?? []), ...(groups.available ?? [])];

  if (!rows.length) {
    host.innerHTML =
      '<div class="empty-state"><strong>No models to write about</strong>' +
      'This backend does not list what it has installed.</div>';
    return;
  }

  host.replaceChildren();
  for (const row of rows) {
    const section = document.createElement('div');
    section.className = 'notes-model';

    const head = document.createElement('div');
    head.className = 'notes-model-head';
    const name = document.createElement('span');
    name.className = 'notes-model-name';
    name.textContent = row.model;
    head.appendChild(name);
    // The same capability the selector badges, repeated here because this is
    // where someone decides which model to use.
    if (row.vision) {
      const badge = document.createElement('span');
      badge.className = 'notes-vision';
      badge.textContent = VISION_MARK;
      head.appendChild(badge);
    }
    section.appendChild(head);

    const list = document.createElement('div');
    list.className = 'notes-entries';
    const entries = LLM_NOTES[row.model] ?? [];
    if (!entries.length) {
      const none = document.createElement('p');
      none.className = 'notes-empty';
      none.textContent = 'No notes yet.';
      list.appendChild(none);
    }
    for (const e of entries) {
      const item = document.createElement('div');
      item.className = 'notes-entry';

      // Author and text are typed by people and round-trip through disk, so
      // both are text nodes - same rule as the library titles and the tag
      // list.
      const body = document.createElement('p');
      body.className = 'notes-text';
      body.textContent = e.text;

      const meta = document.createElement('span');
      meta.className = 'notes-meta';
      meta.textContent = `${e.author} · ${new Date(e.at).toLocaleDateString()}${e.edited_at ? ' · edited' : ''}`;

      // Edit in place, 11 Sep 2026 (a user). Offered on every note, like
      // Delete: the server decides whose it is and a 403 says so.
      const edit = document.createElement('button');
      edit.className = 'ghost notes-del';
      edit.textContent = 'Edit';
      edit.addEventListener('click', () => {
        const box = document.createElement('textarea');
        box.className = 'notes-edit';
        box.maxLength = 600;
        box.rows = 3;
        box.value = e.text;
        const cancel = document.createElement('button');
        cancel.className = 'ghost';
        cancel.textContent = 'Cancel';
        const save = document.createElement('button');
        save.className = 'ghost';
        save.textContent = 'Save';
        const bar = document.createElement('div');
        bar.className = 'notes-foot notes-edit-bar';
        bar.append(cancel, save);

        cancel.addEventListener('click', () => renderLlmNotes());
        const commit = async () => {
          const text = box.value.trim();
          if (!text) { toast('A note cannot be empty. Use Delete to remove it.'); return; }
          if (text === e.text) { renderLlmNotes(); return; }
          save.disabled = true;
          const r = await fetch(
            `/api/llm-notes/${encodeURIComponent(e.id)}?model=${encodeURIComponent(row.model)}`,
            {
              method: 'PATCH',
              headers: { 'content-type': 'application/json', ...USER_HEADER },
              body: JSON.stringify({ text }),
            }
          );
          if (r.ok) { await refreshLlmNotes(); return; }
          const err = await r.json().catch(() => ({}));
          toast(err.message ?? 'Could not save that note');
          save.disabled = false;
        };
        save.addEventListener('click', commit);
        box.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) commit();
          if (ev.key === 'Escape') { ev.stopPropagation(); renderLlmNotes(); }
        });

        item.replaceChildren(box, bar);
        box.focus();
      });

      const del = document.createElement('button');
      del.className = 'ghost notes-del';
      del.textContent = 'Delete';
      del.addEventListener('click', async () => {
        del.disabled = true;
        const r = await fetch(
          `/api/llm-notes/${encodeURIComponent(e.id)}?model=${encodeURIComponent(row.model)}`,
          { method: 'DELETE', headers: USER_HEADER }
        );
        if (r.ok) { await refreshLlmNotes(); return; }
        // 403 is the interesting one: the server, not this panel, decides
        // whose note this is.
        const err = await r.json().catch(() => ({}));
        toast(err.message ?? 'Could not delete that note');
        del.disabled = false;
      });

      const foot = document.createElement('div');
      foot.className = 'notes-foot';
      const actions = document.createElement('span');
      actions.className = 'notes-actions';
      actions.append(edit, del);
      foot.append(meta, actions);
      item.append(body, foot);
      list.appendChild(item);
    }
    section.appendChild(list);

    const form = document.createElement('div');
    form.className = 'notes-add';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = `What is ${row.model} good at?`;
    input.maxLength = 600;
    const add = document.createElement('button');
    add.className = 'ghost';
    add.textContent = 'Add';

    const submit = async () => {
      const text = input.value.trim();
      if (!text) return;
      add.disabled = true;
      try {
        const r = await fetch('/api/llm-notes', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...USER_HEADER },
          body: JSON.stringify({ model: row.model, text }),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          toast(err.message ?? 'Could not save that note');
          return;
        }
        input.value = '';
        await refreshLlmNotes();
      } finally {
        add.disabled = false;
      }
    };
    add.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

    form.append(input, add);
    section.appendChild(form);
    host.appendChild(section);
  }
}

function wireLlmNotes() {
  const modal = $('#llm-notes-modal');
  if (!modal) return;
  const open = () => { modal.hidden = false; refreshLlmNotes(); };
  const close = () => { modal.hidden = true; };
  $('#btn-llm-notes-1')?.addEventListener('click', open);
  $('#btn-llm-notes-2')?.addEventListener('click', open);
  $('#llm-notes-close')?.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) close();
  });
}

// ── session prompt history ───────────────────────────────────
//
// Every prompt generated since this tab opened, newest first. Asked for on
// 25 Aug 2026 as something that "deletes when the user logs off or closes
// out the app", which is the exact contract sessionStorage already has:
// it survives a refresh, it dies with the tab, and it is per-origin per-tab
// rather than shared.
//
// Deliberately NOT the server-side library. That one is the "keep this"
// path - it lives on disk under an account and is meant to outlast the
// session. This is the scratch list, and it never touches disk at all,
// which is what makes it safe on a box five people share: nothing to leak
// between users, nothing to clean up, no per-user directory to get wrong.
const SESSION_HISTORY_KEY = 'promptforge:session-history';
const SESSION_HISTORY_MAX = 30;

/** Read the list. Storage can throw - quota, or a browser with it disabled - */
/** and a broken history must never take the app down with it. */
function readSessionHistory() {
  try {
    const raw = sessionStorage.getItem(SESSION_HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSessionHistory(entries) {
  try {
    sessionStorage.setItem(SESSION_HISTORY_KEY, JSON.stringify(entries));
  } catch {
    // Full, or disabled. The in-memory render already happened; losing the
    // persistence across a refresh is not worth an error the person cannot
    // act on.
  }
}

function clearSessionHistory() {
  try { sessionStorage.removeItem(SESSION_HISTORY_KEY); } catch { /* nothing to do */ }
  // Renders live on the server for a day; clearing the history they belong
  // to deletes them now (agreed 3 Oct 2026).
  if (CAN_RENDER) fetch('/api/render', { method: 'DELETE', headers: USER_HEADER }).catch(() => {});
  renderSessionHistory();
}

/**
 * Record one finished generation. Called from the `done` handler, so what
 * lands here is the CLEANED payload rather than the raw stream - same reason
 * the panel repaints from `done`.
 */
function recordSessionPrompt({ model, brief, segments, simple = null }) {
  if (!Array.isArray(segments) || !segments.length) return null;
  const entries = readSessionHistory();
  const id = `s${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
  entries.unshift({
    id,
    model,
    brief: String(brief ?? ''),
    segments,
    simple,
    at: Date.now(),
  });
  writeSessionHistory(entries.slice(0, SESSION_HISTORY_MAX));
  renderSessionHistory();
  // Returned so a render of this prompt can join the same entry.
  return id;
}

/** First line of the brief, trimmed - enough to recognise a prompt by. */
function sessionTitle(brief) {
  const line = String(brief ?? '').split('\n').find((l) => l.trim()) ?? '';
  const clean = line.trim();
  if (!clean) return 'Untitled prompt';
  return clean.length > 52 ? `${clean.slice(0, 52)}…` : clean;
}

function renderSessionHistory() {
  const host = $('#session-list');
  if (!host) return;
  const entries = readSessionHistory();
  const clear = $('#btn-session-clear');
  if (clear) clear.hidden = entries.length === 0;

  if (!entries.length) {
    host.innerHTML =
      '<div class="empty-state"><strong>Nothing yet this session</strong>' +
      'Prompts you generate appear here until you close the tab.</div>';
    return;
  }

  host.innerHTML = '';
  for (const e of entries) {
    const row = document.createElement('div');
    row.className = 'lib-row';

    const meta = document.createElement('div');
    meta.className = 'lib-meta';
    const model = REGISTRY.models.find((m) => m.key === e.model);

    // The brief is typed by the person and round-trips through storage, so
    // it is built as a text node for the same reason the library titles are.
    const title = document.createElement('span');
    title.className = 'lib-title';
    title.textContent = sessionTitle(e.brief);
    const sub = document.createElement('span');
    sub.className = 'lib-sub';
    sub.textContent = `${model?.label ?? e.model} · ${new Date(e.at).toLocaleTimeString()}`;
    meta.append(title, sub);

    const actions = document.createElement('div');
    actions.className = 'lib-actions';
    const load = document.createElement('button');
    load.className = 'ghost';
    load.textContent = 'Load';
    // Same loader as the library: it switches to the entry's model first, so
    // the template and controls are the ones the prompt was written against.
    load.addEventListener('click', () => loadLibraryEntry({
      model: e.model,
      brief: e.brief,
      segments: e.segments,
      title: sessionTitle(e.brief),
      sessionId: e.id,
      render: e.render ?? null,
    }));
    actions.append(load);

    // The picture sits with its prompt. A thumbnail, because sessionStorage
    // cannot hold the PNG; it opens the full one while the server keeps it.
    if (e.render?.thumb) {
      const link = document.createElement('a');
      link.href = e.render.url;
      link.target = '_blank';
      link.rel = 'noopener';
      const img = document.createElement('img');
      img.className = 'render-thumb';
      img.src = e.render.thumb;
      img.alt = 'Render';
      link.append(img);
      row.append(link);
      meta.style.flex = '1';
    }
    row.append(meta, actions);
    host.appendChild(row);
  }
}

// ── render from PromptForge ──────────────────────────────────
//
// Stages 1-2 of docs/render-plan.md: the finished prompt goes to ComfyUI on
// the server through the model's own workflow and the picture comes back here.
// Everything — whether a model can render, its presets, the sampler lists,
// the sizes, the model files, LoRAs and their triggers — comes from
// GET /api/render/options. Nothing here names a model.

let renderOptions = null;   // GET /api/render/options for currentModel, or null
let renderSettings = null;  // what the next render sends, per model
let renderAbort = null;     // the running render's AbortController
let lastRender = null;      // { id, url, model, settings, ms }
// Bumped on every model switch, so options that arrive for a model the person
// has already left are thrown away rather than painted under the wrong name.
let renderEpoch = 0;

// Workflows other people uploaded that wait for the owner (from the status
// poll; always 0 for anyone else). Shown on the two buttons that lead to the
// approval list, and announced once when a new one arrives.
let renderPending = 0;
function setRenderPending(n) {
  const count = Number(n) || 0;
  if (count > renderPending && IS_OWNER) {
    toast(`${count} uploaded workflow${count === 1 ? '' : 's'} waiting for you in Render models`);
  }
  renderPending = count;
  const tag = count ? ` · ${count} waiting` : '';
  const settings = $('#btn-render-settings');
  if (settings) settings.textContent = `⚙ Settings${tag}`;
  const manage = $('#btn-render-manage');
  if (manage) manage.textContent = count ? `Manage models… (${count} waiting)` : 'Manage models…';
}

// Settings are kept per model AND per workflow (stage 3): two workflows for
// one model rarely want the same steps. The starter keeps the old key, so
// what people saved before stage 3 is still there.
const RENDER_SETTINGS_KEY = (model, workflow) =>
  workflow ? `promptforge:render:${model}:${workflow}` : `promptforge:render:${model}`;
// Which workflow was picked last, per model.
const RENDER_WORKFLOW_KEY = (model) => `promptforge:render-workflow:${model}`;
const RENDER_FIELDS = ['steps', 'cfg', 'sampler', 'scheduler', 'model_file'];

function readRenderPrefs(model, workflow) {
  try {
    return JSON.parse(localStorage.getItem(RENDER_SETTINGS_KEY(model, workflow)) ?? 'null');
  } catch {
    return null;
  }
}

function saveRenderPrefs() {
  if (!renderOptions || !renderSettings) return;
  const { aspect, ...kept } = renderSettings; // aspect follows the builder
  try {
    localStorage.setItem(RENDER_SETTINGS_KEY(renderOptions.model, renderOptions.workflow_id), JSON.stringify(kept));
  } catch {
    /* a private window; the settings still apply until reload */
  }
}

function rememberWorkflow(model, id) {
  try {
    if (id) localStorage.setItem(RENDER_WORKFLOW_KEY(model), id);
    else localStorage.removeItem(RENDER_WORKFLOW_KEY(model));
  } catch {
    /* per-tab only, then */
  }
}

function pickedWorkflow(model) {
  try {
    return localStorage.getItem(RENDER_WORKFLOW_KEY(model)) || null;
  } catch {
    return null;
  }
}

/** The model's presets, then your own, as one list the selects index into. */
function allPresets() {
  return [
    ...(renderOptions?.presets ?? []),
    ...(renderOptions?.my_presets ?? []).map((p) => ({ ...p, mine: true, label: `Mine: ${p.name}` })),
  ];
}

/** The builder's own Aspect control, which the render size follows. */
function builderAspect() {
  return $('[data-bind="aspect_ratio"]')?.value ?? '';
}

/** Width × height for the current settings: the aspect at the chosen tier, or the workflow's size. */
function renderSize() {
  const o = renderOptions;
  const s = renderSettings;
  const size = o?.sizes?.[s?.aspect]?.[s?.tier];
  return size ?? { width: o?.defaults.width, height: o?.defaults.height };
}

const fitsCap = (size) => size && size.width * size.height <= renderOptions.caps.max_megapixels * 1e6;

/**
 * The text that goes to ComfyUI, from the CLEANED result (the done event),
 * never the stream. Positive = the first segment that is neither the
 * negative nor an explanation; the negative segment when the model wrote one.
 * The server assembles the rest (prefix, LoRA triggers, which negative).
 */
function renderTexts() {
  const segs = lastResult?.segments ?? [];
  const meta = new Set(currentModel?.meta_segments ?? []);
  const neg = segs.find((s) => /^negative prompt$/i.test(s.label));
  const pos = segs.find((s) => s !== neg && !meta.has(s.label) && String(s.body ?? '').trim());
  return {
    positive: String(pos?.body ?? '').trim(),
    negativeSegment: renderOptions?.has_negative ? String(neg?.body ?? '').trim() : '',
  };
}

/** The picked model file's own preset, or {}. */
function currentFilePreset() {
  const file = renderSettings?.model_file ?? renderOptions?.defaults.model_file;
  return renderOptions?.model_files?.find((f) => f.file === file) ?? {};
}

/** Trigger words of the LoRAs switched on, in row order. */
function activeTriggers() {
  return (renderSettings?.loras ?? [])
    .filter((l) => l.on && l.file)
    .flatMap((l) => renderOptions.loras?.find((x) => x.file === l.file)?.triggers ?? []);
}

/** Pick a model file and load its own preset — the most specific one wins. */
function applyFilePreset(file) {
  renderSettings.model_file = file;
  const p = renderOptions.model_files?.find((f) => f.file === file) ?? {};
  for (const k of ['steps', 'cfg', 'sampler', 'scheduler']) if (p[k] !== undefined) renderSettings[k] = p[k];
}

/** Index of the preset the settings match, or -1 for "Custom". */
function matchingPreset() {
  return allPresets().findIndex((p) =>
    RENDER_FIELDS.every((k) => p[k] === undefined || p[k] === renderSettings[k])
  );
}

function applyPreset(i) {
  const p = allPresets()[i];
  if (!p) return;
  // A preset naming a file loads that file's own settings first, then its own
  // values on top: a model preset is chosen on purpose, so it has the last word.
  if (p.model_file) applyFilePreset(p.model_file);
  for (const k of RENDER_FIELDS) if (p[k] !== undefined) renderSettings[k] = p[k];
}

function fillPresetSelect(sel) {
  if (!sel || !renderOptions) return;
  const at = matchingPreset();
  const list = allPresets();
  const names = list.map((p, i) => i);
  fillSelect(sel, at === -1 ? [...names, 'custom'] : names, at === -1 ? 'custom' : at, (v) =>
    v === 'custom' ? 'Custom' : list[v].label ?? list[v].name
  );
}

function renderSummaryText() {
  const s = renderSettings;
  const { width, height } = renderSize();
  return [
    renderOptions.workflow,
    s.model_file ? s.model_file.replace(/\.safetensors$/, '') : null,
    `${s.steps} steps`,
    `CFG ${s.cfg}`,
    `${s.sampler} / ${s.scheduler}`,
    `${width}×${height}`,
    s.seed_mode === 'random' ? 'seed random' : `seed ${s.seed}${s.seed_mode === 'increment' ? ' +1' : ''}`,
    (() => {
      const n = (s.loras ?? []).filter((l) => l.on && l.file).length;
      return n ? `${n} LoRA${n === 1 ? '' : 's'}` : null;
    })(),
  ].filter(Boolean).join(' · ');
}

/** Show LoRAs for every model, not just the ones that match. Per tab. */
let renderLoraAll = false;

/** The LoRA rows: on, file, strength, remove; triggers underneath. */
function paintLoraRows() {
  const o = renderOptions;
  const host = $('#render-loras');
  $('#render-loras-field').hidden = !o.loras;
  if (!o.loras) return;
  host.innerHTML = '';
  const rows = renderSettings.loras;
  if (!rows.length) {
    const none = document.createElement('div');
    none.className = 'field-note';
    const matching = o.loras.filter((l) => l.matches).length;
    none.textContent = o.loras.length
      ? `None added. ${matching} of ${o.loras.length} installed LoRA${o.loras.length === 1 ? '' : 's'} match this model.`
      : 'No LoRAs installed in ComfyUI.';
    host.append(none);
  }
  rows.forEach((row, i) => {
    const el = document.createElement('div');
    el.className = 'render-lora';
    el.dataset.i = String(i);
    const on = document.createElement('input');
    on.type = 'checkbox';
    on.checked = row.on;
    on.dataset.k = 'on';
    on.title = 'Use this LoRA';
    const sel = document.createElement('select');
    sel.dataset.k = 'file';
    const offered = o.loras.filter((l) => renderLoraAll || l.matches || l.file === row.file).map((l) => l.file);
    fillSelect(sel, row.file ? offered : ['', ...offered], row.file, (f) =>
      f ? f.replace(/\.safetensors$/, '') + (o.loras.find((l) => l.file === f)?.matches ? '' : ' (other model)') : 'Pick a LoRA…'
    );
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '-1';
    range.max = '2';
    range.step = '0.05';
    range.value = String(row.strength);
    range.dataset.k = 'strength';
    const val = document.createElement('span');
    val.className = 'val';
    val.textContent = Number(row.strength).toFixed(2);
    const del = document.createElement('button');
    del.className = 'ghost';
    del.type = 'button';
    del.textContent = '✕';
    del.title = 'Remove';
    del.dataset.k = 'remove';
    el.append(on, sel, range, val, del);
    const trig = o.loras.find((l) => l.file === row.file)?.triggers ?? [];
    if (trig.length) {
      const t = document.createElement('div');
      t.className = 'render-lora-trig';
      t.textContent = `Trigger words, added when on: ${trig.join(', ')}`;
      el.append(t);
    }
    host.append(el);
  });
  $('#btn-render-add-lora').disabled = rows.length >= o.max_loras;
  $('#render-lora-all').checked = renderLoraAll;
}

/** Repaint the compact section and, when open, the pop-out, from renderSettings. */
function paintRender() {
  const section = $('#render-section');
  if (!section) return;
  if (!renderOptions) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  fillPresetSelect($('#render-preset'));
  $('#render-summary').textContent = renderSummaryText();
  const tooBig = !fitsCap(renderSize());
  const waiting = renderOptions.runnable === false;
  $('#btn-render').disabled = Boolean(renderAbort) || !lastResult?.segments?.length || tooBig || waiting;
  $('#btn-render').title = waiting
    ? 'This workflow is waiting for the owner to approve it'
    : tooBig ? 'Over the size cap — pick a lower resolution in Settings' : '';
  if (!$('#render-modal').hidden) paintRenderModal();
}

function paintRenderModal() {
  const o = renderOptions;
  const s = renderSettings;
  $('#render-modal-title').textContent = `Render settings · ${currentModel?.label ?? ''}`;
  fillSelect($('#render-workflow'), o.workflows.map((w) => w.id ?? ''), o.workflow_id ?? '', (id) => {
    const w = o.workflows.find((x) => (x.id ?? '') === id);
    return w.approved ? w.name : `${w.name} (waiting for approval)`;
  });
  const wnote = $('#render-workflow-note');
  wnote.hidden = o.runnable !== false;
  wnote.textContent = 'This workflow is waiting for the owner to approve it. You can set it up now; it renders once approved.';
  $('#btn-render-delete-workflow').hidden = !o.workflow_id;
  fillPresetSelect($('#render-modal-preset'));
  $('#render-delete-preset').hidden = !allPresets()[matchingPreset()]?.mine;
  $('#btn-render-manage').hidden = !IS_OWNER;

  const strip = (f) => String(f).replace(/\.safetensors$/, '');
  const files = (o.model_files ?? []).map((f) => f.file);
  fillSelect($('#render-model-file'), files, s.model_file ?? o.defaults.model_file, strip);
  $('#render-model-file').disabled = files.length < 2;
  $('#render-te-field').hidden = !o.text_encoders?.length;
  fillSelect($('#render-text-encoder'), o.text_encoders ?? [], s.text_encoder, strip);
  $('#render-vae-field').hidden = !o.vaes?.length;
  fillSelect($('#render-vae'), o.vaes ?? [], s.vae, strip);
  const fp = currentFilePreset();
  $('#render-file-note').textContent =
    [
      files.length < 2 ? (IS_OWNER ? 'Add more model files with Manage models.' : null) : 'Picking a model file loads its own settings.',
      fp.prefix ? `This file adds "${fp.prefix}" in front of the prompt.` : null,
      fp.negative ? 'This file has its own negative.' : null,
    ].filter(Boolean).join(' ');
  paintLoraRows();

  const aspects = currentModel?.aspect_ratios ?? [];
  fillSelect($('#render-aspect'), aspects, s.aspect, (a) => (o.sizes?.[a]?.native ? a : `${a} (workflow size)`));
  const tiers = ['native', ...o.tiers];
  fillSelect($('#render-tier'), tiers, s.tier, (t) => {
    const z = o.sizes?.[s.aspect]?.[t];
    const name = t === 'native' ? 'Native' : `${t}p`;
    if (!z) return t === 'native' ? `Workflow · ${o.defaults.width}×${o.defaults.height}` : `${name} (needs an aspect)`;
    return `${name} · ${z.width}×${z.height}${fitsCap(z) ? '' : ' (over the cap)'}`;
  });
  for (const opt of $('#render-tier').options) {
    const z = o.sizes?.[s.aspect]?.[opt.value];
    opt.disabled = opt.value !== 'native' && (!z || !fitsCap(z));
  }
  $('#render-seed').value = s.seed;
  $('#render-seed').disabled = s.seed_mode === 'random';
  $('#render-seed-mode').value = s.seed_mode;
  const { width, height } = renderSize();
  $('#render-sizeline').textContent =
    `→ ${width} × ${height}` +
    (s.tier === 'native' || !o.sizes?.[s.aspect]?.[s.tier]
      ? ' (the workflow’s own pixel count)'
      : ` (short side ${s.tier}p, multiples of 16)`) +
    (fitsCap({ width, height }) ? '' : ' — over this server’s cap');
  $('#render-steps').value = s.steps;
  $('#render-steps').max = o.caps.max_steps;
  $('#render-cfg').value = s.cfg;
  fillSelect($('#render-sampler'), o.samplers, s.sampler);
  fillSelect($('#render-scheduler'), o.schedulers, s.scheduler);
  $('#render-caps').textContent =
    `Sampler and scheduler lists come from ComfyUI itself${o.running ? '' : ' (as last seen; it is asleep)'}. ` +
    `Server caps: ${o.caps.max_steps} steps, ~${o.caps.max_megapixels} MP.`;

  // The parts in the order the server joins them. Tags already in the prompt
  // are not repeated on a tag model; the server does that, so the preview
  // says so rather than pretending to.
  const { positive, negativeSegment } = renderTexts();
  const sent = $('#render-sent');
  sent.innerHTML = '';
  const line = (label, text) => {
    const b = document.createElement('b');
    b.textContent = `[${label}] `;
    sent.append(b, document.createTextNode(`${text}\n`));
  };
  if (fp.prefix) line('model-file prefix', fp.prefix);
  const trig = activeTriggers();
  if (trig.length) line('LoRA trigger', trig.join(', '));
  line('PromptForge', positive || '(generate a prompt first)');
  // The negative box: filled automatically, then the person's to change.
  $('#render-negative-field').hidden = !o.has_negative;
  if (o.has_negative) {
    const auto = autoNegative(negativeSegment, fp);
    const box = $('#render-negative');
    // Not while they are typing in it: rewriting a focused box moves the caret.
    if (document.activeElement !== box) box.value = currentNegative(negativeSegment, fp);
    $('#render-negative-note').textContent =
      renderNegativeEdit === null ? `Filled with ${auto.source}. Change it as you like.` : 'Your own edit; it is sent as it is.';
    $('#render-negative-auto').hidden = renderNegativeEdit === null;
  }

  if (!o.has_negative) line('negative', `${currentModel?.label ?? 'This model'} takes no negative`);
  else line(renderNegativeEdit === null ? `negative, ${autoNegative(negativeSegment, fp).source}` : 'negative, your edit',
    currentNegative(negativeSegment, fp) || '(empty)');
  if (o.tag_model && (fp.prefix || trig.length)) {
    sent.append(document.createTextNode('(Tags already in the prompt are not added twice.)'));
  }
}

// The negative the box holds: null while it follows the automatic one, the
// person's text once they edit it. Reset on a new prompt or model switch
// (clearRenderResult), so an edit made for one picture never rides along to
// a different one. Owner's call, 4 Oct 2026.
let renderNegativeEdit = null;

/** The good basic negative: what the model wrote, else the model file's, else the model's basic one. */
function autoNegative(negativeSegment, fp) {
  if (negativeSegment) return { text: negativeSegment, source: 'the negative the model wrote' };
  if (fp?.negative) return { text: fp.negative, source: 'this model file’s own negative' };
  return { text: renderOptions?.defaults.negative ?? '', source: 'the model’s basic negative' };
}

function currentNegative(negativeSegment, fp) {
  return renderNegativeEdit ?? autoNegative(negativeSegment, fp).text;
}

/** Forget the picture and any progress. On model switch, Clear, and a new generation. */
function clearRenderResult() {
  renderAbort?.abort();
  renderAbort = null;
  lastRender = null;
  // A new prompt (or model) means a new automatic negative.
  renderNegativeEdit = null;
  const result = $('#render-result');
  if (result) result.hidden = true;
  const progress = $('#render-progress');
  if (progress) progress.hidden = true;
  paintRender();
}

/** Fetch what this model can render with. Hides the section when it cannot. */
async function loadRenderOptions() {
  const epoch = ++renderEpoch;
  renderOptions = null;
  renderSettings = null;
  paintRender();
  if (!CAN_RENDER || !currentModel?.can_render) return;
  let data;
  try {
    const wf = pickedWorkflow(currentModel.key);
    const res = await fetch(
      `/api/render/options?model=${encodeURIComponent(currentModel.key)}${wf ? `&workflow=${encodeURIComponent(wf)}` : ''}`,
      { headers: USER_HEADER }
    );
    data = await res.json();
    if (!res.ok) data = { available: false, message: data.message };
  } catch {
    return;
  }
  if (epoch !== renderEpoch) return;
  if (!data.available) {
    // Rendering switched off on this server: no section at all. A model whose
    // workflow does not load is a fault the owner should see, so it says so.
    if (data.message && IS_OWNER) console.warn(`[render] ${data.message}`);
    return;
  }
  renderOptions = data;
  // A remembered workflow the server no longer has (deleted, or refused by
  // the owner) came back as the starter; forget it.
  rememberWorkflow(data.model, data.workflow_id);
  const saved = readRenderPrefs(data.model, data.workflow_id) ?? {};
  renderSettings = {
    steps: data.defaults.steps,
    cfg: data.defaults.cfg,
    sampler: data.defaults.sampler,
    scheduler: data.defaults.scheduler,
    model_file: data.defaults.model_file ?? null,
    text_encoder: data.defaults.text_encoder ?? null,
    vae: data.defaults.vae ?? null,
    loras: [],
    tier: 'native',
    seed: Math.floor(Math.random() * 2 ** 32),
    seed_mode: 'random',
  };
  // The starter opens on the model's first preset; your own workflow opens on
  // its own values, which is the point of having uploaded it.
  if (!data.workflow_id && data.presets.length && !Object.keys(saved).length) applyPreset(0);
  for (const k of [...RENDER_FIELDS, 'text_encoder', 'vae', 'loras', 'tier', 'seed', 'seed_mode']) {
    if (saved[k] !== undefined && saved[k] !== null) renderSettings[k] = saved[k];
  }
  // A saved choice the server no longer offers falls back to the workflow's:
  // the owner may have removed a file, or a LoRA may have been deleted.
  if (!data.samplers.includes(renderSettings.sampler)) renderSettings.sampler = data.defaults.sampler;
  if (!data.schedulers.includes(renderSettings.scheduler)) renderSettings.scheduler = data.defaults.scheduler;
  if (!data.model_files?.some((f) => f.file === renderSettings.model_file)) renderSettings.model_file = data.defaults.model_file ?? null;
  if (!data.text_encoders?.includes(renderSettings.text_encoder)) renderSettings.text_encoder = data.defaults.text_encoder ?? null;
  if (!data.vaes?.includes(renderSettings.vae)) renderSettings.vae = data.defaults.vae ?? null;
  renderSettings.loras = (Array.isArray(renderSettings.loras) ? renderSettings.loras : [])
    .filter((l) => data.loras?.some((x) => x.file === l.file))
    .slice(0, data.max_loras ?? 8);
  renderSettings.aspect = builderAspect();
  paintRender();
}

function renderStatus(text) {
  $('#render-status').textContent = text;
}

/** One frame at a time from an SSE response, as [event, data]. */
async function* sseFrames(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (.+)$/m.exec(frame);
      const da = /^data: (.+)$/m.exec(frame);
      if (ev && da) yield [ev[1], JSON.parse(da[1])];
    }
  }
}

const RENDER_PHASES = {
  starting: 'Starting ComfyUI — it sleeps when nobody renders…',
  freeing_llm: 'Unloading the LLM to make room on the card…',
  waiting: 'Queued in ComfyUI…',
  loading: 'Loading the model…',
  saving: 'Saving the picture…',
};

async function startRender({ again = false } = {}) {
  if (renderAbort || !renderOptions || !lastResult?.segments?.length) return;
  const { positive, negativeSegment } = renderTexts();
  if (!positive) return toast('This result has no prompt to render');
  const s = renderSettings;
  if (again && lastRender) {
    s.seed = lastRender.settings.seed + 1;
  } else if (s.seed_mode === 'random') {
    s.seed = Math.floor(Math.random() * 2 ** 32);
  } else if (s.seed_mode === 'increment' && lastRender?.model === renderOptions.model) {
    s.seed = lastRender.settings.seed + 1;
  }
  saveRenderPrefs();
  const { width, height } = renderSize();
  const sessionId = lastResult.sessionId ?? null;
  const model = renderOptions.model;

  const controller = new AbortController();
  renderAbort = controller;
  $('#render-result').hidden = true;
  $('#render-progress').hidden = false;
  // The last render's preview must not sit under this one.
  $('#render-preview').hidden = true;
  $('#render-preview').removeAttribute('src');
  const bar = $('#render-bar');
  bar.parentElement.classList.add('indeterminate');
  bar.style.width = '';
  renderStatus('Sending…');
  paintRender();
  const t0 = Date.now();
  const secs = () => `${Math.round((Date.now() - t0) / 1000)} s`;
  // The clock ticks on its own. Events only arrive at phase changes, and a
  // cold Krea2 Raw spends 70 s loading between two of them — measured 3 Oct
  // 2026, the line sat at "Loading the model… 10 s" for over a minute.
  let phase = 'Sending…';
  const say = (text) => {
    phase = text;
    renderStatus(`${phase} ${secs()}`);
  };
  const clock = setInterval(() => renderStatus(`${phase} ${secs()}`), 1000);

  let finished = false;
  try {
    const res = await fetch('/api/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...USER_HEADER },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        workflow: renderOptions.workflow_id,
        positive,
        negative_segment: negativeSegment,
        // Exactly what the Negative box holds, edited or not.
        ...(renderOptions.has_negative ? { negative: currentNegative(negativeSegment, currentFilePreset()) } : {}),
        settings: {
          steps: s.steps,
          cfg: s.cfg,
          sampler: s.sampler,
          scheduler: s.scheduler,
          seed: s.seed,
          width,
          height,
          model_file: s.model_file,
          text_encoder: s.text_encoder,
          vae: s.vae,
          // Only the rows switched on and with a file picked go out.
          loras: s.loras.filter((l) => l.on && l.file).map((l) => ({ file: l.file, strength: l.strength })),
        },
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
      throw new Error(err.message);
    }
    for await (const [ev, data] of sseFrames(res)) {
      if (ev === 'queued') {
        say(`Waiting for the GPU — ${data.position - 1 || 0} ahead of you ·`);
      } else if (ev === 'status') {
        say(RENDER_PHASES[data.state] ?? 'Rendering…');
      } else if (ev === 'node') {
        // Which node ComfyUI is on, by the workflow's own name for it — the
        // stages its own window shows (loading the model, the text encoder,
        // the sampler, decoding). The bar restarts for each node with steps.
        say(`${data.name}…`);
      } else if (ev === 'progress') {
        bar.parentElement.classList.remove('indeterminate');
        bar.style.width = `${Math.round((100 * data.value) / Math.max(1, data.max))}%`;
        say(`${data.node ? `${data.node} · ` : ''}step ${data.value} of ${data.max} ·`);
      } else if (ev === 'preview') {
        const pv = $('#render-preview');
        pv.src = data.image;
        pv.hidden = false;
      } else if (ev === 'done') {
        clearInterval(clock);
        finished = true;
        lastRender = data;
        $('#render-progress').hidden = true;
        showRenderResult(data);
        flagTab('done');
        attachRenderToSession(sessionId, data);
      } else if (ev === 'error') {
        throw new Error(data.message);
      }
    }
    if (!finished) throw new Error('The connection closed before the picture arrived.');
  } catch (err) {
    clearInterval(clock);
    bar.parentElement.classList.remove('indeterminate');
    bar.style.width = '0';
    renderStatus(controller.signal.aborted ? 'Cancelled.' : `Render failed: ${err.message}`);
  } finally {
    clearInterval(clock);
    if (renderAbort === controller) renderAbort = null;
    paintRender();
  }
}

function showRenderResult(r) {
  const s = r.settings;
  $('#render-img').src = r.url;
  $('#render-img').onerror = () => {
    $('#render-result').hidden = true;
    $('#render-progress').hidden = false;
    renderStatus('That picture is gone from the server — renders are kept for a day.');
  };
  $('#render-open').href = r.url;
  const meta = $('#render-meta');
  meta.innerHTML = '';
  for (const line of [
    [s.model_file?.replace(/\.safetensors$/, ''), `${s.width}×${s.height}`].filter(Boolean).join(' · '),
    `${s.steps} steps · CFG ${s.cfg} · ${s.sampler} / ${s.scheduler} · seed ${s.seed}`,
    s.loras?.length ? `LoRA ${s.loras.map((l) => `${l.file.replace(/\.safetensors$/, '')} ${Number(l.strength).toFixed(2)}`).join(', ')}` : null,
    [r.ms ? `${(r.ms / 1000).toFixed(1)} s` : null, 'prompt + workflow saved in the PNG'].filter(Boolean).join(' · '),
    r.llm_unloaded ? 'The LLM was unloaded to make room.' : null,
  ].filter(Boolean)) {
    const div = document.createElement('div');
    div.textContent = line;
    meta.appendChild(div);
  }
  $('#render-result').hidden = false;
}

/** A small JPEG of the picture for the session list; sessionStorage cannot hold the PNG. */
function renderThumb(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const h = 128;
      const w = Math.max(1, Math.round((img.naturalWidth / img.naturalHeight) * h));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      try {
        resolve(c.toDataURL('image/jpeg', 0.7));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** The render joins its prompt's session entry: the history shows them together. */
async function attachRenderToSession(sessionId, r) {
  if (!sessionId) return;
  const thumb = await renderThumb(r.url);
  const entries = readSessionHistory();
  const e = entries.find((x) => x.id === sessionId);
  if (!e) return;
  e.render = { id: r.id, url: r.url, model: r.model, settings: r.settings, ms: r.ms, thumb };
  writeSessionHistory(entries);
  renderSessionHistory();
}

// ── Edit tab (4 Oct 2026) ─────────────────────────────────────
//
// A picture, a request, and the image editor (Qwen Image 2.1). Each result
// becomes the picture, so the next request edits it, and the strip under it
// steps back to any version. The versions are blobs in this page only; the
// server keeps each result for keep_hours like a render. Marks drawn on the
// picture go out burned into it, and the writer is told they are there.

/** Longest edge a picture is sent at. The editor works at about a megapixel; this is headroom, not a target. */
const EDIT_EDGE = 2048;
let editOptions = null;
let editVersions = []; // [{ blob, url, prompt?, renderId? }], url an object URL
let editCurrent = -1;
let editRefs = []; // [{ blob, url }]
let editAbort = null;
let editImage = null; // the current version as a loaded <img>
let editMarking = false;
let editMarked = false;
let editModel = '';
let editModelSignature = '';

/** Shown or hidden by permission and by whether the server has editing set up. */
async function loadEditOptions() {
  const tab = $('.main-tab[data-tab="edit"]');
  if (!tab) return;
  editOptions = null;
  if (CAN_RENDER) {
    try {
      const res = await fetch('/api/edit/options', { headers: USER_HEADER });
      if (res.ok) editOptions = await res.json();
    } catch {
      /* no tab */
    }
  }
  tab.hidden = !editOptions?.available;
  if (!editOptions?.available) return;
  $('#edit-badge').textContent = editOptions.label;
  $('#edit-note').textContent =
    `Each edit is kept on the server for ${editOptions.keep_hours} hours, visible only to you. Pin one to keep it.`;
  // Speed. Remembered per viewer; a preset the server no longer offers falls
  // back to its default.
  const sel = $('#edit-preset');
  const presets = editOptions.presets ?? [];
  sel.replaceChildren(...presets.map((p) => new Option(p.name, p.name)));
  let saved = null;
  try {
    saved = localStorage.getItem('pf-edit-preset');
  } catch {
    /* default */
  }
  sel.value = presets.some((p) => p.name === saved) ? saved : presets[0]?.name ?? '';
  sel.hidden = presets.length < 2;
  paintEditFiles();
  paintEditAbout();
  paintEdit();
}

// The editor's files, remembered per viewer. Only a convenience: a file no
// longer installed falls back to the workflow's own.
const EDIT_FILE_SLOTS = [['model', '#edit-file-model'], ['text_encoder', '#edit-file-te'], ['vae', '#edit-file-vae']];
function readEditFiles() {
  try {
    return JSON.parse(localStorage.getItem('pf-edit-files') || '{}');
  } catch {
    return {};
  }
}

function paintEditFiles() {
  const saved = readEditFiles();
  let any = false;
  for (const [slot, sel] of EDIT_FILE_SLOTS) {
    const el = $(sel);
    // { file, gb }: the exact filename, which is what to search for, and its
    // size, which is about what it takes in memory - the lighter choice is plain.
    const files = editOptions.files?.[slot] ?? [];
    const names = files.map((f) => f.file);
    el.replaceChildren(...files.map(({ file, gb }) => new Option(
      `${file}${gb ? ` · ${gb} GB` : ''}${file === editOptions.defaults?.[slot] ? ' (default)' : ''}`, file)));
    el.value = names.includes(saved[slot]) ? saved[slot] : editOptions.defaults?.[slot] ?? names[0] ?? '';
    // One file is no choice: no picker at all. It appears when a second
    // matching file is put in ComfyUI's folder.
    el.closest('.field').hidden = files.length < 2;
    any ||= files.length > 1;
  }
  $('.edit-files').hidden = !any;
}

function pickedEditFiles() {
  return Object.fromEntries(EDIT_FILE_SLOTS.map(([slot, sel]) => [slot, $(sel).value || null]));
}

/** What the editor is and what it takes to run, from config — this page holds no copy. */
function paintEditAbout() {
  const a = editOptions.about;
  const box = $('#edit-about');
  box.hidden = !a;
  if (!a) return;
  const body = $('#edit-about-body');
  body.replaceChildren();
  const section = (title, content) => {
    if (!content || (Array.isArray(content) && !content.length)) return;
    const h = document.createElement('h4');
    h.textContent = title;
    body.append(h);
    if (Array.isArray(content)) {
      const ul = document.createElement('ul');
      for (const line of content) ul.append(Object.assign(document.createElement('li'), { textContent: line }));
      body.append(ul);
    } else {
      body.append(Object.assign(document.createElement('p'), { textContent: content }));
    }
  };
  section('The model', a.summary);
  section('What it needs', a.needs);
  section('Files', a.files);
  section('Measured', a.measured);
  section('Smaller options', a.smaller);
  body.append(Object.assign(document.createElement('p'), {
    className: 'field-note',
    textContent: 'Nothing is downloaded from here. Put a second matching file in ComfyUI\'s models folder and a picker for it appears above.',
  }));
  // The workflow itself, to use the editor in ComfyUI directly.
  const dl = Object.assign(document.createElement('button'), { className: 'ghost', type: 'button', textContent: 'Download the workflow (opens in ComfyUI)' });
  dl.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/edit/workflow', { headers: USER_HEADER });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? `HTTP ${res.status}`);
      saveBlob(await res.blob(), 'promptforge-qwen-image-edit.json');
    } catch (err) {
      toast(`Could not download it: ${err.message}`);
    }
  });
  body.append(dl);
}

/** The writer picker: vision models only, since the writer has to see the picture. */
function renderEditLlm(llm) {
  const sel = $('#edit-llm');
  if (!sel || !llm) return;
  const groups = chatModelGroups(llm);
  const rows = [...groups.loaded, ...groups.available].filter((r) => r.vision);
  const signature = rows.map((r) => r.model).join(',');
  if (signature === editModelSignature) return;
  editModelSignature = signature;
  sel.replaceChildren(new Option(`Written by the default model${editOptions?.default_llm ? ` (${editOptions.default_llm})` : ''}`, ''));
  for (const r of rows) sel.appendChild(new Option(`Written by ${r.model}`, r.model));
  sel.value = rows.some((r) => r.model === editModel) ? editModel : '';
  editModel = sel.value;
}

/** A picture at no more than `edge` on its longest side. PNG stays PNG; anything else becomes JPEG. */
async function shrinkForEdit(blob, edge = EDIT_EDGE) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && ['image/png', 'image/jpeg', 'image/webp'].includes(blob.type)) {
    bitmap.close?.();
    return blob;
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  const png = blob.type === 'image/png';
  if (!png) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvasBlob(canvas, png ? 'image/png' : 'image/jpeg');
}

/** Hand the browser a blob as a downloaded file. */
function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function canvasBlob(canvas, type = 'image/png') {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not encode'))), type, 0.92));
}

/** Start over from this picture: the strip is cleared and it becomes version 1. */
async function startEditFrom(blob) {
  let picture;
  try {
    picture = await shrinkForEdit(blob);
  } catch {
    toast('That file could not be read as a picture');
    return;
  }
  editAbort?.abort();
  for (const v of editVersions) URL.revokeObjectURL(v.url);
  editVersions = [{ blob: picture, url: URL.createObjectURL(picture) }];
  $('#edit-prompt-box').hidden = true;
  $('#edit-progress').hidden = true;
  await showEditVersion(0);
}

async function addEditVersion(v) {
  editVersions.push({ ...v, url: URL.createObjectURL(v.blob) });
  await showEditVersion(editVersions.length - 1);
}

/** Put a version on the canvas. Marks belong to the picture they were drawn on, so they go. */
async function showEditVersion(i) {
  const v = editVersions[i];
  if (!v) return;
  editCurrent = i;
  const img = new Image();
  img.src = v.url;
  await img.decode().catch(() => {});
  editImage = img;
  editMarked = false;
  const canvas = $('#edit-canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext('2d').drawImage(img, 0, 0);
  if (v.prompt) {
    $('#edit-prompt').textContent = v.prompt;
    $('#edit-prompt-box').hidden = false;
  }
  paintEdit();
}

function clearEditMarks() {
  if (!editImage) return;
  const canvas = $('#edit-canvas');
  canvas.getContext('2d').drawImage(editImage, 0, 0);
  editMarked = false;
  paintEdit();
}

function paintEdit() {
  const has = editCurrent >= 0;
  $('#edit-canvas').hidden = !has;
  $('#edit-empty').hidden = has;
  $('#edit-stage').classList.toggle('has-picture', has);
  $('#edit-stage').classList.toggle('marking', has && editMarking);
  $('#edit-tools').hidden = !has;
  $('#edit-mark').setAttribute('aria-pressed', String(editMarking));
  $('#edit-clear-marks').hidden = !editMarked;
  $('#edit-pin').hidden = !editVersions[editCurrent]?.renderId;
  $('#edit-run').disabled = !has || Boolean(editAbort) || !$('#edit-instruction').value.trim();

  const strip = $('#edit-versions');
  strip.hidden = editVersions.length < 2;
  strip.replaceChildren(
    ...editVersions.map((v, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = i === editCurrent ? 'current' : '';
      b.title = i === 0 ? 'The picture you started from' : `Edit ${i}${v.prompt ? `: ${v.prompt.slice(0, 120)}` : ''}`;
      const img = document.createElement('img');
      img.src = v.url;
      img.alt = i === 0 ? 'Original' : `Edit ${i}`;
      b.append(img);
      b.addEventListener('click', () => showEditVersion(i));
      return b;
    })
  );

  const refs = $('#edit-refs');
  const max = (editOptions?.max_pictures ?? 4) - 1;
  refs.replaceChildren(
    ...editRefs.map((r, i) => {
      const box = document.createElement('div');
      box.className = 'edit-ref';
      const img = document.createElement('img');
      img.src = r.url;
      img.alt = `Reference ${i + 1}`;
      const x = Object.assign(document.createElement('button'), { type: 'button', className: 'ghost', textContent: '×', title: 'Remove' });
      x.addEventListener('click', () => {
        URL.revokeObjectURL(r.url);
        editRefs.splice(i, 1);
        paintEdit();
      });
      box.append(img, x);
      return box;
    })
  );
  if (editRefs.length < max) {
    const add = Object.assign(document.createElement('button'), { type: 'button', className: 'ghost add', textContent: '+ Add' });
    add.addEventListener('click', () => $('#edit-ref-file').click());
    refs.append(add);
  }
}

async function addEditRefs(files) {
  const max = (editOptions?.max_pictures ?? 4) - 1;
  for (const f of files) {
    if (editRefs.length >= max) break;
    try {
      const blob = await shrinkForEdit(f);
      editRefs.push({ blob, url: URL.createObjectURL(blob) });
    } catch {
      toast(`${f.name ?? 'That file'} could not be read as a picture`);
    }
  }
  paintEdit();
}

const EDIT_PHASES = {
  writing: 'Looking at the picture and writing the instruction…',
  starting: 'Starting ComfyUI — it sleeps when nobody renders…',
  freeing_llm: 'Unloading the LLM to make room on the card…',
  waiting: 'Queued in ComfyUI…',
  loading: 'Loading the editor…',
  saving: 'Saving the picture…',
};

async function runEditRequest() {
  if (editAbort || editCurrent < 0) return;
  const instruction = $('#edit-instruction').value.trim();
  if (!instruction) return;
  const controller = new AbortController();
  editAbort = controller;
  const bar = $('#edit-bar');
  const status = $('#edit-status');
  $('#edit-progress').hidden = false;
  $('#edit-preview').hidden = true;
  $('#edit-preview').removeAttribute('src');
  bar.parentElement.classList.add('indeterminate');
  bar.style.width = '';
  paintEdit();
  const t0 = Date.now();
  let phase = 'Sending…';
  const say = (text) => {
    phase = text;
    status.textContent = `${phase} ${Math.round((Date.now() - t0) / 1000)} s`;
  };
  say(phase);
  const clock = setInterval(() => say(phase), 1000);
  let finished = false;
  try {
    const marked = editMarked;
    const main = marked ? await canvasBlob($('#edit-canvas')) : editVersions[editCurrent].blob;
    const pictures = [];
    for (const b of [main, ...editRefs.map((r) => r.blob)]) {
      pictures.push({ type: b.type || 'image/png', data: await blobToBase64(b) });
    }
    const res = await fetch('/api/edit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...USER_HEADER },
      signal: controller.signal,
      body: JSON.stringify({
        instruction,
        pictures,
        marked,
        as_written: $('#edit-as-written').checked,
        ...($('#edit-preset').value ? { preset: $('#edit-preset').value } : {}),
        files: pickedEditFiles(),
        ...(editModel ? { llm_model: editModel } : {}),
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
      throw new Error(err.message);
    }
    for await (const [ev, data] of sseFrames(res)) {
      if (ev === 'queued') {
        say(`Waiting for the GPU — ${data.position - 1 || 0} ahead of you ·`);
      } else if (ev === 'status') {
        say(EDIT_PHASES[data.state] ?? 'Editing…');
      } else if (ev === 'prompt') {
        // What the editor will read, as soon as it is written: the person can
        // see what went wrong before the picture even arrives.
        $('#edit-prompt').textContent = data.text;
        $('#edit-prompt-box').hidden = false;
      } else if (ev === 'node') {
        say(`${data.name}…`);
      } else if (ev === 'progress') {
        bar.parentElement.classList.remove('indeterminate');
        bar.style.width = `${Math.round((100 * data.value) / Math.max(1, data.max))}%`;
        say(`${data.node ? `${data.node} · ` : ''}step ${data.value} of ${data.max} ·`);
      } else if (ev === 'preview') {
        const pv = $('#edit-preview');
        pv.src = data.image;
        pv.hidden = false;
      } else if (ev === 'done') {
        finished = true;
        clearInterval(clock);
        const blob = await fetch(data.url, { headers: USER_HEADER }).then((r) => {
          if (!r.ok) throw new Error('The picture could not be fetched back.');
          return r.blob();
        });
        await addEditVersion({ blob, prompt: data.prompt, renderId: data.id, instruction });
        $('#edit-progress').hidden = true;
        flagTab('done');
        status.textContent = `Done in ${(data.ms / 1000).toFixed(1)} s${data.llm_unloaded ? ' · the LLM was unloaded to make room' : ''}`;
      } else if (ev === 'error') {
        throw new Error(data.message);
      }
    }
    if (!finished) throw new Error('The connection closed before the picture arrived.');
  } catch (err) {
    clearInterval(clock);
    bar.parentElement.classList.remove('indeterminate');
    bar.style.width = '0';
    status.textContent = controller.signal.aborted ? 'Cancelled.' : `Edit failed: ${err.message}`;
  } finally {
    clearInterval(clock);
    if (editAbort === controller) editAbort = null;
    paintEdit();
  }
}

/** A picture from somewhere else in the app (a chat edit) becomes the Edit tab's picture. */
async function openInEditTab(url) {
  try {
    const blob = await fetch(url, { headers: USER_HEADER }).then((r) => {
      if (!r.ok) throw new Error('That picture is gone from the server.');
      return r.blob();
    });
    $('.main-tab[data-tab="edit"]')?.click();
    await startEditFrom(blob);
  } catch (err) {
    toast(err.message);
  }
}

function wireEdit() {
  const stage = $('#edit-stage');
  if (!stage) return;
  const file = $('#edit-file');
  stage.addEventListener('click', () => {
    if (editCurrent < 0) file.click();
  });
  file.addEventListener('change', async () => {
    if (file.files?.[0]) await startEditFrom(file.files[0]);
    file.value = '';
  });
  $('#edit-new').addEventListener('click', () => file.click());
  $('#edit-ref-file').addEventListener('change', async (e) => {
    await addEditRefs([...e.target.files]);
    e.target.value = '';
  });
  for (const ev of ['dragenter', 'dragover']) {
    stage.addEventListener(ev, (e) => {
      e.preventDefault();
      stage.classList.add('dragover');
    });
  }
  for (const ev of ['dragleave', 'drop']) stage.addEventListener(ev, () => stage.classList.remove('dragover'));
  stage.addEventListener('drop', async (e) => {
    e.preventDefault();
    const f = [...(e.dataTransfer?.files ?? [])].find((x) => x.type.startsWith('image/'));
    if (f) await startEditFrom(f);
  });
  // Paste: the picture when there is none yet, a reference after that.
  document.addEventListener('paste', async (e) => {
    if (!$('#panel-edit').classList.contains('active')) return;
    const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith('image/'));
    if (!f) return;
    e.preventDefault();
    if (editCurrent < 0) await startEditFrom(f);
    else await addEditRefs([f]);
  });

  // Marks: red strokes on the picture itself, at the picture's own scale.
  const canvas = $('#edit-canvas');
  let drawing = null;
  const at = (e) => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) * canvas.width) / r.width, ((e.clientY - r.top) * canvas.height) / r.height];
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (!editMarking || editAbort) return;
    canvas.setPointerCapture(e.pointerId);
    drawing = at(e);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const next = at(e);
    const ctx = canvas.getContext('2d');
    ctx.strokeStyle = '#ff1a1a';
    ctx.lineWidth = Math.max(4, Math.round(Math.max(canvas.width, canvas.height) / 160));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(...drawing);
    ctx.lineTo(...next);
    ctx.stroke();
    drawing = next;
    if (!editMarked) {
      editMarked = true;
      paintEdit();
    }
  });
  for (const ev of ['pointerup', 'pointercancel']) canvas.addEventListener(ev, () => { drawing = null; });
  $('#edit-mark').addEventListener('click', () => {
    editMarking = !editMarking;
    paintEdit();
  });
  $('#edit-clear-marks').addEventListener('click', clearEditMarks);

  $('#edit-instruction').addEventListener('input', paintEdit);
  $('#edit-instruction').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) runEditRequest();
  });
  $('#edit-run').addEventListener('click', runEditRequest);
  $('#edit-cancel').addEventListener('click', () => editAbort?.abort());
  $('#edit-preset').addEventListener('change', (e) => {
    try {
      localStorage.setItem('pf-edit-preset', e.target.value);
    } catch {
      /* remembered for this page only */
    }
  });
  $('#edit-llm').addEventListener('change', (e) => {
    editModel = e.target.value;
  });
  for (const [, sel] of EDIT_FILE_SLOTS) {
    $(sel).addEventListener('change', () => {
      try {
        localStorage.setItem('pf-edit-files', JSON.stringify(pickedEditFiles()));
      } catch {
        /* remembered for this page only */
      }
    });
  }
  $('#edit-download').addEventListener('click', () => {
    const v = editVersions[editCurrent];
    if (!v) return;
    const a = document.createElement('a');
    a.href = v.url;
    a.download = editCurrent === 0 ? 'original.png' : `edit-${editCurrent}.png`;
    a.click();
  });
  $('#edit-pin').addEventListener('click', async () => {
    const v = editVersions[editCurrent];
    if (!v?.renderId) return;
    const btn = $('#edit-pin');
    btn.disabled = true;
    try {
      const res = await fetch(`/api/render/${v.renderId}/pin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...USER_HEADER },
        body: JSON.stringify({ brief: v.instruction ?? '' }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message ?? 'Could not pin it.');
      toast(`Pinned as ${body.name}`);
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
    }
  });
  paintEdit();
}

/** An edit chat made, under the reply that carries its instruction. Kept as long as the conversation is. */
function chatEditEl(edit) {
  const box = document.createElement('div');
  box.className = 'chat-edit';
  const link = Object.assign(document.createElement('a'), { href: edit.url, target: '_blank', rel: 'noopener' });
  const img = Object.assign(document.createElement('img'), { src: edit.url, alt: 'Edited picture' });
  img.onerror = () => {
    box.textContent = 'This picture is gone from the server.';
    box.classList.add('gone');
  };
  link.append(img);
  const actions = document.createElement('div');
  actions.className = 'render-actions';
  if (!$('.main-tab[data-tab="edit"]')?.hidden) {
    const open = Object.assign(document.createElement('button'), { className: 'ghost', type: 'button', textContent: 'Open in Edit' });
    open.addEventListener('click', () => openInEditTab(edit.url));
    actions.append(open);
  }
  box.append(link, actions);
  return box;
}

function wireRender() {
  const modal = $('#render-modal');
  if (!modal) return;
  const close = () => {
    modal.hidden = true;
    saveRenderPrefs();
    paintRender();
  };
  $('#btn-render-settings').addEventListener('click', () => {
    if (!renderOptions) return;
    modal.hidden = false;
    paintRenderModal();
  });
  $('#render-modal-close').addEventListener('click', close);
  $('#render-done').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) close();
  });

  const onPreset = (e) => {
    if (e.target.value === 'custom') return;
    applyPreset(Number(e.target.value));
    saveRenderPrefs();
    paintRender();
  };
  $('#render-preset').addEventListener('change', onPreset);
  $('#render-modal-preset').addEventListener('change', onPreset);
  $('#render-reset').addEventListener('click', () => {
    applyPreset(Math.max(0, matchingPreset()));
    paintRender();
  });

  // Every field writes straight into renderSettings and repaints, so the
  // summary line and "What gets sent" never disagree with the form.
  const bind = (id, key, parse = (v) => v) => {
    $(id).addEventListener('change', (e) => {
      renderSettings[key] = parse(e.target.value);
      paintRender();
    });
  };
  bind('#render-aspect', 'aspect');
  bind('#render-tier', 'tier', (v) => (v === 'native' ? 'native' : Number(v)));
  bind('#render-seed', 'seed', (v) => Math.max(0, Math.floor(Number(v) || 0)));
  bind('#render-seed-mode', 'seed_mode');
  bind('#render-steps', 'steps', (v) => Math.min(renderOptions.caps.max_steps, Math.max(1, Math.floor(Number(v) || 1))));
  bind('#render-cfg', 'cfg', (v) => Math.min(30, Math.max(0, Number(v) || 0)));
  bind('#render-sampler', 'sampler');
  bind('#render-scheduler', 'scheduler');
  bind('#render-text-encoder', 'text_encoder');
  bind('#render-vae', 'vae');
  $('#render-negative').addEventListener('input', (e) => {
    renderNegativeEdit = e.target.value;
    paintRender();
  });
  $('#render-negative-auto').addEventListener('click', () => {
    renderNegativeEdit = null;
    // Out of the box first: the repaint leaves a focused box alone.
    $('#render-negative').blur();
    paintRender();
  });
  $('#render-model-file').addEventListener('change', (e) => {
    applyFilePreset(e.target.value);
    saveRenderPrefs();
    paintRender();
  });

  // LoRA rows, delegated: they are rebuilt on every paint.
  const loraRow = (e) => {
    const row = e.target.closest('.render-lora');
    return row ? renderSettings.loras[Number(row.dataset.i)] : null;
  };
  $('#render-loras').addEventListener('input', (e) => {
    const l = loraRow(e);
    if (!l || e.target.dataset.k !== 'strength') return;
    // Live while dragging: only the number beside the slider, no repaint.
    l.strength = Math.round(Number(e.target.value) * 100) / 100;
    e.target.nextElementSibling.textContent = l.strength.toFixed(2);
  });
  $('#render-loras').addEventListener('change', (e) => {
    const l = loraRow(e);
    if (!l) return;
    const k = e.target.dataset.k;
    if (k === 'on') l.on = e.target.checked;
    else if (k === 'file') l.file = e.target.value;
    else if (k === 'strength') l.strength = Math.round(Number(e.target.value) * 100) / 100;
    saveRenderPrefs();
    paintRender();
  });
  $('#render-loras').addEventListener('click', (e) => {
    if (e.target.dataset.k !== 'remove') return;
    const row = e.target.closest('.render-lora');
    renderSettings.loras.splice(Number(row.dataset.i), 1);
    saveRenderPrefs();
    paintRender();
  });
  $('#btn-render-add-lora').addEventListener('click', () => {
    if (renderSettings.loras.length >= renderOptions.max_loras) return;
    // The first matching LoRA not already in the list, as a starting point.
    const used = new Set(renderSettings.loras.map((l) => l.file));
    const next = renderOptions.loras.find((l) => (renderLoraAll || l.matches) && !used.has(l.file));
    renderSettings.loras.push({ on: true, file: next?.file ?? '', strength: 1 });
    saveRenderPrefs();
    paintRender();
  });
  $('#render-lora-all').addEventListener('change', (e) => {
    renderLoraAll = e.target.checked;
    paintRender();
  });
  $('#btn-render-manage').addEventListener('click', openRenderModels);
  wireRenderModels();

  // ── your own workflows and presets (stage 3) ──
  $('#render-workflow').addEventListener('change', async (e) => {
    saveRenderPrefs();
    rememberWorkflow(renderOptions.model, e.target.value || null);
    await loadRenderOptions();
  });
  const readJsonFile = (input) =>
    new Promise((resolve, reject) => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => {
        try {
          resolve(JSON.parse(String(reader.result)));
        } catch {
          reject(new Error(`${file.name} is not JSON.`));
        }
      };
      reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
      reader.readAsText(file);
    });
  // Our workflow for this model, as the template to build an upload on.
  $('#btn-render-template').addEventListener('click', async () => {
    const note = $('#render-upload-note');
    if (!renderOptions?.model) return;
    try {
      const res = await fetch(`/api/render/starter?model=${encodeURIComponent(renderOptions.model)}`, { headers: USER_HEADER });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? `HTTP ${res.status}`);
      saveBlob(await res.blob(), `promptforge-${renderOptions.model}.json`);
    } catch (err) {
      note.textContent = `Could not download it: ${err.message}`;
    }
  });
  $('#btn-render-upload').addEventListener('click', async (e) => {
    const note = $('#render-upload-note');
    const btn = e.currentTarget;
    const apiInput = $('#render-upload-api');
    if (!apiInput.files?.length) return (note.textContent = 'Pick the Export (API) file first.');
    btn.disabled = true;
    note.textContent = 'Uploading…';
    try {
      const api = await readJsonFile(apiInput);
      const ui = await readJsonFile($('#render-upload-ui'));
      const name = $('#render-upload-name').value.trim() || apiInput.files[0].name.replace(/\.json$/i, '');
      const res = await fetch('/api/render/workflows', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...USER_HEADER },
        body: JSON.stringify({ name, models: [renderOptions.model], api, ui }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message ?? `HTTP ${res.status}`);
      apiInput.value = '';
      $('#render-upload-ui').value = '';
      $('#render-upload-name').value = '';
      rememberWorkflow(renderOptions.model, body.id);
      await loadRenderOptions();
      $('#render-upload-note').textContent = body.approved
        ? `Added "${body.name}" and switched to it.`
        : `Added "${body.name}". It renders once the owner approves it.`;
    } catch (err) {
      note.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
  $('#btn-render-delete-workflow').addEventListener('click', async () => {
    const id = renderOptions?.workflow_id;
    if (!id) return;
    const name = renderOptions.workflow;
    const res = await fetch(`/api/render/workflows/${encodeURIComponent(id)}`, { method: 'DELETE', headers: USER_HEADER });
    if (!res.ok) return toast('Could not delete it');
    rememberWorkflow(renderOptions.model, null);
    await loadRenderOptions();
    toast(`Deleted "${name}"`);
  });
  $('#render-save-preset').addEventListener('click', async () => {
    const name = $('#render-preset-name').value.trim();
    if (!name) return toast('Give your preset a name');
    const s = renderSettings;
    const res = await fetch('/api/render/presets', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...USER_HEADER },
      body: JSON.stringify({ name, model: renderOptions.model, steps: s.steps, cfg: s.cfg, sampler: s.sampler, scheduler: s.scheduler, model_file: s.model_file }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return toast(body.message ?? 'Could not save it');
    // Into the list in place, so the select shows it without a refetch that
    // would reset what is on screen.
    renderOptions.my_presets = [...renderOptions.my_presets.filter((p) => p.name !== body.name), body];
    $('#render-preset-name').value = '';
    paintRender();
    toast(`Saved "${body.name}"`);
  });
  $('#render-delete-preset').addEventListener('click', async () => {
    const p = allPresets()[matchingPreset()];
    if (!p?.mine) return;
    const res = await fetch('/api/render/presets', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', ...USER_HEADER },
      body: JSON.stringify({ model: renderOptions.model, name: p.name }),
    });
    if (!res.ok) return toast('Could not delete it');
    renderOptions.my_presets = renderOptions.my_presets.filter((x) => x.name !== p.name);
    paintRender();
    toast(`Deleted "${p.name}"`);
  });

  // The size follows the builder's Aspect control, as the plan says
  // ("pre-filled from the Aspect control"); the pop-out can still override it.
  document.addEventListener('change', (e) => {
    if (renderSettings && e.target.matches?.('[data-bind="aspect_ratio"]')) {
      renderSettings.aspect = e.target.value;
      paintRender();
    }
  });

  $('#btn-render').addEventListener('click', () => startRender());
  $('#btn-render-again').addEventListener('click', () => startRender({ again: true }));
  $('#btn-render-cancel').addEventListener('click', () => {
    if (renderAbort) renderAbort.abort();
    else $('#render-progress').hidden = true;
  });
  $('#btn-render-download').addEventListener('click', async () => {
    if (!lastRender) return;
    try {
      const blob = await fetch(lastRender.url).then((r) => {
        if (!r.ok) throw new Error('That picture is gone from the server.');
        return r.blob();
      });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${lastRender.model}-${lastRender.settings.seed}.png`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      toast(err.message);
    }
  });
  $('#btn-render-pin').addEventListener('click', async (e) => {
    if (!lastRender) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const res = await fetch(`/api/render/${lastRender.id}/pin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...USER_HEADER },
        body: JSON.stringify({ brief: $('[data-bind="brief"]')?.value ?? '' }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message ?? 'Could not pin it.');
      toast(`Pinned as ${body.name}`);
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
    }
  });
}

// ── render models, owner only ────────────────────────────────
//
// The catalogue behind the Model dropdown and the LoRA matching. Every write
// goes to /api/admin/render, which the server refuses to anyone but the owner.

let renderCatalogue = null;

async function adminRender(method, route, body) {
  const res = await fetch(`/api/admin/render${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...USER_HEADER },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? `HTTP ${res.status}`);
  return data;
}

async function openRenderModels() {
  $('#render-models-modal').hidden = false;
  $('#render-models-note').textContent = 'Loading…';
  try {
    renderCatalogue = await adminRender('GET', '');
    $('#render-models-note').textContent = '';
    paintRenderModels();
  } catch (err) {
    $('#render-models-note').textContent = err.message;
  }
}

function paintRenderModels() {
  const c = renderCatalogue;
  // Uploads waiting for the owner: who, what for, and every node type in it.
  const pend = $('#render-pending-body');
  pend.innerHTML = '';
  $('#render-pending-wrap').hidden = !c.pending?.length;
  for (const w of c.pending ?? []) {
    const row = document.createElement('div');
    row.className = 'render-pending';
    row.dataset.user = w.user;
    row.dataset.id = w.id;
    const info = document.createElement('div');
    const head = document.createElement('div');
    head.className = 'lib-title';
    const labels = w.models.map((k) => c.models.find((m) => m.key === k)?.label ?? k).join(', ');
    head.textContent = `${w.name} · ${w.user} · for ${labels}`;
    const types = document.createElement('div');
    types.className = 'types';
    types.textContent = `Nodes: ${w.node_types.join(', ')}`;
    info.append(head, types);
    const actions = document.createElement('div');
    actions.className = 'render-cat-add';
    const ok = Object.assign(document.createElement('button'), { className: 'primary', type: 'button', textContent: 'Approve' });
    ok.dataset.act = 'approve';
    const no = Object.assign(document.createElement('button'), { className: 'danger', type: 'button', textContent: 'Refuse' });
    no.dataset.act = 'refuse';
    actions.append(ok, no);
    row.append(info, actions);
    pend.append(row);
  }

  const body = $('#render-models-body');
  body.innerHTML = '';
  const strip = (f) => String(f).replace(/\.safetensors$/, '');
  const input = (attrs) => Object.assign(document.createElement('input'), attrs);
  const labelled = (text, el) => {
    const l = document.createElement('label');
    l.className = 'field';
    const s = document.createElement('span');
    s.textContent = text;
    l.append(s, el);
    return l;
  };
  for (const m of c.models) {
    const box = document.createElement('div');
    box.className = 'render-cat';
    box.dataset.model = m.key;
    const title = document.createElement('div');
    title.className = 'render-cat-title';
    title.textContent = m.label;
    box.append(title);
    for (const f of m.files) {
      const row = document.createElement('div');
      row.className = 'render-cat-file';
      row.dataset.file = f.file;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = strip(f.file) + (f.file === m.workflow_file ? ' (workflow)' : '');
      const sampler = document.createElement('select');
      fillSelect(sampler, ['', ...c.samplers], f.sampler ?? '', (v) => v || 'sampler: preset');
      sampler.dataset.k = 'sampler';
      const scheduler = document.createElement('select');
      fillSelect(scheduler, ['', ...c.schedulers], f.scheduler ?? '', (v) => v || 'scheduler: preset');
      scheduler.dataset.k = 'scheduler';
      row.append(
        name,
        labelled('Steps', input({ type: 'number', min: 1, value: f.steps ?? '', placeholder: '–' })),
        labelled('CFG', input({ type: 'number', min: 0, step: 0.5, value: f.cfg ?? '', placeholder: '–' })),
        labelled('Sampler', sampler),
        labelled('Scheduler', scheduler)
      );
      row.querySelectorAll('input')[0].dataset.k = 'steps';
      row.querySelectorAll('input')[1].dataset.k = 'cfg';
      const text = document.createElement('div');
      text.className = 'render-cat-text';
      text.dataset.file = f.file;
      const prefix = input({ type: 'text', value: f.prefix ?? '', placeholder: 'trigger words or quality tags this file needs' });
      prefix.dataset.k = 'prefix';
      const neg = input({ type: 'text', value: f.negative ?? '', placeholder: m.has_negative ? 'blank = the model’s basic negative' : 'this model takes no negative' });
      neg.dataset.k = 'negative';
      neg.disabled = !m.has_negative;
      const actions = document.createElement('div');
      actions.className = 'render-cat-add';
      const save = Object.assign(document.createElement('button'), { className: 'primary', type: 'button', textContent: 'Save' });
      save.dataset.act = 'save-file';
      actions.append(save);
      if (f.own && f.file !== m.workflow_file) {
        const del = Object.assign(document.createElement('button'), { className: 'ghost', type: 'button', textContent: 'Remove' });
        del.dataset.act = 'remove-file';
        actions.append(del);
      }
      text.append(labelled('Prefix', prefix), labelled('Negative', neg), actions);
      box.append(row, text);
    }
    const addable = (c.installed[m.folder] ?? []).filter((f) => !m.files.some((x) => x.file === f));
    if (addable.length) {
      const add = document.createElement('div');
      add.className = 'render-cat-add';
      const sel = document.createElement('select');
      fillSelect(sel, addable, addable[0], strip);
      const btn = Object.assign(document.createElement('button'), { className: 'ghost', type: 'button', textContent: 'Add file' });
      btn.dataset.act = 'add-file';
      add.append(sel, btn);
      box.append(add);
    }
    body.append(box);
  }

  const lb = $('#render-loras-body');
  lb.innerHTML = '';
  if (!c.loras.length) {
    lb.innerHTML = '<div class="field-note">No LoRAs installed in ComfyUI’s loras folder.</div>';
  }
  for (const l of c.loras) {
    const row = document.createElement('div');
    row.className = 'render-cat-lora';
    row.dataset.file = l.file;
    const name = document.createElement('div');
    name.innerHTML = '<div class="name"></div><div class="arch"></div>';
    name.querySelector('.name').textContent = strip(l.file);
    name.querySelector('.arch').textContent = l.architecture ? `File says: ${l.architecture}` : 'The file does not say what it is for';
    const models = document.createElement('div');
    for (const m of c.models) {
      const lab = document.createElement('label');
      lab.className = 'render-check';
      const cb = input({ type: 'checkbox', checked: l.models.includes(m.key) });
      cb.dataset.model = m.key;
      lab.append(cb, document.createTextNode(m.label));
      models.append(lab);
    }
    const trig = input({ type: 'text', value: (l.own.triggers ?? l.file_triggers).join(', '), placeholder: 'trigger words, comma separated' });
    trig.dataset.k = 'triggers';
    const actions = document.createElement('div');
    actions.className = 'render-cat-add';
    const save = Object.assign(document.createElement('button'), { className: 'primary', type: 'button', textContent: 'Save' });
    save.dataset.act = 'save-lora';
    actions.append(save);
    if (Object.keys(l.own).length) {
      const reset = Object.assign(document.createElement('button'), { className: 'ghost', type: 'button', textContent: 'Go by the file' });
      reset.title = 'Forget your corrections and use what the file says';
      reset.dataset.act = 'reset-lora';
      actions.append(reset);
    }
    row.append(name, models, trig, actions);
    lb.append(row);
  }
}

function wireRenderModels() {
  const modal = $('#render-models-modal');
  const close = () => {
    modal.hidden = true;
    // The pop-out underneath reads the catalogue through its options.
    loadRenderOptions();
  };
  $('#render-models-close').addEventListener('click', close);
  modal.addEventListener('click', async (e) => {
    if (e.target === modal) return close();
    const act = e.target.dataset?.act;
    if (!act) return;
    const note = $('#render-models-note');
    const box = e.target.closest('.render-cat');
    try {
      if (act === 'approve' || act === 'refuse') {
        const row = e.target.closest('.render-pending');
        renderCatalogue = await adminRender('PUT', '/approve', { user: row.dataset.user, id: row.dataset.id, approve: act === 'approve' });
        // The buttons' count, now, rather than at the next status poll.
        setRenderPending(renderCatalogue.pending?.length ?? 0);
        note.textContent = act === 'approve' ? 'Approved: it can render now.' : 'Refused and deleted.';
      } else if (act === 'add-file') {
        const file = e.target.previousElementSibling.value;
        renderCatalogue = await adminRender('PUT', '/files', { file, model: box.dataset.model });
        note.textContent = `Added ${file}.`;
      } else if (act === 'save-file' || act === 'remove-file') {
        const file = e.target.closest('.render-cat-text').dataset.file;
        if (act === 'remove-file') {
          renderCatalogue = await adminRender('DELETE', '/files', { file });
          note.textContent = `Removed ${file}.`;
        } else {
          const fields = {};
          for (const el of box.querySelectorAll(`[data-file="${CSS.escape(file)}"] [data-k]`)) fields[el.dataset.k] = el.value;
          renderCatalogue = await adminRender('PUT', '/files', { file, model: box.dataset.model, ...fields });
          note.textContent = `Saved ${file}.`;
        }
      } else if (act === 'save-lora' || act === 'reset-lora') {
        const row = e.target.closest('.render-cat-lora');
        const file = row.dataset.file;
        const body = act === 'reset-lora'
          ? { file }
          : {
              file,
              models: [...row.querySelectorAll('input[data-model]')].filter((cb) => cb.checked).map((cb) => cb.dataset.model),
              triggers: row.querySelector('[data-k="triggers"]').value,
            };
        renderCatalogue = await adminRender('PUT', '/loras', body);
        note.textContent = act === 'reset-lora' ? `${file} goes by its file again.` : `Saved ${file}.`;
      }
      paintRenderModels();
    } catch (err) {
      note.textContent = err.message;
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) close();
  });
}

// ── prompt library ───────────────────────────────────────────
// Only meaningful when the server runs with accounts disabled (dev and the
// suites that predate them). With accounts on, identity comes from the
// session cookie and the server ignores this header entirely — which is the
// whole point, since anyone could set it.
const USER_HEADER = { 'x-promptforge-user': 'owner' };

async function refreshLibrary() {
  const host = $('#library-list');
  if (!host) return;
  try {
    const data = await fetch('/api/library', { headers: USER_HEADER }).then((r) => r.json());
    if (!data.entries?.length) {
      host.innerHTML =
        '<div class="empty-state"><strong>Nothing saved yet</strong>Generate a prompt and press Save.</div>';
      return;
    }
    host.innerHTML = '';
    for (const e of data.entries) {
      const row = document.createElement('div');
      row.className = 'lib-row';

      const meta = document.createElement('div');
      meta.className = 'lib-meta';
      const model = REGISTRY.models.find((m) => m.key === e.model);
      // `title` is typed by the user and stored on disk, so it comes back as
      // untrusted text. Built as nodes for the same reason as the error panel
      // and the tag list.
      const title = document.createElement('span');
      title.className = 'lib-title';
      title.textContent = e.title;
      const sub = document.createElement('span');
      sub.className = 'lib-sub';
      sub.textContent = `${model?.label ?? e.model} · ${new Date(e.created_at).toLocaleString()}`;
      meta.append(title, sub);

      const actions = document.createElement('div');
      actions.className = 'lib-actions';

      const load = document.createElement('button');
      load.className = 'ghost';
      load.textContent = 'Load';
      load.addEventListener('click', () => loadLibraryEntry(e));

      const del = document.createElement('button');
      del.className = 'ghost';
      del.textContent = 'Delete';
      del.addEventListener('click', async () => {
        const r = await fetch(`/api/library/${e.id}`, { method: 'DELETE', headers: USER_HEADER });
        toast(r.ok ? 'Deleted' : 'Delete failed');
        refreshLibrary();
      });

      actions.append(load, del);
      row.append(meta, actions);
      host.appendChild(row);
    }
  } catch {
    host.innerHTML = '<div class="empty-state"><strong>Library unavailable</strong></div>';
  }
}

/**
 * A reference role's hint: its `rule`, plus a small ⓘ popout when the role
 * declares `info` (26 Sep 2026, first used by General 18+). <details> rather
 * than a hover title so it opens on a tap as well as a click.
 */
function paintRoleHint(el, def) {
  el.textContent = def?.rule ?? '';
  if (!def?.info) return;
  const more = document.createElement('details');
  more.className = 'role-info';
  const tip = document.createElement('summary');
  tip.textContent = 'ⓘ';
  tip.title = 'What is this one for?';
  const body = document.createElement('div');
  body.className = 'role-info-body';
  body.textContent = def.info;
  more.append(tip, body);
  el.append(' ', more);
}

// ── system prompts people write themselves ───────────────────
//
// A block replaces the shipped prompt for whoever switches it on, so this
// panel has two jobs and they are different: choosing which one is active for
// the model on screen, and reading and writing the blocks themselves. The
// selector does the first; the list under it does the second.
//
// Everything is per model. An Anima prompt is not an H3 prompt, and offering
// one where the other belongs is how ten models start producing one dialect.
let SYSPROMPTS = [];
let SYSPROMPT_DEFAULT_ID = null;   // the group default for the model on screen
let editingBlockId = null;

/** Owner-only: make a block the default for this model, or archive/restore it. */
async function setSysPromptFlags(id, body, done) {
  const r = await fetch(`/api/system-prompts/${id}/flags`, {
    method: 'POST',
    headers: { ...USER_HEADER, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  toast(r.ok ? done : data.message ?? 'Could not change it');
  refreshSystemPrompts();
}

async function refreshSystemPrompts() {
  const sel = $('#sysprompt-active');
  const host = $('#sysprompt-list');
  if (!sel || !host || !currentModel) return;

  try {
    const data = await fetch('/api/system-prompts', { headers: USER_HEADER }).then((r) => r.json());
    SYSPROMPTS = data.entries ?? [];
    const me = ME?.user?.username ?? data.user;
    // A block declares every model it works for, so the same one can appear
    // under Illustrious, Pony and Anima without being written three times.
    const forModel = SYSPROMPTS.filter((b) => (b.models ?? [b.model]).includes(currentModel.key));
    // Archived ones leave everyone's list (26 Sep 2026); the owner still sees
    // them in their own section below, with Restore.
    const mine = forModel.filter((b) => !b.archived);
    const archived = forModel.filter((b) => b.archived);
    const isDefault = (b) => (b.default_for ?? []).includes(currentModel.key);
    const defaultBlock = mine.find(isDefault) ?? null;
    SYSPROMPT_DEFAULT_ID = defaultBlock?.id ?? null;
    // No preference = the group default (or Base when there is none); "base"
    // = Base on purpose. Same rule the server applies at generate time.
    const activeId = PREFS?.system_prompts?.[currentModel.key] ?? '';

    sel.innerHTML = '';
    // "Base" is the prompt this repo ships. Named rather than described,
    // because it is the thing people will refer to out loud.
    const shipped = document.createElement('option');
    shipped.value = 'base';
    shipped.textContent = 'Base';
    sel.appendChild(shipped);
    for (const b of mine) {
      const opt = document.createElement('option');
      opt.value = b.id;
      // Author included because these are shared: "Anima v2" means something
      // different depending on who wrote it.
      opt.textContent = `${b.title} — ${b.author}${isDefault(b) ? ' · default' : ''}`;
      sel.appendChild(opt);
    }
    sel.value = activeId === 'base'
      ? 'base'
      : mine.some((b) => b.id === activeId) ? activeId : (defaultBlock?.id ?? 'base');

    // The note under the selector is the warning, and it only applies when a
    // replacement is actually on.
    // Only says anything when Base is NOT what is running. On Base there is
    // nothing to warn about, and a line that is always there is furniture.
    const note = $('#sysprompt-note');
    if (note) {
      const active = mine.find((b) => b.id === sel.value);
      note.hidden = !active;
      if (active) {
        note.textContent =
          `Running "${active.title}" by ${active.author} instead of the base prompt. ` +
          `The base prompt for ${currentModel.label} is not loaded, and neither are ` +
          `the dialect measurements taken against it.`;
      }
    }

    host.innerHTML = '';
    if (!mine.length) {
      host.innerHTML =
        '<div class="empty-state"><strong>Nobody has written one for this model</strong>' +
        'Press "Write one" to replace what this app ships, for yourself.</div>';
      // No return: the owner's Archived section below still has to draw.
    }
    for (const b of mine) {
      const row = document.createElement('div');
      row.className = 'lib-row';
      const meta = document.createElement('div');
      meta.className = 'lib-meta';
      const title = document.createElement('span');
      title.className = 'lib-title';
      title.textContent = isDefault(b) ? `${b.title} · default` : b.title;
      const sub = document.createElement('span');
      sub.className = 'lib-sub';
      sub.textContent =
        `${b.author} · ${b.body.length.toLocaleString()} chars · ` +
        `${new Date(b.updated_at).toLocaleString()}`;
      meta.append(title, sub);

      const actions = document.createElement('div');
      actions.className = 'lib-actions';

      const read = document.createElement('button');
      read.className = 'ghost';
      // The author edits; everyone else reads. Both open the same modal, and
      // the modal decides — a read-only view is the honest label for what a
      // non-author gets, since Save would be refused server-side anyway.
      read.textContent = b.author === me ? 'Edit' : 'Read';
      read.addEventListener('click', () => openSysPrompt(b, b.author === me));

      const copy = document.createElement('button');
      copy.className = 'ghost';
      copy.textContent = 'Copy to mine';
      copy.addEventListener('click', async () => {
        const r = await fetch(`/api/system-prompts/${b.id}/copy`, {
          method: 'POST',
          headers: USER_HEADER,
        });
        toast(r.ok ? 'Copied — edit it as your own' : 'Copy failed');
        refreshSystemPrompts();
      });

      actions.append(read, copy);

      if (IS_OWNER) {
        const makeDefault = document.createElement('button');
        makeDefault.className = 'ghost';
        makeDefault.textContent = isDefault(b) ? 'Remove default' : 'Make default';
        makeDefault.title = `What everyone runs for ${currentModel.label} until they pick something else`;
        makeDefault.addEventListener('click', () =>
          setSysPromptFlags(b.id, { default_for: currentModel.key, default: !isDefault(b) },
            isDefault(b) ? 'No default — Base again for everyone who has not picked' : `"${b.title}" is the default now`));
        const archive = document.createElement('button');
        archive.className = 'ghost';
        archive.textContent = 'Archive';
        archive.title = 'Take it out of everyone\'s list without deleting it';
        archive.addEventListener('click', () => setSysPromptFlags(b.id, { archived: true }, `"${b.title}" archived`));
        actions.append(makeDefault, archive);
      }

      if (b.author === me || IS_OWNER) {
        const del = document.createElement('button');
        del.className = 'ghost';
        del.textContent = 'Delete';
        del.addEventListener('click', async () => {
          const r = await fetch(`/api/system-prompts/${b.id}`, {
            method: 'DELETE',
            headers: USER_HEADER,
          });
          const body = await r.json().catch(() => ({}));
          toast(r.ok ? 'Deleted' : body.message ?? 'Delete failed');
          refreshSystemPrompts();
        });
        actions.appendChild(del);
      }

      row.append(meta, actions);
      host.appendChild(row);
    }
    // The owner's view of what was archived, so nothing is lost by it.
    if (IS_OWNER && archived.length) {
      const head = document.createElement('div');
      head.className = 'panel-title';
      head.style.margin = '14px 0 6px';
      head.textContent = `Archived (${archived.length})`;
      host.appendChild(head);
      for (const b of archived) {
        const row = document.createElement('div');
        row.className = 'lib-row';
        const meta = document.createElement('div');
        meta.className = 'lib-meta';
        meta.append(
          Object.assign(document.createElement('span'), { className: 'lib-title', textContent: b.title }),
          Object.assign(document.createElement('span'), { className: 'lib-sub', textContent: `${b.author} · archived` })
        );
        const actions = document.createElement('div');
        actions.className = 'lib-actions';
        const restore = document.createElement('button');
        restore.className = 'ghost';
        restore.textContent = 'Restore';
        restore.addEventListener('click', () => setSysPromptFlags(b.id, { archived: false }, `"${b.title}" is back in the list`));
        actions.appendChild(restore);
        row.append(meta, actions);
        host.appendChild(row);
      }
    }
  } catch {
    host.innerHTML = '<div class="empty-state"><strong>System prompts unavailable</strong></div>';
  }
}

/** Open the editor. `mine` decides whether Save is offered at all. */
function openSysPrompt(block, mine) {
  editingBlockId = block?.id ?? null;
  const modal = $('#sysprompt-modal');
  if (!modal) return;
  $('#sysprompt-modal-title').textContent = block
    ? mine ? 'Edit your system prompt' : `${block.title} — by ${block.author}`
    : 'Write a system prompt';
  $('#sysprompt-title').value = block?.title ?? '';
  $('#sysprompt-body').value = block?.body ?? '';
  $('#sysprompt-message').hidden = true;

  // Every image and video model in the registry, ticked where this block
  // already applies. A new one starts with the model you are looking at.
  const host = $('#sysprompt-models');
  host.querySelectorAll('.share-model').forEach((n) => n.remove());
  const on = new Set(block ? block.models ?? [block.model] : [currentModel?.key]);
  for (const m of REGISTRY.models) {
    const label = document.createElement('label');
    label.className = 'share-model';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = m.key;
    box.checked = on.has(m.key);
    const name = document.createElement('span');
    name.textContent = m.label;
    label.append(box, name);
    host.appendChild(label);
  }

  // Somebody else's block is readable, not writable. The server refuses the
  // edit either way; hiding the buttons is what makes that legible rather
  // than a surprise on save.
  const editable = !block || mine;
  $('#sysprompt-title').disabled = !editable;
  $('#sysprompt-body').disabled = !editable;
  $('#sysprompt-models').querySelectorAll('input').forEach((b) => { b.disabled = !editable; });
  $('#sysprompt-save').hidden = !editable;
  $('#sysprompt-load-shipped').hidden = !editable;
  $('#sysprompt-file-pick').hidden = !editable;

  paintSysPromptCount();
  modal.hidden = false;
}

function paintSysPromptCount() {
  const out = $('#sysprompt-count');
  const body = $('#sysprompt-body');
  if (out && body) out.textContent = body.value.length ? `${body.value.length.toLocaleString()} chars` : '';
}

async function loadLibraryEntry(entry) {
  // Switching to the saved entry's model first, so its template and controls
  // are the ones the prompt was written against.
  if (entry.model !== currentModel?.key) {
    const model = REGISTRY.models.find((m) => m.key === entry.model);
    if (model) {
      currentType = model.type;
      $$('#type-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.type === currentType));
      rebuildModelSelect();
      $('#model-select').value = entry.model;
      await selectModel(entry.model);
    }
  }
  const brief = $('[data-bind="brief"]');
  if (brief) {
    brief.value = entry.brief ?? '';
    brief.dispatchEvent(new Event('input'));
  }
  const mount = $('#output-mount');
  mount.innerHTML = '';
  history = [];
  story = null;
  lastResult = { segments: entry.segments, model: entry.model, simple: entry.simple ?? null, sessionId: entry.sessionId ?? null };
  for (const seg of shownSegments(lastResult, currentModel, promptStyle)) {
    mount.appendChild(segmentEl(currentModel, seg));
  }
  clearRenderResult();
  // A session entry brings its picture back, while the server still has it.
  if (entry.render?.url) {
    lastRender = entry.render;
    showRenderResult(entry.render);
  }
  updateActionButtons();
  toast(`Loaded "${entry.title}"`);
}

function isMonoSegment(model, label) {
  if (/negative/i.test(label)) return true;
  if (/positive/i.test(label)) return model.template === 'booru' || model.template === 'hybrid';
  return false;
}

function segmentEl(model, seg) {
  // A segment whose whole body is N/A has nothing to say — SKILL.md's own
  // rule. h3 emits four of them in base mode, and as full cards they filled
  // the output panel and pushed the actual prompt off screen. Rendered as a
  // compact muted row instead, and still rendered rather than hidden: seeing
  // that Subject definitions came back N/A is how you confirm base mode
  // behaved, and a silently missing card looks like a dropped segment.
  const isEmpty = /^n\/a$/i.test((seg.body ?? '').trim());

  const wrap = document.createElement('div');
  wrap.className = `segment${seg.label === 'Refused' ? ' refused' : ''}${isEmpty ? ' empty' : ''}`;
  wrap.dataset.label = seg.label;

  const head = document.createElement('div');
  head.className = 'segment-head';
  const lab = document.createElement('span');
  lab.className = 'segment-label';
  // Never translated. A segment label is the model's OUTPUT CONTRACT — the
  // exact string after `===SEGMENT:` that registry.mjs validates against the
  // "Segments to emit" list in the model's own prompt file. It is registry
  // data in the same way a model name is, not chrome.
  //
  // Caught in a browser: with the interface in French the panel read
  // "Positive prompt / Prompt négatif / Reasoning", because only one of the
  // three happened to be in the dictionary. Half a translated contract is
  // worse than none of one — it reads as a rendering fault, and it hides
  // which field the model actually emitted.
  lab.dataset.noI18n = '';
  lab.textContent = seg.label;
  head.append(lab);

  // No copy button on an empty one. "N/A" is not something anyone needs on
  // their clipboard, and offering it implies there is content to take.
  if (!isEmpty) {
    const btn = document.createElement('button');
    btn.className = 'ghost';
    btn.textContent = 'Copy';
    // Segment copy strips the field prefix — copying "Summary" must not paste
    // the word "summary:" into the target tool.
    const fieldName = model?.segment_fields?.[seg.label];
    btn.addEventListener('click', () => copyText(stripPrefix(seg.label, wrap.dataset.body ?? '', fieldName), `${seg.label} copied`));
    head.append(btn);
  }

  const body = document.createElement('div');
  body.className = `segment-body${isMonoSegment(model, seg.label) ? ' mono' : ''}`;
  body.textContent = seg.body;
  wrap.dataset.body = seg.body;

  wrap.append(head, body);
  return wrap;
}

// A segment can have two names: the friendly UI label shown above the panel,
// and the official field name a model's prompt may write as its own prefix
// instead (declared per-model in segment_fields). Strip whichever one is
// actually present so a copy-pasted body never carries a stray label.
export function stripPrefix(label, body, fieldName) {
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const alts = [label, fieldName].filter(Boolean).map(escape);
  const re = new RegExp(`^\\s*(?:${alts.join('|')})\\s*:\\s*`, 'i');
  return body.replace(re, '');
}

function renderError(data) {
  const box = document.createElement('div');
  box.className = 'error-box';
  const msg = document.createElement('div');
  // textContent, not innerHTML. `message` is not always fixed server text: the
  // unknown_segment and missing_segment messages embed segment labels taken
  // from the model's own output, so a model emitting
  // `===SEGMENT: <img src=x onerror=...>===` would have injected markup here.
  // Only reachable by the person who submitted the brief, and the app is behind
  // a login on the tailnet, so this was low severity — but there is no reason
  // to render model output as HTML.
  const code = document.createElement('span');
  code.className = 'code';
  code.textContent = data.code ?? 'error';
  msg.appendChild(code);
  msg.appendChild(document.createElement('br'));
  msg.appendChild(document.createTextNode(data.message ?? 'Something went wrong.'));
  box.appendChild(msg);
  if (data.verbatim) {
    const pre = document.createElement('pre');
    pre.textContent = data.verbatim;
    box.appendChild(pre);
  }
  if (data.partial) {
    const pre = document.createElement('pre');
    pre.textContent = `Partial output kept:\n${data.partial}`;
    box.appendChild(pre);
  }
  const retry = document.createElement('button');
  retry.className = 'ghost';
  retry.textContent = 'Retry';
  retry.style.marginTop = '10px';
  retry.addEventListener('click', () => generate());
  box.appendChild(retry);
  return box;
}

// ── how long it took ─────────────────────────────────────────
//
// One formatter for both places a duration is shown — the live counter in the
// progress bar and the stamp left on the output afterwards. Shared so the
// number cannot change shape when the bar disappears and the stamp replaces
// it: whatever it said at the last tick is what stays on screen.
export function formatElapsed(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

// The bar is gone the moment the answer lands, and with it the only record of
// what the wait actually was. Asked for 5 Sep 2026 after a run that felt much
// longer than it was: the tool rounds show no progress at all (the segment
// parser is fed in one push at the end on a tool run, so the bar sits at
// "0 of 3" for the whole generation), and without a number afterwards there is
// nothing to compare one setting against another with.
//
// **Wall clock, from pressing Generate to the last segment.** Not the model's
// own timing — queue wait and the character lookup are part of what the
// person waited through, and a number that excluded them would disagree with
// the counter they had just been watching.
//
// Stamped on the positive prompt because that is the segment people read
// first and the one at the top of the panel. It is the whole generation's
// time, not that segment's — no segment has a time of its own, they all come
// out of one call.
function stampElapsed(mount, ms) {
  if (!mount || !Number.isFinite(ms)) return;
  const cards = [...mount.querySelectorAll('.segment:not(.empty)')];
  // The positive prompt by name, falling back to whatever came first. Prose
  // models do not all label a segment "Positive prompt", and the top card is
  // the right place in either case.
  const card =
    cards.find((c) => /positive/i.test(c.dataset.label ?? '')) ?? cards[0];
  const head = card?.querySelector('.segment-head');
  if (!head) return;

  head.querySelector('.segment-time')?.remove();
  const span = document.createElement('span');
  span.className = 'segment-time';
  // Same rule as the segment label beside it: a duration is a measurement,
  // not chrome, and half a translated header reads as a rendering fault.
  span.dataset.noI18n = '';
  span.textContent = formatElapsed(ms);
  span.title = 'Time from pressing Generate to the finished prompt';
  head.querySelector('.segment-label')?.after(span);
}

// ── generation progress ──────────────────────────────────────
//
// The bar tracks SEGMENTS COMPLETED against the segment list the registry
// says this model emits - not elapsed time, and not an invented percentage.
// That list is already authoritative: registry.mjs validates it against the
// "Segments to emit" heading in the model's own prompt file at boot, and the
// parser drives its output contract from it. So "3 of 5" here is a fact.
//
// Deliberately NOT a time estimate. h3 on the 27B ranges from ~19s with
// thinking off to ~240s with it on, and the first generation after a model
// switch pays an ~33s load on top. A bar that pretended to know how long
// that would take would be lying most of the time.
//
// Stop is real, not cosmetic: server.mjs does req.on('close', () => abort())
// on the generate route, so dropping the connection aborts the upstream LLM
// call and gives the VRAM back rather than leaving it running unwatched.
function createGenProgress(model, onStop) {
  // The registry's list until the server says otherwise. A request's contract
  // can be shorter than the model's - h3's base modes ask for three segments,
  // REF2VA for seven - and only the server knows which mode Auto detect
  // resolved to, so it sends the real list as a `contract` event.
  let expected = Array.isArray(model?.segments) ? model.segments : [];

  const el = document.createElement('div');
  el.className = 'genbar';

  const head = document.createElement('div');
  head.className = 'genbar-head';
  const phase = document.createElement('strong');
  phase.textContent = 'Generating…';
  const time = document.createElement('span');
  time.className = 'genbar-time';
  time.textContent = '0s';
  const stop = document.createElement('button');
  stop.type = 'button';
  stop.className = 'ghost genbar-stop';
  stop.textContent = 'Stop';
  stop.addEventListener('click', () => { stop.disabled = true; onStop(); });
  head.append(phase, time, stop);
  el.appendChild(head);

  const track = document.createElement('div');
  track.className = 'genbar-track';
  const fill = document.createElement('div');
  fill.className = 'genbar-fill';
  track.appendChild(fill);
  el.appendChild(track);

  const hint = document.createElement('p');
  hint.className = 'genbar-hint';
  el.appendChild(hint);

  const started = Date.now();
  const timer = setInterval(() => {
    time.textContent = formatElapsed(Date.now() - started);
  }, 1000);

  let done = 0;

  const paint = () => {
    if (!expected.length) {
      // A model with no declared segments cannot have a meaningful bar. Show
      // the indeterminate state and say nothing false about progress.
      el.classList.add('indeterminate');
      hint.textContent = 'This model does not declare its segments, so there is nothing to count.';
      return;
    }
    // Before the first segment lands, sit at a visible sliver rather than 0 -
    // an empty bar next to a spinner reads as "stuck".
    const pct = done === 0 ? 4 : Math.round((done / expected.length) * 100);
    fill.style.width = pct + '%';
    el.classList.toggle('indeterminate', done === 0);
    hint.textContent = done >= expected.length
      ? 'Finishing up.'
      : done + ' of ' + expected.length + ' segments · next: ' + expected[done];
  };
  paint();

  return {
    el,
    /** A backend state - queued, model loading - rather than segment progress. */
    say(text) { phase.textContent = text; },
    /** The segments this request will actually return, from the server. */
    expect(list) {
      if (!Array.isArray(list) || !list.length) return;
      expected = list;
      paint();
    },
    /** One segment finished. The label keeps the count honest. */
    segment(label) {
      if (expected.length && !expected.includes(label)) return;
      done = Math.min(done + 1, expected.length || done + 1);
      phase.textContent = done >= expected.length
        ? 'Finishing…'
        : 'Writing: ' + expected[done];
      paint();
    },
    /**
     * Milliseconds since the bar went up, which is the number it has been
     * showing. Readable after remove() — only the interval is cleared, the
     * start time lives in this closure — so the done handler can take it
     * without having to keep a second clock of its own.
     */
    elapsed() { return Date.now() - started; },
    remove() { clearInterval(timer); el.remove(); },
  };
}

// ── generation over SSE ──────────────────────────────────────
// ── Tab title, for when the answer lands and nobody is looking ───────────
//
// A generation runs about 100 seconds on the P40 and the queue is concurrency
// 1, so somebody who starts one and switches tab can be waiting several
// minutes on other people's jobs before their own even begins. They tab away.
// They miss it.
//
// **There is no browser notification to send them.** The Notification API
// needs a secure context, and this app is served over plain HTTP on the
// tailnet — so requestPermission() is refused for everybody except whoever is
// sitting at the box itself on localhost. Testing it locally would pass and
// then fail for all four of them, which is the worst way to find out. The
// title is the one channel that always works and asks nobody for permission.
//
// **Only while the tab is hidden.** If they are looking at the page then the
// output is already on screen, and relabelling the tab of a page somebody is
// reading tells them nothing they cannot see.
// Read on first use, not at module load. scripts/test-app.mjs imports this
// file into Node to exercise the pure helpers, and there is no `document`
// there — a top-level document.title threw on import and took the whole suite
// with it, which is exactly what that suite is for.
let baseTitle = null;
let titleFlag = null;
const hasDom = () => typeof document !== 'undefined';

/** @param {'done'|'error'} state */
function flagTab(state) {
  if (!hasDom() || !document.hidden) return;
  baseTitle ??= document.title;
  titleFlag = state;
  document.title = state === 'error' ? `Failed - ${baseTitle}` : `Done - ${baseTitle}`;
}

function clearTabFlag() {
  if (!titleFlag || !hasDom()) return;
  titleFlag = null;
  document.title = baseTitle ?? document.title;
}

// Cleared on returning to the tab rather than after a timer: the flag means
// "something finished while you were away", and coming back is what makes that
// no longer true.
if (hasDom()) {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) clearTabFlag();
  });
}

async function generate() {
  if (generating || !currentModel) return;
  // MOSS Layout JSON: the brief, or, left empty, the Layout Studio's Global
  // prompt — a scene written there, around boxes drawn by hand.
  const layoutOnly = wantsLayout(currentModel);
  const typed = $('[data-bind="brief"]')?.value ?? '';
  const brief = layoutOnly && !typed.trim() ? layoutStudio()?.getProject().caption ?? '' : typed;
  if (!brief.trim() && !readShotBriefs().some((row) => row.trim())) {
    return toast(layoutOnly ? 'Write a brief, or a Global prompt' : 'Write a brief first');
  }

  clearTabFlag();
  generating = true;
  setGenerateEnabled(false);

  // Layout JSON has no Output panel: progress, errors and the negative prompt
  // go under Generate, and the JSON goes onto the studio (applyLayoutToStudio).
  const mount = (layoutOnly && $('#builder-mount [data-bind="layout_status"]')) || $('#output-mount');
  const shown = (label) => !(layoutOnly && label === 'Layout JSON');
  mount.innerHTML = '';
  // A new prompt starts a new story.
  story = null;
  // A new prompt is coming; the last picture belonged to the old one.
  clearRenderResult();

  // Aborting the fetch closes the SSE connection, which the server treats as
  // a cancellation of the upstream call - see server.mjs:543. Stopping is
  // therefore free of a half-finished generation still burning the GPU.
  const controller = new AbortController();
  let stopped = false;
  const note = createGenProgress(currentModel, () => {
    stopped = true;
    controller.abort();
  });
  mount.appendChild(note.el);

  const seen = new Map();
  // The role-isolated read of the reference pictures, when one happened. Kept
  // with the result rather than only shown, because the second pass needs it:
  // that call gets the reading instead of the pictures, so it judges the
  // draft against exactly what the draft was written from.
  let referenceRead = '';

  // h3's picture tiles, numbered as the server will number them. Their
  // descriptions go with the request (collectControls) and are used as they
  // are; the server scans only the pictures that have none.
  const pictureTiles = currentPictureTiles();
  closeReadingCard();

  // Kept: a MOSS layout goes back onto the canvas it was sent with.
  const sentControls = collectControls();
  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: currentModel.key,
        brief,
        controls: sentControls,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
      note.remove();
      mount.appendChild(renderError({ code: err.error ?? 'error', message: err.message }));
      return;
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });

      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(frame);
        const da = /^data: (.+)$/m.exec(frame);
        if (!ev || !da) continue;
        const data = JSON.parse(da[1]);

        if (ev[1] === 'queued') {
          note.say(`Waiting — ${data.position - 1 || 0} ahead of you`);
        } else if (ev[1] === 'status') {
          // A backend still loading the model is a wait, not a failure — the
          // request is being retried behind this, so say what is happening
          // rather than leaving "Generating…" up for a minute.
          //
          // `character_lookup` is the same idea for a shorter pause: the
          // server is reading canon off danbooru before the first token, and
          // an unexplained second — or fifteen, on a cold cache — reads as a
          // stall. See characterCanon in server.mjs.
          const PHASES = {
            model_loading: 'Loading model…',
            character_lookup: 'Looking up character…',
            // The second pass, which is a whole extra generation. Without a
            // label this is the longest unexplained pause in the app.
            revising: 'Re-reading and revising…',
            // The look-first half of the reference pipeline: a whole call
            // that produces no prompt, so without a label it is a minute of
            // "Generating…" with nothing to show for it.
            reading_references: 'Looking at your references…',
          };
          // The Director's keyframes, counted. Unlike every phase above there
          // are N of these and each is a whole vision call, so a static label
          // would sit unchanged for minutes on an eight-segment timeline and
          // read as a hang. The count is the only thing that says it is
          // moving.
          if (data.state === 'reading_keyframes') {
            const total = Number(data.total) || 0;
            const done = Number(data.done) || 0;
            note.say(
              total > 1
                ? `Looking at keyframe ${done + 1} of ${total}…`
                : 'Looking at your keyframe…'
            );
          } else note.say(PHASES[data.state] ?? 'Generating…');
        } else if (ev[1] === 'warning') {
          // Server-side warnings had nowhere to land until 8 Sep 2026 — the
          // generate route has sent these since reference pictures shipped
          // and this branch did not exist, so "that model cannot see images"
          // was written to a stream nothing read. Prepended, like the
          // over-limit note below: the segments own the rest of the panel.
          const w = document.createElement('p');
          w.className = 'warning';
          w.textContent = data.message;
          mount.prepend(w);
        } else if (ev[1] === 'reference_analysis') {
          // What the model actually saw in the pictures, before it wrote a
          // word of the prompt. On screen because it is the only way to tell
          // a bad reading from a bad prompt written off a good one.
          referenceRead = data.text ?? '';
          if (referenceRead) mount.prepend(referenceReadEl(referenceRead));
        } else if (ev[1] === 'keyframe_readings') {
          // The same thing for the Director's timeline: what was seen in each
          // keyframe, before a word of the prompt was written. Folded shut
          // like the reference read, because on an eight-segment timeline
          // this is eight paragraphs and the prompt is what the panel is for.
          //
          // Prepended in REVERSE, which is what puts them in order. Each
          // prepend goes above the last, so walking the list forwards leaves
          // segment 1 at the bottom and the highest-numbered one on top —
          // shipped that way and spotted on a three-segment run, where the
          // panel read "segment 3" then "segment 1". Timeline order is the
          // only order these mean anything in.
          for (const r of [...(data.readings ?? [])].reverse()) {
            if (r?.text) mount.prepend(referenceReadEl(r.text, `What the model saw in segment ${r.index}'s keyframe`));
          }
        } else if (ev[1] === 'picture_readings') {
          // h3: what was seen in each reference picture. Onto the tiles, behind
          // their eye buttons, rather than into the output panel.
          for (const r of data.readings ?? []) placeReading(pictureTiles, r?.labels, r?.text);
        } else if (ev[1] === 'tool') {
          // The model looked something up. Named, with what it searched for,
          // for the same reason the web search says what it is searching:
          // several tool rounds on a 27B is minutes of a progress bar that
          // would otherwise say "Generating…" the whole way through, and a
          // person watching has no way to tell work from a hang.
          const what = (data.queries ?? []).join(', ');
          note.say(what ? `Checking tags: ${what}…` : 'Checking tags…');
        } else if (ev[1] === 'contract') {
          // The segment list this request will return, which can be shorter
          // than the registry's. Without it an h3 T2VA bar would sit at
          // "3 of 7" and then jump to done.
          note.expect(data.labels);
        } else if (ev[1] === 'segment') {
          // Progressive render: each segment appears as it completes.
          if (!seen.has(data.label)) {
            const el = segmentEl(currentModel, data);
            seen.set(data.label, el);
            if (shown(data.label)) mount.appendChild(el);
            note.segment(data.label);
          }
        } else if (ev[1] === 'done') {
          // Read before remove(), so the stamp is the same number the counter
          // was showing rather than one measured a tick later.
          const took = note.elapsed();
          note.remove();
          flagTab('done');
          if (lastResult) history.push(lastResult);
          // `ms` travels with the result, so undoing back to this one brings
          // its time back with it rather than showing the newer run's.
          lastResult = {
            segments: data.segments,
            model: currentModel.key,
            ms: took,
            simple: data.simple_prompt ?? null,
            // Undo carries it too, so a second pass run after undoing back to
            // an older draft still gets that draft's own reading.
            referenceRead: data.reference_analysis ?? referenceRead ?? '',
            // Which pictures that reading was made from; a revision reuses
            // the reading only while they are still the ones selected.
            referenceIdentity: data.reference_analysis_identity ?? '',
          };
          if (sentControls.layout) applyLayoutToStudio(data.segments, sentControls.layout);
          // Into the session list. After lastResult so a failure here cannot
          // cost the person the output that is already on screen.
          lastResult.sessionId = recordSessionPrompt({
            model: currentModel.key,
            brief,
            segments: data.segments,
            simple: data.simple_prompt ?? null,
          });
          // The server cleans two things after the last token: tags leaking
          // out of the aspect control, and the negative-prompt defects
          // server/negative.mjs handles. Segments were rendered as they
          // streamed, so without this the panel keeps SHOWING the raw text
          // while Copy, Save and Download all give the cleaned version - and
          // a panel that disagrees with its own copy button is worse than
          // either answer alone. Found 22 Aug while testing the aspect strip;
          // the negative cleanup had the same gap since it shipped.
          //
          // The segment's own Copy button reads wrap.dataset.body, not the
          // text on screen, so that is swapped too. Until 15 Sep 2026 only the
          // screen was, and Copy handed back the raw stream - on Anima v5 that
          // is the `Core tags:` / `Description:` lines the third pass joins
          // away, pasted into ComfyUI with the labels still in.
          // A segment the server wrote after the stream (h3 picture labels'
          // Retention analysis) never streamed in, so it is added here, in
          // the place the registry orders it.
          const order = currentModel.segments ?? [];
          for (const seg of data.segments ?? []) {
            if (seen.has(seg.label) || !seg.body || !shown(seg.label)) continue;
            const el = segmentEl(currentModel, seg);
            const at = order.indexOf(seg.label);
            const before = [...seen].find(([label]) => at >= 0 && order.indexOf(label) > at)?.[1];
            if (before) before.before(el);
            else mount.appendChild(el);
            seen.set(seg.label, el);
          }
          for (const seg of data.segments ?? []) {
            const wrap = seen.get(seg.label);
            if (wrap) wrap.dataset.body = seg.body;
            const node = wrap?.querySelector('.segment-body');
            if (node && node.textContent !== seg.body) node.textContent = seg.body;
          }
          // The fields streamed in as they were written; in Simple they are
          // now swapped for the one assembled card.
          if (lastResult.simple && promptStyle === 'simple') repaintSegments();
          stampElapsed(mount, took);
          if (data.over_limit) {
            const w = document.createElement('p');
            w.className = 'warning';
            w.textContent = `Output is ${data.over_limit.actual.toLocaleString()} characters, over this model's ${data.over_limit.limit.toLocaleString()} limit.`;
            mount.prepend(w);
          }
          updateActionButtons();
        } else if (ev[1] === 'error') {
          note.remove();
          flagTab('error');
          mount.appendChild(renderError(data));
        }
      }
    }
  } catch (err) {
    note.remove();
    // An abort the person asked for is not an error. Anything already
    // streamed stays on screen - it is real output, just incomplete - with a
    // line saying so rather than a red box blaming the network.
    if (stopped || err.name === 'AbortError') {
      const msg = document.createElement('p');
      msg.className = 'stream-note';
      msg.textContent = seen.size
        ? 'Stopped after ' + seen.size + ' segment' + (seen.size === 1 ? '' : 's') + '. What arrived is below.'
        : 'Stopped before anything came back.';
      mount.prepend(msg);
    } else {
      flagTab('error');
      mount.appendChild(renderError({ code: 'network', message: err.message }));
    }
  } finally {
    generating = false;
    setGenerateEnabled(true);
    refreshStatus();
  }
}

// ── model switching ──────────────────────────────────────────
async function selectModel(key) {
  currentModel = REGISTRY.models.find((m) => m.key === key);
  if (!currentModel) return;
  // A user must never see one model's result sitting under another's name.
  history = [];
  clearOutput(`No prompt yet for ${currentModel.label}`);
  // The Render section is per model too: its workflow, presets and sizes.
  loadRenderOptions();
  // Immediately, not on the next poll: a target that pins its own LLM has to
  // disable this control the moment you land on it, or there is a window where
  // it offers a choice that would be ignored.
  renderPromptLlm();
  // Which system prompt is active is a per-model question, so the panel
  // follows the tab rather than being painted once at boot.
  refreshSystemPrompts();
  await renderBuilder(currentModel);
}

function rebuildModelSelect() {
  const sel = $('#model-select');
  const models = modelsOfType(currentType);

  // Honour the saved default where it belongs to the group being shown. A
  // model can be dropped from config/models.yaml, so a stale preference must
  // fall back to the first entry rather than selecting nothing. The server
  // checks this too; this is the half that keeps the UI honest if PREFS is
  // stale.
  const preferred = PREFS?.default_model;
  const chosen = models.some((m) => m.key === preferred) ? preferred : models[0]?.key;

  fillSelect(sel, models.map((m) => m.key), chosen, (k) =>
    REGISTRY.models.find((m) => m.key === k).label
  );
  return chosen;
}

// ── wiring ───────────────────────────────────────────────────
// ── Tab 3: image analysis ────────────────────────────────────
//
// Same rule as the model registry: nothing here names a tagger. The selector,
// the limits, the accepted types and which analysis modes are usable all come
// from GET /api/taggers.

let TAGGERS = null;
let analysisFile = null;
let analysisResult = null;
let analysing = false;

// The spec lists five analysis modes and four of them need a captioning vision
// model. That model was dropped on 21 Aug rather than deferred — WD covers
// tagging, which is what this tab is for — so the four are gone with it rather
// than sitting in a dropdown as permanently disabled entries. See the context
// doc under "Caption modes, dropped rather than deferred".
//
// Nothing read the selected mode: it was never sent to /api/analyze, which
// only ever does the tag pass. Removing it changed no behaviour at all.

// ── cropping before the tagger sees it ───────────────────────
//
// The tagger reads everything in frame. Asked about an outfit, a full-body
// shot comes back with the face, the background, the pose and the weather as
// well, and the useful tags sit among them at the same confidence. Cropping
// to the part being asked about is the fix, and it is the one piece of a user's
// reference card the app did not have.
//
// The crop is held in NATURAL image pixels, not screen pixels: the preview
// box is responsive, so a rect stored in CSS pixels would mean something
// different after a window resize. Everything on screen is derived from the
// natural rect at paint time, which is also why the resize listener only has
// to repaint.
let analysisCrop = null;     // {x, y, w, h} in natural pixels, or null
let analysisCropped = null;  // the cropped File, cached until the crop changes
let analysisImg = null;      // the <img> in the preview, for its rendered rect

const clampTo = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * The bytes to tag: the crop if there is one, the original if there is not.
 *
 * Re-encoded in the file's own type so the server's content-type stays honest
 * and `analysisValidate` still passes on the far side. Canvas silently falls
 * back to PNG for a type it cannot encode, so the blob's type is read back
 * rather than assumed.
 *
 * Cached, because this runs on every Analyse press and again on every send to
 * Tab 1, and re-encoding a 4K crop is not free.
 */
async function analysisBytes() {
  if (!analysisCrop || !analysisImg) return analysisFile;
  if (analysisCropped) return analysisCropped;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(analysisCrop.w));
  canvas.height = Math.max(1, Math.round(analysisCrop.h));
  canvas
    .getContext('2d')
    .drawImage(
      analysisImg,
      analysisCrop.x, analysisCrop.y, analysisCrop.w, analysisCrop.h,
      0, 0, canvas.width, canvas.height
    );

  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, analysisFile.type, 0.95)
  );
  if (!blob) return analysisFile; // encoder refused; tag the whole picture
  analysisCropped = new File([blob], analysisFile.name, { type: blob.type });
  return analysisCropped;
}

/** Paint the selection over the image. Natural pixels in, CSS pixels out. */
function renderCropBox() {
  const box = $('#analysis-crop-box');
  if (!box) return;
  if (!analysisCrop || !analysisImg?.naturalWidth) {
    box.hidden = true;
    return;
  }
  const p = $('#analysis-preview').getBoundingClientRect();
  const i = analysisImg.getBoundingClientRect();
  const scale = i.width / analysisImg.naturalWidth;
  box.hidden = false;
  box.style.left = `${i.left - p.left + analysisCrop.x * scale}px`;
  box.style.top = `${i.top - p.top + analysisCrop.y * scale}px`;
  box.style.width = `${analysisCrop.w * scale}px`;
  box.style.height = `${analysisCrop.h * scale}px`;
}

function updateCropBar() {
  const bar = $('#analysis-crop-bar');
  if (!bar) return;
  bar.hidden = !analysisFile;
  const cropped = Boolean(analysisCrop && analysisImg?.naturalWidth);
  $('#analysis-crop-reset').hidden = !cropped;
  $('#analysis-crop-hint').textContent = cropped
    ? `Tagging ${Math.round(analysisCrop.w)} × ${Math.round(analysisCrop.h)} of ` +
      `${analysisImg.naturalWidth} × ${analysisImg.naturalHeight}`
    : 'Drag a frame on the image to tag only part of it';
}

/**
 * Called whenever the crop settles. Any result on screen was computed from
 * different bytes, so it goes — the same rule as the output panel clearing on
 * a model switch, for the same reason: nobody should read one picture's tags
 * under another picture's frame.
 */
function cropChanged() {
  analysisCropped = null;
  if (analysisResult) {
    analysisResult = null;
    $('#analysis-mount').replaceChildren();
    $('#analysis-output-title').textContent = 'Results';
  }
  describeReset();
  renderCropBox();
  updateCropBar();
  analysisSetEnabled();
}

/**
 * Draw, move and resize, bound to the preview rather than to the image,
 * because a drag that leaves the picture still has to be followed. Pointer
 * events cover mouse and touch in one path; the preview sets
 * `touch-action: none` so a drag on a phone crops instead of scrolling.
 */
function initCrop() {
  const preview = $('#analysis-preview');
  if (!preview) return;

  let mode = null;      // 'draw' | 'move' | a corner name
  let origin = null;    // where the drag started, in natural pixels
  let startCrop = null; // the crop as it was when the drag started

  const toNatural = (e) => {
    const i = analysisImg.getBoundingClientRect();
    const scale = analysisImg.naturalWidth / i.width;
    return {
      x: clampTo((e.clientX - i.left) * scale, 0, analysisImg.naturalWidth),
      y: clampTo((e.clientY - i.top) * scale, 0, analysisImg.naturalHeight),
    };
  };

  preview.addEventListener('pointerdown', (e) => {
    if (!analysisImg?.naturalWidth) return;
    const i = analysisImg.getBoundingClientRect();
    // Letterboxing means part of the preview is not the picture. A press
    // there is not a crop.
    const onImage =
      e.clientX >= i.left && e.clientX <= i.right &&
      e.clientY >= i.top && e.clientY <= i.bottom;
    if (!onImage) return;

    const handle = e.target.closest?.('.crop-handle');
    mode = handle
      ? handle.dataset.corner
      : e.target.closest?.('.crop-box') ? 'move' : 'draw';
    origin = toNatural(e);
    startCrop = analysisCrop ? { ...analysisCrop } : null;
    if (mode === 'draw') analysisCrop = { x: origin.x, y: origin.y, w: 0, h: 0 };
    preview.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  preview.addEventListener('pointermove', (e) => {
    if (!mode) return;
    const at = toNatural(e);

    if (mode === 'draw') {
      analysisCrop = {
        x: Math.min(origin.x, at.x),
        y: Math.min(origin.y, at.y),
        w: Math.abs(at.x - origin.x),
        h: Math.abs(at.y - origin.y),
      };
    } else if (mode === 'move') {
      // Clamped as a whole rather than per-edge, so dragging into a corner
      // slides the frame along it instead of squashing it.
      const dx = clampTo(at.x - origin.x, -startCrop.x, analysisImg.naturalWidth - startCrop.x - startCrop.w);
      const dy = clampTo(at.y - origin.y, -startCrop.y, analysisImg.naturalHeight - startCrop.y - startCrop.h);
      analysisCrop = { ...startCrop, x: startCrop.x + dx, y: startCrop.y + dy };
    } else {
      // A corner drag pivots on the opposite corner, which is what lets a
      // drag past it flip the frame rather than invert its size.
      const anchorX = mode.includes('w') ? startCrop.x + startCrop.w : startCrop.x;
      const anchorY = mode.includes('n') ? startCrop.y + startCrop.h : startCrop.y;
      analysisCrop = {
        x: Math.min(anchorX, at.x),
        y: Math.min(anchorY, at.y),
        w: Math.abs(at.x - anchorX),
        h: Math.abs(at.y - anchorY),
      };
    }
    renderCropBox();
    updateCropBar();
  });

  const settle = (e) => {
    if (!mode) return;
    mode = null;
    preview.releasePointerCapture?.(e.pointerId);
    // A click, or a twitch. Too small to be a frame anyone meant, and reading
    // it as "clear the crop" is the behaviour that needs no extra button.
    if (analysisCrop && (analysisCrop.w < 16 || analysisCrop.h < 16)) analysisCrop = null;
    cropChanged();
  };
  preview.addEventListener('pointerup', settle);
  preview.addEventListener('pointercancel', settle);

  // Held in natural pixels precisely so this is a repaint, not a conversion.
  window.addEventListener('resize', renderCropBox);

  $('#analysis-crop-reset')?.addEventListener('click', () => {
    analysisCrop = null;
    cropChanged();
  });
}

function analysisSetEnabled() {
  const ready = Boolean(analysisFile) && !analysing && Boolean(TAGGERS?.available);
  $('#analysis-run').disabled = !ready;
  const has = Boolean(analysisResult);
  $('#analysis-copy-all').disabled = !has;
  $('#analysis-copy-general').disabled = !has;
  $('#analysis-to-builder').disabled = !has || !currentModel;
  paintDescribe();

  // The as-a-reference panel appears only once there is something to send,
  // and only where the target model actually has a reference list — the video
  // templates have H3's own uploader, which is a different contract and not
  // something this can hand to.
  const asRef = $('#analysis-asref');
  if (asRef) {
    const canTakeReferences = Boolean($('[data-bind="imgref_upload"]', $('#builder-mount')));
    asRef.hidden = !has || !currentModel || !canTakeReferences;
    const btn = $('#analysis-to-reference');
    if (btn) btn.disabled = asRef.hidden;
  }
}

/**
 * Role and fidelity for "send as reference", from the same registry vocabulary
 * Tab 1's cards use.
 *
 * Built once the registry has loaded rather than at boot, and refilled on
 * model switch, for the same reason every other selector here is: the
 * vocabulary is config, and a list written into index.html would be a second
 * copy that goes stale the first time the owner rewords a role.
 */
function fillAnalysisReferenceControls() {
  const roleSel = $('#analysis-ref-role');
  const fidSel = $('#analysis-ref-fidelity');
  const hint = $('#analysis-ref-hint');
  if (!roleSel || !fidSel || !REGISTRY) return;

  const roles = REGISTRY.defaults?.image_reference_roles ?? {};
  const fidelities = REGISTRY.defaults?.reference_fidelity ?? {};
  if (!Object.keys(roles).length) return;

  // Keep whatever was already chosen across a model switch — someone sending
  // three outfit references in a row should not have to reselect each time.
  const keptRole = roleSel.value || REGISTRY.defaults?.default_image_reference_role;
  const keptFid = fidSel.value || REGISTRY.defaults?.default_reference_fidelity;

  fillSelect(roleSel, Object.keys(roles), keptRole, (k) => roles[k]?.label ?? k);
  fillSelect(fidSel, Object.keys(fidelities), keptFid, (k) => fidelities[k]?.label ?? k);

  const paint = () => {
    if (hint) paintRoleHint(hint, roles[roleSel.value]);
  };
  roleSel.onchange = paint;
  paint();
}

/**
 * Send this analysis to Tab 1 as a configured reference.
 *
 * The difference from `sendAnalysisToBuilder` is the claim being made, not the
 * data: that one says "put these tags in the prompt", this one says "this
 * picture is a character sheet, follow it closely". The second is what people
 * mean most of the time, and until now the app had no way to express it.
 *
 * The file travels with it, so Tab 1 shows the same thumbnail rather than an
 * anonymous card — and it still never leaves the browser: `addImageReference`
 * re-reads it locally and only the tags go up.
 */
async function sendAnalysisAsReference() {
  if (!analysisResult || !analysisFile || !currentModel) return;
  const roleSel = $('#analysis-ref-role');
  const fidSel = $('#analysis-ref-fidelity');

  const ok = adoptImageReference({
    // The cropped bytes, so Tab 1's card shows the frame that was tagged
    // rather than the picture it was cut from. The tags below already
    // describe the crop; a thumbnail of the original would disagree with
    // them.
    file: await analysisBytes(),
    role: roleSel?.value,
    fidelity: fidSel?.value,
    // Already analysed here — handing the result over means Tab 1 does not
    // pay a second CPU pass on the same picture, which is ~2.5s on the EVA02
    // weights and would look like the button doing nothing.
    analysis: analysisResult,
  });
  if (!ok) return;

  $$('.main-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === 'prompt'));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-prompt'));
  const label = REGISTRY.defaults?.image_reference_roles?.[roleSel?.value]?.label ?? 'reference';
  toast(`Sent to ${currentModel.name} as a ${label.toLowerCase()} reference`);
}

/**
 * WD returns danbooru underscore form. Rewrite it into whatever the target
 * model's tag_style asks for, deriving it from the registry rather than
 * naming any model here.
 *
 * The `space` case gives real spaces, matching what pony.md, sdxl.md and
 * anima.md all ask for. It used to give dashes, because that was the variant
 * the tag database served those models and the two paths must never inject
 * two different spellings of the same tag. The search path now serves `space`
 * out of the underscore rows, so both sides produce the same thing.
 *
 * The conversion is from the **underscore** form, never from dash. Dash
 * collapses word-internal hyphens and space separators into the same
 * character, so `t-shirt` and `long-hair` are indistinguishable and a naive
 * `-` to space gives `t shirt`. WD returns underscore form, so there is
 * nothing lossy in the path. Measured 20 Aug 2026 — see "Open: Pony gets
 * dashes" in the context doc.
 */
export function tagForModel(tag, model) {
  switch (model?.tag_style) {
    case 'underscore': return tag;
    case 'space': return tag.replace(/_/g, ' ');
    // Prose models have no tag_style. Underscores read badly in a sentence,
    // so they become real spaces on the way into the brief.
    default: return tag.replace(/_/g, ' ');
  }
}

/**
 * Send the analysis into Tab 1. Where it lands depends on the target model:
 * a booru template has a tag list that carries weights through to generation,
 * so tags go there. Every other template has only a brief, so they are
 * appended as text rather than silently dropped.
 */
function sendAnalysisToBuilder() {
  if (!analysisResult || !currentModel) return;

  const picked = [
    ...(analysisResult.character ?? []),
    ...(analysisResult.general ?? []),
  ];
  if (!picked.length) {
    toast('Nothing to send — no tags passed the thresholds');
    return;
  }

  const mount = $('#builder-mount');
  const hasTagList = Boolean($('[data-bind="tag_pills"]', mount));
  const converted = picked.map((t) => ({
    tag: tagForModel(t.tag, currentModel),
    category_name: t.category_name ?? 'general',
  }));

  let added = 0;
  if (hasTagList) {
    for (const t of converted) {
      if (selectedTags.some((s) => s.tag === t.tag)) continue;
      selectedTags.push({ tag: t.tag, category_name: t.category_name, weight: 1.0 });
      added++;
    }
    activeTagIndex = selectedTags.length - 1;
    renderTagPills(mount, currentModel);
  } else {
    const brief = $('[data-bind="brief"]', mount);
    if (!brief) {
      toast(`${currentModel.name} has nowhere to put tags`);
      return;
    }
    const text = converted.map((t) => t.tag).join(', ');
    brief.value = brief.value.trim() ? `${brief.value.trim()}, ${text}` : text;
    brief.dispatchEvent(new Event('input', { bubbles: true }));
    added = converted.length;
  }

  $$('.main-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === 'prompt'));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-prompt'));

  toast(
    added
      ? `${added} tag${added === 1 ? '' : 's'} sent to ${currentModel.name}`
      : `Already in ${currentModel.name}`
  );
}

function analysisError(code, message, onRetry) {
  const box = document.createElement('div');
  box.className = 'error-box';
  const msg = document.createElement('div');
  msg.innerHTML = `<span class="code"></span><br>`;
  msg.querySelector('.code').textContent = code;
  msg.append(message);
  box.appendChild(msg);
  if (onRetry) {
    const retry = document.createElement('button');
    retry.className = 'ghost';
    retry.textContent = 'Retry';
    retry.style.marginTop = '10px';
    retry.addEventListener('click', onRetry);
    box.appendChild(retry);
  }
  return box;
}

/**
 * What the model saw in the reference pictures, before it wrote the prompt.
 *
 * Collapsed, because on an ordinary good generation nobody needs it and it is
 * longer than the prompt. Open when something came out wrong: a pose that
 * missed is either a bad reading or a good reading badly compiled, and those
 * two have completely different fixes — one is the analysis prompt, the other
 * is the model's own file. Without this on screen they are the same bug.
 *
 * Not a segment. It is not part of the prompt, nothing copies it, and it must
 * never end up in the clipboard alongside something that is.
 */
function referenceReadEl(text, title = 'What the model saw in your references') {
  const box = document.createElement('details');
  box.className = 'segment reference-read';

  const head = document.createElement('summary');
  head.className = 'segment-head';
  const label = document.createElement('span');
  label.className = 'segment-label';
  label.textContent = title;
  head.appendChild(label);

  const body = document.createElement('div');
  body.className = 'segment-body';
  // The analyst's own layout — REFERENCE 1, USE, IGNORE — carries meaning in
  // its line breaks, so it is shown as written rather than reflowed.
  body.style.whiteSpace = 'pre-wrap';
  body.textContent = text;

  box.append(head, body);
  return box;
}

function tagSection(title, tags, cls) {
  const wrap = document.createElement('div');
  wrap.className = 'segment';

  const head = document.createElement('div');
  head.className = 'segment-head';
  const label = document.createElement('span');
  label.className = 'segment-label';
  // Same rule as the generated segments above: these are the tagger's own
  // category names, and they travel with the tags.
  label.dataset.noI18n = '';
  label.textContent = `${title} — ${tags.length}`;
  const copy = document.createElement('button');
  copy.className = 'ghost';
  copy.textContent = 'Copy';
  copy.addEventListener('click', () =>
    copyText(tags.map((t) => t.tag).join(', '), `${title} copied`));
  head.append(label, copy);

  const grid = document.createElement('div');
  grid.className = 'tag-grid';
  for (const t of tags) {
    const pill = document.createElement('span');
    pill.className = `tag-pill ${cls}`;
    pill.append(t.tag);
    const conf = document.createElement('span');
    conf.className = 'tag-conf';
    conf.textContent = t.confidence.toFixed(2);
    pill.appendChild(conf);
    grid.appendChild(pill);
  }
  wrap.append(head, grid);
  return wrap;
}

function renderAnalysis(result) {
  const mount = $('#analysis-mount');
  mount.replaceChildren();

  $('#analysis-output-title').textContent = `Results — ${result.model}`;

  const top = result.ratings?.[0];
  if (top) mount.appendChild(tagSection('Rating', [top], 'meta'));
  if (result.character?.length) mount.appendChild(tagSection('Character', result.character, 'character'));
  if (result.general?.length) mount.appendChild(tagSection('General', result.general, 'general'));

  if (!result.general?.length && !result.character?.length) {
    const p = document.createElement('p');
    p.className = 'placeholder-tab';
    p.textContent =
      `Nothing scored above the thresholds (general ${result.thresholds.general}, ` +
      `character ${result.thresholds.character}). Lower them and run it again.`;
    mount.appendChild(p);
  }

  const note = document.createElement('p');
  note.className = 'field-note';
  note.textContent = `${result.took_ms} ms on the CPU.`;
  mount.appendChild(note);
}

/** Client-side mirror of the server's check, so an oversized file is refused
 *  before it is uploaded. The server enforces it again regardless.
 *
 *  `limits` is injectable so scripts/test-app.mjs can check the messages
 *  actually name the limit — the spec's requirement for this row is not just
 *  that the file is refused, but that the refusal says what the limit is.
 *  In the app it always comes from GET /api/taggers. */
export function analysisValidate(file, limits = TAGGERS?.limits ?? {}) {
  const allowed = limits.allowed_image_types ?? [];
  const maxMb = limits.max_image_mb ?? 20;
  if (allowed.length && !allowed.includes(file.type)) {
    return `${file.type || 'That file'} is not accepted. Allowed: ${allowed.join(', ')}.`;
  }
  if (file.size > maxMb * 1024 * 1024) {
    return `Image is ${(file.size / 1048576).toFixed(1)} MB. The limit is ${maxMb} MB.`;
  }
  return null;
}

function analysisSetFile(file) {
  const problem = analysisValidate(file);
  if (problem) {
    $('#analysis-mount').replaceChildren(analysisError('rejected', problem));
    return;
  }
  analysisFile = file;
  analysisResult = null;
  describeReset();
  loadComfyMeta(file);

  const preview = $('#analysis-preview');
  const img = document.createElement('img');
  img.alt = file.name;
  img.src = URL.createObjectURL(file);
  img.addEventListener('load', () => URL.revokeObjectURL(img.src), { once: true });
  // The hint names the picture's real dimensions, which are not known until
  // it has decoded.
  img.addEventListener('load', updateCropBar, { once: true });

  // The selection box is mounted with the image and stays hidden until there
  // is a crop, rather than being created on first drag: one element, one id,
  // and renderCropBox can assume it exists.
  const box = document.createElement('div');
  box.className = 'crop-box';
  box.id = 'analysis-crop-box';
  box.hidden = true;
  for (const corner of ['nw', 'ne', 'sw', 'se']) {
    const handle = document.createElement('span');
    handle.className = `crop-handle ${corner}`;
    handle.dataset.corner = corner;
    box.appendChild(handle);
  }
  preview.replaceChildren(img, box);

  // A crop belongs to the picture it was drawn on. A new picture starts
  // uncropped, always.
  analysisImg = img;
  analysisCrop = null;
  analysisCropped = null;
  updateCropBar();

  $('#analysis-mount').replaceChildren();
  $('#analysis-output-title').textContent = 'Results';
  analysisSetEnabled();
}

async function runAnalysis() {
  if (!analysisFile || analysing) return;
  analysing = true;
  analysisSetEnabled();

  const mount = $('#analysis-mount');
  const note = document.createElement('p');
  note.className = 'field-note';
  note.textContent = 'Analysing…';
  mount.replaceChildren(note);

  const params = new URLSearchParams({ tagger: $('#tagger-select').value });
  const g = $('#analysis-general').value;
  const c = $('#analysis-character').value;
  if (g !== '') params.set('general_threshold', g);
  if (c !== '') params.set('character_threshold', c);

  try {
    // The crop if there is one, the original if not. Re-encoding can change
    // the type, so the header comes from the bytes actually being sent.
    const bytes = await analysisBytes();
    const res = await fetch(`/api/analyze?${params}`, {
      method: 'POST',
      headers: { 'content-type': bytes.type },
      body: bytes,
    });
    const data = await res.json().catch(() => ({
      error: 'bad_response',
      message: `The server returned ${res.status} with no JSON body.`,
    }));

    if (!res.ok) {
      mount.replaceChildren(analysisError(data.error ?? `http_${res.status}`, data.message ?? 'Analysis failed.', runAnalysis));
      return;
    }
    analysisResult = data;
    renderAnalysis(data);
  } catch (err) {
    // Server unreachable mid-request. Same shape as every other failure here.
    mount.replaceChildren(analysisError('unreachable', `Could not reach the server: ${err.message}`, runAnalysis));
  } finally {
    analysing = false;
    analysisSetEnabled();
  }
}

// ── Describe it: the picture in words (22 Sep 2026) ─────────
//
// Tags AND natural language from one picture, either or both. The words come
// from the "Written by" model through /api/analyze/describe; the tags, when
// there are any, go with it so it can say what they missed or got wrong.
let describeText = '';
let describeAbort = null;

function describeReset() {
  describeAbort?.abort();
  describeAbort = null;
  describeText = '';
  $('#analysis-describe-text')?.replaceChildren();
  paintDescribe();
}

function paintDescribe() {
  const box = $('#analysis-describe');
  if (!box) return;
  box.hidden = !analysisFile;
  const running = Boolean(describeAbort);
  const has = Boolean(describeText.trim()) && !running;
  $('#analysis-describe-run').disabled = !analysisFile || running;
  $('#analysis-describe-run').textContent = running ? 'Describing…' : describeText ? 'Describe again' : 'Describe it';
  $('#analysis-describe-copy').disabled = !has;
  $('#analysis-describe-send').disabled = !has || !currentModel;
  $('#analysis-describe-both').disabled = !has || !analysisResult || !currentModel;
}

/** Just the description paragraph(s) — not the character line or the check. */
function describeParagraph() {
  const m = /Description:\s*([\s\S]*?)(?:\n\s*(?:Characters|Tagger check):|$)/i.exec(describeText);
  return (m ? m[1] : describeText).trim();
}

/** The character tags it recognised, as an array. */
function describeCharacters() {
  const m = /(?:^|\n)\s*Characters:\s*([^\n]*)/i.exec(describeText);
  const line = (m?.[1] ?? '').trim();
  if (!line || /^none\b/i.test(line)) return [];
  // Keeps what a danbooru tag can hold and drops the rest, which is also how
  // the backticks it sometimes wraps tags in come off. NOT a regex containing
  // a backtick: scripts/test-app.mjs reads one as a template string opening
  // and then stops recognising comments for the rest of the file.
  return line.split(',').map((s) => s.replace(/[^a-z0-9_()'.:\- ]/gi, '').trim()).filter(Boolean);
}

let describeUnknown = [];

// Describe's own model (26 Sep 2026). Empty = "same as Written by", the old
// behaviour. Kept apart from PREFS.prompt_llm on purpose: comparing models on
// one picture must not change the model that writes everyone's prompts.
let describeModel = '';
let describeModelSignature = null;   // null, not '': an empty vision list must still build the default row

function renderDescribeLlm(llm) {
  const sel = $('#analysis-describe-model');
  if (!sel || !llm) return;
  const groups = chatModelGroups(llm);
  // Vision only: a model that cannot see has nothing to say about a picture,
  // and offering it would just end in the no_vision error.
  const rows = [...groups.loaded, ...groups.available].filter((r) => r.vision);
  const signature = rows.map((r) => r.model).join(',');
  if (signature === describeModelSignature) return;
  describeModelSignature = signature;
  sel.replaceChildren(new Option('Same as Written by', ''));
  for (const r of rows) sel.appendChild(new Option(r.model, r.model));
  sel.value = rows.some((r) => r.model === describeModel) ? describeModel : '';
  describeModel = sel.value;
}

function paintDescribeText(extra) {
  const host = $('#analysis-describe-text');
  const pre = document.createElement('div');
  pre.className = 'field-note';
  pre.style.cssText = 'white-space:pre-wrap;font-size:13px;line-height:1.55;margin-top:8px';
  pre.textContent = describeText || extra || '';
  host.replaceChildren(pre);
  // Suggested tags danbooru does not have. The model writes plausible ones,
  // and a tag the image model never saw in training does nothing in a prompt.
  if (describeUnknown.length) {
    const warn = document.createElement('p');
    warn.className = 'auth-message';
    warn.style.marginTop = '10px';
    warn.textContent = `Not real danbooru tags, so they will do nothing in a prompt: ${describeUnknown.join(', ')}`;
    host.appendChild(warn);
  }
}

async function runDescribe() {
  if (!analysisFile || describeAbort) return;
  describeAbort = new AbortController();
  const abort = describeAbort;
  describeText = '';
  describeUnknown = [];
  paintDescribeText('Waiting for the model…');
  paintDescribe();

  const tags = analysisResult
    ? [...(analysisResult.character ?? []), ...(analysisResult.general ?? [])].map((t) => t.tag).join(',')
    : '';
  try {
    const bytes = await analysisBytes();
    const query = new URLSearchParams({
      tags,
      ...(describeModel ? { model: describeModel } : {}),
      temperature: $('#analysis-describe-temp')?.value ?? '0.2',
      presence_penalty: $('#analysis-describe-penalty')?.value ?? '0',
    });
    const res = await fetch(`/api/analyze/describe?${query}`, {
      method: 'POST',
      headers: { 'content-type': bytes.type },
      body: bytes,
      signal: abort.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      paintDescribeText(`Could not describe it — ${body.message ?? body.error ?? res.status}`);
      return;
    }
    // Same SSE shape as the reference read-back.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        let event = 'message';
        let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        let payload;
        try { payload = JSON.parse(data); } catch { continue; }
        if (event === 'queued') {
          paintDescribeText(`Waiting for the card — ${payload.position} ahead…`);
        } else if (event === 'token') {
          describeText += payload.text ?? '';
          paintDescribeText();
        } else if (event === 'done') {
          describeUnknown = payload.unknown ?? [];
          paintDescribeText();
        } else if (event === 'error') {
          paintDescribeText(`${describeText}\n\nStopped — ${payload.message ?? payload.error}`);
        }
      }
    }
    if (!describeText.trim()) paintDescribeText('The model returned nothing. Try again, or pick a different model above.');
  } catch (err) {
    if (!abort.signal.aborted) paintDescribeText(`Could not describe it — ${err.message}`);
  } finally {
    if (describeAbort === abort) describeAbort = null;
    paintDescribe();
  }
}

/** Append text to the current Prompt Assist brief and switch to it. */
function sendToBrief(text, label) {
  const brief = $('[data-bind="brief"]', $('#builder-mount'));
  if (!brief) {
    toast(`${currentModel?.name ?? 'This model'} has no brief to put it in`);
    return false;
  }
  brief.value = brief.value.trim() ? `${brief.value.trim()}\n\n${text}` : text;
  brief.dispatchEvent(new Event('input', { bubbles: true }));
  $$('.main-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === 'prompt'));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-prompt'));
  toast(`${label} sent to ${currentModel.name}`);
  return true;
}

// ── What ComfyUI wrote inside the picture ────────────────────
let comfyMeta = null;

function comfyReset() {
  comfyMeta = null;
  const box = $('#analysis-comfy');
  if (box) box.hidden = true;
}

/** Sent the ORIGINAL file, never the crop: re-encoding strips this. */
async function loadComfyMeta(file) {
  comfyReset();
  if (!file || file.type !== 'image/png') return;
  try {
    const res = await fetch('/api/analyze/meta', {
      method: 'POST',
      headers: { 'content-type': file.type },
      body: file,
    });
    if (!res.ok) return;
    const meta = await res.json();
    if (!meta.found) return;
    comfyMeta = meta;
    paintComfyMeta();
  } catch { /* nothing to show */ }
}

function paintComfyMeta() {
  const box = $('#analysis-comfy');
  const body = $('#analysis-comfy-body');
  body.replaceChildren();
  const row = (label, value) => {
    if (!value) return;
    const p = document.createElement('p');
    p.className = 'field-note';
    p.style.margin = '2px 0';
    const b = document.createElement('strong');
    b.textContent = `${label}: `;
    p.append(b, value);
    body.appendChild(p);
  };
  const s = comfyMeta.settings ?? {};
  row('Checkpoint', (comfyMeta.checkpoints ?? []).join(', '));
  row('LoRAs', (comfyMeta.loras ?? []).map((l) => `${l.name}${l.model != null ? ` @ ${l.model}` : ''}`).join(', '));
  row('Seed', comfyMeta.seed != null ? String(comfyMeta.seed) : '');
  row('Sampler', [comfyMeta.sampler, s.sampler_name, s.scheduler].filter(Boolean).join(' · '));
  row('Steps / CFG / denoise', [s.steps, s.cfg, s.denoise].filter((x) => x != null).join(' / '));
  if (comfyMeta.prompt) {
    const p = document.createElement('p');
    p.className = 'field-note';
    p.style.cssText = 'white-space:pre-wrap;margin:8px 0 0';
    p.textContent = `Prompt: ${comfyMeta.prompt}${comfyMeta.prompt_partial ? '  (built at run time — this is only the part that was typed)' : ''}`;
    body.appendChild(p);
  }
  $('#analysis-comfy-copy').disabled = !comfyMeta.prompt;
  $('#analysis-comfy-send').disabled = !comfyMeta.prompt;
  box.hidden = false;
}

function initComfyMeta() {
  $('#analysis-comfy-copy').addEventListener('click', () => copyText(comfyMeta?.prompt ?? '', 'Prompt copied'));
  $('#analysis-comfy-send').addEventListener('click', () => {
    if (comfyMeta?.prompt) sendToBrief(comfyMeta.prompt, 'The original prompt');
  });
}

function initDescribe() {
  initComfyMeta();
  $('#analysis-describe-run').addEventListener('click', runDescribe);
  $('#analysis-describe-model')?.addEventListener('change', (e) => { describeModel = e.target.value; });
  for (const [id, digits] of [['analysis-describe-temp', 2], ['analysis-describe-penalty', 1]]) {
    const input = $(`#${id}`);
    const shown = $(`#${id}-val`);
    input?.addEventListener('input', () => { if (shown) shown.textContent = Number(input.value).toFixed(digits); });
  }
  // copyText has the fallback for plain http, which is how the group reaches
  // the box - navigator.clipboard alone refuses there.
  $('#analysis-describe-copy').addEventListener('click', () => copyText(describeParagraph(), 'Description copied'));
  $('#analysis-describe-send').addEventListener('click', () => sendToBrief(describeParagraph(), 'Description'));
  // Tags first, into the tag list where the model has one (or the brief
  // where it does not), then the description into the brief.
  $('#analysis-describe-both').addEventListener('click', () => {
    sendAnalysisToBuilder();
    sendToBrief(describeParagraph(), 'Tags and description');
  });
  paintDescribe();
}

async function initAnalysis() {
  initDescribe();
  try {
    TAGGERS = await fetch('/api/taggers').then((r) => r.json());
  } catch {
    TAGGERS = { taggers: [], available: 0, limits: {} };
  }

  const select = $('#tagger-select');
  const badge = $('#tagger-badge');
  select.replaceChildren();

  for (const t of TAGGERS.taggers ?? []) {
    const opt = document.createElement('option');
    opt.value = t.key;
    opt.textContent = t.available ? `${t.name} — ${t.device.toUpperCase()}` : `${t.name} — unavailable`;
    opt.disabled = !t.available;
    if (t.default) opt.selected = true;
    select.appendChild(opt);
  }

  // All of them at once, merged the way a reference picture's are: animetimm
  // leads and WD EVA02 adds what it lacks (22 Sep 2026). Only worth offering
  // where there is more than one to merge.
  if ((TAGGERS.taggers ?? []).filter((t) => t.available).length > 1) {
    const opt = document.createElement('option');
    opt.value = 'all';
    opt.textContent = 'All taggers — more tags, a little slower';
    select.appendChild(opt);
  }

  if (!TAGGERS.available) {
    const opt = document.createElement('option');
    opt.textContent = 'No tagger available';
    select.replaceChildren(opt);
    select.disabled = true;
    badge.textContent = 'unavailable';
    const why = (TAGGERS.taggers ?? []).find((t) => t.detail)?.detail;
    $('#analysis-mount').replaceChildren(
      analysisError(
        'tagger_unavailable',
        why
          ? `No tagger is usable on this machine. ${why}. Check the paths in config/taggers.yaml.`
          : 'No tagger is configured. See config/taggers.yaml.'
      )
    );
  } else {
    badge.textContent = `${TAGGERS.available} of ${TAGGERS.total} ready`;
  }

  // The threshold boxes start at the chosen tagger's own tuned cut-offs, and
  // follow it when the choice changes. They were hard-coded to WD's numbers,
  // which hid animetimm's characters - see taggers.mjs list().
  const fillThresholds = () => {
    // "All taggers" runs the primary first, so its numbers are the ones to show.
    const t = select.value === 'all'
      ? (TAGGERS.taggers ?? []).find((x) => x.default && x.available) ?? (TAGGERS.taggers ?? [])[0]
      : (TAGGERS.taggers ?? []).find((x) => x.key === select.value);
    if (t?.general_threshold != null) $('#analysis-general').value = t.general_threshold;
    if (t?.character_threshold != null) $('#analysis-character').value = t.character_threshold;
  };
  fillThresholds();
  select.addEventListener('change', fillThresholds);

  const limits = TAGGERS.limits ?? {};
  if (limits.allowed_image_types) {
    $('#dropzone-limits').textContent =
      `${limits.allowed_image_types.map((t) => t.split('/')[1].toUpperCase()).join(', ')} · up to ${limits.max_image_mb} MB`;
  }

  const dz = $('#analysis-dropzone');
  const input = $('#analysis-file');
  dz.addEventListener('click', () => input.click());
  dz.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => {
    if (input.files?.[0]) analysisSetFile(input.files[0]);
  });

  for (const type of ['dragenter', 'dragover']) {
    dz.addEventListener(type, (e) => { e.preventDefault(); dz.classList.add('dragover'); });
  }
  for (const type of ['dragleave', 'drop']) {
    dz.addEventListener(type, (e) => { e.preventDefault(); dz.classList.remove('dragover'); });
  }
  dz.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) analysisSetFile(file);
  });

  $('#analysis-run').addEventListener('click', runAnalysis);
  initCrop();

  const allTags = () => [
    ...(analysisResult?.character ?? []),
    ...(analysisResult?.general ?? []),
  ].map((t) => t.tag);

  $('#analysis-copy-all').addEventListener('click', () => {
    if (analysisResult) copyText(allTags().join(', '), 'All tags copied');
  });
  $('#analysis-copy-general').addEventListener('click', () => {
    if (analysisResult) copyText((analysisResult.general ?? []).map((t) => t.tag).join(', '), 'General tags copied');
  });
  $('#analysis-to-builder').addEventListener('click', sendAnalysisToBuilder);
  $('#analysis-to-reference')?.addEventListener('click', sendAnalysisAsReference);

  analysisSetEnabled();
}

// ── accounts ─────────────────────────────────────────────────
//
// The server refuses every /api/ route without a session, so none of this is
// the security boundary — it is the half that makes the refusal legible. The
// wall starts covering the page and is only lifted once /api/auth/me confirms
// an approved account, so the app never flashes into view for someone who is
// not signed in.

let ME = null;            // { auth_enabled, authenticated, user, owner_registered }
let authMode = 'login';   // 'login' | 'register'

const escHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

/**
 * A session can end while the tab is open — it expires, or the owner disables
 * the account. Every existing call site would then quietly get a 401 and
 * render nothing, which looks like the app breaking rather than like being
 * signed out. Catching it in one place covers all of them, including calls
 * added later.
 */
// Guarded because scripts/test-app.mjs imports this module in Node to unit
// test the pure helpers, where there is no window. Everything else in this
// file defers its DOM access into a function; this is the one piece that
// would otherwise run at import time.
const rawFetch =
  typeof window === 'undefined' ? globalThis.fetch : window.fetch.bind(window);

if (typeof window !== 'undefined') {
  window.fetch = async (input, init) => {
    const res = await rawFetch(input, init);
    const url = String(typeof input === 'string' ? input : input?.url ?? '');
    if (res.status === 401 && url.includes('/api/') && !url.includes('/api/auth/')) {
      // auth_enabled guards the case where the server runs without accounts:
      // a 401 there means something else entirely, and throwing up a login
      // wall nobody can get past would be worse than the original error.
      if (ME?.auth_enabled && ME?.authenticated) {
        ME = { ...ME, authenticated: false, user: null };
        showWall('login', 'Your session ended. Sign in again.');
      }
    }
    return res;
  };
}

function authMessage(text, kind = 'error') {
  const el = $('#auth-message');
  if (!text) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = text;
  el.classList.toggle('ok', kind === 'ok');
}

function setAuthMode(mode) {
  authMode = mode;
  $$('#auth-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  const registering = mode === 'register';
  $('#auth-display-field').hidden = !registering;
  $('#auth-referral-field').hidden = !registering;
  $('#auth-submit').textContent = registering ? 'Create account' : 'Sign in';
  // Tells a password manager which of the two this is, or it offers to save a
  // new credential every time someone signs in.
  $('#auth-password').setAttribute('autocomplete', registering ? 'new-password' : 'current-password');
  authMessage(null);

  // First visitor on a fresh box: say plainly that registering the owner name
  // claims it, rather than leaving them at a gate nobody can open.
  const foot = $('#auth-footnote');
  if (ME && ME.auth_enabled && !ME.owner_registered) {
    foot.textContent =
      'No owner account exists yet. The first account you create becomes the owner of this server, approved immediately.';
  } else {
    foot.textContent = registering
      ? 'New accounts have to be approved by the owner before they can be used.'
      : '';
  }
}

function showWall(mode = 'login', message = null) {
  $('#auth-wall').hidden = false;
  $('#auth-forms').hidden = false;
  $('#auth-pending').hidden = true;
  setAuthMode(mode);
  if (message) authMessage(message);
}

function showPending(text) {
  $('#auth-wall').hidden = false;
  $('#auth-forms').hidden = true;
  const pending = $('#auth-pending');
  pending.hidden = false;
  if (text) $('#auth-pending-text').textContent = text;
}

// Permissions follow the owner's grants without a reload (5 Oct 2026).
// Identity was read only at sign-in, so a person given LoRA training or
// rendering saw the tab only after refreshing the page, and one whose grant
// was taken away kept seeing it. The server refuses them either way; this is
// about what they are shown. Re-read on the status poll, applied only when
// something changed.
let PERMISSIONS_SEEN = '';
const permissionsKey = (user) => JSON.stringify([Boolean(user?.is_owner), [...(user?.grants ?? [])].sort()]);

async function refreshPermissions() {
  if (!ME?.authenticated || ME?.auth_enabled === false) return;
  let user;
  try {
    const res = await rawFetch('/api/auth/me');
    if (!res.ok) return;
    user = (await res.json())?.user;
  } catch {
    return;
  }
  if (!user || permissionsKey(user) === PERMISSIONS_SEEN) return;
  ME = { ...ME, user };
  applyIdentity(user);
  loadRenderOptions();
  // Standing on a tab that has just been taken away: back to the first one.
  if ($('.main-tab.active')?.hidden) $('.main-tab[data-tab="prompt"]')?.click();
}

function applyIdentity(user) {
  const who = $('#whoami');
  const owner = Boolean(user?.is_owner);
  // Held so the queue panel, which repaints on every 10s poll rather than on
  // sign-in, knows whether to draw its controls. Hiding them is courtesy —
  // /api/admin/queue/move is gated server-side like the rest of the admin
  // surface, so a hand-rolled request from a friend is refused too.
  IS_OWNER = owner;
  CAN_OFFLOAD = owner || (user?.grants ?? []).includes('offload');
  CAN_TRAIN = owner || (user?.grants ?? []).includes('train');
  // With accounts off there is no user to hold it, and the server lets the
  // owner header through, as every fetch here sends.
  CAN_RENDER = owner || (user?.grants ?? []).includes('render') || ME?.auth_enabled === false;
  CAN_CAPTION = owner || (user?.grants ?? []).includes('caption') || ME?.auth_enabled === false;
  PERMISSIONS_SEEN = permissionsKey(user);
  // Train is hidden outright for everyone else rather than showing a notice:
  // the server refuses them anyway, and a view they can never use is noise.
  paintLoraTab();
  loadEditOptions();
  if (user) {
    who.hidden = false;
    who.innerHTML =
      `<strong>${escHtml(user.display_name || user.username)}</strong>` +
      (owner ? '<span class="owner-tag">owner</span>' : '');
  } else {
    who.hidden = true;
  }
  // whoami is the way into the account panel, which is where Sign out lives.
  // Owner-only controls. Hiding them is courtesy; the server enforces both.
  $('#btn-accounts').hidden = !owner;
  $('#btn-backend').hidden = !owner;
  $('#btn-usage').hidden = !owner;
  $('#btn-reload-prompts').hidden = Boolean(user) && !owner;
  $('#btn-monitoring').hidden = true;
  if (user) showBenchTabIfSheets();
  if (owner) {
    refreshPendingCount();
    maybeOpenSetup();
    showMonitoringIfRunning();
  }
}

// The owner's way into Grafana (the monitoring from PR #3). Shown
// only when Grafana actually answers through the /grafana/ pass-through, so a
// box without the monitoring profile - most of them, and the P40 - never
// shows a button that leads to an error. The server refuses everyone but the
// owner either way; hiding it for others is courtesy.
async function showMonitoringIfRunning() {
  try {
    const res = await fetch('/grafana/api/health', { cache: 'no-store' });
    $('#btn-monitoring').hidden = !res.ok;
  } catch {
    $('#btn-monitoring').hidden = true;
  }
}

function initMonitoringButton() {
  $('#btn-monitoring').addEventListener('click', () => {
    window.open('/grafana/d/promptforge-main/promptforge-llm-and-system-monitoring?orgId=1&kiosk', '_blank', 'noopener');
  });
}

async function submitAuth(event) {
  event.preventDefault();
  const btn = $('#auth-submit');
  const username = $('#auth-username').value.trim();
  const password = $('#auth-password').value;
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  authMessage(null);

  try {
    const path = authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
    const body = { username, password };
    if (authMode === 'register') {
      body.display_name = $('#auth-display').value.trim();
      body.referral = $('#auth-referral').value.trim();
    }
    const res = await rawFetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      // A pending or disabled account is not a failed login — the password
      // was right. Say what is actually true.
      if (data.error === 'account_pending') return showPending(data.message);
      return authMessage(data.message ?? `Something went wrong (${res.status}).`);
    }

    if (authMode === 'register' && data.user?.status !== 'approved') {
      return showPending();
    }

    $('#auth-password').value = '';
    await startApp(data.user ?? null);
  } catch (err) {
    authMessage(`Could not reach the server — ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
  }
}

// ── the owner's accounts panel ───────────────────────────────

async function refreshPendingCount() {
  try {
    const res = await rawFetch('/api/admin/users');
    if (!res.ok) return;
    const { users } = await res.json();
    const waiting = users.filter((u) => u.status === 'pending').length;
    const pip = $('#accounts-pip');
    pip.hidden = waiting === 0;
    pip.textContent = String(waiting);
  } catch { /* the pip is a nicety; never let it break the topbar */ }
}

/**
 * One row, in one of two contexts.
 *
 * `pending` is a decision queue — approve or deny, nothing else. Removing an
 * account is not a decision about a request, and putting a destructive button
 * next to Approve invites a misclick on the one action that cannot be undone.
 *
 * `manage` is where accounts already decided on live, and where the
 * destructive and recovery actions belong.
 */
function accountRow(user, context) {
  const when = user.created_at ? new Date(user.created_at).toLocaleString() : 'unknown';
  const who = escHtml(user.username);
  const btn = (act, label, cls) =>
    `<button class="${cls}" data-act="${act}" data-user="${who}">${label}</button>`;

  let actions;
  if (context === 'pending') {
    actions = btn('approve', 'Approve', 'primary') + btn('deny', 'Deny', 'danger');
  } else if (user.is_owner) {
    // The owner cannot be denied or removed, but can still reset their own
    // password — it is the only way to change it, and the confirm warns that
    // it signs them out.
    actions =
      '<span class="account-meta">This is the owner account.</span>' +
      btn('reset', 'Reset password', 'ghost');
  } else {
    // Offload is offered only to an approved account: granting a permission
    // to someone who cannot sign in is a setting with nowhere to take effect.
    const grantBtn = (grant, allow, revoke) => {
      if (user.status !== 'approved') return '';
      const holds = (user.grants ?? []).includes(grant);
      return `<button class="ghost" data-act="${holds ? 'ungrant' : 'grant'}" data-grant="${grant}" data-user="${who}">${holds ? revoke : allow}</button>`;
    };
    actions =
      (user.status === 'approved' ? btn('deny', 'Revoke access', 'danger') : btn('approve', 'Approve', 'primary')) +
      grantBtn('offload', 'Allow offload', 'Revoke offload') +
      grantBtn('train', 'Allow LoRA training', 'Revoke LoRA training') +
      grantBtn('render', 'Allow rendering', 'Revoke rendering') +
      grantBtn('caption', 'Allow LoRA captions', 'Revoke LoRA captions') +
      btn('reset', 'Reset password', 'ghost') +
      btn('remove', 'Remove user', 'danger');
  }

  return `
    <div class="account-row ${user.status === 'pending' ? 'pending' : ''}" data-row="${who}">
      <div class="account-head">
        <span class="account-name">${escHtml(user.display_name || user.username)}</span>
        <span class="account-handle">@${escHtml(user.username)}</span>
        <span class="account-status ${escHtml(user.status)}">${escHtml(user.status)}</span>
      </div>
      <div class="account-meta">Registered ${escHtml(when)}</div>
      ${
        (user.grants ?? []).includes('offload')
          ? '<div class="account-meta">Can offload models from VRAM</div>'
          : ''
      }
      ${
        (user.grants ?? []).includes('train')
          ? '<div class="account-meta">Can train LoRAs (Tab 2)</div>'
          : ''
      }
      ${
        (user.grants ?? []).includes('render')
          ? '<div class="account-meta">Can render pictures in ComfyUI</div>'
          : ''
      }
      ${
        (user.grants ?? []).includes('caption')
          ? '<div class="account-meta">Can caption LoRA datasets</div>'
          : ''
      }
      ${user.referral ? `<div class="account-referral">${escHtml(user.referral)}</div>` : ''}
      <div class="account-actions">${actions}</div>
    </div>`;
}

async function refreshAccounts() {
  const host = $('#accounts-list');
  host.innerHTML = '<p class="field-note">Loading…</p>';
  try {
    const res = await rawFetch('/api/admin/users');
    if (!res.ok) {
      host.innerHTML = `<p class="field-note">Could not load accounts (${res.status}).</p>`;
      return;
    }
    const { users } = await res.json();
    const pending = users.filter((u) => u.status === 'pending');
    const decided = users.filter((u) => u.status !== 'pending');

    // Two sections rather than one list: the top is a queue you empty, the
    // bottom is a register you maintain. They are different jobs and the
    // destructive actions belong only to the second.
    host.innerHTML =
      `<div class="accounts-section">
         <div class="accounts-heading">
           Waiting for approval${pending.length ? ` <span class="pending-pip">${pending.length}</span>` : ''}
         </div>
         ${
           pending.length
             ? pending.map((u) => accountRow(u, 'pending')).join('')
             : '<p class="field-note">Nothing waiting.</p>'
         }
       </div>
       <div class="accounts-section">
         <div class="accounts-heading">All accounts</div>
         ${
           decided.length
             ? decided.map((u) => accountRow(u, 'manage')).join('')
             : '<p class="field-note">No accounts yet.</p>'
         }
       </div>`;
    refreshPendingCount();
  } catch (err) {
    host.innerHTML = `<p class="field-note">Could not load accounts — ${escHtml(err.message)}</p>`;
  }
}

/**
 * Render a freshly generated password into its row. The server does not store
 * it, so this is the only time it can ever be read — which is why it replaces
 * the row's actions and stays there until the panel is refreshed by hand,
 * rather than appearing in a toast that times out mid-copy.
 */
function showTemporaryPassword(username, password) {
  const row = $(`.account-row[data-row="${CSS.escape(username)}"]`);
  if (!row) return;
  const actions = $('.account-actions', row);
  actions.innerHTML = `
    <div class="temp-password">
      <div class="temp-password-label">New password for ${escHtml(username)} — shown once, send it to them now</div>
      <div class="temp-password-row">
        <code>${escHtml(password)}</code>
        <button class="ghost" data-copy="${escHtml(password)}">Copy</button>
        <button class="ghost" data-act="dismiss-temp">Done</button>
      </div>
    </div>`;
}

// Your own preferences, fetched once at boot so the model selectors can
// honour them, and re-read whenever the account panel opens.
let PREFS = null;

/**
 * Why the last loadAccount() failed, for the panel to show.
 *
 * It returned a bare null, and every caller treated that as "nothing to do"
 * and stopped. Reported 5 Sep 2026 as an account panel with empty dropdowns —
 * no error in the console, nothing in the server log, because there was no
 * failure anywhere: the panel had simply given up at its first line and said
 * nothing about it. A silent bail is the hardest kind of bug to be told about,
 * which is the whole reason this exists.
 */
let accountLoadError = null;

async function loadAccount() {
  accountLoadError = null;
  try {
    const res = await rawFetch('/api/account');
    if (!res.ok) {
      accountLoadError = `the server answered ${res.status} for /api/account`;
      return null;
    }
    const data = await res.json();
    PREFS = data.preferences ?? null;
    // The account is the authority on language, and this is the first moment
    // it is known. Until now the interface has been in whatever this browser
    // last cached — which is right for the login wall and wrong the instant
    // there is an account saying otherwise. A no-op when they already agree.
    if (PREFS?.language) setLanguage(PREFS.language);
    // The account is the authority on appearance too, and this is the first
    // moment it is known. index.html already painted from this browser's
    // cache before first paint; this corrects it when they disagree — which
    // is exactly what happens on someone else's machine, or after changing it
    // from a phone.
    if (PREFS) applyAppearance(PREFS);
    return data;
  } catch (err) {
    accountLoadError = `the request for /api/account failed — ${err.message}`;
    return null;
  }
}

/** Populate the account panel from the server rather than from stale state. */
async function fillAccountPanel() {
  const problem = (text) => {
    const box = $('#acct-message');
    if (!box) return;
    box.hidden = false;
    box.textContent = text;
  };

  const data = await loadAccount();
  if (!data) {
    problem(
      `Your settings could not be loaded — ${accountLoadError ?? 'the reason is not known'}. ` +
        'Nothing here is saved or lost; reopening usually works.'
    );
    return;
  }

  try {
    await fillAccountFields(data);
  } catch (err) {
    // A throw halfway leaves every selector below it empty and every one above
    // it filled, which reads as "the settings are broken" rather than as one
    // failure with a name. Naming it costs nothing and is the difference
    // between a bug report and a diagnosis.
    problem(`Part of your settings could not be filled in — ${err.message}`);
    throw err;
  }
}

async function fillAccountFields(data) {

  $('#acct-display').value = data.user?.display_name ?? '';

  // The standing instruction. Its cap comes from /api/status rather than
  // being written here, so the textarea and the validator cannot disagree
  // about the number — the same rule the chat temperature slider follows.
  const instruction = $('#acct-instruction');
  if (instruction) {
    let max = 500;
    try {
      max = (await fetch('/api/status').then((r) => r.json()))?.custom_instruction_max ?? 500;
    } catch {
      // The server's own default. An unbounded textarea would let someone
      // write past the cap and have the whole thing dropped on save.
    }
    instruction.maxLength = max;
    instruction.value = data.preferences?.custom_instruction ?? '';
    const count = $('#acct-instruction-count');
    const paint = () => {
      if (count) count.textContent = instruction.value.length
        ? `${instruction.value.length} / ${max}`
        : '';
    };
    instruction.oninput = paint;
    paint();
  }
  $('#acct-username-note').textContent = `Signed in as @${data.user?.username ?? '?'} — usernames cannot be changed.`;

  // Registry-driven, like every other selector in this file: no model is
  // named here. Grouped by type with <optgroup> so ten entries in one list
  // stay readable — the groups come from the registry's own `type` field
  // rather than a hardcoded pair.
  const sel = $('#acct-model');
  sel.innerHTML = '';
  const types = [...new Set(REGISTRY.models.map((m) => m.type))];
  for (const type of types) {
    const group = document.createElement('optgroup');
    group.label = `${prettify(type)} models`;
    for (const m of REGISTRY.models.filter((x) => x.type === type)) {
      const opt = document.createElement('option');
      opt.value = m.key;
      opt.textContent = m.label;
      if (m.key === PREFS?.default_model) opt.selected = true;
      group.appendChild(opt);
    }
    sel.appendChild(group);
  }

  const taggerOpts = ['both', ...(TAGGERS?.taggers ?? []).map((t) => t.key)];
  fillSelect($('#acct-tagger'), taggerOpts, PREFS?.default_tagger, (k) =>
    k === 'both' ? 'Both taggers' : (TAGGERS?.taggers ?? []).find((t) => t.key === k)?.name ?? k
  );

  await fillReferenceAnalysis();
  await fillPromptLlm();
  await fillChatTemperature();
  await fillLanguage();
  await fillAppearance();
}

// ── appearance, per person ───────────────────────────────────
//
// Colour scheme, typeface and text size. All three change only what THIS
// account sees: they live in that person's preferences record and are applied
// by setting an attribute on <html>, so nothing about them reaches another
// session, another user, or the server's own output.
//
// Names are written out here rather than derived from the keys because
// "tokyo" should read "Tokyo Night" and "paper" should say what it is. The
// server owns the LIST — /api/status serves it from the same constant the
// validator enforces — and this only owns how each entry reads. An unknown
// key falls back to its own name rather than vanishing, so adding a theme
// server-side is never invisible.
const THEME_NAMES = {
  midnight: 'Midnight — the original',
  lime: 'Lime',
  nord: 'Nord — arctic, low contrast',
  dracula: 'Dracula — purple',
  gruvbox: 'Gruvbox — warm, retro',
  tokyo: 'Tokyo Night — indigo',
  sakura: 'Sakura — pink on black',
  paper: 'Paper — light',
};
const FONT_NAMES = {
  // Not 'Inter' — no @font-face loads it, so this is the system UI font on
  // every box here. Naming a face the app never ships was the reason three
  // options looked identical and only one of them said so.
  default: 'Default — system UI',
  grotesk: 'Grotesk — Arial',
  humanist: 'Humanist — Verdana, wider',
  serif: 'Serif',
  mono: 'Monospace — everything',
};
const TEXT_SIZE_NAMES = { small: 'Small', normal: 'Normal', large: 'Large' };

/**
 * Put the chosen appearance on <html>, and cache it for the next load.
 *
 * The cache is what stops a flicker: index.html reads it inline before first
 * paint, because waiting for /api/account would render the default palette
 * for a few hundred milliseconds and then swap it on every single load. The
 * account stays the authority and corrects the cache when they disagree.
 *
 * 'midnight' and 'default' mean REMOVE the attribute — those palettes live in
 * styles.css :root, so that a browser which never loads themes.css renders
 * the app exactly as it did before any of this existed.
 */
function applyAppearance({ theme, font, text_size: textSize } = {}) {
  const root = document.documentElement;
  // Only ever set an attribute for a value there is a palette for. Found the
  // hard way: real accounts on this box carry `theme: "dark"`, written by
  // setPrefs back when DEFAULT_PREFS said so and the key was accepted by
  // nothing. There is no [data-theme="dark"] block, so it rendered the
  // default palette by accident rather than by design — which is the kind of
  // thing that looks fine until someone adds a "dark" theme and it lands on
  // every old account at once.
  const set = (attr, value, none, known) => {
    if (!value || value === none || !known.includes(value)) root.removeAttribute(attr);
    else root.setAttribute(attr, value);
  };
  set('data-theme', theme, 'midnight', Object.keys(THEME_NAMES));
  set('data-font', font, 'default', Object.keys(FONT_NAMES));
  set('data-textsize', textSize, 'normal', Object.keys(TEXT_SIZE_NAMES));
  // A benchmark sheet is in an iframe with its own <html>, so themes.css —
  // which keys off data-theme on the root — cannot reach it. Its palette is
  // copied in instead, and this is where a theme change has to re-copy it.
  // Safe when the tab has never been opened: the frame is empty and the
  // function returns without touching anything.
  paintBenchmarkFrame();
  paintThemeInto($('#layout-frame iframe'));
  try {
    localStorage.setItem('promptforge-appearance', JSON.stringify({ theme, font, text_size: textSize }));
  } catch { /* private mode */ }
}

// ── which output segments you want, per model ────────────────
//
// A cell in the builder's control row, beside Quality preset and Length,
// because that is where the person is looking when they care — the owner's
// call after seeing it buried in the profile panel. It still SAVES to the
// account, so it is a standing choice rather than something to re-tick every
// generation; the builder is just where the choice is made and shown.
//
// The negative prompt and the "explain yourself" segments are the only ones
// that can be switched off. server/segments.mjs decides that and is the only
// place that does, which is why each model arrives carrying its own
// `optional_segments` instead of app.js re-deriving the rule.
//
// Per model, not one global switch: krea2's "What changed" says what it
// rewrote, and Reasoning on a booru tag list explains a list you can already
// read. One switch would throw those out together.
/**
 * The segments this account has switched off for a model.
 *
 * Absent and empty mean different things: no entry is "never touched, use the
 * default", an empty entry is "ticked them all on". The default is config's
 * — optional_segments_default — and the server resolves it identically, so a
 * checkbox always shows what the generation will actually do.
 *
 * One function because there were briefly two, and only the one behind the
 * checkboxes learned about the default: the boxes read OFF while the negative
 * prompt box stayed on screen.
 */
function omittedSegments(model) {
  const stored = (PREFS?.omit_segments ?? {})[model?.key];
  if (Array.isArray(stored)) return stored;
  const off = String(REGISTRY?.defaults?.optional_segments_default ?? 'on').toLowerCase() === 'off';
  return off ? (model?.optional_segments ?? []) : [];
}
function renderSegmentToggles(mount, model) {
  const block = $('[data-bind="slider_block"]', mount);
  if (!block) return;
  // A model switch re-renders the row, so a previous model's cell has to go
  // with it — the same reason renderSliders clears the Length field.
  $('.field.segments', mount)?.remove();

  const optional = model?.optional_segments ?? [];
  if (!optional.length) return;

  const wrap = document.createElement('div');
  wrap.className = 'field segments';

  const head = document.createElement('span');
  head.className = 'slider-title';
  head.textContent = 'Include';
  wrap.appendChild(head);

  const boxes = document.createElement('div');
  boxes.className = 'segment-switches';
  // Absent and empty mean different things: no entry is "never touched, use
  // the default", an empty entry is "ticked them all on". The default is
  // config's — optional_segments_default — and the server resolves it the
  // same way, so the checkbox always shows what the generation will do.
  const omitted = () => omittedSegments(model);

  for (const label of optional) {
    const item = document.createElement('label');
    item.className = 'segment-switch';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.dataset.segment = label;
    box.checked = !omitted().includes(label);
    const text = document.createElement('span');
    text.textContent = label;
    item.append(box, text);
    box.addEventListener('change', () => saveSegmentToggles(mount, model));
    boxes.appendChild(item);
  }
  wrap.appendChild(boxes);

  const note = document.createElement('span');
  note.className = 'field-note';
  note.textContent = 'Unticked is not asked for, so it is not written.';
  wrap.appendChild(note);

  block.parentElement.insertBefore(wrap, block);
  applySegmentPrefs(mount, model);
}

/**
 * Persist the switches and apply them to the builder.
 *
 * Written as the OMISSIONS rather than the inclusions, so an account with no
 * preference and a model whose segments change later both mean "give me
 * everything" — the behaviour that predates this control.
 *
 * PREFS is updated before the request rather than after it, because the
 * builder reads PREFS to decide whether to hide the negative box and a
 * round trip between ticking and hiding would read as a stuck checkbox.
 */
async function saveSegmentToggles(mount, model) {
  const omit = [];
  for (const box of $$('.field.segments input[type="checkbox"]', mount)) {
    if (!box.checked) omit.push(box.dataset.segment);
  }
  // Always an entry, even when empty. Deleting it would mean "never touched",
  // which now resolves back to the default — so ticking everything on would
  // switch itself off again on the next reload.
  const next = { ...(PREFS?.omit_segments ?? {}), [model.key]: omit };
  PREFS = { ...(PREFS ?? {}), omit_segments: next };
  applySegmentPrefs(mount, model);

  try {
    await rawFetch('/api/account', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ preferences: { omit_segments: next } }),
    });
  } catch {
    // The switch still applies to this session. It is a preference, not an
    // instruction that has to reach the server before the next generation —
    // that one reads the stored value, and a failed save simply means the
    // next reload starts from the old one.
    toast('Could not save that preference — it applies until you reload.');
  }
}

/**
 * Hide the negative prompt box when this model's negative is switched off.
 *
 * collectControls() skips any control inside [hidden], so hiding the field is
 * also what stops a stale negative riding along on a request that did not ask
 * for one — the same mechanism the i2v frame fields rely on.
 */
function applySegmentPrefs(mount, model) {
  const omitted = omittedSegments(model);
  const field = $('[data-bind="negative"]', mount)?.closest('.field');
  if (!field) return;
  const off = omitted.some((l) => /negative/i.test(l));
  // Only ever hides on this path. A model with has_negative:false has already
  // been hidden by data-show, and un-hiding here would show a box for a model
  // that has no negative prompt at all.
  if (off) field.hidden = true;
  else if (model?.has_negative !== false) field.hidden = false;
}

async function fillAppearance() {
  const themeSel = $('#acct-theme');
  const fontSel = $('#acct-font');
  const sizeSel = $('#acct-textsize');
  if (!themeSel) return;

  let offered = null;
  try {
    offered = (await fetch('/api/status').then((r) => r.json()))?.appearance;
  } catch {
    // Fall through to what themes.css carries. The two agree unless someone
    // has added a palette to only half the pair.
  }
  const themes = offered?.themes ?? Object.keys(THEME_NAMES);
  const fonts = offered?.fonts ?? Object.keys(FONT_NAMES);
  const sizes = offered?.text_sizes ?? Object.keys(TEXT_SIZE_NAMES);

  fillSelect(themeSel, themes, PREFS?.theme ?? 'midnight', (k) => THEME_NAMES[k] ?? k);
  fillSelect(fontSel, fonts, PREFS?.font ?? 'default', (k) => FONT_NAMES[k] ?? k);
  fillSelect(sizeSel, sizes, PREFS?.text_size ?? 'normal', (k) => TEXT_SIZE_NAMES[k] ?? k);

  // Applied on change rather than on Save, like the language selector and for
  // the same reason: an appearance you cannot see applied is one you cannot
  // judge, and the Save button is itself one of the things that changes
  // colour. Still written to the account on Save, which is what makes it
  // survive to another device.
  const live = () => applyAppearance({
    theme: themeSel.value,
    font: fontSel.value,
    text_size: sizeSel.value,
  });
  themeSel.onchange = live;
  fontSel.onchange = live;
  sizeSel.onchange = live;
}

/**
 * The interface language.
 *
 * Options come from /api/status, from the same constant the server validates
 * against — a selector offering a language the server drops would look like
 * the setting refusing to save, which is the trap the chat temperature slider
 * is bounded to avoid.
 *
 * Each language is named IN ITSELF. Someone hunting for German is looking for
 * "Deutsch", and a list reading "German" is a list they have to translate in
 * their head first — which is a strange thing to ask of the one control that
 * exists because they would rather not read English.
 *
 * Applied on change rather than on save. The rest of this panel waits for the
 * Save button, but a language you cannot see applied is a language you cannot
 * confirm you picked correctly — and the Save button itself is one of the
 * things that changes. It is still written to the account on save.
 */
const LANGUAGE_NAMES = { en: 'English', fr: 'Français', de: 'Deutsch' };

async function fillLanguage() {
  const sel = $('#acct-language');
  if (!sel) return;

  let offered = null;
  try {
    offered = (await fetch('/api/status').then((r) => r.json()))?.languages;
  } catch {
    // Fall through to what the module itself carries dictionaries for. The
    // two agree unless someone has added one to only half the pair.
  }
  const langs = Array.isArray(offered) && offered.length ? offered : uiLanguages();

  fillSelect(sel, langs, PREFS?.language ?? uiLanguage(), (k) => LANGUAGE_NAMES[k] ?? k);
  sel.onchange = () => setLanguage(sel.value);
}

/**
 * Chat temperature.
 *
 * The range is served by /api/status rather than written here, so the slider
 * cannot offer a value validatePreferences will drop — which would look like
 * the setting refusing to save.
 */
/**
 * Who reads a reference image: the taggers, or the model you write with.
 *
 * The options come from /api/status rather than being written here, from the
 * same constant the server validates against — a selector offering a value
 * the server drops looks exactly like a setting that will not save.
 *
 * `llm_available` is a different question from the list. It says whether THIS
 * server can do it at all — the instruction file has to be on disk and the
 * config switch has to be on — and when it cannot, the option is disabled
 * with the reason under it rather than quietly missing.
 */
async function fillReferenceAnalysis() {
  const sel = $('#acct-reference-analysis');
  const note = $('#acct-reference-analysis-note');
  if (!sel) return;

  let info = null;
  try {
    info = (await fetch('/api/status').then((r) => r.json()))?.reference_analysis;
  } catch {
    // Fall through to the two the server ships with. Both are real values;
    // the worst case is offering the LLM on a box that has it switched off,
    // which falls back to the taggers and says so on the card.
  }
  const options = info?.options?.length ? info.options : ['taggers', 'llm'];
  const available = info?.llm_available !== false;

  fillSelect(sel, options, PREFS?.reference_analysis ?? 'taggers', (k) =>
    k === 'llm' ? 'The model you write prompts with' : 'The taggers (animetimm + EVA02)'
  );
  for (const opt of sel.options) {
    if (opt.value === 'llm') opt.disabled = !available;
  }

  const paint = () => {
    if (!note) return;
    note.textContent = !available
      ? 'The LLM reader is switched off on this server, so references are read by the taggers.'
      : sel.value === 'llm'
        ? 'Slower and uses the graphics card, and it sees light, framing and surface the taggers cannot score.'
        : 'Fast, runs on the CPU, and the only thing here that can name a character.';
  };
  paint();
  // Bound once — fillAccountPanel runs on every open.
  if (!sel.dataset.bound) {
    sel.addEventListener('change', paint);
    sel.dataset.bound = '1';
  }
}

async function fillChatTemperature() {
  const sel = $('#acct-chat-temp');
  const out = $('#acct-chat-temp-value');
  if (!sel) return;

  let range = null;
  try {
    range = (await fetch('/api/status').then((r) => r.json()))?.chat?.temperature_range;
  } catch {
    // Fall through to the same numbers the server ships with. Leaving the
    // slider unbounded would let it produce a value the server drops.
  }
  const { min = 0, max = 1.5, step = 0.05, default: fallback = 0.7 } = range ?? {};
  sel.min = min;
  sel.max = max;
  sel.step = step;
  sel.value = PREFS?.chat_temperature ?? fallback;

  const paint = () => {
    if (out) out.textContent = Number(sel.value).toFixed(2);
  };
  paint();
  // Bound once. fillAccountPanel runs every time the panel opens, and a
  // listener added per open would fire once per open thereafter.
  if (!sel.dataset.bound) {
    sel.addEventListener('input', paint);
    sel.dataset.bound = '1';
  }
}

/**
 * Which LLM writes your prompts.
 *
 * Listed from what Ollama actually has installed rather than from a written
 * list, so it can never offer something that is not there — and so a model
 * pulled after this shipped appears without a code change.
 *
 * The reason this control exists is worth stating in the panel: the default
 * model declines some of what people here actually make, and switching used to
 * mean editing config and restarting the server for everybody.
 */
async function fillPromptLlm() {
  const sel = $('#acct-prompt-llm');
  const note = $('#acct-prompt-llm-note');
  if (!sel) return;

  let status = null;
  try {
    status = await fetch('/api/status').then((r) => r.json());
  } catch {
    // Fall through: the control still offers the default, which always works.
  }
  const installed = status?.llm?.installed ?? [];
  const configured = status?.llm?.model ?? null;

  sel.innerHTML = '';
  const asDefault = document.createElement('option');
  asDefault.value = '';
  asDefault.textContent = configured ? `Default — ${configured}` : 'Default';
  sel.appendChild(asDefault);

  for (const name of installed) {
    if (name === configured) continue;   // already the default entry
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  }

  const chosen = PREFS?.prompt_llm ?? '';
  // A saved choice for a model that has since been removed: keep it visible
  // rather than silently reverting to default, or the setting appears not to
  // have saved.
  if (chosen && !installed.includes(chosen)) {
    const missing = document.createElement('option');
    missing.value = chosen;
    missing.textContent = `${chosen} — not installed`;
    sel.appendChild(missing);
  }
  sel.value = chosen;

  // Targets that pin their own LLM, named from the registry rather than
  // hardcoded, because a personal setting must not quietly override a measured
  // requirement without saying so.
  const pinned = REGISTRY.models.filter((m) => m.llm_model).map((m) => m.label);
  if (note) {
    note.textContent =
      'Some models decline requests the others handle. This is where you pick a ' +
      'different one for prompt writing.' +
      (pinned.length
        ? ` ${pinned.join(' and ')} always ${pinned.length > 1 ? 'use' : 'uses'} the model set for ` +
          `${pinned.length > 1 ? 'them' : 'it'} in the registry, whatever you choose here.`
        : '');
  }
}

// ── Guided tour ──────────────────────────────────────────────
//
// Offered once per account, after sign-in, in a box of its own; either answer
// is saved as the `tour` preference so it is not asked again. The account
// panel starts it any time. The tour itself is web/tour.js, its stops
// web/tour-steps.js. Owner's design, 15 Oct 2026.

function saveTourState(state) {
  PREFS = { ...(PREFS ?? {}), tour: state };
  rawFetch('/api/account', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ preferences: { tour: state } }),
  }).catch(() => {
    // Quiet, like the other one-click preferences: the worst case is being
    // asked again next time.
  });
}

function runTour() {
  saveTourState('taken');
  startTour();
}

/** Ask once, after anything else that opens on sign-in has been dealt with. */
function maybeOfferTour() {
  if (PREFS?.tour !== 'unasked') return;
  const box = $('#tour-offer');
  const open = () => {
    $('#tour-offer-ask').hidden = false;
    $('#tour-offer-later').hidden = true;
    box.hidden = false;
  };
  $('#tour-offer-yes').addEventListener('click', () => {
    box.hidden = true;
    runTour();
  });
  $('#tour-offer-no').addEventListener('click', () => {
    saveTourState('declined');
    $('#tour-offer-ask').hidden = true;
    $('#tour-offer-later').hidden = false;
  });
  $('#tour-offer-ok').addEventListener('click', () => { box.hidden = true; });

  // The setup wizard opens on a first run, after a fetch, so it may not be
  // up yet when this runs. Wait until no other box has been open for two
  // checks in a row, then ask. Gives up quietly if it never gets a clear
  // moment within ten minutes; the next sign-in asks again.
  let clear = 0;
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    const busy = $$('.modal-backdrop').some((m) => m !== box && !m.hidden);
    clear = busy ? 0 : clear + 1;
    if (clear >= 2) { clearInterval(timer); open(); }
    else if (tries > 600) clearInterval(timer);
  }, 1000);
}

function initPasswordPanel() {
  const modal = $('#password-modal');
  const msg = $('#pw-message');
  const close = () => {
    modal.hidden = true;
    $('#password-form').reset();
    msg.hidden = true;
    $('#acct-message').hidden = true;
  };

  $('#whoami').addEventListener('click', () => {
    msg.hidden = true;
    $('#acct-message').hidden = true;
    modal.hidden = false;
    fillAccountPanel();
  });

  $('#acct-tour').addEventListener('click', () => {
    close();
    runTour();
  });

  $('#acct-save').addEventListener('click', async () => {
    const btn = $('#acct-save');
    const out = $('#acct-message');
    const show = (text, ok = false) => {
      out.hidden = false;
      out.textContent = text;
      out.classList.toggle('ok', ok);
    };
    btn.disabled = true;
    try {
      const res = await rawFetch('/api/account', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          display_name: $('#acct-display').value,
          preferences: {
            default_model: $('#acct-model').value,
            default_tagger: $('#acct-tagger').value,
            ...($('#acct-reference-analysis')
              ? { reference_analysis: $('#acct-reference-analysis').value }
              : {}),
            prompt_llm: $('#acct-prompt-llm')?.value ?? '',
            // Number, not the string the input carries: the validator checks
            // typeof and would drop a string without saying why.
            ...($('#acct-chat-temp')
              ? { chat_temperature: Number($('#acct-chat-temp').value) }
              : {}),
            // Already applied on change — this is what makes it survive to
            // the next device, rather than living only in this browser's
            // localStorage cache.
            ...($('#acct-language') ? { language: $('#acct-language').value } : {}),
            // Already applied on change — saving is what carries them to the
            // next device rather than leaving them in this browser's cache.
            ...($('#acct-theme') ? { theme: $('#acct-theme').value } : {}),
            ...($('#acct-font') ? { font: $('#acct-font').value } : {}),
            ...($('#acct-textsize') ? { text_size: $('#acct-textsize').value } : {}),
            // Free text, and the server drops it rather than truncating when
            // it is too long — the textarea's maxLength is the same number,
            // so the only way to exceed it is by not using the textarea.
            ...($('#acct-instruction') ? { custom_instruction: $('#acct-instruction').value } : {}),
          },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return show(data.message ?? `Something went wrong (${res.status}).`);
      PREFS = data.preferences ?? PREFS;
      // The topbar carries the display name, so it has to follow immediately
      // rather than waiting for a reload.
      if (data.user) applyIdentity(data.user);
      show('Saved.', true);
      toast('Account updated');
    } catch (err) {
      show(`Could not reach the server — ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  });

  $('#acct-signout').addEventListener('click', async () => {
    await rawFetch('/api/auth/logout', { method: 'POST' });
    // Before the reload, not after: the next person to sign in on this tab
    // must not inherit the last one's prompts.
    clearSessionHistory();
    // A full reload rather than tearing the app down by hand: it guarantees
    // no previous user's output, library or model state is left on screen.
    location.reload();
  });
  $('#password-close').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) close();
  });

  $('#password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const current = $('#pw-current').value;
    const next = $('#pw-new').value;
    const confirmValue = $('#pw-confirm').value;

    const show = (text, ok = false) => {
      msg.hidden = false;
      msg.textContent = text;
      msg.classList.toggle('ok', ok);
    };

    // Caught here rather than at the server, which has no way to know the
    // second box exists.
    if (next !== confirmValue) return show('The two new passwords do not match.');

    const btn = $('#pw-submit');
    btn.disabled = true;
    try {
      const res = await rawFetch('/api/account/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ current_password: current, new_password: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return show(data.message ?? `Something went wrong (${res.status}).`);
      show('Password changed.', true);
      toast('Password changed');
      setTimeout(close, 900);
    } catch (err) {
      show(`Could not reach the server — ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  });
}

/**
 * The tag database section of the admin panel.
 *
 * Text goes in with textContent throughout. The log lines come from a child
 * process reading a third-party CSV index, so they are no more ours than the
 * model output the error box already refuses to render as HTML.
 */
async function refreshTagDb() {
  const summary = $('#tagdb-summary');
  if (!summary) return;
  try {
    const info = await fetch('/api/tags/info').then((r) => r.json());
    if (!info.loaded) {
      summary.textContent = info.error ?? 'No tag database. Press Update to build one.';
      return;
    }
    const age =
      info.age_days == null
        ? 'age unknown'
        : info.age_days === 0
          ? 'updated today'
          : `${info.age_days} day${info.age_days === 1 ? '' : 's'} old`;
    const stale = info.stale ? ` · older than ${info.stale_after_days} days` : '';
    summary.textContent = `${info.total_rows.toLocaleString()} tags · ${age}${stale}`;
    // Only a hint. Nothing is broken about a stale list — danbooru moves
    // slowly — so this nudges rather than warns.
    summary.classList.toggle('stale', Boolean(info.stale));
  } catch {
    summary.textContent = 'Could not read the tag database.';
  }
}

/** Server messages sometimes end in a full stop and sometimes do not. */
function sentence(text) {
  const t = String(text).trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

function initTagDbPanel() {
  const btn = $('#btn-tagdb-update');
  const out = $('#tagdb-result');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    // Two downloads, ~180,000 inserts and an index build. Measured at about
    // two seconds on this box, but it is a network call, so say something
    // immediately rather than leaving a dead button.
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Updating…';
    out.hidden = false;
    out.textContent = 'Downloading the tag lists… autocomplete is unavailable until this finishes.';
    try {
      const res = await fetch('/api/admin/tags/update', { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.ok) {
        out.textContent = `Updated — ${data.tags.total_rows.toLocaleString()} tags in ${(data.took_ms / 1000).toFixed(1)}s.`;
      } else {
        out.textContent = `Update failed: ${sentence(data.message ?? res.status)} The previous tag database is still in place.`;
      }
    } catch (err) {
      out.textContent = `Update failed: ${sentence(err.message)} The previous tag database is still in place.`;
    } finally {
      btn.disabled = false;
      btn.textContent = label;
      refreshTagDb();
    }
  });
}
// ─────────────────────── Live host usage strip ───────────────────────
//
// CPU, RAM and VRAM across the top. On a box five people share and one GPU
// everybody queues for, "is something already hammering it" was answered by
// sshing in and running nvidia-smi; the queue panel says who holds the GPU,
// this says what the machine is doing — including the half PromptForge does
// not own, since ComfyUI shares the card.
//
// Its own 2s poll. The 10s /api/status one is right for backend health and
// wrong for something meant to read as live: a bar that steps once every ten
// seconds reads as broken rather than as calm.

const SYS_POLL_MS = 2000;

/**
 * Bytes to a short human size, in BINARY units labelled the ordinary way.
 *
 * Decimal until 5 Sep 2026, which rendered a 32GB machine as "33.6GB" and had
 * the owner asking whether he had more RAM than he thought. Both sources here
 * report in binary — /proc/meminfo in kB that are really KiB, nvidia-smi in
 * MiB — so dividing by 1e9 inflated every figure by 7%.
 *
 * Labelled GB rather than GiB because that is what every OS tool calls it,
 * and a strip that said GiB would trade one confusing number for one
 * confusing unit. The remaining gap from the number on the box is real and
 * worth seeing: the kernel reserves some, and 31.3 of 32 is the truth.
 */
function shortBytes(n) {
  if (!Number.isFinite(n)) return '—';
  const K = 1024;
  if (n >= K ** 4) return `${(n / K ** 4).toFixed(1)}TB`;
  if (n >= K ** 3) return `${(n / K ** 3).toFixed(1)}GB`;
  if (n >= K ** 2) return `${Math.round(n / K ** 2)}MB`;
  return `${Math.round(n / K)}kB`;
}

/**
 * "Tesla P40" -> "P40", "Tesla V100-PCIE-32GB" -> "V100", "NVIDIA RTX A6000"
 * -> "A6000".
 *
 * nvidia-smi reports a full marketing name and there is no room for it in a
 * strip gauge. The model number is the part that identifies the card to
 * somebody standing in front of the machine; the vendor and the bus are not.
 * Falls back to the index when nothing recognisable is in there, so an
 * unfamiliar card still gets a distinct label rather than a blank one.
 */
function shortGpuName(g) {
  // Two digits minimum, not three: the card this box actually has is a P40.
  const m = String(g.name ?? '').match(/\b([A-Z]?\d{2,4}[A-Za-z]*)\b/);
  return m ? m[1] : `VRAM ${g.index}`;
}

/**
 * One gauge: a label, a reading, and a bar.
 *
 * The bar takes a `hot` class past 85% rather than a colour scale, because a
 * gradient invites reading precision into it that is not there — what matters
 * is "there is room" versus "there is not".
 */
function sysGauge(label, percent, detail, title) {
  const p = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
  return `
    <div class="sysgauge${p != null && p >= 85 ? ' hot' : ''}"${title ? ` title="${escHtml(title)}"` : ''}>
      <span class="sysgauge-label">${escHtml(label)}</span>
      <span class="sysgauge-bar"><span style="width:${p ?? 0}%"></span></span>
      <span class="sysgauge-value">${p == null ? '—' : `${Math.round(p)}%`}</span>
      ${detail ? `<span class="sysgauge-detail">${escHtml(detail)}</span>` : ''}
    </div>`;
}

function paintSystem(data) {
  const bar = $('#sysbar');
  if (!bar) return;
  if (!data || data.disabled) {
    bar.hidden = true;
    return;
  }
  const parts = [];
  if (data.cpu) {
    parts.push(sysGauge('CPU', data.cpu.percent, `${data.cpu.cores} cores`, 'Host CPU across all cores'));
  }
  if (data.memory) {
    parts.push(
      sysGauge(
        'RAM',
        data.memory.percent,
        `${shortBytes(data.memory.used)} / ${shortBytes(data.memory.total)}`,
        'System memory in use. Read from MemAvailable, so the page cache is not counted against you.'
      )
    );
  }
  // One gauge per card, and NAMED when there is more than one.
  //
  // The plan is a P40 alongside a V100 for a while — not the matched pair the
  // old spec assumed — and with two different cards "VRAM 0" and "VRAM 1" make
  // you remember which is which. "P40" and "V100" do not. Single card stays
  // plain "VRAM", because naming it tells you nothing you did not know.
  for (const g of data.gpu ?? []) {
    const name = data.gpu.length > 1 ? shortGpuName(g) : 'VRAM';
    parts.push(
      sysGauge(
        name,
        g.percent,
        `${shortBytes(g.used)} / ${shortBytes(g.total)}`,
        `${g.name} — ${g.utilization}% busy${g.temperature != null ? `, ${g.temperature}°C` : ''}`
      )
    );
    parts.push(
      sysGauge(
        data.gpu.length > 1 ? `${shortGpuName(g)} busy` : 'GPU',
        g.utilization,
        g.temperature != null ? `${g.temperature}°C` : '',
        // Worth saying: the P40 is passively cooled and throttles, so a slow
        // generation and a hot card are the same story.
        `${g.name} compute utilisation`
      )
    );
  }
  if (!parts.length) {
    bar.hidden = true;
    return;
  }
  bar.innerHTML = parts.join('');
  bar.hidden = false;
}

async function refreshSystem() {
  try {
    const res = await fetch('/api/system');
    if (!res.ok) return;
    paintSystem(await res.json());
  } catch {
    // A dropped poll is not worth a message. The strip holds its last reading
    // and the next tick corrects it.
  }
}

// ─────────────────────────── Randomizer ───────────────────────────
//
// Tick categories, roll, insert into the brief. Nothing here calls a model:
// /api/randomizer/roll spawns a Python script that reads the tag database,
// and the result lands in the brief box for the person to edit. It is a
// writing aid, not a generation step.
//
// Image models only, gated on `type` from the registry rather than on a list
// of names — a seventh image model gets this for free.

let randomizerCats = null;

/**
 * One box: a parent with its pieces inside.
 *
 * The parent tick is a real control, not a label — ticking it means "all of
 * this", which is the coarse choice most people want, and opening it up to
 * tick two of nine is the fine one. That is the shape the source workflow
 * uses, where a group toggle sits above a column of individual toggles.
 *
 * `indeterminate` is set in script rather than markup because HTML has no
 * attribute for it; a parent showing plain unchecked while three children are
 * on would misreport what is about to be rolled.
 */
// Which boxes are open. Per viewer, per browser, and a convenience only —
// every read and write is wrapped, and a browser that refuses storage just
// gets everything collapsed, which is the default anyway.
const RANDOMIZER_OPEN_KEY = 'pf.randomizer.open';

function readOpenBoxes() {
  try {
    const raw = localStorage.getItem(RANDOMIZER_OPEN_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function writeOpenBoxes(set) {
  try {
    localStorage.setItem(RANDOMIZER_OPEN_KEY, JSON.stringify([...set]));
  } catch {
    // Private window, or site data blocked. The panel still works; it just
    // forgets which boxes were open.
  }
}

/**
 * One box: a header that collapses, with its pieces inside.
 *
 * Collapsed by default. Sixteen boxes fully expanded is 138 checkboxes and a
 * long scroll to reach the one you wanted; collapsed they are sixteen rows,
 * and you open the two you care about. Owner's call, 5 Sep 2026.
 *
 * The parent tick and the collapse are separate controls on purpose — ticking
 * "all of Hair" and looking inside Hair are different intentions, and one
 * gesture doing both means you cannot do either alone. The checkbox is its own
 * element and the rest of the header is a button, which is also the only way
 * to keep this keyboard-operable: a checkbox nested inside a button is invalid
 * and browsers do not agree on what it does.
 */
function randomizerBox(box, open) {
  const kids = box.children ?? [];
  const total = kids.reduce((n, k) => n + (k.options ?? 0), 0);
  const id = escHtml(box.id);
  return `
    <section class="rbox${open ? ' open' : ''}" data-box="${id}">
      <div class="rbox-head">
        <input type="checkbox" data-rparent="${id}"
               aria-label="Select everything in ${escHtml(box.label)}">
        <button type="button" class="rbox-toggle" data-toggle="${id}"
                aria-expanded="${open ? 'true' : 'false'}">
          <span class="rbox-title">${escHtml(box.label)}</span>
          <span class="rbox-count" data-count="${id}"
                >${kids.length} · ${total.toLocaleString()} options</span>
          <span class="rbox-caret" aria-hidden="true"></span>
        </button>
        <!-- How many of this box's sub-categories a roll actually uses.
             Ticking Eyes means five terms about eyes; this says "give me two
             of them", and WHICH two is random, because picking the first two
             alphabetically would make Sclera unreachable forever. Default is
             all, so this changes nothing until it is touched. -->
        <span class="rbox-limit" data-limit-for="${id}"
              title="How many of these to use in a roll">
          <button type="button" class="rlim" data-limit="${id}" data-delta="-1"
                  aria-label="Use fewer from ${escHtml(box.label)}">−</button>
          <span class="rlim-n" data-limit-n="${id}" data-max="${kids.length}">all</span>
          <button type="button" class="rlim" data-limit="${id}" data-delta="1"
                  aria-label="Use more from ${escHtml(box.label)}">+</button>
        </span>
      </div>
      <div class="rbox-kids"${open ? '' : ' hidden'}>
        ${kids
          .map(
            (k) => `
          <label class="rkid" title="${k.options} options">
            <input type="checkbox" data-rchild="${escHtml(k.id)}" data-of="${id}">
            <span>${escHtml(k.label)}</span>
          </label>`
          )
          .join('')}
      </div>
    </section>`;
}

/** Parent ticks follow their children, and the count line follows both. */
function syncRandomizerBoxes() {
  const modal = $('#randomizer-modal');
  let picked = 0;
  for (const box of modal.querySelectorAll('.rbox')) {
    const parent = $('input[data-rparent]', box);
    const kids = [...box.querySelectorAll('input[data-rchild]')];
    const on = kids.filter((k) => k.checked).length;
    picked += on;
    parent.checked = on === kids.length && kids.length > 0;
    parent.indeterminate = on > 0 && on < kids.length;
    box.classList.toggle('active', on > 0);

    // The header has to say what is ticked inside, because collapsed is the
    // default and a closed box otherwise hides the only thing you need to
    // know about it. Falls back to the size of the box when nothing is on.
    // The stepper reads "off" until something in the box is ticked, because
    // until then it is: a box showing "all" while contributing nothing looks
    // like a setting that is on, which is exactly how the owner read it.
    // Ticking governs whether the box is in the roll; the stepper only caps
    // how much of it gets used once it is.
    const lim = $('[data-limit-n]', box);
    if (lim) {
      const max = Number(lim.dataset.max);
      const set = Number(lim.dataset.value || 0);
      lim.textContent = on === 0 ? 'off' : set === 0 ? 'all' : String(set);
      lim.classList.toggle('off', on === 0);
      lim.classList.toggle('set', on > 0 && set !== 0);
    }

    const count = $(`[data-count="${CSS.escape(box.dataset.box)}"]`, box);
    if (count) {
      if (on === 0) {
        count.textContent = count.dataset.idle ?? count.textContent;
        count.dataset.idle ??= count.textContent;
        count.classList.remove('on');
      } else {
        count.dataset.idle ??= count.textContent;
        count.textContent = on === kids.length ? `all ${on}` : `${on} of ${kids.length}`;
        count.classList.add('on');
      }
    }
  }
  const count = $('#randomizer-count');
  if (count) {
    count.textContent = picked
      ? `${picked} selected`
      : 'Nothing selected — tick a box to roll it.';
  }
  return picked;
}

function randomizerSay(text) {
  const note = $('#randomizer-note');
  if (!note) return;
  note.hidden = !text;
  note.textContent = text ?? '';
}

async function openRandomizer() {
  const modal = $('#randomizer-modal');
  modal.hidden = false;
  randomizerSay('');
  $('#randomizer-roll').textContent = $('#randomizer-result').value.trim() ? 'Reroll' : 'Roll';
  if (randomizerCats) return;

  const host = $('#randomizer-categories');
  host.innerHTML = '<p class="field-note">Loading…</p>';
  try {
    const res = await rawFetch('/api/randomizer/categories');
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      host.innerHTML = '';
      randomizerSay(data.message ?? `Could not load the categories (${res.status}).`);
      return;
    }
    randomizerCats = data.categories ?? [];
    const open = readOpenBoxes();
    host.innerHTML = randomizerCats.map((b) => randomizerBox(b, open.has(b.id))).join('');
    // Nothing preselected. Every box ticked is 138 sub-categories in one
    // brief, which is not a starting point, it is a wall.
    syncRandomizerBoxes();
  } catch (err) {
    host.innerHTML = '';
    randomizerSay(`Could not reach the server — ${err.message}`);
  }
}

/** The grouped preview: what each box contributed, under its own name. */
function renderRandomizerBreakdown(boxes) {
  const host = $('#randomizer-breakdown');
  if (!host) return;
  host.innerHTML = (boxes ?? [])
    .map(
      (b) => `
      <div class="rpick">
        <div class="rpick-box">${escHtml(b.label)}</div>
        ${(b.picks ?? [])
          .map(
            (p) => `<div class="rpick-row">
              <span class="rpick-label">${escHtml(p.label)}</span>
              <span class="rpick-text">${escHtml(p.text)}</span>
            </div>`
          )
          .join('')}
      </div>`
    )
    .join('');
}

function initRandomizer() {
  const modal = $('#randomizer-modal');
  const btn = $('#btn-randomizer');
  if (!modal || !btn) return;

  const result = $('#randomizer-result');
  const insert = $('#randomizer-insert');
  const replace = $('#randomizer-replace');
  const preview = $('#randomizer-preview');
  const close = () => { modal.hidden = true; };

  // Enabled off the textarea, not off the last roll — someone can type their
  // own line in there and insert that, and a disabled button beside text they
  // just wrote would be a lie.
  const syncButtons = () => {
    const has = Boolean(result.value.trim());
    insert.disabled = !has;
    replace.disabled = !has;
  };
  result.addEventListener('input', syncButtons);

  btn.addEventListener('click', openRandomizer);
  $('#randomizer-close').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) close();
  });

  // Delegated: the boxes are built once from the server's category list.
  $('#randomizer-categories').addEventListener('change', (e) => {
    const parent = e.target.closest('input[data-rparent]');
    if (parent) {
      const box = parent.closest('.rbox');
      for (const kid of box.querySelectorAll('input[data-rchild]')) kid.checked = parent.checked;
    }
    syncRandomizerBoxes();
  });

  // Controlled chaos: the switch that reveals the per-box steppers.
  //
  // Remembered per browser, like the open boxes, and wrapped for the same
  // reason — a browser refusing storage should get the default, not an error.
  const CHAOS_KEY = 'pf.randomizer.chaos';
  const grid = $('#randomizer-categories');
  const chaos = $('#randomizer-chaos');
  const setChaos = (on) => {
    grid.classList.toggle('chaos', on);
    chaos.checked = on;
    try {
      localStorage.setItem(CHAOS_KEY, on ? '1' : '');
    } catch {
      // Private window. The switch still works for this session.
    }
  };
  try {
    setChaos(localStorage.getItem(CHAOS_KEY) === '1');
  } catch {
    setChaos(false);
  }
  chaos.addEventListener('change', () => setChaos(chaos.checked));

  // Every box whose stepper sits below its child count. "all" sends nothing,
  // so an untouched panel behaves exactly as it did before steppers existed.
  //
  // Returns nothing at all while the switch is off, even if numbers were set
  // earlier: a hidden control must not be quietly shortening a roll. The
  // values survive, so turning it back on restores what was there.
  const readLimits = () => {
    if (!grid.classList.contains('chaos')) return {};
    const out = {};
    for (const el of modal.querySelectorAll('[data-limit-n]')) {
      const n = Number(el.dataset.value || 0);
      if (n > 0 && n < Number(el.dataset.max)) out[el.dataset.limitN] = n;
    }
    return out;
  };

  // The steppers. A cycle rather than a clamp: all, 1, 2, … , n-1, back to
  // all. "all" is the resting state and the one people want most, so it is
  // where the control starts and always one press from returning to — a
  // clamped stepper made you press minus four times to undo a curious poke.
  //
  // n itself is not a state because it IS "all". A box with a single
  // sub-category therefore has nowhere to go and simply does not move.
  //
  // stopPropagation because these sit inside the header, and a click that also
  // toggled the box open would make them unusable.
  $('#randomizer-categories').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-limit]');
    if (!btn) return;
    e.stopPropagation();
    const el = modal.querySelector(`[data-limit-n="${CSS.escape(btn.dataset.limit)}"]`);
    if (!el) return;
    const max = Number(el.dataset.max);
    if (max < 2) return;
    // 0 is "all"; the cycle is 0, 1, … , max-1.
    const cur = Number(el.dataset.value || 0);
    const next = (cur + Number(btn.dataset.delta) + max) % max;
    el.dataset.value = String(next);
    // syncRandomizerBoxes owns the text, because it also knows whether the box
    // is ticked and therefore whether this reads "off".
    syncRandomizerBoxes();
  });

  // Open and close. Delegated like the ticks, and the open set is written
  // back so the two boxes someone actually uses are still open tomorrow.
  $('#randomizer-categories').addEventListener('click', (e) => {
    const toggle = e.target.closest('button[data-toggle]');
    if (!toggle) return;
    const box = toggle.closest('.rbox');
    const kids = $('.rbox-kids', box);
    const nowOpen = kids.hidden;
    kids.hidden = !nowOpen;
    box.classList.toggle('open', nowOpen);
    toggle.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
    const open = readOpenBoxes();
    if (nowOpen) open.add(box.dataset.box);
    else open.delete(box.dataset.box);
    writeOpenBoxes(open);
  });

  $('#randomizer-collapse').addEventListener('click', () => {
    for (const box of modal.querySelectorAll('.rbox')) {
      $('.rbox-kids', box).hidden = true;
      box.classList.remove('open');
      $('button[data-toggle]', box)?.setAttribute('aria-expanded', 'false');
    }
    writeOpenBoxes(new Set());
  });

  // Clears the ticks, not the open boxes — someone tidying their selection is
  // usually about to make a different one in the same categories.
  $('#randomizer-none').addEventListener('click', () => {
    for (const el of modal.querySelectorAll('#randomizer-categories input')) el.checked = false;
    syncRandomizerBoxes();
  });

  // Both buttons run the same request; Surprise sets a flag and skips the
  // 'tick something first' check, because choosing for you is its whole job.
  const doRoll = async (surprise) => {
    // Child ids only. A parent id would work — the script expands it — but
    // sending exactly what is ticked means the request says what the person
    // sees, and a half-ticked box cannot be misread as a whole one.
    // Sent for BOTH buttons. Roll uses them as the selection; Surprise uses
    // them as the pool it draws from, so ticking Hair and Environment means
    // 'surprise me, but from these'. Nothing ticked means everything except
    // NSFW.
    const picked = [...modal.querySelectorAll('input[data-rchild]:checked')].map(
      (el) => el.dataset.rchild
    );
    const women = Number($('#randomizer-women').value) || 0;
    const men = Number($('#randomizer-men').value) || 0;
    // A cast on its own is a valid roll — the counts are a choice, not a draw.
    if (!surprise && !picked.length && !women && !men) {
      return randomizerSay('Tick at least one box, or set a character count.');
    }
    const roll = $('#randomizer-roll');
    roll.disabled = true;
    randomizerSay('');
    try {
      const res = await rawFetch('/api/randomizer/roll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categories: picked, women, men, surprise, limits: readLimits() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        randomizerSay(data.message ?? `Roll failed (${res.status}).`);
        return;
      }
      result.value = data.text ?? '';
      renderRandomizerBreakdown(data.boxes);
      preview.hidden = false;
      syncButtons();
      // Rolling again is the point — the preview exists so a bad draw costs a
      // click rather than a generation.
      roll.textContent = 'Reroll';
    } catch (err) {
      randomizerSay(`Could not reach the server — ${err.message}`);
    } finally {
      roll.disabled = false;
    }
  };

  $('#randomizer-roll').addEventListener('click', () => doRoll(false));
  $('#randomizer-surprise').addEventListener('click', () => doRoll(true));

  // Two verbs, because both are wanted and guessing wrong is destructive one
  // way round: Add keeps what they wrote, Replace does not.
  const writeBrief = (mode) => {
    const field = $('[data-bind="brief"]', $('#builder-mount'));
    if (!field) return;
    const text = result.value.trim();
    if (!text) return;
    const existing = field.value.trim();
    field.value = mode === 'replace' || !existing ? text : `${existing}, ${text}`;
    // The word counter and the generate button both listen for this; setting
    // .value in script fires nothing on its own.
    field.dispatchEvent(new Event('input', { bubbles: true }));
    close();
    toast(mode === 'replace' ? 'Brief replaced' : 'Added to brief');
  };
  insert.addEventListener('click', () => writeBrief('add'));
  replace.addEventListener('click', () => writeBrief('replace'));
}

/** Bytes as GB, because model sizes are only ever discussed in GB. */
function sizeLabel(bytes) {
  if (!bytes) return '';
  return ` · ${(bytes / 1e9).toFixed(1)} GB`;
}

/**
 * One row of the usage table.
 *
 * A bar rather than a percentage on its own: the useful reading is relative —
 * "that one is half of everything and this one is a sliver" — and a column of
 * numbers makes you do that comparison in your head.
 *
 * Zero runs is not an error state and is not styled as one. It is the answer
 * the owner came for.
 */
function usageRow(r, topRuns) {
  const pct = Math.round(r.share * 100);
  const width = topRuns ? Math.max(2, Math.round((r.runs / topRuns) * 100)) : 0;
  const when =
    r.runs === 0
      ? 'never used'
      : r.days_since === 0
        ? 'used today'
        : r.days_since === 1
          ? 'used yesterday'
          : `last used ${r.days_since} days ago`;
  // Present in the counts but not in the backend's catalogue: already deleted,
  // or served by the other backend. Said plainly rather than dropped, so a
  // count that suddenly stops rising has a visible reason.
  const gone = r.installed ? '' : ' · not installed';

  return `
    <div class="account-row">
      <div class="account-head">
        <span class="account-handle">${escHtml(r.model)}</span>
        <span class="account-status">${r.runs} run${r.runs === 1 ? '' : 's'}</span>
      </div>
      <div class="usage-bar"><span style="width:${width}%"></span></div>
      <div class="account-meta">${pct}% of all runs · ${escHtml(when)}${gone}${escHtml(sizeLabel(r.size_bytes))}</div>
      ${
        r.runs === 0
          ? ''
          : `<div class="account-actions">
               <button class="ghost" data-usage-forget="${escHtml(r.model)}">Reset count</button>
             </div>`
      }
    </div>`;
}

// Off means the table is the models the backend is actually serving. The
// hidden rows are counts under names nothing serves — mostly the test suites,
// which drive the real server as `qwen3:8b` and `stub-model` and outnumbered
// the real runs three to one. Kept as a switch rather than a permanent hide:
// a model that WAS used and has since been deleted belongs to the same set,
// and Reset count lives on those rows.
let usageShowAll = false;

async function refreshUsage() {
  const host = $('#usage-list');
  if (!host) return;
  host.innerHTML = '<p class="field-note">Loading…</p>';
  try {
    const res = await rawFetch(`/api/admin/usage${usageShowAll ? '?all=1' : ''}`);
    if (!res.ok) {
      host.innerHTML = `<p class="field-note">Could not load usage (${res.status}).</p>`;
      return;
    }
    const data = await res.json();
    const rows = data.models ?? [];
    if (!rows.length) {
      host.innerHTML = '<p class="field-note">Nothing has been generated yet.</p>';
      return;
    }
    const topRuns = rows[0]?.runs ?? 0;
    // Only offered when there is something behind it. `filtered` is the
    // server's account of what it did, so a backend that could not be polled
    // shows the whole table and no switch, rather than a switch that appears
    // to do nothing.
    const toggle = usageShowAll
      ? `<button class="ghost" data-usage-toggle>Show only what this box serves</button>`
      : data.filtered && data.hidden
        ? `<button class="ghost" data-usage-toggle>Also show ${data.hidden} name${
            data.hidden === 1 ? '' : 's'
          } this box does not serve</button>`
        : '';
    host.innerHTML =
      rows.map((r) => usageRow(r, topRuns)).join('') +
      `<p class="field-note">${data.total_runs.toLocaleString()} run${
        data.total_runs === 1 ? '' : 's'
      } counted${data.filtered && data.hidden ? ' for the models shown' : ' in total'}.</p>` +
      (toggle ? `<div class="account-actions">${toggle}</div>` : '');
  } catch (err) {
    host.innerHTML = `<p class="field-note">Could not reach the server — ${escHtml(err.message)}</p>`;
  }
}

function initUsagePanel() {
  const host = $('#usage-list');
  const modal = $('#usage-modal');
  if (!host || !modal) return;

  // Its own modal, opened from its own top-bar button. Same open/close
  // contract as every other modal here — backdrop click and Escape both
  // close, because a panel that can only be dismissed by finding a button is
  // the one people stop opening.
  $('#btn-usage').addEventListener('click', () => {
    modal.hidden = false;
    refreshUsage();
  });
  $('#usage-close').addEventListener('click', () => { modal.hidden = true; });
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) modal.hidden = true;
  });

  // Delegated: the rows are rebuilt on every refresh.
  host.addEventListener('click', async (e) => {
    if (e.target.closest('button[data-usage-toggle]')) {
      usageShowAll = !usageShowAll;
      refreshUsage();
      return;
    }
    const btn = e.target.closest('button[data-usage-forget]');
    if (!btn) return;
    const model = btn.dataset.usageForget;
    if (!confirm(`Forget the run count for ${model}? The count starts again from zero.`)) return;
    btn.disabled = true;
    try {
      const res = await rawFetch('/api/admin/usage/forget', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast(data.message ?? 'Failed');
        return;
      }
      refreshUsage();
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
    }
  });
}

/**
 * The owner's side of a model request.
 *
 * Same row shape as an account, because it is the same job: something arrived,
 * somebody has to say yes or no, and the answer is recorded. Approve and Deny
 * settle a pending one; Clear only ever appears on a request already decided,
 * so nothing can be made to disappear without an answer.
 */
function requestRow(r) {
  const when = r.created_at ? new Date(r.created_at).toLocaleString() : 'unknown';
  const id = escHtml(r.id);
  const btn = (act, label, cls) =>
    `<button class="${cls}" data-req="${act}" data-id="${id}">${label}</button>`;

  const actions =
    r.status === 'pending'
      ? btn('approve', 'Approve', 'primary') + btn('deny', 'Deny', 'danger')
      : btn('remove', 'Clear', 'ghost');

  const decided =
    r.status === 'pending'
      ? ''
      : ` · ${escHtml(r.status)} by ${escHtml(r.decided_by ?? 'the owner')}${
          r.decided_at ? ` on ${escHtml(new Date(r.decided_at).toLocaleString())}` : ''
        }`;

  return `
    <div class="account-row ${r.status === 'pending' ? 'pending' : ''}">
      <div class="account-head">
        <span class="account-handle">${escHtml(r.tag)}</span>
        <span class="account-status ${escHtml(r.status)}">${escHtml(r.status)}</span>
      </div>
      <div class="account-meta">Asked by ${escHtml(r.user)} on ${escHtml(when)}${decided}</div>
      ${r.reason ? `<div class="account-referral">${escHtml(r.reason)}</div>` : ''}
      ${
        r.url
          ? `<div class="account-meta"><a href="${escHtml(r.url)}" target="_blank" rel="noreferrer noopener">${escHtml(r.url)}</a></div>`
          : ''
      }
      <div class="account-actions">${actions}</div>
    </div>`;
}

async function refreshModelRequests() {
  const host = $('#requests-list');
  if (!host) return;
  host.innerHTML = '<p class="field-note">Loading…</p>';
  try {
    const res = await rawFetch('/api/admin/requests');
    if (!res.ok) {
      host.innerHTML = `<p class="field-note">Could not load requests (${res.status}).</p>`;
      return;
    }
    const { requests } = await res.json();
    host.innerHTML = requests.length
      ? requests.map(requestRow).join('')
      : '<p class="field-note">Nobody has asked for a model.</p>';
  } catch (err) {
    host.innerHTML = `<p class="field-note">Could not reach the server — ${escHtml(err.message)}</p>`;
  }
}

function initRequestsPanel() {
  const host = $('#requests-list');
  if (!host) return;
  // Delegated: the rows are rebuilt on every refresh.
  host.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-req]');
    if (!btn) return;
    const { req: act, id } = btn.dataset;
    btn.disabled = true;
    try {
      const res = await rawFetch(`/api/admin/requests/${encodeURIComponent(id)}/${act}`, {
        method: 'POST',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data.message ?? 'Failed');
        return;
      }
      // Approving records the decision; the pull is a command the owner runs,
      // because a modal that starts a 17GB download onto a shared box is not
      // the smaller version of Tab 6's model management. It goes in its own
      // element above the list, which the refresh below does not touch — a
      // command that vanished as the row repainted would be worse than none.
      const cmd = $('#requests-command');
      if (cmd) {
        cmd.innerHTML = data.pull_command
          ? `<code class="request-command">${escHtml(data.pull_command)}</code>`
          : '';
      }
      toast(
        act === 'remove'
          ? 'Cleared'
          : data.pull_command
            ? 'Approved — run the command shown above the list'
            : `Request ${data.request?.status ?? act}`
      );
    } finally {
      // The button goes with the row the refresh replaces, so there is nothing
      // to re-enable.
      refreshModelRequests();
    }
  });
}

// Opened once per page load at most, and only for an owner whose install has
// never been told where its LLM server is (server says setup_needed). A box
// configured through server.local.yaml - the P40 - never sees it.
let setupChecked = false;
async function maybeOpenSetup() {
  if (setupChecked) return;
  setupChecked = true;
  try {
    const res = await fetch('/api/admin/models/backend');
    if (!res.ok) return;
    const info = await res.json();
    if (info.setup_needed) openWizard();
  } catch { /* the Backend button still works */ }
}

function backendMessage(text, kind = 'error') {
  const msg = $('#backend-message');
  msg.hidden = !text;
  msg.className = `auth-message ${kind}`;
  msg.textContent = text || '';
}

/** Fill the default-model picker from a Test connection, keeping `current` selected when it is served. */
function fillBackendModels(models, current) {
  const field = $('#backend-model-field');
  const select = $('#backend-model');
  select.replaceChildren();
  for (const name of models) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select.append(opt);
  }
  if (current && models.includes(current)) select.value = current;
  field.hidden = models.length === 0;
}

async function openBackendPanel(info, { welcome = false } = {}) {
  const modal = $('#backend-modal');
  modal.hidden = false;
  $('#backend-welcome').hidden = !welcome;
  $('#backend-intro').hidden = welcome;
  backendMessage('');
  $('#backend-model-field').hidden = true;
  loadNetwork();
  loadMaintenance();
  loadTaggers();
  loadFeatureSetup();
  try {
    if (!info) {
      const res = await fetch('/api/admin/models/backend');
      if (res.ok) info = await res.json();
    }
  } catch (e) {
    console.error('Failed to load backend config:', e);
  }
  if (!info) return;
  $('#backend-select').value = info.backend || 'ollama';
  $('#backend-url').value = info.base_url || '';
  modal.dataset.currentModel = info.model || '';
  // Test straight away, so the model list is there without an extra click
  // whenever the saved address already works.
  if (info.backend !== 'mock') testBackend();
}

async function testBackend() {
  const backend = $('#backend-select').value;
  const base_url = $('#backend-url').value.trim();
  if (backend === 'mock') {
    fillBackendModels([], null);
    backendMessage('Mock needs no server — it answers with canned text.', 'ok');
    return true;
  }
  if (!base_url) {
    backendMessage('Enter the address of your LLM server first.');
    return false;
  }
  const btn = $('#backend-test');
  btn.disabled = true;
  backendMessage('Connecting…', 'ok');
  try {
    const res = await fetch('/api/admin/models/backend', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ backend, base_url, test: true }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) {
      fillBackendModels([], null);
      backendMessage(body.message || `Failed (${res.status})`);
      return false;
    }
    fillBackendModels(body.models, $('#backend-modal').dataset.currentModel);
    backendMessage(
      body.models.length
        ? `Connected — ${body.models.length} model${body.models.length === 1 ? '' : 's'} available.`
        : 'Connected, but the server lists no models. Pull or load one, then test again.',
      body.models.length ? 'ok' : 'error'
    );
    return true;
  } catch (e) {
    backendMessage(`Failed — ${e.message}`);
    return false;
  } finally {
    btn.disabled = false;
  }
}

// "Let other devices connect" (22 Sep 2026). Saved for the next start - a
// running server cannot change the address it listens on - so the panel
// always says whether a restart is still owed.
function paintNetwork(info) {
  const box = $('#network-remote');
  const msg = $('#network-message');
  const list = $('#network-addresses');
  box.checked = Boolean(info.saved);
  const managed = info.source === 'environment' || info.source === 'local_config';
  box.disabled = managed;

  list.replaceChildren();
  for (const a of info.addresses ?? []) {
    const row = document.createElement('p');
    row.className = 'field-note';
    const code = document.createElement('code');
    code.textContent = a.url;
    row.append(`${a.label}: `, code);
    list.append(row);
  }

  let text = '';
  let kind = 'ok';
  if (info.source === 'environment') {
    text = info.in_container
      ? 'Running in a container: who can connect is set by the ports line in compose.yaml. "8090:8090" lets other devices in; "127.0.0.1:8090:8090" keeps it to this PC.'
      : 'Set by PROMPTFORGE_BIND when PromptForge was started, not here.';
  } else if (info.source === 'local_config') {
    text = 'Set in config/server.local.yaml on this machine (server.bind), not here.';
  } else if (info.restart_needed) {
    text = `Saved. Restart PromptForge for this to take effect — right now ${info.allow_remote ? 'other devices can still connect' : 'only this PC can connect'}.`;
    kind = 'error';
  } else if (info.allow_remote && !(info.addresses ?? []).length) {
    text = 'Other devices may connect, but no network address was found on this PC.';
    kind = 'error';
  }
  msg.hidden = !text;
  msg.className = `auth-message ${kind}`;
  msg.textContent = text;
}

async function loadNetwork() {
  try {
    const res = await fetch('/api/admin/network');
    if (res.ok) paintNetwork(await res.json());
  } catch { /* the rest of the panel still works */ }
}

async function saveNetwork() {
  const box = $('#network-remote');
  box.disabled = true;
  try {
    const res = await fetch('/api/admin/network', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allow_remote: box.checked }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = $('#network-message');
      msg.hidden = false;
      msg.className = 'auth-message error';
      msg.textContent = body.message || `Failed (${res.status})`;
      box.checked = !box.checked;
      box.disabled = false;
      return;
    }
    paintNetwork(body);
  } catch (e) {
    box.checked = !box.checked;
    box.disabled = false;
  }
}

// The Close PromptForge switch (27 Sep 2026). Owner-only on the server; the
// owner is let past the notice, which is why this panel can still turn it off.
async function loadMaintenance() {
  try {
    const res = await fetch('/api/admin/maintenance');
    if (res.ok) $('#maintenance-on').checked = (await res.json()).on;
  } catch { /* the rest of the panel still works */ }
}

async function saveMaintenance() {
  const box = $('#maintenance-on');
  const msg = $('#maintenance-message');
  box.disabled = true;
  try {
    const res = await fetch('/api/admin/maintenance', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ on: box.checked }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || `Failed (${res.status})`);
    box.checked = body.on;
    msg.hidden = true;
  } catch (e) {
    box.checked = !box.checked;
    msg.hidden = false;
    msg.className = 'auth-message error';
    msg.textContent = e.message;
  } finally {
    box.disabled = false;
  }
}

// Image taggers in the Setup panel (22 Sep 2026): one row per tagger saying
// found or missing, a Download button for the two public WD ones, and a
// folder box that is searched for all of them. Polls only while a download
// is running.
let taggerPoll = null;

function mb(bytes) {
  return `${Math.round(bytes / 1e6).toLocaleString()} MB`;
}

function paintTaggers(info) {
  const rows = $('#tagger-rows');
  rows.replaceChildren();
  let busy = false;
  for (const t of info.taggers ?? []) {
    const row = document.createElement('p');
    row.className = 'field-note';
    const name = document.createElement('strong');
    name.textContent = t.name;
    row.append(name, ' — ');
    const dl = t.download;
    if (dl?.state === 'downloading') {
      busy = true;
      row.append(`downloading… ${mb(dl.received)} of ${mb(dl.total)}`);
    } else if (t.found) {
      row.append('✓ ready');
      if (t.source === 'local_config') row.append(' (set in config/taggers.local.yaml)');
    } else {
      row.append(`missing ${t.missing.join(', ')}`);
      if (dl?.state === 'failed') row.append(` — download failed: ${dl.error}`);
      if (t.downloadable && t.source !== 'local_config') {
        const btn = document.createElement('button');
        btn.className = 'ghost';
        btn.type = 'button';
        btn.style.marginLeft = '8px';
        btn.textContent = 'Download';
        btn.title = 'Free, no login — from Hugging Face into the taggers folder';
        btn.addEventListener('click', () => downloadTagger(t.key));
        row.append(btn);
      } else if (/animetimm/i.test(t.key)) {
        row.append(' — needs a one-time conversion: see docs/taggers-setup.md in the PromptForge folder');
      }
    }
    rows.append(row);
  }
  $('#tagger-dir-note').textContent = info.taggers_dir
    ? `Or put the files in ${info.taggers_dir} yourself — that folder is where PromptForge looks first.`
    : '';
  clearTimeout(taggerPoll);
  if (busy && !($('#backend-modal').hidden && $('#wizard-modal').hidden)) taggerPoll = setTimeout(loadTaggers, 2000);
}

async function loadTaggers() {
  try {
    const res = await fetch('/api/admin/taggers');
    if (res.ok) paintTaggers(await res.json());
  } catch { /* the rest of the panel still works */ }
}

function taggerMessage(text, kind = 'error') {
  const msg = $('#tagger-message');
  msg.hidden = !text;
  msg.className = `auth-message ${kind}`;
  msg.textContent = text || '';
}

async function downloadTagger(key) {
  taggerMessage('');
  const res = await fetch('/api/admin/taggers/download', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key }),
  }).catch(() => null);
  const body = await res?.json().catch(() => ({}));
  if (!res?.ok) return taggerMessage(body?.message || 'Could not start the download.');
  paintTaggers(body);
}

async function scanTaggerFolder() {
  const folder = $('#tagger-folder').value.trim();
  if (!folder) return taggerMessage('Paste a folder first.');
  const btn = $('#tagger-scan');
  btn.disabled = true;
  taggerMessage('Searching…', 'ok');
  try {
    const res = await fetch('/api/admin/taggers/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folder }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return taggerMessage(body.message || `Failed (${res.status})`);
    paintTaggers(body);
    const n = body.scan?.found?.length ?? 0;
    taggerMessage(
      n
        ? `Found ${n} tagger${n === 1 ? '' : 's'} and switched to ${n === 1 ? 'it' : 'them'} — no restart needed.`
        : `No tagger files in that folder${body.scan?.capped ? ' (it is very large — try a folder closer to them)' : ''}.`,
      n ? 'ok' : 'error'
    );
  } catch (e) {
    taggerMessage(`Failed — ${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

function initBackendPanel() {
  const modal = $('#backend-modal');
  if (!modal) return;
  $('#network-remote').addEventListener('change', saveNetwork);
  $('#maintenance-on').addEventListener('change', saveMaintenance);
  $('#tagger-scan').addEventListener('click', scanTaggerFolder);
  $('#backend-llamacpp-local').addEventListener('click', () => {
    $('#backend-select').value = 'llamacpp';
    $('#backend-url').value = 'http://127.0.0.1:8080/v1';
    $('#backend-model-field').hidden = true;
  });

  $('#btn-backend').addEventListener('click', () => openBackendPanel(null));
  $('#backend-test').addEventListener('click', testBackend);
  // A shortcut from PR #3: fill in Ollama on this same machine.
  $('#backend-localhost')?.addEventListener('click', () => {
    $('#backend-select').value = 'ollama';
    $('#backend-url').value = 'http://127.0.0.1:11434/v1';
    $('#backend-model-field').hidden = true;
  });
  // A different server means a different model list; the old one is stale.
  $('#backend-select').addEventListener('change', () => { $('#backend-model-field').hidden = true; });
  $('#backend-url').addEventListener('input', () => { $('#backend-model-field').hidden = true; });

  $('#backend-close').addEventListener('click', () => { modal.hidden = true; });
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) modal.hidden = true;
  });

  $('#backend-save').addEventListener('click', async () => {
    const saved = await saveBackend();
    // In the wizard, Next moves on instead; only the panel closes itself.
    if (saved === 'saved' && !$('#backend-modal').hidden) setTimeout(() => { modal.hidden = true; }, 1500);
  });

  initFeatureSetup();
}

/**
 * Save the LLM server choice. Returns 'saved', 'restart' (saved, restart
 * recommended) or null when nothing was saved. Shared by the panel's Save
 * button and the wizard's Next.
 */
async function saveBackend() {
  const backend = $('#backend-select').value;
  const base_url = $('#backend-url').value.trim();

  if (!base_url && backend !== 'mock') {
    backendMessage('Enter the address of your LLM server.');
    return null;
  }
  // Saving an address nobody has tested would take generation down for
  // everyone on a typo, so Save tests first when the list is not showing.
  if ($('#backend-model-field').hidden && !(await testBackend())) return null;
  const model = $('#backend-model-field').hidden ? null : $('#backend-model').value;

  try {
    const res = await fetch('/api/admin/models/backend', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ backend, base_url, model }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      backendMessage(body.message || `Failed (${res.status})`);
      return null;
    }
    $('#backend-modal').dataset.currentModel = body.model || '';
    backendMessage(
      body.restart_recommended
        ? `Saved. Generation now uses ${backend}. Restart PromptForge once so idle offload and picture reading follow too.`
        : `Saved${model ? ` — default model ${model}` : ''}.`,
      'ok'
    );
    return body.restart_recommended ? 'restart' : 'saved';
  } catch (e) {
    backendMessage(`Failed — ${e.message}`);
    return null;
  }
}

// ── Rendering and LoRA training in the Setup panel and the wizard (4 Oct 2026) ──
// Both off until someone chooses them; see server/featuresetup.mjs.

function featureMessage(id, text, kind = 'error') {
  const msg = $(id);
  msg.hidden = !text;
  msg.className = `auth-message ${kind}`;
  msg.textContent = text || '';
}

// What the server last said about each, for the wizard's summary.
const FEATURE_STATE = { comfyui: null, training: null };

function paintComfy(info) {
  FEATURE_STATE.comfyui = info;
  const managed = info.source === 'local_config' || info.source === 'environment';
  let text = '';
  let kind = 'ok';
  if (managed) text = 'Set in config/server.local.yaml on this machine, not here.';
  else if (info.restart_needed) {
    text = 'Saved. Restart PromptForge for this to take effect.';
    kind = 'error';
  } else if (info.enabled) {
    text = `✓ On — ${info.dir ? `ComfyUI in ${info.dir}, started when someone renders` : `using the ComfyUI at ${info.url}`}${info.running ? ' (running now)' : ''}.`;
  }
  featureMessage('#comfy-status', text, kind);
  for (const id of ['#comfy-folder', '#comfy-connect', '#comfy-url', '#comfy-connect-url']) $(id).disabled = managed;
  $('#comfy-off').hidden = managed || !(info.saved?.enabled ?? info.enabled);
  if (info.in_container && !$('#comfy-url').value) $('#comfy-url').value = 'http://host.docker.internal:8188';
  if (info.dir && !$('#comfy-folder').value) $('#comfy-folder').value = info.dir;
}

function paintTraining(info) {
  FEATURE_STATE.training = info;
  const managed = info.source === 'local_config';
  featureMessage(
    '#training-status',
    managed ? 'Set in config/server.local.yaml on this machine, not here.' : info.enabled ? `✓ Connected to TrainFlow at ${info.url}.` : '',
    'ok'
  );
  $('#training-url').disabled = managed;
  $('#training-connect').disabled = managed;
  $('#training-off').hidden = managed || !info.enabled;
  if (!$('#training-url').value) {
    $('#training-url').value = info.url || (info.in_container ? 'http://host.docker.internal:8900' : 'http://127.0.0.1:8900');
  }
  paintLoraTab(info.enabled);
}

async function loadFeatureSetup() {
  const [c, t] = await Promise.all([
    fetch('/api/admin/setup/comfyui').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch('/api/admin/setup/training').then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  if (c) paintComfy(c);
  if (t) paintTraining(t);
}

/** POST to a setup route, painting the result or the error. Returns true on success. */
async function postFeature(kind, payload, btn) {
  const msgId = kind === 'comfyui' ? '#comfy-message' : '#training-message';
  if (btn) btn.disabled = true;
  featureMessage(msgId, payload.enabled === false ? 'Saving…' : 'Checking…', 'ok');
  try {
    const res = await fetch(`/api/admin/setup/${kind}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      featureMessage(msgId, body.message || `Failed (${res.status})`);
      return false;
    }
    featureMessage(msgId, '');
    (kind === 'comfyui' ? paintComfy : paintTraining)(body);
    // Editing rides on rendering, so its tab follows the switch.
    if (kind === 'comfyui') loadEditOptions();
    return true;
  } catch (e) {
    featureMessage(msgId, `Failed — ${e.message}`);
    return false;
  } finally {
    if (btn) btn.disabled = false;
  }
}

function initFeatureSetup() {
  // "I have it" / "I don't have it yet": one shows the connect boxes, the
  // other the installer link.
  for (const kind of ['comfy', 'training']) {
    for (const radio of document.querySelectorAll(`input[name="${kind}-have"]`)) {
      radio.addEventListener('change', () => {
        const need = radio.value === 'need' && radio.checked;
        $(`#${kind}-have`).hidden = need;
        $(`#${kind}-need`).hidden = !need;
      });
    }
  }
  $('#comfy-connect').addEventListener('click', (e) => {
    const folder = $('#comfy-folder').value.trim();
    if (!folder) return featureMessage('#comfy-message', 'Paste the folder ComfyUI is in first.');
    postFeature('comfyui', { folder }, e.currentTarget);
  });
  $('#comfy-connect-url').addEventListener('click', (e) => {
    const url = $('#comfy-url').value.trim() || $('#comfy-url').placeholder;
    postFeature('comfyui', { url }, e.currentTarget);
  });
  $('#comfy-off').addEventListener('click', (e) => postFeature('comfyui', { enabled: false }, e.currentTarget));
  $('#training-connect').addEventListener('click', (e) => {
    const url = $('#training-url').value.trim() || $('#training-url').placeholder;
    postFeature('training', { url }, e.currentTarget);
  });
  $('#training-off').addEventListener('click', (e) => postFeature('training', { enabled: false }, e.currentTarget));
  initWizard();
}

// The tab itself is always there since 17 Oct 2026: its Caption half needs no
// TrainFlow, and the people most likely to want captions are the ones who
// train somewhere else. Only the Train half depends on TrainFlow being
// connected and on the "train" grant, so that is what hides.
let TRAINING_ON = null;
function paintLoraTab(enabled) {
  if (typeof enabled === 'boolean') TRAINING_ON = enabled;
  const train = $('#lora-mode button[data-mode="train"]');
  const caption = $('#lora-mode button[data-mode="caption"]');
  if (!train || !caption) return;
  // CAN_TRAIN, not just "signed in": the Train half is empty without it,
  // because the TrainFlow panel itself stays hidden (loadLoraTab). Caption
  // has its own grant since 17 Oct 2026; the server checks it on every call.
  const canTrain = TRAINING_ON !== false && CAN_TRAIN;
  const canCaption = CAN_CAPTION;
  train.hidden = !canTrain;
  caption.hidden = !canCaption;
  // A switch with one side is just a label; drop it and that side is the tab.
  $('#lora-mode').hidden = !(canTrain && canCaption);
  // Neither half: no tab, rather than a tab that can only say no.
  const tab = $('.main-tab[data-tab="lora"]');
  if (tab) tab.hidden = !canTrain && !canCaption;
  if (!canTrain && loraMode === 'train' && canCaption) setLoraMode('caption');
  if (!canCaption && loraMode === 'caption' && canTrain) setLoraMode('train');
}

// ── Caption / Train switch ──
// Train is hidden, never unloaded: changing the frame's src, or taking it out
// of the page, drops TrainFlow's WebSocket and the progress view with it.
let loraMode = 'caption';
function setLoraMode(mode) {
  loraMode = mode;
  try { localStorage.setItem('pf.loraMode', mode); } catch {}
  $$('#lora-mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('#lora-caption').hidden = mode !== 'caption';
  $('#lora-train').hidden = mode !== 'train';
  // The style picker belongs to Caption only.
  $('.lora-cap-style-field').hidden = mode !== 'caption';
  $('#lora-cap-format').hidden = mode !== 'caption';
  if (mode === 'train') loadLoraTab();
}

function openLoraTab() {
  loadCaptionStyles();
  let saved = null;
  try { saved = localStorage.getItem('pf.loraMode'); } catch {}
  const trainHidden = $('#lora-mode button[data-mode="train"]').hidden;
  const captionHidden = $('#lora-mode button[data-mode="caption"]').hidden;
  const want = loraMode === 'train' || saved === 'train' ? 'train' : 'caption';
  setLoraMode((want === 'train' && !trainHidden) || captionHidden ? 'train' : 'caption');
}

// ── Caption view (17-18 Oct 2026) ──
// A dataset zip goes in; every picture in it is sent, downscaled, to
// /api/caption one at a time, and the same zip comes back with a .txt beside
// each picture. The owner's shape (18 Oct): no folder picking and no review
// grid, the model does the whole set. Nothing is stored on the server.
const CAP = {
  styles: [],
  style: null,
  zipName: '',
  items: [], // { path, stem, file }  every picture in the zip
  others: [], // { name, data }      everything else, passed through
  captions: new Map(), // stem -> caption written for the current style
  problems: [], // { path, message } for the list under the button
  abort: null, // the running batch
};
// Anything the browser can decode: each picture is re-encoded to JPEG here
// before it goes to the model, so the server never sees the original format.
const CAP_IMAGE_TYPE = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', webp: 'image/webp',
  avif: 'image/avif', gif: 'image/gif', bmp: 'image/bmp',
};
const CAP_IMAGE_EXT = new RegExp(`\\.(${Object.keys(CAP_IMAGE_TYPE).join('|')})$`, 'i');

let capStylesLoaded = false;
async function loadCaptionStyles() {
  if (capStylesLoaded) return;
  const sel = $('#lora-cap-style');
  try {
    const r = await fetch('/api/caption/styles');
    const body = await r.json();
    if (!r.ok) throw new Error(body?.message ?? `HTTP ${r.status}`);
    CAP.styles = body.styles ?? [];
  } catch (err) {
    sel.innerHTML = '<option>Styles unavailable</option>';
    sel.disabled = true;
    $('#lora-cap-style-note').textContent = `Caption styles could not be loaded: ${err.message}`;
    $('#lora-cap-style-note').classList.add('warn');
    return;
  }
  capStylesLoaded = true;
  // The LoRA types ride on the same response: id, label, and the hint the
  // type puts under Don't include.
  CAP.types = body.types ?? [];
  const typeSel = $('#lora-cap-type');
  typeSel.replaceChildren(...CAP.types.map((t) => new Option(t.label, t.id)));
  let savedType = null;
  try { savedType = localStorage.getItem('pf.loraType'); } catch {}
  if (CAP.types.some((t) => t.id === savedType)) typeSel.value = savedType;
  paintLoraTypeNote();
  sel.innerHTML = '';
  for (const s of CAP.styles) sel.add(new Option(s.label, s.id));
  let saved = null;
  try { saved = localStorage.getItem('pf.captionStyle'); } catch {}
  selectCaptionStyle(CAP.styles.some((s) => s.id === saved) ? saved : CAP.styles[0]?.id);
}

function paintLoraTypeNote() {
  const t = (CAP.types ?? []).find((x) => x.id === $('#lora-cap-type').value);
  $('#lora-cap-type-note').textContent = t?.exclude ?? '';
}

function selectCaptionStyle(id) {
  const style = CAP.styles.find((s) => s.id === id) ?? null;
  CAP.style = style;
  $('#lora-cap-style').value = id ?? '';
  $('#lora-cap-format').textContent = style?.format ?? '—';
  $('#lora-cap-style-note').textContent = style?.note ?? '';
  try { if (id) localStorage.setItem('pf.captionStyle', id); } catch {}
  const lengthField = $('#lora-cap-length-field');
  lengthField.hidden = !style?.lengths;
  if (style?.lengths) {
    const sel = $('#lora-cap-length');
    sel.replaceChildren(...style.lengths.map((l) => new Option(l[0].toUpperCase() + l.slice(1), l)));
    sel.value = style.default_length ?? style.lengths[0];
  }
  // One style's captions must never go out under another style's name, and a
  // batch still running for the old style stops.
  CAP.abort?.abort();
  resetCaptions(CAP.items.length ? 'Style changed. Press Caption the dataset to start again.' : 'Drop a zip to start.');
}

function resetCaptions(status) {
  CAP.captions.clear();
  CAP.problems = [];
  $('#lora-cap-status').textContent = status;
  $('#lora-cap-bar').hidden = true;
  paintCaptionButtons();
  paintCaptionResult();
}

async function loadCaptionZip(file) {
  CAP.abort?.abort();
  CAP.items = [];
  CAP.others = [];
  const summary = $('#lora-cap-summary');
  summary.hidden = false;
  summary.textContent = `Reading ${file.name}…`;
  let entries;
  try {
    entries = await readZip(file);
  } catch (err) {
    summary.textContent = `Could not read ${file.name}: ${err.message}`;
    resetCaptions('Drop a zip to start.');
    return;
  }
  // Mac zips carry __MACOSX/ shadow copies of every file; they are not pictures.
  entries = entries.filter((e) => !e.name.startsWith('__MACOSX/') && !/(^|\/)\._/.test(e.name));
  const stemOf = (p) => p.replace(/\.[^./]+$/, '');
  const pictures = entries.filter((e) => CAP_IMAGE_EXT.test(e.name));
  const stems = new Set(pictures.map((e) => stemOf(e.name)));
  // A caption already in the zip for a picture is replaced, not kept beside
  // the new one; anything else in the zip goes back out untouched.
  const isOldCaption = (e) => /\.txt$/i.test(e.name) && stems.has(stemOf(e.name));
  const replaced = entries.filter(isOldCaption).length;
  CAP.others = entries.filter((e) => !CAP_IMAGE_EXT.test(e.name) && !isOldCaption(e));
  CAP.items = pictures
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map((e) => {
      const ext = e.name.split('.').pop().toLowerCase();
      return { path: e.name, stem: stemOf(e.name), file: new Blob([e.data], { type: CAP_IMAGE_TYPE[ext] ?? 'application/octet-stream' }) };
    });
  CAP.zipName = file.name.replace(/\.zip$/i, '');
  summary.innerHTML = '';
  const strong = document.createElement('strong');
  strong.textContent = file.name;
  summary.append(strong, document.createTextNode(
    ` · ${CAP.items.length} picture${CAP.items.length === 1 ? '' : 's'}` +
    (replaced ? ` · ${replaced} old caption${replaced === 1 ? '' : 's'} will be replaced` : '')
  ));
  resetCaptions(CAP.items.length ? 'Ready.' : 'No pictures in that zip (PNG, JPG, WEBP, AVIF, GIF or BMP).');
}

// Caption's own "Written by" (17 Oct 2026), the same shape as Describe's:
// vision models only, empty = whatever writes my prompts.
let captionModel = '';
let captionModelSignature = null;
function renderCaptionLlm(llm) {
  const sel = $('#lora-cap-model');
  if (!sel || !llm) return;
  const groups = chatModelGroups(llm);
  const rows = [...groups.loaded, ...groups.available].filter((r) => r.vision);
  const signature = rows.map((r) => r.model).join(',');
  if (signature === captionModelSignature) return;
  captionModelSignature = signature;
  sel.replaceChildren(new Option('Same as Written by', ''));
  for (const r of rows) sel.appendChild(new Option(r.model, r.model));
  sel.value = rows.some((r) => r.model === captionModel) ? captionModel : '';
  captionModel = sel.value;
}

/**
 * A downscaled JPEG of a dataset picture for the model and the tagger. The
 * originals can be 20 MB PNGs; the model reads at well under 1536px anyway,
 * and sending the full file 40 times over the tailnet is the slow part. The
 * picture that goes back in the zip is always the original.
 */
async function captionBytes(file) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1536 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    return await new Promise((ok) => canvas.toBlob((b) => ok(b ?? file), 'image/jpeg', 0.92));
  } catch {
    return file;
  }
}

/** Read an SSE response, calling on(event, payload) per frame. */
async function readSSE(res, on) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      let event = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      try { on(event, JSON.parse(data)); } catch { /* skip a bad frame */ }
    }
  }
}

/** Caption one picture. Resolves to the done payload, or throws with a message. */
async function captionOne(it, signal, onWait) {
  const bytes = await captionBytes(it.file);
  let tags = '';
  let hintNote = '';
  if ($('#lora-cap-tagger').checked) {
    // The CPU tagger first, as hints. A failure here is not fatal - the model
    // can caption without them - but it is reported, because a whole dataset
    // quietly captioned without hints looks exactly like one with.
    try {
      const r = await fetch('/api/analyze', { method: 'POST', headers: { 'content-type': bytes.type }, body: bytes, signal });
      const data = await r.json().catch(() => ({}));
      if (r.ok) tags = [...(data.character ?? []), ...(data.general ?? [])].map((t) => t.tag).join(',');
      else hintNote = `no tagger hints (${data.message ?? data.error ?? `HTTP ${r.status}`})`;
    } catch (err) {
      if (signal.aborted) throw err;
      hintNote = `no tagger hints (${err.message})`;
    }
  }
  const query = new URLSearchParams({
    style: CAP.style.id,
    type: $('#lora-cap-type').value,
    trigger: $('#lora-cap-trigger').value.trim(),
    exclude: $('#lora-cap-exclude').value,
    tags,
    ...(captionModel ? { model: captionModel } : {}),
    ...(CAP.style.lengths ? { length: $('#lora-cap-length').value } : {}),
  });
  const res = await fetch(`/api/caption?${query}`, {
    method: 'POST',
    // USER_HEADER for an install with accounts off, like the other gated
    // routes; with accounts on the server ignores it.
    headers: { 'content-type': bytes.type, ...USER_HEADER },
    body: bytes,
    signal,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
    // Refusals that would refuse every picture end the batch, not just this one.
    err.fatal = res.status === 403 || res.status === 503 || res.status === 400;
    throw err;
  }
  let result = null;
  let failure = null;
  await readSSE(res, (event, payload) => {
    if (event === 'queued') onWait?.(payload.position);
    else if (event === 'done') result = payload;
    else if (event === 'error') failure = payload.message ?? payload.error;
  });
  if (failure) throw new Error(failure);
  if (!result) throw new Error('The model returned nothing.');
  return { ...result, hintNote };
}

async function runCaptions() {
  if (CAP.abort || !CAP.style || !CAP.items.length) return;
  const abort = new AbortController();
  CAP.abort = abort;
  const styleId = CAP.style.id;
  CAP.captions.clear();
  CAP.problems = [];
  paintCaptionButtons();
  paintCaptionResult();
  const status = $('#lora-cap-status');
  const bar = $('#lora-cap-bar');
  const fill = $('#lora-cap-fill');
  bar.hidden = false;
  fill.style.width = '0%';
  const total = CAP.items.length;
  const started = Date.now();
  let n = 0;
  let stopReason = '';
  for (const it of CAP.items) {
    if (abort.signal.aborted || CAP.style?.id !== styleId) break;
    // A rough time left from the pictures done so far, once there are any.
    const each = n ? (Date.now() - started) / n : 0;
    const left = each ? ` · about ${Math.max(1, Math.round((each * (total - n)) / 60000))} min left` : '';
    status.textContent = `Captioning ${n + 1} of ${total}${left}`;
    try {
      const r = await captionOne(it, abort.signal, (pos) => {
        status.textContent = `Captioning ${n + 1} of ${total} · waiting for the card, ${pos} ahead`;
      });
      if (CAP.style?.id !== styleId) break;
      CAP.captions.set(it.stem, r.caption);
      const notes = [];
      if (r.watermark) notes.push('has a watermark; crop or drop it');
      if (r.replaced?.length) notes.push(`swapped for real tags: ${r.replaced.map((x) => `${x.from} → ${x.to}`).join(', ')}`);
      if (r.unknown?.length) notes.push(`not danbooru tags: ${r.unknown.join(', ')}`);
      if (r.hintNote) notes.push(r.hintNote);
      if (notes.length) CAP.problems.push({ path: it.path, message: notes.join('; ') });
    } catch (err) {
      if (abort.signal.aborted) break;
      CAP.problems.push({ path: it.path, message: `no caption: ${err.message}` });
      if (err.fatal) { stopReason = err.message; break; }
    }
    n += 1;
    fill.style.width = `${Math.round((n / total) * 100)}%`;
    paintCaptionResult();
  }
  CAP.abort = null;
  const done = CAP.captions.size;
  status.textContent = stopReason
    ? `Stopped: ${stopReason}`
    : abort.signal.aborted
      ? `Stopped after ${done} of ${total}. You can download what is done.`
      : `Done: ${done} of ${total} captioned.`;
  paintCaptionButtons();
  paintCaptionResult();
}

function paintCaptionButtons() {
  const busy = Boolean(CAP.abort);
  $('#lora-cap-run').disabled = busy || !CAP.items.length || !CAP.style;
  $('#lora-cap-stop').hidden = !busy;
  $('#lora-cap-drop').classList.toggle('disabled', busy);
}

function paintCaptionResult() {
  const n = CAP.captions.size;
  const btn = $('#lora-cap-download');
  const note = $('#lora-cap-download-note');
  btn.disabled = n === 0 || Boolean(CAP.abort);
  const missing = CAP.items.length - n;
  note.hidden = n === 0;
  note.textContent = `Your pictures with ${n} caption${n === 1 ? '' : 's'}, each a .txt named after its picture.` +
    (missing && !CAP.abort ? ` ${missing} picture${missing === 1 ? ' has' : 's have'} no caption.` : '');
  const list = $('#lora-cap-problems');
  list.hidden = CAP.problems.length === 0;
  list.replaceChildren(...CAP.problems.map((p) => {
    const li = document.createElement('li');
    const b = document.createElement('strong');
    b.textContent = p.path;
    li.append(b, document.createTextNode(`: ${p.message}`));
    return li;
  }));
}

async function downloadCaptions() {
  if (!CAP.captions.size) return;
  const files = [];
  for (const it of CAP.items) {
    files.push({ name: it.path, data: new Uint8Array(await it.file.arrayBuffer()) });
    const text = CAP.captions.get(it.stem);
    if (text) files.push({ name: `${it.stem}.txt`, data: `${text}\n` });
  }
  for (const o of CAP.others) files.push(o);
  const url = URL.createObjectURL(makeZip(files));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${CAP.zipName || 'dataset'}-captioned-${CAP.style?.id ?? 'captions'}.zip`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function wireCaptionView() {
  for (const btn of $$('#lora-mode button')) {
    btn.addEventListener('click', () => setLoraMode(btn.dataset.mode));
  }
  $('#lora-cap-style').addEventListener('change', (e) => selectCaptionStyle(e.target.value));
  $('#lora-cap-model').addEventListener('change', (e) => { captionModel = e.target.value; });
  // The type changes what every caption leaves out, so captions written for
  // the old one are cleared, like a style change.
  $('#lora-cap-type').addEventListener('change', () => {
    paintLoraTypeNote();
    try { localStorage.setItem('pf.loraType', $('#lora-cap-type').value); } catch {}
    CAP.abort?.abort();
    if (CAP.items.length) resetCaptions('LoRA type changed. Press Caption the dataset to start again.');
  });

  const drop = $('#lora-cap-drop');
  const input = $('#lora-cap-zip');
  const take = (file) => {
    if (CAP.abort || !file) return;
    if (!/\.zip$/i.test(file.name)) {
      $('#lora-cap-summary').hidden = false;
      $('#lora-cap-summary').textContent = `${file.name} is not a .zip. Zip the pictures and drop the zip.`;
      return;
    }
    loadCaptionZip(file);
  };
  drop.addEventListener('click', () => { if (!CAP.abort) input.click(); });
  drop.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && !CAP.abort) { e.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => {
    take(input.files[0]);
    input.value = '';
  });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('dragover');
    take(e.dataTransfer.files[0]);
  });

  $('#lora-cap-run').addEventListener('click', runCaptions);
  $('#lora-cap-stop').addEventListener('click', () => CAP.abort?.abort());
  $('#lora-cap-download').addEventListener('click', downloadCaptions);
}

// ── The setup wizard (4 Oct 2026) ──
// The Setup panel one step at a time. Each section step borrows that
// section's element from the panel and puts it back on the way out, so the
// panel's own handlers do all the work and there is one copy of each control.
const WIZARD = { steps: [], at: 0 };
const WIZARD_LABELS = {
  llm: 'LLM server',
  network: 'Who can connect',
  taggers: 'Image taggers',
  comfyui: 'Render pictures',
  training: 'LoRA training',
};

function wizardSection(name) {
  return document.querySelector(`.setup-sec[data-sec="${name}"]`);
}

/** Put every borrowed section back where it lives in the Setup panel. */
function returnWizardSections() {
  for (const sec of document.querySelectorAll('#wizard-slot .setup-sec')) {
    const home = sec._home;
    if (home) home.parent.insertBefore(sec, home.next);
  }
}

function openWizard() {
  $('#backend-modal').hidden = true;
  WIZARD.steps = ['welcome'];
  WIZARD.at = 0;
  $('#wizard-modal').hidden = false;
  loadNetwork();
  loadTaggers();
  loadFeatureSetup();
  // Fill the LLM step the way the panel does, testing a saved address at once.
  fetch('/api/admin/models/backend')
    .then((r) => (r.ok ? r.json() : null))
    .then((info) => {
      if (!info) return;
      $('#backend-select').value = info.backend || 'ollama';
      $('#backend-url').value = info.base_url || '';
      $('#backend-modal').dataset.currentModel = info.model || '';
      if (info.base_url && info.backend !== 'mock') testBackend();
    })
    .catch(() => {});
  showWizardStep();
}

function closeWizard() {
  returnWizardSections();
  $('#backend-save').hidden = false;
  $('#wizard-modal').hidden = true;
}

function showWizardStep() {
  returnWizardSections();
  const step = WIZARD.steps[WIZARD.at];
  const isSection = Boolean(WIZARD_LABELS[step]);
  for (const el of document.querySelectorAll('#wizard-modal .wizard-step')) {
    el.hidden = el.dataset.step !== (isSection ? 'section' : step);
  }
  if (isSection) {
    const sec = wizardSection(step);
    sec._home ??= { parent: sec.parentNode, next: sec.nextSibling };
    $('#wizard-slot').append(sec);
  }
  if (step === 'done') paintWizardSummary();

  // The panel's Save button is the wizard's Next on the LLM step.
  $('#backend-save').hidden = step === 'llm';
  const last = WIZARD.at === WIZARD.steps.length - 1 && step === 'done';
  $('#wizard-back').hidden = WIZARD.at === 0 || last;
  // The LLM step cannot be skipped: without it nothing works.
  $('#wizard-skip').hidden = !isSection || step === 'llm';
  $('#wizard-next').textContent = last ? 'Start using PromptForge' : step === 'llm' ? 'Save and continue' : 'Next';

  const dots = $('#wizard-dots');
  dots.replaceChildren();
  // On the welcome step the route is not chosen yet, so it is one dot.
  const total = WIZARD.steps.length > 1 ? WIZARD.steps.length : 1;
  for (let i = 0; i < total; i++) {
    const d = document.createElement('span');
    if (i <= WIZARD.at) d.className = 'on';
    dots.append(d);
  }
}

function paintWizardSummary() {
  const rows = [];
  const row = (label, text) => rows.push(`<p class="wizard-summary-row"><strong>${escHtml(label)}</strong> — ${escHtml(text)}</p>`);
  const model = $('#backend-modal').dataset.currentModel;
  row('Prompt writing', model ? `ready, default model ${model}` : 'ready');
  row('Who can connect', $('#network-remote').checked ? 'other devices too' : 'only this PC');
  const taggers = $('#tagger-rows').textContent;
  const ready = (taggers.match(/✓ ready/g) ?? []).length;
  const busy = /downloading/.test(taggers);
  row('Image taggers', busy ? 'downloading — they switch on by themselves when done' : ready ? `${ready} ready` : 'off');
  const c = FEATURE_STATE.comfyui;
  row('Render pictures', c?.enabled || c?.saved?.enabled ? 'on' : 'off');
  const t = FEATURE_STATE.training;
  row('LoRA training', t?.enabled ? 'connected' : 'off');
  $('#wizard-summary').innerHTML = rows.join('');
  const restart = Boolean(c?.restart_needed) || /Restart PromptForge/.test($('#network-message').textContent);
  featureMessage('#wizard-restart', restart ? 'Restart PromptForge once so every choice takes effect.' : '');
}

async function wizardNext({ skip = false } = {}) {
  const step = WIZARD.steps[WIZARD.at];
  if (step === 'welcome') {
    WIZARD.steps = [
      'welcome',
      'llm',
      'network',
      ...($('#wizard-want-taggers').checked ? ['taggers'] : []),
      ...($('#wizard-want-comfyui').checked ? ['comfyui'] : []),
      ...($('#wizard-want-training').checked ? ['training'] : []),
      'done',
    ];
  } else if (step === 'llm' && !skip) {
    const btn = $('#wizard-next');
    btn.disabled = true;
    const saved = await saveBackend();
    btn.disabled = false;
    if (!saved) return;
  } else if (step === 'done') {
    closeWizard();
    refreshStatus();
    return;
  }
  WIZARD.at = Math.min(WIZARD.at + 1, WIZARD.steps.length - 1);
  showWizardStep();
}

function initWizard() {
  $('#wizard-next').addEventListener('click', () => wizardNext());
  $('#wizard-skip').addEventListener('click', () => wizardNext({ skip: true }));
  $('#wizard-back').addEventListener('click', () => {
    WIZARD.at = Math.max(0, WIZARD.at - 1);
    showWizardStep();
  });
  $('#wizard-rerun').addEventListener('click', openWizard);
  // Never a trap: a first run closed early opens again on the next load,
  // because the server still says setup is needed.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#wizard-modal').hidden) closeWizard();
  });
}

function initAccountsPanel() {
  const modal = $('#accounts-modal');
  $('#btn-accounts').addEventListener('click', () => {
    modal.hidden = false;
    refreshAccounts();
    refreshModelRequests();
    refreshTagDb();
  });
  initTagDbPanel();
  initRequestsPanel();
  initUsagePanel();
  $('#accounts-close').addEventListener('click', () => { modal.hidden = true; });
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) modal.hidden = true;
  });

  // Delegated: the rows are rebuilt on every refresh.
  $('#accounts-list').addEventListener('click', async (e) => {
    const copyBtn = e.target.closest('button[data-copy]');
    if (copyBtn) {
      navigator.clipboard.writeText(copyBtn.dataset.copy).then(
        () => toast('Password copied'),
        () => toast('Could not copy — select it by hand')
      );
      return;
    }
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'dismiss-temp') return refreshAccounts();
    const { act, user } = btn.dataset;
    if (act === 'deny' && !confirm(`Deny ${user}? They will not be able to sign in.`)) return;
    // Remove is the one irreversible action here, and it takes the person's
    // saved prompt library with it — name them, then say that.
    if (
      act === 'remove' &&
      !confirm(
        `Are you sure you want to remove ${user}?\n\n` +
          `This deletes their account AND every prompt they have saved. It cannot be undone.\n\n` +
          `To block them without deleting anything, use Deny instead.`
      )
    ) {
      return;
    }
    if (act === 'reset') {
      const self = user === ME?.user?.username;
      const warning = self
        ? `Reset your own password?\n\nYou will be signed out immediately and have to sign back in with the new one.`
        : `Reset the password for ${user}?\n\nTheir current password stops working straight away, and they will be signed out. You will get a new one to send them.`;
      if (!confirm(warning)) return;
    }

    // grant and ungrant are the same route with a different body, because the
    // permission being toggled is data rather than a verb — a second grant
    // later is a string, not two more endpoints.
    const granting = act === 'grant' || act === 'ungrant';
    const grant = btn.dataset.grant ?? 'offload';
    const GRANT_ASK = {
      offload:
        `Let ${user} offload models?\n\n` +
        `They will be able to drop any model out of VRAM, including one somebody else is generating with. That request finishes first, and the next one reloads the model.`,
      train:
        `Let ${user} train LoRAs?\n\n` +
        `They get Tab 2 and TrainFlow, which reads and writes whatever paths are typed into it. ` +
        `Only grant this once TrainFlow runs as a box user that cannot reach anything but its own folders.`,
    };
    if (act === 'grant' && !confirm(GRANT_ASK[grant] ?? `Grant "${grant}" to ${user}?`)) {
      return;
    }

    btn.disabled = true;
    try {
      const res = await rawFetch(
        `/api/admin/users/${encodeURIComponent(user)}/${granting ? 'grant' : act}`,
        granting
          ? {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ grant, on: act === 'grant' }),
            }
          : { method: 'POST' }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data.message ?? 'Failed');
      } else if (act === 'reset') {
        // Shown once and never again — it is not stored anywhere. Rendered
        // into the row rather than a toast for exactly that reason: a toast
        // vanishes on a timer and this has to survive being copied.
        showTemporaryPassword(user, data.password);
        return;
      } else if (granting) {
        // The person's own page reads its permissions at sign-in, so a grant
        // handed out while they are looking at the app appears on their next
        // reload. Said here rather than left to be noticed.
        const what = { train: 'train LoRAs', render: 'render pictures' }[grant] ?? 'offload models';
        toast(act === 'grant' ? `${user} can ${what} — on their next page load` : `${user} can no longer ${what}`);
      } else {
        toast(act === 'remove' ? `${user} removed` : `${user}: ${data.user?.status}`);
      }
    } finally {
      if (act !== 'reset') refreshAccounts();
    }
  });

}

// init() builds the whole app and must run exactly once — a second sign-in in
// the same tab (after a session ends and is renewed) must not mount every
// template and event listener a second time.
let appStarted = false;

async function startApp(user) {
  // ME has to track the *current* identity, not just whatever /api/auth/me
  // said at boot. The 401 interceptor keys off it, so leaving it stale after
  // a sign-in means a revoked session silently does nothing instead of
  // putting the wall back.
  ME = { ...(ME ?? {}), authenticated: true, user };
  applyIdentity(user);
  $('#auth-wall').hidden = true;
  if (!appStarted) {
    appStarted = true;
    await init();
  }
}

// The wall is visible in the markup rather than shown from here: app.js is a
// module and therefore deferred, so anything switched on at this point has
// already let the app render behind it for a frame.
async function boot() {
  // First, before anything renders. The login wall is in the markup rather
  // than switched on by script, so it is already on screen — and it is the
  // one surface that has to be readable before any account is known. i18n
  // falls back to this browser's last choice, then to the browser's own
  // language list, for exactly that moment.
  startI18n();

  initAccountsPanel();
  initBackendPanel();
  initMonitoringButton();
  initRandomizer();
  initPasswordPanel();
  $('#auth-form').addEventListener('submit', submitAuth);
  $('#auth-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (btn) setAuthMode(btn.dataset.mode);
  });
  $('#auth-pending-back').addEventListener('click', () => showWall('login'));

  try {
    ME = await rawFetch('/api/auth/me').then((r) => r.json());
  } catch (err) {
    showWall('login', `Cannot reach the server — ${err.message}`);
    return;
  }

  // A server running with accounts disabled has no one to be; boot straight
  // into the app the way it behaved before accounts existed.
  if (!ME.auth_enabled || ME.authenticated) {
    return startApp(ME.user ?? null);
  }
  showWall('login');
}

// NOTE: this block sits at MODULE scope deliberately.
//
// It was first inserted inside init(), which made paintBenchmarkFrame
// invisible to applyAppearance — and applyAppearance calls it on every
// theme change. The ReferenceError was swallowed by loadAccount's catch,
// which returned null, which made fillAccountPanel bail at its first line.
// The symptom was an account panel of empty dropdowns with nothing in the
// console and nothing in the server log. Reported 5 Sep 2026.

// ── Benchmarks tab ───────────────────────────────────────────
//
// Reads the sheets server/benchmarks.mjs serves. Runs nothing: there is no
// button here that starts a generation, and that is deliberate — a benchmark
// run costs 27B time on a queue five people share, which is a different
// feature with a different price.
//
// The sheets are shown in an iframe rather than injected into the panel.
// p40-bench-2026-09-03.html was hand-written with its own stylesheet and
// twelve classes of bar chart, and inlining that would restyle the whole app.

/**
 * The palette handed to a sheet, by variable name.
 *
 * The sheets carry no colours of their own — see the note on STYLE in
 * server/benchmarks.mjs. These are copied from the live document, so whichever
 * of the seven themes is on is the one a sheet renders in, including the ones
 * that did not exist when the sheet was written.
 *
 * Copied rather than linked because a stylesheet cannot follow a `data-theme`
 * set on a DIFFERENT document's root: the iframe has its own <html>, and
 * themes.css keys off that attribute. Reading the computed values out of the
 * parent and writing them in as inline custom properties is the version that
 * needs no coordination between the two documents at all.
 */
const BENCH_VARS = [
  '--bg-deep', '--bg-base', '--bg-surface', '--bg-elevated', '--bg-input',
  '--border', '--border-light',
  '--text-primary', '--text-secondary', '--text-muted',
  '--accent', '--accent-dim', '--accent-glow', '--accent-glow-strong',
  '--accent-blue', '--accent-purple', '--accent-amber', '--accent-rose',
  '--on-accent', '--radius', '--radius-lg', '--mono', '--sans',
];

/**
 * Push the current palette into the sheet frame.
 *
 * Same-origin, so contentDocument is reachable; wrapped anyway, because a
 * frame mid-navigation throws and a benchmark sheet is not worth an exception
 * that stops the tab handler.
 */
function paintBenchmarkFrame() {
  paintThemeInto($('#bench-frame'));
}

/**
 * The palette, font and text size into any same-origin frame: the benchmark
 * sheet, and the MOSS Layout Studio, whose stylesheet maps these variables
 * onto its own.
 */
function paintThemeInto(frame) {
  const doc = (() => {
    try { return frame?.contentDocument ?? null; } catch { return null; }
  })();
  if (!doc?.documentElement) return;
  const from = getComputedStyle(document.documentElement);
  for (const name of BENCH_VARS) {
    const value = from.getPropertyValue(name).trim();
    if (value) doc.documentElement.style.setProperty(name, value);
  }
  // Light or dark, so the frame's own form controls and scrollbars match.
  doc.documentElement.style.colorScheme = from.colorScheme || 'dark';
  // data-theme as well, so a sheet that keys off it directly — p40-bench has
  // its own [data-theme="dark"] block — agrees with the variables it is given.
  // Text size the same way: it is a rule on body, not a variable.
  for (const attr of ['data-theme', 'data-textsize']) {
    const value = document.documentElement.getAttribute(attr);
    if (value) doc.documentElement.setAttribute(attr, value);
    else doc.documentElement.removeAttribute(attr);
  }
}

let benchLoaded = false;
let benchSheets = [];

// ── Tab 6: the pinboard ────────────────────────────────────────────────────
//
// A picture and the prompt that made it, uploaded by anybody and visible to
// everybody. The whole tab is two jobs: put a pair in, and take one back out
// into the builder.
//
// Taking one out reuses Tab 3's hand-off — `adoptImageReference` — rather
// than growing a second way to put a picture on a reference card. That path
// has been carrying cropped bytes from Image Analysis into Tab 1 since it
// shipped, and a shared picture is the same move from a different shelf.
//
// The saved prompt REPLACES the brief. The randomizer next door offers Add
// and Replace because a roll is something you bolt onto what you already
// wrote; this is the opposite — the saved prompt is the starting point and
// you edit it in the brief, which is the owner's call, 19 Sep 2026.
let sharedLoaded = false;
let sharedEntries = [];
let sharedLimits = { max_image_mb: 20, accepted_types: [], text_max: 20000 };

// The server's rule for turning a typed name into a filename, mirrored so the
// hint under the field can show what the file will actually be called. Kept
// deliberately identical to slugify() in server/sharedimages.mjs — the server
// is still the one that decides, and this only predicts.
function sharedSlug(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
}

const SHARED_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

/**
 * Fill a "made with" selector from the registry, image models only.
 *
 * Built from REGISTRY rather than from three names written here — the rule
 * CLAUDE.md states as a non-negotiable, and the reason a fourth image model
 * needs one registry entry and no edit to this file. The blank first option
 * is the normal case: plenty of what goes up is a reference photo that no
 * model made.
 */
function fillSharedModels(sel, chosen = '') {
  if (!sel) return;
  const models = modelsOfType('image');
  fillSelect(sel, ['', ...models.map((m) => m.key)], chosen ?? '', (k) =>
    k === '' ? 'Not set' : (models.find((m) => m.key === k)?.label ?? k)
  );
}

/** A model key as its registry label, for a badge. Unknown keys show as-is. */
const sharedModelLabel = (key) =>
  key ? (REGISTRY?.models?.find((m) => m.key === key)?.label ?? key) : '';

async function loadSharedImages({ force = false } = {}) {
  if (sharedLoaded && !force) return;
  sharedLoaded = true;
  try {
    // Both in one go: the weight links are shared and somebody else may have
    // added one since this tab was last opened, exactly like the pins.
    const [data, links] = await Promise.all([
      fetch('/api/shared-images', { headers: USER_HEADER }).then((r) => r.json()),
      fetch('/api/weight-links', { headers: USER_HEADER })
        .then((r) => (r.ok ? r.json() : { links: {} }))
        .catch(() => ({ links: {} })),
    ]);
    sharedEntries = data.entries ?? [];
    sharedWeightLinks = links.links ?? {};
    if (data.limits) sharedLimits = { ...sharedLimits, ...data.limits };
  } catch {
    // An unreachable library is an empty grid with a note, not an error
    // banner over a tab whose other half — the upload form — still works.
    sharedEntries = [];
  }
  renderSharedGrid();
}

function renderSharedGrid() {
  const grid = $('#shared-grid');
  const empty = $('#shared-empty');
  const count = $('#shared-count');
  const tpl = $('#shared-card');
  if (!grid || !tpl) return;

  const needle = ($('#shared-search')?.value ?? '').trim().toLowerCase();
  const shown = needle
    ? sharedEntries.filter((e) =>
        // The model matches on its label as well as its key, because what is
        // on screen is "Illustrious XL" and typing that should find it.
        [e.name, e.text, e.author, e.model, sharedModelLabel(e.model)]
          .some((f) => String(f ?? '').toLowerCase().includes(needle))
      )
    : sharedEntries;

  if (count) {
    count.textContent = needle
      ? `${shown.length} of ${sharedEntries.length}`
      : `${sharedEntries.length} shared`;
  }
  if (empty) {
    empty.hidden = shown.length > 0;
    empty.textContent = sharedEntries.length
      ? 'Nothing matches that.'
      : 'Nothing pinned yet. Put the first one up.';
  }

  grid.innerHTML = '';
  for (const entry of shown) {
    const card = tpl.content.firstElementChild.cloneNode(true);
    card.dataset.name = entry.name;

    const thumb = $('[data-bind="shared_thumb"]', card);
    if (thumb) {
      thumb.src = `/api/shared-images/${encodeURIComponent(entry.name)}/file`;
      thumb.alt = entry.name;
    }
    $('[data-bind="shared_card_name"]', card).textContent = entry.name;
    // "added by hand" rather than blank for a pair somebody dropped in over
    // SSH — it never went through the button, so there is nobody to credit,
    // and saying so is more honest than attributing it to no one.
    const by = $('[data-bind="shared_card_by"]', card);
    if (by) {
      const who = entry.author ?? 'added by hand';
      by.textContent = entry.at ? `${who} · ${entry.at.slice(0, 10)}` : who;
    }

    // The model as a corner badge. Hidden when nothing was set, which is the
    // normal case for a reference photo that no model made.
    const badge = $('[data-bind="shared_card_model"]', card);
    if (badge) {
      const label = sharedModelLabel(entry.model);
      badge.textContent = label;
      badge.hidden = !label;
    }

    card.addEventListener('click', () => openSharedDetail(entry.name));
    grid.appendChild(card);
  }
}

// Which entry the detail modal is showing. By name rather than by object so a
// refresh underneath it cannot leave the modal editing a stale copy.
let sharedOpen = null;

// Which of a pin's two texts goes into the builder: 'brief' or 'prompt'.
// Re-decided per pin when the modal opens, rather than remembered, because
// not every pin has both.
let sharedTakeWhich = 'brief';

/**
 * The Brief / Final prompt toggle.
 *
 * A half the pin does not have is disabled rather than hidden — a control
 * that changes shape between pins is harder to learn than one that greys out,
 * and the greyed half says the pin is missing something.
 */
function paintTakeWhich(entry) {
  const wrap = $('#shared-take-which');
  const briefBlock = $('#shared-brief-block');
  if (briefBlock) briefBlock.hidden = !entry.brief?.trim() && entry.can_edit === false;
  if (!wrap) return;
  const have = { brief: Boolean(entry.brief?.trim()), prompt: Boolean(entry.text?.trim()) };
  for (const b of $$('button', wrap)) {
    const which = b.dataset.which;
    b.disabled = !have[which];
    b.classList.toggle('active', which === sharedTakeWhich);
  }
}

// The KSampler fields worth a row of their own, in the order somebody reading
// them would want: what to set first, then how hard, then with what. The rest
// of a node's inputs — tile_width, seam_fix_mask_blur, fifteen more on an
// UltimateSDUpscale — go in the copied text but not on screen, where they
// would bury the six numbers this is for.
const COMFY_FIELDS = [
  ['seed', 'Seed'],
  ['noise_seed', 'Seed'],
  ['steps', 'Steps'],
  ['cfg', 'CFG'],
  ['sampler_name', 'Sampler'],
  ['scheduler', 'Scheduler'],
  ['denoise', 'Denoise'],
];

/** Everything, as a block somebody can paste back into ComfyUI or a comment. */
function comfyText(comfy) {
  if (!comfy) return '';
  const lines = [];
  for (const s of comfy.samplers ?? []) {
    lines.push(comfy.samplers.length > 1 ? `${s.type} (node ${s.node})` : s.type);
    for (const [k, v] of Object.entries(s.settings ?? {})) lines.push(`  ${k}: ${v}`);
  }
  for (const c of comfy.checkpoints ?? []) lines.push(`checkpoint: ${c}`);
  for (const l of comfy.loras ?? []) {
    const strengths = [l.model, l.clip].filter((n) => n !== null).join(' / ');
    lines.push(`lora: ${l.name}${strengths ? `  ${strengths}` : ''}`);
  }
  return lines.join('\n');
}

/**
 * The settings block in the detail modal, or nothing at all.
 *
 * Hidden rather than empty when a picture has no ComfyUI graph in it. Most
 * pictures will not — a JPEG, a screenshot, anything re-encoded on its way
 * here — and a "From ComfyUI" heading over an empty list reads as a broken
 * parser rather than as a picture from somewhere else.
 */
/** One label/value row into a <dl>. */
function comfyRow(list, label, value, mono = false) {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = String(value);
  if (mono) dd.classList.add('mono');
  list.append(dt, dd);
}

// Where each weight lives, pasted in by hand and shared by everyone. Keyed on
// the bare filename, so a link added once serves every pin that names it —
// including ones pinned before the link existed.
let sharedWeightLinks = {};

/** The key the server files a weight under: no folder, no extension, lower. */
const weightKey = (name) =>
  String(name ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/\.(safetensors|ckpt|pt|sft|gguf|bin)$/i, '')
    .trim()
    .toLowerCase();

/**
 * Civitai's search page for a weight. A helper for FINDING the thing, never
 * presented as the model's own page.
 *
 * Civitai resolves a file to its page by SHA256, and ComfyUI records no
 * hashes in the PNG, so nothing in the picture says which model it is.
 * Guessing from the filename and calling the top hit "the" model would be
 * wrong often and confidently — people rename these, and half of what this
 * group loads is self-trained and has no page at all. So the real link is
 * typed in by a person, and this is the button that helps them find it.
 */
const civitaiSearchUrl = (name) =>
  `https://civitai.com/search/models?query=${encodeURIComponent(weightKey(name))}`;

/**
 * A resource row: the weight's name, its link if anybody has added one, and
 * the means to add one if not.
 *
 * Re-rendered in place on save rather than by repainting the whole card,
 * because the card is inside an open modal somebody is reading.
 */
function resourceRow(list, label, name, suffix = '') {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.className = 'shared-weight';
  list.append(dt, dd);

  const paint = () => {
    dd.textContent = '';
    const known = sharedWeightLinks[weightKey(name)];

    if (known?.url) {
      const a = document.createElement('a');
      a.href = known.url;
      a.target = '_blank';
      a.rel = 'noreferrer noopener';
      a.textContent = name;
      a.className = 'shared-weight-link';
      a.title = `${known.url}${known.by ? ` — added by ${known.by}` : ''}`;
      dd.appendChild(a);
    } else {
      dd.append(document.createTextNode(name));
    }
    if (suffix) dd.append(document.createTextNode(` — ${suffix}`));

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'ghost shared-weight-add';
    edit.textContent = known?.url ? 'edit link' : '+ link';
    edit.addEventListener('click', () => editor(known?.url ?? ''));
    dd.appendChild(edit);
  };

  const editor = (current) => {
    dd.textContent = '';
    const input = document.createElement('input');
    input.type = 'url';
    input.className = 'shared-weight-input';
    input.placeholder = 'https://civitai.com/models/…';
    input.value = current;

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'ghost';
    save.textContent = 'Save';

    const find = document.createElement('a');
    find.href = civitaiSearchUrl(name);
    find.target = '_blank';
    find.rel = 'noreferrer noopener';
    find.className = 'shared-weight-link';
    find.textContent = 'find it';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'ghost';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', paint);

    const commit = async () => {
      const url = input.value.trim();
      if (!url) return paint();
      save.disabled = true;
      try {
        const res = await fetch(`/api/weight-links/${encodeURIComponent(name)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', ...USER_HEADER },
          body: JSON.stringify({ url }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.message ?? 'Could not save it.');
        // Into the shared map, so every other row naming this weight — in
        // this modal and in the next one opened — picks it up without a
        // refetch.
        sharedWeightLinks[body.key] = body;
        toast(`Link saved for ${name.split('/').pop()}`);
        paint();
      } catch (err) {
        toast(err.message);
        save.disabled = false;
      }
    };
    save.addEventListener('click', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') paint();
    });

    dd.append(input, save, cancel, find);
    input.focus();
  };

  paint();
}

function renderComfy(comfy) {
  const host = $('#shared-comfy');
  const list = $('#shared-comfy-list');
  const resHost = $('#shared-resources');
  const resList = $('#shared-resources-list');
  const negHost = $('#shared-negative-block');
  const negText = $('#shared-negative-text');
  if (!host || !list) return;

  for (const el of [host, resHost, negHost]) if (el) el.hidden = true;
  list.innerHTML = '';
  if (resList) resList.innerHTML = '';
  if (!comfy) return;

  // ── Generation: the settings somebody would retype ──
  const lead = comfy.samplers?.[0];
  if (lead) {
    const seen = new Set();
    for (const [key, label] of COMFY_FIELDS) {
      const v = lead.settings?.[key];
      if (v === undefined || seen.has(label)) continue;
      seen.add(label);
      // The seed arrives as a string when it was too long for a double to
      // hold exactly — see quoteLongSeeds in server/comfymeta.mjs. Either way
      // it is digits to be copied, so it gets the monospace column.
      comfyRow(list, label, v, label === 'Seed');
    }
  }
  // Named rather than folded in silently: a second pass has its own seed, and
  // somebody reproducing this needs to know the one on screen is not the only
  // one. The full set is in Copy settings.
  if ((comfy.samplers?.length ?? 0) > 1) {
    comfyRow(list, 'Also', comfy.samplers.slice(1).map((s) => s.type).join(', '));
  }
  host.hidden = !list.children.length;

  // ── Resources: the weights, which is a different question ──
  //
  // Split from the settings above because they are answers to different
  // questions — "what numbers do I set" and "what do I need installed" — and
  // because a graph with four LoRAs would otherwise bury the seed.
  if (resList) {
    for (const c of comfy.checkpoints ?? []) resourceRow(resList, 'Checkpoint', c);
    for (const l of comfy.loras ?? []) {
      const strengths = [l.model, l.clip].filter((n) => n !== null).join(' / ');
      resourceRow(resList, 'LoRA', l.name, strengths);
    }
    if (resHost) resHost.hidden = !resList.children.length;
  }

  // ── The negative, to read and copy, never to save as the entry's text ──
  if (negHost && negText) {
    negText.textContent = comfy.negative ?? '';
    negHost.hidden = !comfy.negative;
  }
}

function closeSharedDetail() {
  sharedOpen = null;
  const modal = $('#shared-modal');
  if (modal) modal.hidden = true;
}

function openSharedDetail(name) {
  const entry = sharedEntries.find((e) => e.name === name);
  const modal = $('#shared-modal');
  if (!entry || !modal) return;
  sharedOpen = name;

  $('#shared-modal-title').textContent = entry.name;
  const img = $('#shared-detail-img');
  if (img) {
    img.src = `/api/shared-images/${encodeURIComponent(entry.name)}/file`;
    img.alt = entry.name;
  }
  const by = $('#shared-detail-by');
  if (by) {
    const who = entry.author ?? 'added by hand, not through the app';
    by.textContent = entry.at ? `${who} · ${entry.at.slice(0, 10)}` : who;
  }
  const text = $('#shared-detail-text');
  if (text) text.value = entry.text ?? '';
  const briefBox = $('#shared-detail-brief');
  if (briefBox) briefBox.value = entry.brief ?? '';
  // Default to whichever half this pin actually has, preferring the brief:
  // it is the one somebody else can adapt without rewriting every tag.
  sharedTakeWhich = entry.brief?.trim() ? 'brief' : 'prompt';
  paintTakeWhich(entry);
  const modelSel = $('#shared-detail-model');
  fillSharedModels(modelSel, entry.model ?? '');
  const save = $('#shared-detail-save');
  if (save) save.hidden = true;

  // What somebody pinned is theirs. `can_edit` is computed server-side — it
  // needs the owner gate, and a second copy of that rule in the browser is a
  // second chance to get it subtly different — and the server refuses the
  // PATCH regardless. This half only stops the UI offering something that
  // would bounce.
  const mine = entry.can_edit !== false;
  if (text) text.readOnly = !mine;
  if (modelSel) modelSel.disabled = !mine;
  const remove = $('#shared-detail-remove');
  if (remove) remove.hidden = !mine;
  const locked = $('#shared-detail-locked');
  if (locked) {
    locked.hidden = mine;
    locked.textContent = `${entry.author ?? 'Whoever put this up'} owns this one. Take it into the builder to change the prompt — the copy in your brief is yours.`;
  }
  if (text) {
    text.placeholder = mine
      ? 'No prompt saved with this one. Write it in and press Save.'
      : 'No prompt was saved with this one.';
  }

  // Painted from what the listing already knows, then refreshed from the
  // entry's own route. The listing deliberately carries only `has_comfy` —
  // a grid of thirty tiles must not be thirty graphs — and a pair copied in
  // over SSH has not been parsed at all until something asks for it.
  renderComfy(entry.comfy ?? null);
  fetch(`/api/shared-images/${encodeURIComponent(entry.name)}`, { headers: USER_HEADER })
    .then((r) => (r.ok ? r.json() : null))
    .then((full) => {
      if (!full || sharedOpen !== entry.name) return;   // modal moved on
      entry.comfy = full.comfy ?? null;
      renderComfy(entry.comfy);
    })
    .catch(() => { /* the settings are a bonus; the picture and prompt are the entry */ });

  // Says up front what "Image only" would do here, so nobody presses it on a
  // video model and wonders why nothing arrived on a reference card.
  //
  // Asked of the DOM rather than of adoptImageReference, which answers false
  // for a missing file as readily as for a missing block and so can never be
  // a capability probe. The mounted block IS the switch — app.js returns
  // early when it is absent and no model decides it — so that is the thing
  // to look at.
  // Careful with the wording. The video models DO take reference pictures —
  // h3 through the Director's own rows, wan through its frame pair — they
  // just do not take them through this block, and a note claiming otherwise
  // would be flatly wrong to anyone who has used the h3 panel.
  const note = $('#shared-take-note');
  if (note) {
    const takesRefs = !!$('[data-bind="image_reference"]', $('#builder-mount'));
    note.textContent = takesRefs
      ? ''
      : `${currentModel?.name ?? 'This model'} takes its references on its own panel, not here — Image and Both will bring only the prompt.`;
  }

  modal.hidden = false;
}

/**
 * Take one entry into the builder. `want` is 'image', 'prompt' or 'both'.
 *
 * The two halves are independent on purpose, and not only because the buttons
 * ask for them separately: a model with no reference block — the video ones —
 * still gets the prompt, because a saved prompt is worth having whether or not
 * this model can take the picture. The toast says what actually happened
 * rather than what was asked for.
 */
async function useSharedEntry(name, want = 'both') {
  const entry = sharedEntries.find((e) => e.name === name);
  if (!entry) return;
  // Whichever of the two texts the toggle is on, taken from the box rather
  // than from the entry, so an edit typed in the modal travels even if Save
  // was not pressed. The disk copy is a separate decision.
  const box = sharedTakeWhich === 'brief' ? '#shared-detail-brief' : '#shared-detail-text';
  const fallback = sharedTakeWhich === 'brief' ? entry.brief : entry.text;
  const body = String($(box)?.value ?? fallback ?? '').trim();

  let file = null;
  if (want !== 'prompt') {
    try {
      const res = await fetch(`/api/shared-images/${encodeURIComponent(entry.name)}/file`, {
        headers: USER_HEADER,
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const blob = await res.blob();
      const type = blob.type || entry.type || 'image/png';
      file = new File([blob], `${entry.name}${SHARED_EXT[type] ?? '.png'}`, { type });
    } catch (err) {
      // Not fatal to the whole action — on 'both' the prompt is still worth
      // having, and the toast below will not claim the picture arrived.
      console.warn(`[shared-images] could not fetch ${entry.name}: ${err.message}`);
    }
  }

  closeSharedDetail();
  $$('.main-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === 'prompt'));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-prompt'));

  const attached = file ? adoptImageReference({ file }) : false;

  // Straight replace. The saved prompt is the starting point and the brief is
  // where it gets edited — see the note at the top of this section.
  const field = $('[data-bind="brief"]', $('#builder-mount'));
  const wrote = want !== 'image' && body && field;
  if (wrote) {
    field.value = body;
    // The word counter and the generate button both listen for this; setting
    // .value in script fires nothing on its own.
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Names WHICH of the two texts travelled. With a toggle on screen the
  // difference matters, and "its prompt is in the brief" would be ambiguous
  // in exactly the case somebody chose deliberately.
  const model = currentModel?.name ?? 'this model';
  const which = sharedTakeWhich === 'brief' ? 'brief' : 'final prompt';
  if (attached && wrote) toast(`${entry.name} attached, and its ${which} is in the brief box`);
  else if (attached) toast(`${entry.name} attached as a reference`);
  else if (wrote && want === 'prompt') toast(`The ${which} from ${entry.name} is in the brief box`);
  else if (wrote) toast(`The ${which} is in the brief box — ${model} takes its references on its own panel`);
  else if (want === 'prompt') toast(`No ${which} saved with ${entry.name}`);
  else toast(`Nothing to take from ${entry.name}`);
}

function wireSharedDetail() {
  const modal = $('#shared-modal');
  if (!modal) return;

  $('#shared-modal-close')?.addEventListener('click', closeSharedDetail);
  // Backdrop click and Escape, the same two ways out every other modal here
  // offers. A picture opened full size is the easiest thing in the app to get
  // stuck behind.
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeSharedDetail();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closeSharedDetail();
  });

  const text = $('#shared-detail-text');
  const briefBox = $('#shared-detail-brief');
  const save = $('#shared-detail-save');
  const modelSel = $('#shared-detail-model');

  // Shown the moment either field differs from what is saved. Both are one
  // Save, because they are one entry.
  const dirty = () => {
    const entry = sharedEntries.find((e) => e.name === sharedOpen);
    if (!entry || !save) return;
    if (entry.can_edit === false) return;             // never offer what would bounce
    save.hidden =
      text.value === (entry.text ?? '') &&
      (briefBox?.value ?? '') === (entry.brief ?? '') &&
      (modelSel?.value ?? '') === (entry.model ?? '');
  };
  text?.addEventListener('input', dirty);
  briefBox?.addEventListener('input', dirty);
  modelSel?.addEventListener('change', dirty);

  save?.addEventListener('click', async () => {
    const entry = sharedEntries.find((e) => e.name === sharedOpen);
    if (!entry || !text) return;
    save.disabled = true;
    try {
      const res = await fetch(`/api/shared-images/${encodeURIComponent(entry.name)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...USER_HEADER },
        body: JSON.stringify({
          text: text.value,
          brief: briefBox?.value ?? '',
          model: modelSel?.value || null,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message ?? 'Could not save it.');
      entry.text = body.text ?? '';
      entry.brief = body.brief ?? '';
      entry.model = body.model ?? null;
      save.hidden = true;
      renderSharedGrid();                             // the tile badge follows
      toast(`Saved ${entry.name}`);
    } catch (err) {
      toast(err.message);
    } finally {
      save.disabled = false;
    }
  });

  for (const b of $$('#shared-take-which button')) {
    b.addEventListener('click', () => {
      if (b.disabled) return;
      sharedTakeWhich = b.dataset.which;
      const entry = sharedEntries.find((e) => e.name === sharedOpen);
      if (entry) paintTakeWhich(entry);
    });
  }

  $('#shared-detail-brief-copy')?.addEventListener('click', () => {
    const body = $('#shared-detail-brief')?.value ?? '';
    if (!body.trim()) return toast('No brief saved with this one');
    copyText(body, `${sharedOpen} brief copied`);
  });

  $('#shared-detail-copy')?.addEventListener('click', () => {
    const body = text?.value ?? '';
    if (!body.trim()) return toast('No prompt saved with this one');
    copyText(body, `${sharedOpen} copied`);
  });

  $('#shared-detail-remove')?.addEventListener('click', async () => {
    const name = sharedOpen;
    if (!name) return;
    if (!confirm(`Take ${name} off the pinboard? The picture and its prompt both go.`)) return;
    try {
      const res = await fetch(`/api/shared-images/${encodeURIComponent(name)}`, {
        method: 'DELETE',
        headers: USER_HEADER,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message ?? 'Could not remove it.');
      sharedEntries = sharedEntries.filter((e) => e.name !== name);
      closeSharedDetail();
      renderSharedGrid();
      toast(`${name} removed`);
    } catch (err) {
      toast(err.message);
    }
  });

  $('#shared-negative-copy')?.addEventListener('click', () => {
    const body = $('#shared-negative-text')?.textContent ?? '';
    if (!body.trim()) return;
    copyText(body, 'Negative copied');
  });

  $('#shared-comfy-copy')?.addEventListener('click', () => {
    const entry = sharedEntries.find((e) => e.name === sharedOpen);
    const body = comfyText(entry?.comfy);
    if (!body) return toast('No ComfyUI settings in that one');
    copyText(body, 'Settings copied');
  });

  $('#shared-take-both')?.addEventListener('click', () => useSharedEntry(sharedOpen, 'both'));
  $('#shared-take-image')?.addEventListener('click', () => useSharedEntry(sharedOpen, 'image'));
  $('#shared-take-prompt')?.addEventListener('click', () => useSharedEntry(sharedOpen, 'prompt'));
}

function wireSharedAdd() {
  const nameInput = $('#shared-name');
  const fileInput = $('#shared-file');
  const textInput = $('#shared-text');
  const briefInput = $('#shared-brief');
  const preview = $('#shared-preview');
  const saveBtn = $('#shared-save');
  const resetBtn = $('#shared-reset');
  const status = $('#shared-add-status');
  const hint = $('#shared-name-hint');
  const search = $('#shared-search');
  if (!nameInput || !fileInput || !saveBtn) return;

  const modelSel = $('#shared-model');
  fillSharedModels(modelSel, '');

  let picked = null;
  let previewUrl = null;
  let detected = null;      // the ComfyUI data read off the picked file

  // The negative never goes in the prompt box — this app writes negatives in
  // code (server/negative.mjs) and a negative pasted into a positive prompt
  // is a prompt defect. It is offered to the clipboard instead, for whoever
  // wants it in their ComfyUI graph.
  $('#shared-add-usenegative')?.addEventListener('click', () => {
    if (!detected?.negative) return;
    copyText(detected.negative, 'Negative copied');
  });

  // The fragments of a prompt the file only half holds, for whoever wants
  // them anyway. A button rather than automatic, because what goes in is
  // wildcard syntax and half a prompt — see inspectPicked.
  $('#shared-add-usepartial')?.addEventListener('click', () => {
    if (!detected?.prompt) return;
    textInput.value = detected.prompt;
    toast('Fragments pasted — this workflow builds the rest at run time');
  });

  const paint = () => {
    const slug = sharedSlug(nameInput.value);
    if (hint) {
      hint.textContent = !nameInput.value.trim()
        ? ''
        : slug
          ? `Saved as ${slug}${SHARED_EXT[picked?.type] ?? ''} and ${slug}.txt`
          : 'Letters and numbers, at least one.';
    }
    saveBtn.disabled = !slug || !picked;
  };

  nameInput.addEventListener('input', paint);

  /**
   * Read the picture's ComfyUI data and fill the form in, Civitai-style.
   *
   * Only the front of the file goes up — ComfyUI's text chunks sit before the
   * pixels — so this costs a slice rather than a second upload of a 20MB PNG.
   *
   * **Only ever fills an EMPTY box.** Whatever somebody has typed outranks
   * whatever the file says: the point is to save them pasting, not to
   * overrule them. Same rule the name field already follows.
   */
  async function inspectPicked(file) {
    detected = null;
    renderDetected(null);
    if (!file) return;
    try {
      const head = file.slice(0, 1024 * 1024);
      const image = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('unreadable'));
        // The slice loses the original media type, so it is restated — the
        // server reads the type off the data URI to decide what it is.
        reader.readAsDataURL(new File([head], file.name, { type: file.type }));
      });
      const res = await fetch('/api/shared-images/inspect', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...USER_HEADER },
        body: JSON.stringify({ image }),
      });
      if (!res.ok) return;
      const body = await res.json();
      if (picked !== file) return;              // they picked another one meanwhile
      detected = body.comfy ?? null;
      renderDetected(detected);
      // Filled in only when the file actually HOLDS the prompt.
      //
      // A workflow that assembles its prompt at run time — concatenation
      // nodes, a wildcard processor — stores the pieces and not the result,
      // so what came back is a fragment plus template syntax like
      // `{dark background|neon city}`. Dropping that into the box and calling
      // it the prompt would put braces nothing understands into somebody's
      // brief two clicks later. It is shown instead, with a button.
      if (detected?.prompt && !detected.prompt_partial && !textInput.value.trim()) {
        textInput.value = detected.prompt;
        toast('Prompt read from the file');
      }
    } catch {
      // A file that cannot be read is still perfectly pinnable by hand.
    }
  }

  /** The panel under the preview: what came out of the file, or nothing. */
  function renderDetected(comfy) {
    const host = $('#shared-add-detected');
    const list = $('#shared-add-detected-list');
    const negBtn = $('#shared-add-usenegative');
    if (!host || !list) return;
    if (!comfy) {
      host.hidden = true;
      list.innerHTML = '';
      if (negBtn) negBtn.hidden = true;
      return;
    }
    list.innerHTML = '';
    const row = (label, value, mono = false) => {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = String(value);
      if (mono) dd.classList.add('mono');
      list.append(dt, dd);
    };
    const lead = comfy.samplers?.[0];
    const seen = new Set();
    for (const [key, label] of COMFY_FIELDS) {
      const v = lead?.settings?.[key];
      if (v === undefined || seen.has(label)) continue;
      seen.add(label);
      row(label, v, label === 'Seed');
    }
    for (const c of comfy.checkpoints ?? []) resourceRow(list, 'Checkpoint', c);
    for (const l of comfy.loras ?? []) {
      const strengths = [l.model, l.clip].filter((n) => n !== null).join(' / ');
      resourceRow(list, 'LoRA', l.name, strengths);
    }
    // A prompt the file only half holds. Shown as a row rather than pushed
    // into the box, with a way to take it if you want the fragment.
    const partialBtn = $('#shared-add-usepartial');
    if (comfy.prompt && comfy.prompt_partial) {
      row('Prompt', 'built at run time — only fragments are in the file');
      if (partialBtn) partialBtn.hidden = false;
    } else if (partialBtn) {
      partialBtn.hidden = true;
    }
    if (negBtn) negBtn.hidden = !comfy.negative;
    host.hidden = false;
  }

  /** Shared by the file input and the drop target. */
  function take(file) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    if (preview) preview.hidden = true;
    picked = file ?? null;

    if (picked) {
      const maxMb = sharedLimits.max_image_mb ?? 20;
      const types = sharedLimits.accepted_types ?? [];
      if (types.length && !types.includes(picked.type)) {
        toast(`${picked.type || 'That file'} is not an image this box accepts.`);
        fileInput.value = '';
        picked = null;
      } else if (picked.size > maxMb * 1024 * 1024) {
        // Refused here as well as on the server, so an oversized file is
        // stopped before it goes over the tailnet rather than after.
        toast(`${picked.name} is ${(picked.size / 1048576).toFixed(1)} MB. The limit is ${maxMb} MB.`);
        fileInput.value = '';
        picked = null;
      } else {
        previewUrl = URL.createObjectURL(picked);
        if (preview) {
          preview.src = previewUrl;
          preview.hidden = false;
        }
        // The filename is the obvious name and nobody wants to retype it, so
        // it seeds an empty field and never overwrites one somebody filled.
        if (!nameInput.value.trim()) {
          nameInput.value = picked.name.replace(/\.[^.]+$/, '');
        }
        inspectPicked(picked);
      }
    }
    if (!picked) renderDetected(null);
    paint();
  }

  fileInput.addEventListener('change', () => take(fileInput.files?.[0] ?? null));

  // Drop anywhere on the panel, not just on the input. Civitai's upload is a
  // drop target and this is the same gesture; the file input stays for
  // anybody who would rather click.
  const drop = $('#shared-drop') ?? fileInput.parentElement;
  const panel = $('.shared-add');
  if (panel && drop) {
    let over = 0;
    panel.addEventListener('dragenter', (e) => {
      e.preventDefault();
      over += 1;
      drop.classList.add('dragging');
    });
    panel.addEventListener('dragover', (e) => e.preventDefault());
    panel.addEventListener('dragleave', () => {
      // Counted rather than cleared on the first leave: dragging across a
      // child element fires leave on the parent, and a hint that flickers
      // while the file is still over the panel reads as a rejection.
      over = Math.max(0, over - 1);
      if (!over) drop.classList.remove('dragging');
    });
    panel.addEventListener('drop', (e) => {
      e.preventDefault();
      over = 0;
      drop.classList.remove('dragging');
      const file = e.dataTransfer?.files?.[0];
      if (file) take(file);
    });
  }

  const clear = () => {
    nameInput.value = '';
    textInput.value = '';
    if (briefInput) briefInput.value = '';
    fileInput.value = '';
    if (modelSel) modelSel.value = '';
    picked = null;
    detected = null;
    renderDetected(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    if (preview) preview.hidden = true;
    if (status) status.textContent = '';
    paint();
  };
  resetBtn?.addEventListener('click', clear);

  saveBtn.addEventListener('click', async () => {
    if (!picked) return;
    saveBtn.disabled = true;
    if (status) status.textContent = 'Uploading…';
    try {
      // Read as a data URI rather than downscaled through a canvas the way
      // references are: the library holds the picture somebody actually made,
      // and the folder is meant to be usable as a training dataset directly.
      const image = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Could not read that file.'));
        reader.readAsDataURL(picked);
      });
      const res = await fetch('/api/shared-images', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...USER_HEADER },
        body: JSON.stringify({
          name: nameInput.value,
          text: textInput.value,
          brief: briefInput?.value ?? '',
          model: modelSel?.value || null,
          image,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message ?? 'Could not add it.');
      sharedEntries = [body, ...sharedEntries];
      renderSharedGrid();
      clear();
      // Named, because the server may have renamed it around a collision and
      // finding out later by not seeing your name is worse.
      toast(`Added as ${body.name}`);
    } catch (err) {
      if (status) status.textContent = err.message;
      toast(err.message);
    } finally {
      saveBtn.disabled = false;
      paint();
    }
  });

  search?.addEventListener('input', renderSharedGrid);
  paint();
}

// The sheets are this box's own measurements and never ship (22 Sep 2026), so
// on most installs there are none - and a tab that only ever says "nothing
// here" is noise. Hidden until the list says otherwise.
async function showBenchTabIfSheets() {
  const tab = $('.main-tab[data-tab="bench"]');
  if (!tab) return;
  // The owner always sees it: that is where Run benchmark lives, and a fresh
  // install has no sheets until it is pressed.
  if (IS_OWNER) {
    tab.hidden = false;
    return;
  }
  try {
    const data = await fetch('/api/benchmarks', { headers: USER_HEADER }).then((r) => r.json());
    tab.hidden = !(data.sheets ?? []).length;
  } catch {
    tab.hidden = true;
  }
}

// ── Run benchmark (owner) ────────────────────────────────────
let benchRunPoll = null;
let benchRunWired = false;

function paintBenchRun(info) {
  const box = $('#bench-run');
  box.hidden = false;
  const running = info.state === 'running';
  const list = $('#bench-run-models');

  // The checklist is drawn once and left alone while running, so a poll
  // never unticks what the owner chose.
  if (!list.dataset.drawn && info.available) {
    list.replaceChildren();
    for (const m of info.available) {
      const row = document.createElement('label');
      row.className = 'field';
      row.style.cssText = 'flex-direction:row;align-items:center;gap:8px;margin:2px 0';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = m;
      cb.checked = true;
      const name = document.createElement('span');
      name.textContent = m.replace(/^hf\.co\//, '');
      name.style.cssText = 'font-size:12px;word-break:break-all';
      row.append(cb, name);
      list.append(row);
    }
    list.dataset.drawn = '1';
    if (!info.available.length) list.textContent = 'No models found — check Setup.';
  }
  for (const cb of $$('input', list)) cb.disabled = running;
  $('#bench-run-start').disabled = running;
  $('#bench-run-cancel').hidden = !running;

  const status = $('#bench-run-status');
  if (running) {
    status.textContent = `Running ${info.done + 1} of ${info.total}: ${String(info.current ?? '…').replace(/^hf\.co\//, '')}. You can close this; it keeps going.`;
  } else if (info.state === 'done' || info.state === 'cancelled') {
    status.textContent = info.sheet
      ? `${info.state === 'done' ? 'Finished' : 'Cancelled'} — the result is at the top of the list.`
      : 'Cancelled before any model finished.';
  } else if (info.state === 'failed') {
    status.textContent = `Stopped: ${info.error}`;
  } else {
    status.textContent = '';
  }

  clearTimeout(benchRunPoll);
  if (running) benchRunPoll = setTimeout(refreshBenchRun, 3000);
  // A run just ended: show its sheet.
  if (!running && box.dataset.wasRunning === '1' && info.sheet) {
    benchLoaded = false;
    loadBenchmarks();
  }
  box.dataset.wasRunning = running ? '1' : '';
}

async function refreshBenchRun() {
  try {
    const res = await fetch('/api/admin/benchmark');
    if (res.ok) paintBenchRun(await res.json());
  } catch { /* try again on the next open */ }
}

function wireBenchRun() {
  if (benchRunWired) return;
  benchRunWired = true;
  $('#bench-run-start').addEventListener('click', async () => {
    const models = $$('#bench-run-models input:checked').map((cb) => cb.value);
    const res = await fetch('/api/admin/benchmark/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ models }),
    }).catch(() => null);
    const body = await res?.json().catch(() => ({}));
    if (!res?.ok) {
      $('#bench-run-status').textContent = body?.message || 'Could not start.';
      return;
    }
    paintBenchRun(body);
  });
  $('#bench-run-cancel').addEventListener('click', async () => {
    const res = await fetch('/api/admin/benchmark/cancel', { method: 'POST' }).catch(() => null);
    if (res?.ok) {
      $('#bench-run-status').textContent = 'Cancelling after the current generation…';
    }
  });
}

// ── LoRA training tab (admin test only) ──────────────────────
// Everyone else always sees the static "currently testing" panel in the
// HTML. This never runs for them - it's called from the tab click handler,
// and the admin panel it fills stays hidden without IS_OWNER.
//
// There is deliberately no form here. An earlier pass rebuilt TrainFlow's
// SDXL fields in PromptForge's own markup; the owner's answer was that he
// wants TrainFlow itself in the tab, so the panel is an iframe onto
// /trainflow/ and every field, button and log line is TrainFlow's. That also
// means this stops needing maintenance when the DaSiWa node pack changes its form.
//
// The src is set on first open rather than in the HTML so that the frame is
// never requested by the people who cannot have it - /trainflow/ answers 403
// for everyone but the owner, and an iframe showing a JSON error is a worse
// answer than no iframe.
let loraLoaded = false;

async function loadLoraTab() {
  $('#lora-admin').hidden = !CAN_TRAIN;
  if (!CAN_TRAIN || loraLoaded) return;
  loraLoaded = true;

  // Asked for before the frame is pointed at it, because an iframe reports
  // nothing useful when the document it loads is an error - onload fires just
  // the same, and same-origin or not, a 502 body is not something to render
  // inside the panel. This way the failure is a sentence in PromptForge's
  // voice instead.
  const probe = await fetch('/trainflow/', { method: 'HEAD' }).catch(() => null);
  if (!probe?.ok) {
    const body = probe ? await fetch('/trainflow/').then((r) => r.json()).catch(() => null) : null;
    const err = $('#lora-frame-error');
    err.hidden = false;
    err.textContent = body?.message ?? 'TrainFlow is not answering on this box.';
    $('#lora-frame').hidden = true;
    loraLoaded = false;
    return;
  }
  // Clear a previous failure. Without this the panel stays on the error it
  // showed last time even after TrainFlow comes back, because the retry
  // succeeds and then changes nothing visible - which reads as the retry
  // having failed too.
  $('#lora-frame-error').hidden = true;
  $('#lora-frame').hidden = false;
  $('#lora-frame').src = '/trainflow/';
  wireDatasetUpload();
  paintTrainingLayout();
}

/**
 * The folders to paste into TrainFlow, read from the server rather than
 * written out here a second time - the person picks an output slot, and a
 * path that disagreed with where the server actually writes would be worse
 * than showing nothing.
 */
let trainingLayout = null;

/**
 * Where the picked folder will land, shown BEFORE anything is sent and
 * updated as the name is typed. The name field is the destination - it
 * becomes a folder inside the dataset root - and saying so only after the
 * upload finished meant the one moment it was useful had already passed.
 */
function updateDestination() {
  const el = $('#lora-ds-dest');
  if (!el || !trainingLayout) return;
  const name = $('#lora-ds-name').value.trim();
  if (!name) {
    el.hidden = false;
    el.textContent = 'Name it, or pick a folder and its own name is used.';
    return;
  }
  const bad = !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
  el.hidden = false;
  el.textContent = bad
    ? 'Letters, numbers, dot, dash and underscore only.'
    : `Uploads to: ${trainingLayout.datasets_root}/${name}` +
      (trainingLayout.existing?.includes(name) ? '  (adding to the folder already there)' : '');
}

// Set while a path is being written into TrainFlow. Repainting the slot list
// replaces those buttons wholesale, so a repaint arriving mid-click destroyed
// the button under the pointer and the click went nowhere.
let fillBusy = false;

async function paintTrainingLayout() {
  if (fillBusy) return;
  const box = $('#lora-ds-layout');
  const data = await fetch('/api/admin/training/layout').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!data || fillBusy) return;
  trainingLayout = data;
  await fetch('/api/admin/training/datasets')
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => { if (d) trainingLayout.existing = d.datasets.map((x) => x.name); })
    .catch(() => {});
  updateDestination();
  box.hidden = false;
  const days = data.retention_days;
  const slots = data.slots.map(
    (s) => `<div class="lora-slot-row">` +
           `<button type="button" class="lora-slot" data-path="${s.path}" data-field="output_path">` +
           `<span>${s.name}</span><code>${s.path}</code>` +
           `<em>${s.files ? `${s.files} file${s.files === 1 ? '' : 's'}` : 'empty'}</em>` +
           `<strong>Use</strong></button>` +
           // Only offered where there is something to fetch; an empty slot
           // with a Files button is a dead end.
           (s.files
             ? `<button type="button" class="topbar-btn lora-files" data-slot="${s.name}">Files</button>`
             : '') +
           `<div class="lora-files-list" id="files-${s.name}" hidden></div></div>`
  ).join('');
  box.innerHTML =
    `<div class="lora-slot-head">Uploads go to <code>${data.datasets_root}</code></div>` +
    `<div class="lora-slot-head">Click one to set it as TrainFlow's Output Path:</div>${slots}` +
    (days > 0
      ? `<div class="lora-slot-note">Datasets and output are deleted ${days} days after the last file is written to them.</div>`
      : '') +
    // A build marker, so "did the page actually pick up the fix" is something
    // that can be read off the screen instead of guessed at from behaviour.
    `<div class="lora-slot-note">upload build ${UPLOAD_BUILD}</div>`;
  for (const b of box.querySelectorAll('.lora-slot')) {
    b.addEventListener('click', () => fillTrainflowField(b.dataset.field, b.dataset.path, b));
  }
  for (const b of box.querySelectorAll('.lora-files')) {
    b.addEventListener('click', () => toggleOutputFiles(b.dataset.slot, b));
  }
  markActiveSlots();
  // Reflects TrainFlow's own fields, including changes made inside the frame,
  // so what is highlighted is always what TrainFlow will actually use.
  clearInterval(slotWatch);
  slotWatch = setInterval(markActiveSlots, 2000);
}

let slotWatch = null;

/**
 * What a slot produced, with a download link per file.
 *
 * The LoRA is the point of the whole exercise and it lived only on the box -
 * TrainFlow's own Output button opens a folder on the SERVER, which is no use
 * from a browser on another machine. Sample images land here too, so previews
 * become something that can be looked at rather than something that exists
 * somewhere you cannot reach.
 */
async function toggleOutputFiles(slot, button) {
  const box = document.getElementById(`files-${slot}`);
  if (!box) return;
  if (!box.hidden) {
    box.hidden = true;
    button.textContent = 'Files';
    return;
  }
  button.textContent = 'Loading…';
  const data = await fetch(`/api/admin/training/output?slot=${encodeURIComponent(slot)}`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  button.textContent = 'Hide';
  box.hidden = false;
  if (!data?.files?.length) {
    box.textContent = 'Nothing in this slot yet.';
    return;
  }
  const size = (b) =>
    b >= 1073741824 ? `${(b / 1073741824).toFixed(2)} GB`
    : b >= 1048576 ? `${(b / 1048576).toFixed(0)} MB`
    : `${(b / 1024).toFixed(0)} KB`;
  box.innerHTML = data.files
    .map((f) => {
      const href = `/api/admin/training/download?slot=${encodeURIComponent(slot)}&file=${encodeURIComponent(f.name)}`;
      const img = /\.(png|jpe?g|webp)$/i.test(f.name)
        ? `<a href="${href}" target="_blank" rel="noopener" class="lora-file-view">view</a>`
        : '';
      return `<div class="lora-file"><code>${f.name}</code><em>${size(f.size)}</em>` +
             `${img}<a href="${href}" download>download</a></div>`;
    })
    .join('');
}

/**
 * Highlight the slot TrainFlow is actually pointed at, read from its own
 * field rather than remembered from a click.
 *
 * A momentary "Set" was the wrong shape for this: the output path is a
 * standing choice among five, so the question being asked is "which one am I
 * using", and an acknowledgement that vanishes cannot answer it. Reading the
 * frame also means a path typed inside TrainFlow shows up here correctly.
 */
function markActiveSlots() {
  let out = null;
  let ds = null;
  try {
    const doc = $('#lora-frame')?.contentDocument;
    out = doc?.getElementById('output_path')?.value || null;
    ds = doc?.getElementById('dataset_path')?.value || null;
  } catch {
    return; // frame not ready; leave whatever is shown alone
  }
  for (const b of document.querySelectorAll('.lora-slot')) {
    const want = b.dataset.field === 'dataset_path' ? ds : out;
    const active = Boolean(want) && b.dataset.path === want;
    b.classList.toggle('is-active', active);
    const strong = b.querySelector('strong');
    if (!strong) continue;
    const label = active ? 'In use' : 'Use';
    strong.dataset.label = label;
    // Do not stamp over a confirmation that is still showing; the stored
    // label above is what it will restore to.
    if (!strong.dataset.timer || Date.now() > Number(strong.dataset.until || 0)) strong.textContent = label;
  }
}

/**
 * Put a path into one of TrainFlow's own fields.
 *
 * The frame is same-origin - it is served through our own /trainflow/ proxy,
 * not from TrainFlow's port - so its document is reachable and this can fill
 * the field directly instead of asking someone to retype a long path. Both
 * events are dispatched because TrainFlow saves on either, and a value set
 * from script raises neither on its own.
 *
 * Falls back to the clipboard if the frame is not there yet, so the button is
 * never a dead end.
 */
async function fillTrainflowField(fieldId, value, button) {
  fillBusy = true;
  try {
    await fillTrainflowFieldInner(fieldId, value, button);
  } finally {
    fillBusy = false;
  }
}

async function fillTrainflowFieldInner(fieldId, value, button) {
  // The label is restored from a stored original, not from whatever it says
  // now, and each button owns its timer. Reading the current text meant a
  // second click during the confirmation captured "Set" as the original and
  // the button kept that word for good.
  const say = (text) => {
    if (!button) return;
    const strong = button.querySelector('strong');
    if (!strong) return;
    if (!strong.dataset.label) strong.dataset.label = strong.textContent;
    clearTimeout(Number(strong.dataset.timer || 0));
    strong.textContent = text;
    strong.dataset.until = String(Date.now() + 1600);
    strong.dataset.timer = String(setTimeout(() => {
      strong.textContent = strong.dataset.label;
      strong.dataset.timer = '';
    }, 1600));
  };

  const fieldNow = () => {
    try { return $('#lora-frame')?.contentDocument?.getElementById(fieldId) ?? null; } catch { return null; }
  };

  // The frame may still be loading, or mid-reload, in which case the field
  // does not exist yet and the old code gave up instantly and copied to the
  // clipboard instead - which is why this worked only some of the time.
  let field = fieldNow();
  for (let i = 0; !field && i < 15; i++) {
    await new Promise((r) => setTimeout(r, 200));
    field = fieldNow();
  }

  if (!field) {
    try {
      await navigator.clipboard.writeText(value);
      say('Copied');
    } catch {
      say('Select it');
    }
    return;
  }

  // Read, change one key, write back - through TrainFlow's own settings API.
  //
  // The obvious approach, setting .value and dispatching 'input', is what the
  // first version did, and it is destructive: that event triggers TrainFlow's
  // queueSave(), which serialises EVERY field straight from the DOM. Click it
  // before the frame has finished loading its settings and the form is still
  // blank, so the save writes an empty settings file over the real one. That
  // happened - it erased a dataset path, an output path and a precision
  // setting in one click. Setting one field must not be able to lose the
  // others, so the whole object is round-tripped instead.
  let saved = false;
  try {
    const cur = await fetch('/trainflow/api/settings').then((r) => (r.ok ? r.json() : null));
    if (cur && typeof cur === 'object') {
      cur[fieldId] = value;
      const res = await fetch('/trainflow/api/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cur),
      });
      saved = res.ok;
    }
  } catch {
    saved = false;
  }

  // The visible field is updated too, so the frame shows what was saved - but
  // WITHOUT dispatching anything, because a save has already happened and a
  // second one from a half-loaded form is the bug above.
  const f = fieldNow();
  if (f) {
    f.value = value;
    f.scrollIntoView({ block: 'center' });
  }
  say(saved ? 'Set' : 'Retry');
  markActiveSlots();
}

// ── Tab 2 dataset upload ─────────────────────────────────────────────
// One request per file, raw bytes, a few at a time. Not one giant multipart
// POST: a training set is thousands of files and several gigabytes, and a
// single request that size is one dropped connection away from having to
// start over - which is exactly what went wrong pushing a checkpoint over
// ssh. Per-file requests make the work resumable, because the server can be
// asked what it already has.
let datasetWired = false;

const DATASET_OK = /\.(png|jpe?g|webp|bmp|txt|caption)$/i;

// Bumped whenever the upload path changes, and shown in the panel. Browser
// caching made "is the fix live for you" unanswerable from behaviour alone.
const UPLOAD_BUILD = '0924-01';

function setDatasetStatus(text) {
  $('#lora-ds-status').textContent = text;
}

async function uploadDataset(fileList) {
  // The name defaults to the picked folder's own name. Requiring it to be
  // typed first meant picking a folder and being refused by a one-line
  // message, which reads as the upload silently not working - the exact
  // doubt this panel exists to remove.
  let name = $('#lora-ds-name').value.trim();
  if (!name) {
    const first = fileList[0]?.webkitRelativePath?.split('/')[0] ?? '';
    name = first.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 64);
    if (name) $('#lora-ds-name').value = name;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    setDatasetStatus('Type a dataset name first (letters, numbers, dot, dash, underscore), then pick the files.');
    return;
  }

  // A picked folder carries everything in it, including whatever else lives
  // there. Only images and captions are sent.
  // The path each file keeps inside the dataset. webkitRelativePath is set
  // when a folder was picked, and its first segment is the folder's own name,
  // which is dropped - the dataset name replaces it. Sub-folders below that
  // are preserved, because a training folder can hold both `2.txt` and
  // `input/2.txt` and flattening silently overwrites one with the other.
  const relOf = (f) => {
    const rp = f.webkitRelativePath;
    if (!rp) return f.name;
    const segs = rp.split('/');
    return segs.length > 1 ? segs.slice(1).join('/') : f.name;
  };

  const files = Array.from(fileList).filter((f) => DATASET_OK.test(f.name));
  const skipped = fileList.length - files.length;
  if (!files.length) {
    setDatasetStatus('Nothing to upload - no images or caption files in that selection.');
    return;
  }

  // Ask what is already there, so a re-run after a drop or a closed tab only
  // sends what is missing. Size is compared as well as name: a file cut off
  // by a killed upload has the right name and the wrong length, and trusting
  // the name alone would leave it broken forever.
  // The bar appears the moment a folder is picked, not when the first byte
  // moves. Reading a 2,000-file folder and asking the server what it already
  // has both take a moment, and silence during them reads as nothing working.
  $('#lora-ds-bar').hidden = false;
  $('#lora-ds-fill').style.width = '0%';
  setDatasetStatus(`Found ${files.length} files. Checking what is already uploaded…`);
  const existing = await fetch(`/api/admin/training/dataset?name=${encodeURIComponent(name)}`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  const have = existing?.files ?? {};
  const todo = files.filter((f) => have[relOf(f)] !== f.size);
  const already = files.length - todo.length;

  if (!todo.length) {
    setDatasetStatus(`All ${files.length} files are already uploaded.`);
    showDatasetPath(existing?.path);
    return;
  }

  const bar = $('#lora-ds-bar');
  const fill = $('#lora-ds-fill');
  bar.hidden = false;
  let done = 0;
  let failed = 0;
  let firstError = '';
  const total = todo.length;

  // Progress is measured in BYTES, not files. A file count jumps in sixes and
  // sits still in between, which on a slow link is indistinguishable from
  // nothing happening - which is exactly the doubt this is here to remove.
  const totalBytes = todo.reduce((n, f) => n + f.size, 0);
  let sentBytes = 0;
  const inFlight = new Map();
  const started = Date.now();

  const fmt = (b) =>
    b >= 1073741824 ? `${(b / 1073741824).toFixed(2)} GB`
    : b >= 1048576 ? `${(b / 1048576).toFixed(0)} MB`
    : `${(b / 1024).toFixed(0)} KB`;

  function paint() {
    const live = sentBytes + [...inFlight.values()].reduce((a, b) => a + b, 0);
    const pct = totalBytes ? Math.min(100, (live / totalBytes) * 100) : 0;
    fill.style.width = `${pct.toFixed(1)}%`;
    const secs = (Date.now() - started) / 1000;
    const rate = secs > 0.5 ? live / secs : 0;
    const left = rate > 0 ? (totalBytes - live) / rate : 0;
    const eta =
      !rate ? '' :
      left > 90 ? ` · ~${Math.ceil(left / 60)} min left` :
      ` · ~${Math.max(1, Math.round(left))}s left`;
    setDatasetStatus(
      `${pct.toFixed(1)}% · ${fmt(live)} of ${fmt(totalBytes)} · ${done}/${total} files` +
      (rate ? ` · ${(rate / 1048576).toFixed(1)} MB/s` : '') + eta +
      (failed ? ` · ${failed} failed` : '')
    );
  }
  paint();
  const ticker = setInterval(paint, 250);

  // XMLHttpRequest rather than fetch: only XHR reports bytes as they leave the
  // browser (upload.onprogress). fetch resolves when a file is done and says
  // nothing in between, so a single large file looks frozen.
  function put(file) {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open(
        'PUT',
        `/api/admin/training/dataset?name=${encodeURIComponent(name)}&file=${encodeURIComponent(relOf(file))}`
      );
      xhr.upload.addEventListener('progress', (e) => inFlight.set(file, e.loaded));
      const finish = (ok, why) => {
        inFlight.delete(file);
        if (ok) sentBytes += file.size;
        else if (!firstError) firstError = why;
        if (!ok) failed += 1;
        done += 1;
        resolve();
      };
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) return finish(true);
        // A 404 here means the running server predates these routes, which is
        // a restart away from working and worth saying rather than counting.
        if (xhr.status === 404) return finish(false, 'The server has not been restarted since this was added.');
        let msg = `HTTP ${xhr.status}`;
        try { msg = JSON.parse(xhr.responseText).message || msg; } catch { /* not json */ }
        finish(false, msg);
      });
      xhr.addEventListener('error', () => finish(false, 'The connection dropped.'));
      xhr.addEventListener('abort', () => finish(false, 'Cancelled.'));
      xhr.send(file);
    });
  }

  // Six at a time. Enough to keep the link busy, few enough that a stalled
  // request does not hold up everything behind it.
  const queue = todo.slice();
  async function worker() {
    for (;;) {
      const file = queue.shift();
      if (!file) return;
      await put(file);
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  clearInterval(ticker);
  fill.style.width = '100%';

  const parts = [`${total - failed} of ${total} uploaded`];
  if (firstError) parts.push(firstError);
  if (already) parts.push(`${already} already there`);
  if (skipped) parts.push(`${skipped} skipped (not an image or caption)`);
  if (failed) parts.push(`${failed} failed - pick the same folder again to retry just those`);
  setDatasetStatus(parts.join(', ') + '.');

  const after = await fetch(`/api/admin/training/dataset?name=${encodeURIComponent(name)}`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  showDatasetPath(after?.path);
}

function showDatasetPath(p) {
  if (!p) return;
  const el = $('#lora-ds-path');
  el.hidden = false;
  el.innerHTML =
    `<button type="button" class="lora-slot" data-field="dataset_path" data-path="${p}">` +
    `<span>Dataset Path</span><code>${p}</code><strong>Use</strong></button>`;
  const b = el.querySelector('.lora-slot');
  b.addEventListener('click', () => fillTrainflowField('dataset_path', p, b));
  // The slot list shows file counts, and one of them may have just changed.
  paintTrainingLayout();
}

function wireDatasetUpload() {
  if (datasetWired) return;
  datasetWired = true;
  $('#lora-ds-pick').addEventListener('click', () => $('#lora-ds-dir').click());
  $('#lora-ds-pickfiles').addEventListener('click', () => $('#lora-ds-files').click());
  $('#lora-ds-name').addEventListener('input', updateDestination);
  for (const id of ['#lora-ds-dir', '#lora-ds-files']) {
    $(id).addEventListener('change', (e) => {
      if (e.target.files?.length) stageDataset(e.target.files);
      // Cleared so picking the same folder again re-fires change, which is
      // how a retry of the failed files is started.
      e.target.value = '';
    });
  }
  $('#lora-ds-go').addEventListener('click', () => {
    const files = pendingFiles;
    // Every early return here used to be silent, which is indistinguishable
    // from a dead button. Say which one happened.
    if (!files || !files.length) {
      setDatasetStatus('The picked files were lost - choose the folder again.');
      showStaged(false);
      return;
    }
    showStaged(false);
    setDatasetStatus(`Starting upload of ${files.length} files…`);
    uploadDataset(files).catch((err) => {
      console.error('[upload]', err);
      setDatasetStatus(`Upload failed to start: ${err?.message ?? err}`);
    });
  });
  $('#lora-ds-cancel').addEventListener('click', () => {
    pendingFiles = null;
    showStaged(false);
    setDatasetStatus('');
  });
}

// Files picked but not yet sent. Held so the destination can be read and
// changed first - see stageDataset.
let pendingFiles = null;

function showStaged(on) {
  $('#lora-ds-go').hidden = !on;
  $('#lora-ds-cancel').hidden = !on;
}

/**
 * A pick does not upload. It works out the destination, shows it, and waits.
 * Uploading straight from the file dialog gave no opportunity to see where
 * the folder was going, let alone send it somewhere else.
 */
function stageDataset(fileList) {
  const usable = Array.from(fileList).filter((f) => DATASET_OK.test(f.name));
  if (!usable.length) {
    setDatasetStatus('Nothing to upload - no images or caption files in that selection.');
    showStaged(false);
    return;
  }
  // A materialised array, NOT the input's FileList. That object is live: the
  // `input.value = ''` in the change handler - there so re-picking the same
  // folder fires change again - empties it, and a staged reference to it went
  // from 34 files to zero before Upload was ever pressed. No request, no
  // error, nothing on screen.
  pendingFiles = Array.from(fileList);

  // The folder's own name is only a default. It is put in the box so it can
  // be edited before anything is sent.
  if (!$('#lora-ds-name').value.trim()) {
    const first = usable[0]?.webkitRelativePath?.split('/')[0] ?? '';
    const derived = first.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 64);
    if (derived) $('#lora-ds-name').value = derived;
  }

  const bytes = usable.reduce((n, f) => n + f.size, 0);
  const mb = bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(2)} GB` : `${(bytes / 1048576).toFixed(0)} MB`;
  const skipped = fileList.length - usable.length;
  setDatasetStatus(`${usable.length} files (${mb}) ready${skipped ? `, ${skipped} skipped` : ''}. Check the name, then press Upload.`);
  updateDestination();
  showStaged(true);
}

async function loadBenchmarks() {
  if (IS_OWNER) {
    wireBenchRun();
    refreshBenchRun();
  }
  if (benchLoaded) return;
  benchLoaded = true;

  const index = $('#bench-index');
  const empty = $('#bench-empty');
  const frame = $('#bench-frame');
  if (!index || !frame) return;

  try {
    const data = await fetch('/api/benchmarks', { headers: USER_HEADER }).then((r) => r.json());
    benchSheets = data.sheets ?? [];
  } catch {
    benchSheets = [];
  }

  if (!benchSheets.length) {
    // The sheets live in docs/ and travel with the repo, so an empty list
    // means a checkout without them rather than a failure worth alarming
    // about. Say which state it is.
    if (empty) empty.hidden = false;
    frame.hidden = true;
    return;
  }
  if (empty) empty.hidden = true;

  const show = (sheet) => {
    for (const el of $$('.bench-item', index)) {
      el.classList.toggle('active', el.dataset.id === sheet.id);
    }
    $('#bench-title').textContent = `${sheet.title} · ${sheet.date}`;
    const open = $('#bench-open');
    if (open) {
      open.href = `/api/benchmarks/${sheet.id}`;
      open.hidden = false;
    }
    frame.hidden = false;
    frame.src = `/api/benchmarks/${sheet.id}`;
  };

  index.innerHTML = '';
  for (const sheet of benchSheets) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'bench-item';
    item.dataset.id = sheet.id;
    const title = document.createElement('span');
    title.className = 'bench-item-title';
    title.textContent = sheet.title;
    const date = document.createElement('span');
    date.className = 'bench-item-date';
    date.textContent = sheet.date;
    const summary = document.createElement('span');
    summary.className = 'bench-item-summary';
    summary.textContent = sheet.summary;
    item.append(title, date, summary);
    item.addEventListener('click', () => show(sheet));
    index.appendChild(item);
  }

  // Repainted on every load, because the frame gets a fresh document each
  // time and inline properties do not survive a navigation.
  frame.addEventListener('load', paintBenchmarkFrame);
  show(benchSheets[0]);
}

async function init() {
  REGISTRY = await fetch('/api/models').then((r) => r.json());

  $('#model-select').addEventListener('change', (e) => selectModel(e.target.value));

  wireCaptionView();

  for (const btn of $$('#type-toggle button')) {
    btn.addEventListener('click', async () => {
      $$('#type-toggle button').forEach((b) => b.classList.toggle('active', b === btn));
      currentType = btn.dataset.type;
      const first = rebuildModelSelect();
      await selectModel(first);
    });
  }



  for (const tab of $$('.main-tab')) {
    tab.addEventListener('click', () => {
      // Loaded on first open rather than at boot: four sheets is four fetches
      // and 50 KB nobody who never opens this tab should pay for.
      if (tab.dataset.tab === 'bench') loadBenchmarks();
      // Same reasoning, and one more: the pinboard is shared, so what somebody
      // else put up since this tab was last opened matters. Re-fetched on every
      // open rather than cached like the sheets, which are files in the repo.
      if (tab.dataset.tab === 'shared') loadSharedImages({ force: true });
      if (tab.dataset.tab === 'lora') openLoraTab();
      $$('.main-tab').forEach((t) => t.classList.toggle('active', t === tab));
      $$('.tab-panel').forEach((p) =>
        p.classList.toggle('active', p.id === `panel-${tab.dataset.tab}`)
      );
    });
  }

  $('#btn-copy-all').addEventListener('click', () => {
    if (!lastResult) return;
    // What is on screen, so in Simple this is the one assembled prompt.
    const shown = shownSegments(lastResult, currentModel, promptStyle);
    const kept = promptSegments(shown, currentModel);
    copyText(
      kept.map((s) => s.body).join('\n\n'),
      shown !== lastResult.segments
        ? 'Simple prompt copied'
        : `Prompt copied — ${kept.length} of ${lastResult.segments.length} segments`
    );
  });

  $('#btn-download').addEventListener('click', () => {
    if (!lastResult) return;
    const text = lastResult.segments.map((s) => `${s.label}\n${s.body}`).join('\n\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${currentModel.key}-prompt.txt`;
    a.click();
    URL.revokeObjectURL(url);
  });

  $('#btn-clear').addEventListener('click', () => {
    history = [];
    clearOutput(`No prompt yet for ${currentModel.label}`);
  });

  // The read-back panel's own two controls. Wired here with the rest of the
  // static chrome rather than per card, because the panel is one shared
  // surface however many references there are.
  $('#btn-refanalysis-close')?.addEventListener('click', closeReadback);
  $('#btn-refanalysis-again')?.addEventListener('click', () => {
    if (REFANALYSIS.open) analyzeReference(REFANALYSIS.open);
  });

  $('#btn-save').addEventListener('click', async () => {
    if (!lastResult) return;
    const brief = $('[data-bind="brief"]')?.value ?? '';
    const suggested = brief.trim().slice(0, 60);
    const title = prompt('Save as:', suggested);
    if (title === null) return;   // cancelled
    const r = await fetch('/api/library', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...USER_HEADER },
      body: JSON.stringify({
        title,
        model: currentModel.key,
        brief,
        segments: lastResult.segments,
      }),
    });
    const body = await r.json().catch(() => ({}));
    toast(r.ok ? 'Saved to library' : body.message ?? 'Save failed');
    if (r.ok) refreshLibrary();
  });

  $('#btn-library-refresh').addEventListener('click', refreshLibrary);

  // ── system prompts ──
  $('#btn-sysprompt-new')?.addEventListener('click', () => openSysPrompt(null, true));
  // Manage opens the same modal on nothing, which is where the group's list
  // lives — one surface for writing and for reading everyone else's.
  $('#btn-sysprompt-manage')?.addEventListener('click', () => openSysPrompt(null, true));

  // ── dropping a .txt or .md in ──
  //
  // A prompt file usually already exists as a file. Reading it in the browser
  // rather than uploading it: nothing about this needs to reach the server
  // until Save, and a file endpoint would be a second way in for no gain.
  const drop = $('#sysprompt-drop');
  const hint = $('#sysprompt-drop-hint');
  const readIntoBox = async (file) => {
    if (!file) return;
    const ok = /\.(txt|md|markdown)$/i.test(file.name) || /^text\//.test(file.type);
    if (!ok) return toast('Drop a .txt or .md file');
    // A prompt file is text; a 40k cap server-side, so anything wildly larger
    // is a mistake worth naming before it is pasted into the box.
    if (file.size > 200000) return toast('That file is far larger than a prompt file — check it first');
    $('#sysprompt-body').value = await file.text();
    if (!$('#sysprompt-title').value) {
      $('#sysprompt-title').value = file.name.replace(/\.(txt|md|markdown)$/i, '');
    }
    paintSysPromptCount();
    toast(`Loaded ${file.name}`);
  };
  if (drop) {
    for (const ev of ['dragenter', 'dragover']) {
      drop.addEventListener(ev, (e) => {
        e.preventDefault();
        drop.classList.add('dragging');
        if (hint) hint.classList.add('show');
      });
    }
    for (const ev of ['dragleave', 'drop']) {
      drop.addEventListener(ev, (e) => {
        e.preventDefault();
        drop.classList.remove('dragging');
        if (hint) hint.classList.remove('show');
      });
    }
    drop.addEventListener('drop', (e) => readIntoBox(e.dataTransfer?.files?.[0]));
  }
  $('#sysprompt-file-pick')?.addEventListener('click', () => $('#sysprompt-file').click());
  $('#sysprompt-file')?.addEventListener('change', (e) => {
    readIntoBox(e.target.files?.[0]);
    e.target.value = '';
  });
  $('#sysprompt-close')?.addEventListener('click', () => { $('#sysprompt-modal').hidden = true; });
  $('#sysprompt-body')?.addEventListener('input', paintSysPromptCount);

  // Switching one on is a preference, saved immediately: the alternative is a
  // Save button on a panel that has one control, and a control that looks
  // applied but is not is the failure this whole file avoids elsewhere.
  $('#sysprompt-active')?.addEventListener('change', async (e) => {
    const next = { ...(PREFS?.system_prompts ?? {}) };
    // Picking the group default stores nothing, so a later change of default
    // reaches this person too; Base is stored as "base" because it is now a
    // deliberate choice rather than the absence of one.
    if (e.target.value && e.target.value !== SYSPROMPT_DEFAULT_ID) next[currentModel.key] = e.target.value;
    else delete next[currentModel.key];
    const r = await rawFetch('/api/account', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ preferences: { system_prompts: next } }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) {
      PREFS = data.preferences ?? PREFS;
      toast(
        e.target.value === 'base' ? 'Back to the shipped prompt'
          : e.target.value === SYSPROMPT_DEFAULT_ID ? 'Following the group default'
            : 'Your pick is on for this model'
      );
      refreshSystemPrompts();
    } else {
      toast(data.message ?? 'Could not switch it');
    }
    refreshSystemPrompts();
  });

  $('#sysprompt-load-shipped')?.addEventListener('click', async () => {
    // The first ticked model, or the tab you are on. A block for several
    // models has to start from one of them, and the one being looked at is
    // the least surprising choice.
    const key =
      $('#sysprompt-models').querySelector('input:checked')?.value ?? currentModel?.key;
    const r = await fetch(`/api/system-prompts?shipped=${encodeURIComponent(key)}`, { headers: USER_HEADER });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return toast(data.message ?? 'Could not read the shipped prompt');
    $('#sysprompt-body').value = data.body ?? '';
    paintSysPromptCount();
  });

  $('#sysprompt-save')?.addEventListener('click', async () => {
    const out = $('#sysprompt-message');
    const r = await fetch('/api/system-prompts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...USER_HEADER },
      body: JSON.stringify({
        id: editingBlockId ?? undefined,
        title: $('#sysprompt-title').value,
        models: [...$('#sysprompt-models').querySelectorAll('input:checked')].map((b) => b.value),
        body: $('#sysprompt-body').value,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      out.hidden = false;
      out.textContent = data.message ?? `Something went wrong (${r.status}).`;
      return;
    }
    $('#sysprompt-modal').hidden = true;
    toast(editingBlockId ? 'Saved' : 'Written — switch it on above to use it');
    refreshSystemPrompts();
  });
  $('#btn-session-clear').addEventListener('click', () => {
    clearSessionHistory();
    toast('Session history cleared');
  });
  renderSessionHistory();
  wireRender();
  wireEdit();
  wireLlmNotes();
  // Wired at boot; the grid they feed is fetched on first open of the tab.
  // Wiring on demand would make the listeners depend on having visited the
  // tab, which is the kind of ordering bug that only shows up for whoever
  // opens the app straight onto a different one.
  wireSharedAdd();
  wireSharedDetail();

  // Refine edits the draft on screen. It used to append the request to the
  // brief and regenerate, so the model never saw what it had written and
  // "change shot 4" came back as a whole new prompt (a user, 12 Oct 2026).
  // Now it is the second pass with the person's request as the instruction.
  $('#btn-refine').addEventListener('click', () => {
    const instruction = $('#refine-input').value.trim();
    if (!instruction) return toast('Say what to change');
    reviseDraft(instruction).then((ok) => {
      if (ok) $('#refine-input').value = '';
    });
  });
  $('#refine-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !$('#btn-refine').disabled) $('#btn-refine').click();
  });

  // The second pass: the draft handed back with the brief, and an edit asked
  // for. With an instruction it is Refine - one named change, the rest kept.
  // Resolves true when the output was replaced.
  async function reviseDraft(instruction = null, { continueStory = false } = {}) {
    if (!lastResult?.segments?.length || !currentModel) return false;
    const label = continueStory ? 'Continuing the story' : instruction ? 'The refine' : 'The second pass';
    const mount = $('#output-mount');
    for (const id of ['#btn-second-pass', '#btn-refine', '#btn-continue']) $(id).disabled = true;
    const abort = new AbortController();
    const note = createGenProgress(currentModel, () => abort.abort());
    mount.appendChild(note.el);
    note.say(continueStory ? 'Writing the next part…' : instruction ? 'Making that change…' : 'Re-reading and revising…');
    try {
      const res = await fetch('/api/revise', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: abort.signal,
        body: JSON.stringify({
          model: currentModel.key,
          brief: $('[data-bind="brief"]', $('#builder-mount'))?.value ?? '',
          controls: {
            ...collectControls(),
            // The reading THIS draft was written from, so the second pass
            // gets the reference as text and the pictures stay off the wire.
            // Off lastResult and not off the live variable, for the same
            // reason `segments` is: the person may have undone back to an
            // older draft, and that draft's reading is the one to judge it
            // against. See a user's workflow — a revision pass that has lost
            // the visual evidence is the pass that replaces a described pose
            // with "the pose in the reference".
            ...(lastResult.referenceRead
              ? { reference_analysis: lastResult.referenceRead, reference_analysis_identity: lastResult.referenceIdentity ?? '' }
              : {}),
          },
          // What is ON SCREEN, which is what the person is judging - they may
          // have loaded this from session history or undone back to it.
          segments: lastResult.segments,
          ...(instruction ? { instruction } : {}),
          ...(continueStory ? { continue: true } : {}),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
        note.remove();
        toast(err.message ?? `${label} failed.`);
        return false;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let done = null;
      let failed = null;
      const warnings = [];
      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        buf += dec.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';
        for (const frame of frames) {
          const ev = frame.match(/^event: (.+)\ndata: ([\s\S]+)$/m);
          if (!ev) continue;
          if (ev[1] === 'done') done = JSON.parse(ev[2]);
          else if (ev[1] === 'error') failed = JSON.parse(ev[2]);
          else if (ev[1] === 'warning') warnings.push(JSON.parse(ev[2]).message);
        }
      }
      const took = note.elapsed();
      note.remove();
      if (failed) {
        flagTab('error');
        toast(failed.message ?? `${label} failed.`);
        return false;
      }
      flagTab('done');
      if (!done?.segments?.length) {
        toast(`${label} returned nothing. Your prompt is unchanged.`);
        return false;
      }
      const next = {
        segments: done.segments,
        model: currentModel.key,
        ms: took,
        // Only the reading the server verified against the CURRENT pictures.
        // Empty clears one it refused, so a later revision cannot bring a
        // removed picture's reading back.
        referenceRead: done.reference_analysis ?? '',
        referenceIdentity: done.reference_analysis_identity ?? '',
        simple: done.simple_prompt ?? null,
      };
      if (continueStory) {
        // A new part, not a replacement: the old part stays one arrow away.
        // Undo belongs to a part, so it starts empty on the new one.
        story ??= { parts: [lastResult], at: 0 };
        next.sessionId = recordSessionPrompt({
          model: currentModel.key,
          brief: `${$('[data-bind="brief"]', $('#builder-mount'))?.value ?? ''} (part ${story.parts.length + 1})`,
          segments: next.segments,
          simple: next.simple,
        });
        story.parts.push(next);
        story.at = story.parts.length - 1;
        history = [];
        lastResult = next;
        showResult(next);
        $('#refine-input').value = '';
        toast(warnings[0] ?? `Part ${story.parts.length} written`);
        return true;
      }
      // Undoable, like every other thing that replaces the output. A second
      // pass is a whole extra generation, so it gets its own time rather than
      // the first pass's.
      history.push(lastResult);
      lastResult = next;
      showResult(next);
      toast(
        done.changed
          ? `${instruction ? 'Changed' : 'Revised'} ${done.changed} segment${done.changed === 1 ? '' : 's'}`
          : 'The model read it back and left it as it was'
      );
      return true;
    } catch (err) {
      note.remove();
      toast(`${label} failed (${err.message}). Your prompt is unchanged.`);
      return false;
    } finally {
      updateActionButtons();
    }
  }
  $('#btn-second-pass').addEventListener('click', () => reviseDraft());
  // Continue story: the next part, from the part on screen. Whatever is typed
  // in the refine box is what happens next; empty lets the model carry on.
  $('#btn-continue').addEventListener('click', () =>
    reviseDraft($('#refine-input').value.trim() || null, { continueStory: true }));
  const showPart = (at) => {
    if (!story || at < 0 || at >= story.parts.length) return;
    story.at = at;
    lastResult = story.parts[at];
    history = [];
    clearRenderResult();
    showResult(lastResult);
    updateActionButtons();
  };
  $('#btn-part-prev').addEventListener('click', () => story && showPart(story.at - 1));
  $('#btn-part-next').addEventListener('click', () => story && showPart(story.at + 1));

  $('#btn-undo').addEventListener('click', () => {
    const prev = history.pop();
    if (!prev) return;
    lastResult = prev;
    const mount = $('#output-mount');
    mount.innerHTML = '';
    for (const seg of shownSegments(prev, currentModel, promptStyle)) {
      mount.appendChild(segmentEl(currentModel, seg));
    }
    // The reading that produced this draft comes back with it. A panel that
    // showed the wrong run's reading would be worse than showing none.
    if (prev.referenceRead) mount.prepend(referenceReadEl(prev.referenceRead));
    // Undefined on anything restored from session history, which was recorded
    // before this existed and carries no time. stampElapsed leaves the header
    // alone rather than printing "NaNs".
    stampElapsed(mount, prev.ms);
    updateActionButtons();
    toast('Reverted');
  });

  // Active users. The handle is always there; the panel opens over the app
  // rather than resizing it, so nothing reflows when it appears.
  $('#people-tab')?.addEventListener('click', () => togglePeople());
  $('#people-close')?.addEventListener('click', () => togglePeople(false));
  // Escape closes it, like the modals. Not a backdrop click — there is no
  // backdrop, and the panel is meant to be readable while you keep working.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#people-panel')?.hidden) togglePeople(false);
  });

  $('#btn-warmup').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Warming…';
    try {
      // The model on screen, so the server can resolve the same LLM the next
      // generate will use rather than the deployment default.
      const res = await fetch('/api/warmup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: currentModel?.key ?? null }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) {
        toast(body.detail ? `Warm up failed — ${body.detail}` : 'Warm up failed');
      } else if (body.warmed) {
        toast(`Model ready in ${body.seconds}s`);
      } else {
        // llama.cpp and vLLM load at server start, and mock loads nothing.
        toast(body.detail ?? 'Nothing to warm up');
      }
    } catch (err) {
      toast(`Warm up failed — ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
      refreshStatus();
    }
  });

  $('#btn-reload-prompts').addEventListener('click', async () => {
    const res = await fetch('/api/prompts/reload', {
      method: 'POST',
      headers: { 'x-promptforge-user': 'owner' },
    });
    const body = await res.json().catch(() => ({}));
    toast(res.ok ? `Reloaded ${body.count} prompts` : body.message ?? 'Reload refused');
  });

  // Before the first paint: rebuildModelSelect() reads PREFS, so loading it
  // afterwards would mean the saved default only applied on the second render.
  await loadAccount();

  // The saved default carries its own group. Opening on a video model means
  // opening on the Video tab, or the preference could only ever apply to
  // image models — currentType starts at 'image'.
  const preferred = REGISTRY.models.find((m) => m.key === PREFS?.default_model);
  if (preferred) currentType = preferred.type;
  $$('#type-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.type === currentType));

  const first = rebuildModelSelect();
  await selectModel(first);

  // Tab 3 is independent of the model registry, and a tagger backend that is
  // missing must not stop Tab 1 loading — so its failure is swallowed here
  // and reported inside its own tab.
  initAnalysis().catch((err) => console.error('image analysis failed to init', err));

  // Same treatment for the same reason: chat is a whole tab, and a failure
  // in it must not stop Tab 1 from loading.
  initPromptLlm();
  initOffload();
  initKeepAlive();

  try {
    initChat();
  } catch (err) {
    console.error('chat failed to init', err);
  }

  refreshLibrary();
  refreshStatus();
  setInterval(refreshStatus, 10000);
  setInterval(refreshPermissions, 10000);
  // Live enough to watch a generation land on the card.
  refreshSystem();
  setInterval(refreshSystem, SYS_POLL_MS);
  // The countdown between polls. Cheap — it reads one number and writes one
  // string — and it is what makes the topbar timer move rather than lurch
  // ten seconds at a time.
  setInterval(paintOffload, 1000);

  maybeOfferTour();
}

boot().catch((err) => {
  document.body.insertAdjacentHTML(
    'afterbegin',
    `<div class="error-box" style="margin:24px">Frontend failed to start: ${err.message}</div>`
  );
});
