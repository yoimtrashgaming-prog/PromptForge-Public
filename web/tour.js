// The guided tour: dims the page, rings one control, and puts a speech bubble
// beside it saying what it does. Back, Next and Skip; Escape and the arrow
// keys work too. The stops are in tour-steps.js.
//
// Nothing here knows about the app beyond the selectors in that file. A stop
// whose target is not on screen is skipped when it is reached rather than
// filtered out up front, so a control that appears or disappears while the
// tour is running is handled the same way as one that was never there.

import { TOUR_STEPS } from './tour-steps.js';

let active = null;

function visible(el) {
  if (!el || el.closest('[hidden]')) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function find(step) {
  const el = document.querySelector(step.target);
  return visible(el) ? el : null;
}

/** Start the tour. `onEnd` runs once, however it ends. */
export function startTour({ onEnd } = {}) {
  if (active) return;
  // The stops are on the first tab, and the tab buttons are visible from
  // everywhere, so start there.
  document.querySelector('.main-tab[data-tab="prompt"]')?.click();

  const ring = document.createElement('div');
  ring.className = 'tour-ring';
  const bubble = document.createElement('div');
  bubble.className = 'tour-bubble';
  bubble.setAttribute('role', 'dialog');
  bubble.setAttribute('aria-live', 'polite');
  bubble.innerHTML = `
    <div class="tour-count"></div>
    <div class="tour-title"></div>
    <p class="tour-text"></p>
    <div class="tour-actions">
      <button class="ghost tour-skip" type="button">Skip tour</button>
      <span class="tour-spacer"></span>
      <button class="ghost tour-back" type="button">Back</button>
      <button class="primary tour-next" type="button">Next</button>
    </div>`;
  // A click-catcher under the ring, so the page cannot be used mid-tour and
  // a stray click does not land on whatever is highlighted.
  const shield = document.createElement('div');
  shield.className = 'tour-shield';
  // The dimmed page: four panels round the ring (above, below, left, right).
  // Plain boxes rather than a clip-path cut-out or a huge shadow, neither of
  // which painted in the in-app browser it was tested in.
  const dim = document.createElement('div');
  dim.className = 'tour-dim';
  for (let i = 0; i < 4; i++) dim.append(document.createElement('div'));
  document.body.append(shield, dim, ring, bubble);

  active = { at: -1, ring, bubble, shield, dim, onEnd, el: null };

  bubble.querySelector('.tour-skip').addEventListener('click', endTour);
  bubble.querySelector('.tour-back').addEventListener('click', () => go(-1));
  bubble.querySelector('.tour-next').addEventListener('click', () => go(1));
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, true);
  window.visualViewport?.addEventListener('resize', place);
  window.visualViewport?.addEventListener('scroll', place);

  go(1);
}

function onKey(e) {
  if (!active) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endTour(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
}

/** Move to the next stop that is on screen, in direction `dir`. */
function go(dir) {
  let i = active.at + dir;
  while (i >= 0 && i < TOUR_STEPS.length && !find(TOUR_STEPS[i])) i += dir;
  if (i >= TOUR_STEPS.length) return endTour();
  if (i < 0) return; // Back on the first stop: nothing earlier to show.
  active.at = i;
  show(i);
}

function show(i) {
  const step = TOUR_STEPS[i];
  const el = find(step);
  active.el = el;
  // Count only the stops this account can see, so it never says "3 of 19"
  // and then ends at 12.
  const shown = TOUR_STEPS.filter((s) => find(s));
  const n = shown.indexOf(step) + 1;
  const { bubble } = active;
  bubble.querySelector('.tour-count').textContent = `${n} of ${shown.length}`;
  bubble.querySelector('.tour-title').textContent = step.title;
  bubble.querySelector('.tour-text').textContent = step.text;
  const hasEarlier = TOUR_STEPS.slice(0, i).some((s) => find(s));
  bubble.querySelector('.tour-back').disabled = !hasEarlier;
  const last = !TOUR_STEPS.slice(i + 1).some((s) => find(s));
  bubble.querySelector('.tour-next').textContent = last ? 'Done' : 'Next';
  // An instant jump, not a smooth scroll: a smooth one left the ring drawn
  // where the target had been for most of a second.
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  place();
  bubble.querySelector('.tour-next').focus({ preventScroll: true });
}

/** Put the ring round the target and the bubble beside it, inside the window. */
function place() {
  if (!active?.el) return;
  const { ring, bubble, dim, el } = active;
  const pad = 6;
  const r = el.getBoundingClientRect();
  const hole = { x: r.left - pad, y: r.top - pad, w: r.width + pad * 2, h: r.height + pad * 2 };
  Object.assign(ring.style, {
    top: `${hole.y}px`,
    left: `${hole.x}px`,
    width: `${hole.w}px`,
    height: `${hole.h}px`,
  });
  const [dimAbove, dimBelow, dimLeft, dimRight] = dim.children;
  const px = (n) => `${Math.max(0, n)}px`;
  Object.assign(dimAbove.style, { top: '0', left: '0', right: '0', height: px(hole.y) });
  Object.assign(dimBelow.style, { top: px(hole.y + hole.h), left: '0', right: '0', bottom: '0' });
  Object.assign(dimLeft.style, { top: px(hole.y), left: '0', width: px(hole.x), height: px(hole.h) });
  Object.assign(dimRight.style, { top: px(hole.y), left: px(hole.x + hole.w), right: '0', height: px(hole.h) });

  // The part of the page actually on screen. On a phone that can be a window
  // into a wider page (the layout here is wider than 375px), and a fixed
  // element placed against the layout alone lands off screen.
  const vv = window.visualViewport;
  const vx = vv ? vv.offsetLeft : 0;
  const vy = vv ? vv.offsetTop : 0;
  const vw = vv ? vv.width : window.innerWidth;
  const vh = vv ? vv.height : window.innerHeight;
  const gap = 12;
  const margin = 16;
  // On a phone the bubble spans the screen, at the top or the bottom,
  // whichever is clear of the target; there is no room beside anything.
  if (vw < 600) {
    bubble.classList.add('tour-docked');
    bubble.style.left = `${vx + margin}px`;
    bubble.style.width = `${vw - margin * 2}px`;
    const b = bubble.getBoundingClientRect();
    const targetLow = r.top + r.height / 2 > vy + vh / 2;
    bubble.style.top = targetLow ? `${vy + margin}px` : `${vy + vh - margin - b.height}px`;
    return;
  }
  bubble.classList.remove('tour-docked');
  bubble.style.width = '';
  const b = bubble.getBoundingClientRect();
  // Below the target if it fits, else above, else wherever it fits on screen.
  let top = r.bottom + pad + gap;
  if (top + b.height > vy + vh - margin) top = r.top - pad - gap - b.height;
  if (top < vy + margin) top = Math.max(vy + margin, Math.min(vy + vh - margin - b.height, r.top));
  let left = r.left + r.width / 2 - b.width / 2;
  left = Math.max(vx + margin, Math.min(vx + vw - margin - b.width, left));
  bubble.style.top = `${top}px`;
  bubble.style.left = `${left}px`;
}

export function endTour() {
  if (!active) return;
  const { ring, bubble, shield, dim, onEnd } = active;
  active = null;
  ring.remove();
  bubble.remove();
  shield.remove();
  dim.remove();
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', place);
  window.removeEventListener('scroll', place, true);
  window.visualViewport?.removeEventListener('resize', place);
  window.visualViewport?.removeEventListener('scroll', place);
  window.scrollTo({ top: 0, behavior: 'instant' });
  onEnd?.();
}
