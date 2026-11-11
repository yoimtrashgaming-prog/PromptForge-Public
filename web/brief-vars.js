/**
 * Variables in the brief: `a $hair_color dress in $location`.
 *
 * The brief keeps the $names, so a good brief is a template to Generate again:
 * Random rolls fresh each time and a fixed pick holds. scripts/randomizer.py
 * does all the filling, from the Randomizer's lists, and the seed is what makes
 * the line under the brief the exact text Generate sends.
 *
 * Picks belong to a token, not to a position in the text. Typing keeps them by
 * matching the tokens before and after the edit, so adding a $color at the
 * front does not hand the next one's pick to its neighbour.
 *
 * Hover shows the menu on a mouse; the row of buttons does the same on a phone,
 * which has no hover.
 */

// Same pattern as TOKEN in scripts/randomizer.py.
const TOKEN = /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)|\{([^{}|]*(?:\|[^{}|]*)+)\}/g;
const CLOSE_MS = 220;
const FILL_MS = 200;
const SUGGEST_MAX = 40;

const newSeed = () => Math.floor(Math.random() * 0x7fffffff);
const tag = (name, className, text) => {
  const el = document.createElement(name);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
};

function tokensIn(text) {
  return [...text.matchAll(TOKEN)]
    .filter((m) => m[0] !== '$$')
    .map((m) => ({ raw: m[0], name: m[1] || m[2] || null, start: m.index, end: m.index + m[0].length }));
}

/** Carry picks across an edit: same tokens at the front and back keep theirs. */
function carryPicks(before, after, picks) {
  const out = new Array(after.length).fill(null);
  let head = 0;
  while (head < before.length && head < after.length && before[head].raw === after[head].raw) {
    out[head] = picks[head] ?? null;
    head += 1;
  }
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head
    && before[before.length - 1 - tail].raw === after[after.length - 1 - tail].raw) {
    out[after.length - 1 - tail] = picks[before.length - 1 - tail] ?? null;
    tail += 1;
  }
  return out;
}

let library = null;
let active = null;
/** Survives a model switch, which rebuilds the textarea. */
let kept = null;

async function loadLibrary() {
  if (library) return library;
  const res = await fetch('/api/variables');
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.message ?? `Could not load the variables (${res.status}).`);
  library = new Map(data.variables.map((v) => [v.name, v]));
  return library;
}

async function askFill(text, picks, seed) {
  const res = await fetch('/api/variables/fill', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ brief: text, picks, seed }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.message ?? `Could not fill the brief (${res.status}).`);
  return data;
}

export function hasVariables(text) {
  return tokensIn(String(text ?? '')).length > 0;
}

/** The text to send, then a fresh seed so the next Generate rolls again. */
export async function fillBriefForSend() {
  if (!active) throw new Error('The brief variables are not ready yet.');
  active.sync();
  const out = await askFill(active.field.value, active.picks, active.seed);
  active.seed = newSeed();
  active.refresh();
  return out.text;
}

export function attachBriefVars(field) {
  active?.destroy();

  const wrap = tag('div', 'bv-wrap');
  const mirror = tag('div', 'bv-mirror');
  mirror.setAttribute('aria-hidden', 'true');
  field.parentNode.insertBefore(wrap, field);
  wrap.append(mirror, field);
  field.classList.add('bv-field');
  // Where people who skip the updates will meet this. Only attached on a model
  // that has variables, so the line goes where they go.
  if (!field.placeholder.includes('$')) field.placeholder += ' Stuck for ideas? Try $';

  const panel = tag('div', 'bv-panel');
  const row = tag('div', 'bv-row');
  const add = tag('button', 'ghost bv-add', '+ Variable');
  add.type = 'button';
  add.title = 'Add a list to the brief. Typing $ does the same.';
  const reroll = tag('button', 'ghost', 'Reroll');
  reroll.type = 'button';
  reroll.title = 'New random picks. Fixed ones stay. No model involved.';
  reroll.hidden = true;
  row.append(add, reroll);
  const chips = tag('div', 'bv-chips');
  const preview = tag('div', 'bv-preview');
  preview.hidden = true;
  const note = tag('div', 'field-note warn');
  note.hidden = true;
  panel.append(row, chips, preview, note);
  wrap.after(panel);

  const menu = tag('div', 'bv-menu');
  menu.hidden = true;
  document.body.append(menu);

  const fresh = kept?.text === field.value ? kept : null;
  const state = {
    field,
    tokens: tokensIn(field.value),
    picks: fresh?.picks ?? [],
    seed: fresh?.seed ?? newSeed(),
    last: null,
    sync,
    refresh,
    destroy,
  };
  let closeTimer = null;
  let fillTimer = null;
  let ask = 0;
  let suggesting = false;
  let suggestIndex = 0;

  function closeMenu() {
    clearTimeout(closeTimer);
    menu.hidden = true;
    suggesting = false;
  }
  const closeSoon = () => {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(closeMenu, CLOSE_MS);
  };
  menu.addEventListener('pointerenter', () => clearTimeout(closeTimer));
  menu.addEventListener('pointerleave', () => { if (!suggesting) closeSoon(); });

  function place(anchor) {
    menu.hidden = false;
    const box = anchor.getBoundingClientRect();
    const tall = menu.offsetHeight;
    const wide = menu.offsetWidth;
    menu.style.left = `${Math.max(8, Math.min(box.left, innerWidth - wide - 8))}px`;
    menu.style.top = `${box.bottom + tall + 6 < innerHeight ? box.bottom + 4 : Math.max(8, box.top - tall - 4)}px`;
  }

  function option(label, chosen, onPick) {
    const b = tag('button', `bv-option${chosen ? ' on' : ''}`, label);
    b.type = 'button';
    // Keeps the caret in the brief for the suggestion list.
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('click', onPick);
    return b;
  }

  function choicesOf(i) {
    const token = state.tokens[i];
    if (token.name) return library?.get(token.name)?.choices ?? [];
    return (state.last?.tokens?.[i]?.choices ?? []).map((text) => ({ text }));
  }

  function setPick(i, pick) {
    state.picks[i] = pick;
    closeMenu();
    render();
    fillNow();
  }

  function openPick(i, anchor) {
    const token = state.tokens[i];
    if (!token) return;
    clearTimeout(closeTimer);
    const known = !token.name || library?.has(token.name);
    if (!known) return;
    suggesting = false;
    menu.replaceChildren();
    const v = token.name ? library.get(token.name) : null;
    menu.append(tag('strong', '', v ? `$${token.name} · ${v.label}` : 'One-off list'));
    const list = tag('div', 'bv-list');
    const pick = state.picks[i];
    const fill = (filter) => {
      list.replaceChildren(option('Random', !pick, () => setPick(i, null)));
      for (const c of choicesOf(i)) {
        const label = c.text ?? c.label;
        if (filter && !label.toLowerCase().includes(filter)) continue;
        const same = c.text ? pick?.text === c.text : pick?.source === c.source;
        list.append(option(label, same, () => setPick(i, c.text ? { text: c.text } : { source: c.source, label: c.label })));
      }
    };
    if (choicesOf(i).length > 8) {
      const search = tag('input', 'bv-search');
      search.placeholder = 'Filter…';
      search.setAttribute('aria-label', 'Filter this list');
      search.addEventListener('input', () => fill(search.value.trim().toLowerCase()));
      menu.append(search);
    }
    fill('');
    menu.append(list);
    if (!choicesOf(i).length) menu.append(tag('div', 'field-note', 'This one is built from several parts, so it always rolls.'));
    place(anchor);
  }

  /** The $word being typed at the caret, if there is one. */
  function typedWord() {
    const before = field.value.slice(0, field.selectionStart);
    const m = /\$\{?([A-Za-z0-9_]*)$/.exec(before);
    return m && !before.slice(0, m.index).endsWith('$') ? { start: m.index, word: m[1].toLowerCase() } : null;
  }

  function insertName(name, at) {
    const end = field.selectionStart;
    const start = at?.start ?? end;
    const text = field.value;
    const next = text.slice(end, end + 1);
    const put = `$${name}${next && /\s/.test(next) ? '' : ' '}`;
    field.value = text.slice(0, start) + put + text.slice(end);
    field.focus();
    field.selectionStart = field.selectionEnd = start + put.length;
    closeMenu();
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function openSuggest(at) {
    if (!library) return;
    const word = at?.word ?? '';
    const hits = [...library.values()]
      .filter((v) => !word || v.name.includes(word) || v.label.toLowerCase().includes(word))
      // A name that starts with what was typed beats one that only contains it,
      // and an adult list only surfaces once its own name is being typed.
      .filter((v) => !v.nsfw || (word && v.name.startsWith(word)))
      .sort((a, b) => Number(b.name.startsWith(word)) - Number(a.name.startsWith(word)))
      .slice(0, SUGGEST_MAX);
    if (!hits.length) return closeMenu();
    suggesting = true;
    suggestIndex = Math.min(suggestIndex, hits.length - 1);
    menu.replaceChildren();
    const list = tag('div', 'bv-list');
    hits.forEach((v, i) => {
      const b = option('', i === suggestIndex, () => insertName(v.name, typedWord()));
      b.dataset.name = v.name;
      b.append(tag('span', '', `$${v.name}`), tag('small', '', v.group === 'Combined' ? v.label : `${v.group} · ${v.label}`));
      list.append(b);
    });
    menu.append(list);
    place(field);
    list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }

  field.addEventListener('keydown', (e) => {
    if (!suggesting) return;
    const items = [...menu.querySelectorAll('.bv-option')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      suggestIndex = (suggestIndex + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      openSuggest(typedWord());
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      insertName(items[suggestIndex].dataset.name, typedWord());
    } else if (e.key === 'Escape') {
      closeMenu();
    }
  });

  function renderMirror() {
    mirror.replaceChildren();
    const text = field.value;
    let end = 0;
    state.tokens.forEach((t, i) => {
      mirror.append(document.createTextNode(text.slice(end, t.start)));
      const known = !t.name || !library || library.has(t.name);
      const span = tag('span', `bv-token${known ? '' : ' unknown'}${state.picks[i] ? ' fixed' : ''}`, t.raw);
      span.dataset.index = i;
      mirror.append(span);
      end = t.end;
    });
    // The trailing newline keeps a last empty line the same height as the field.
    mirror.append(document.createTextNode(`${text.slice(end)}\n`));
    mirror.scrollTop = field.scrollTop;
  }

  function renderChips() {
    chips.replaceChildren();
    state.tokens.forEach((t, i) => {
      const known = !t.name || !library || library.has(t.name);
      const pick = state.picks[i];
      const value = pick?.text ?? pick?.label ?? (known ? state.last?.tokens?.[i]?.value : 'not a list') ?? '…';
      const b = tag('button', `bv-chip${pick ? ' fixed' : ''}${known ? '' : ' unknown'}`);
      b.type = 'button';
      b.disabled = !known;
      b.append(tag('span', '', t.name ? `$${t.name}` : 'list'), tag('b', '', value || 'nothing'));
      b.addEventListener('click', () => openPick(i, b));
      chips.append(b);
    });
  }

  function render() {
    renderMirror();
    renderChips();
    const any = state.tokens.length > 0;
    reroll.hidden = !any;
    if (!any) {
      preview.hidden = true;
      note.hidden = true;
    }
  }

  function showFill(out) {
    state.last = out;
    preview.hidden = false;
    preview.replaceChildren(tag('span', 'bv-sends', 'Sends'), document.createTextNode(out.text));
    const unknown = [...new Set(out.tokens.filter((t) => !t.known).map((t) => t.raw))];
    note.hidden = !unknown.length;
    note.textContent = unknown.length ? `Not a list, sent as written: ${unknown.join(', ')}` : '';
    renderChips();
  }

  function fillNow() {
    clearTimeout(fillTimer);
    if (!state.tokens.length) return;
    const mine = ++ask;
    askFill(field.value, state.picks, state.seed)
      .then((out) => { if (mine === ask) showFill(out); })
      .catch((err) => {
        if (mine !== ask) return;
        note.hidden = false;
        note.textContent = err.message;
      });
  }

  function refresh() {
    clearTimeout(fillTimer);
    fillTimer = setTimeout(fillNow, FILL_MS);
  }

  /** Text set from code (the Randomizer, a stash) fires nothing; pick it up here. */
  function sync() {
    const after = tokensIn(field.value);
    state.picks = carryPicks(state.tokens, after, state.picks);
    state.tokens = after;
    kept = { text: field.value, picks: state.picks, seed: state.seed };
    render();
  }

  function onInput() {
    sync();
    refresh();
    const at = typedWord();
    if (at) {
      suggestIndex = 0;
      openSuggest(at);
    } else if (suggesting) {
      closeMenu();
    }
  }

  function tokenAt(x, y) {
    return document.elementsFromPoint(x, y).find((el) => el.classList?.contains('bv-token'));
  }

  field.addEventListener('input', onInput);
  field.addEventListener('focus', () => { sync(); refresh(); });
  field.addEventListener('blur', () => { if (suggesting) closeSoon(); });
  field.addEventListener('scroll', () => { mirror.scrollTop = field.scrollTop; closeMenu(); });
  field.addEventListener('pointermove', (e) => {
    if (suggesting || e.pointerType === 'touch') return;
    const span = tokenAt(e.clientX, e.clientY);
    if (span) openPick(Number(span.dataset.index), span);
    else if (!menu.hidden) closeSoon();
  });
  field.addEventListener('pointerleave', () => { if (!suggesting) closeSoon(); });
  add.addEventListener('click', () => {
    if (!suggesting) {
      suggestIndex = 0;
      openSuggest(null);
      place(add);
    } else closeMenu();
  });
  reroll.addEventListener('click', () => {
    state.seed = newSeed();
    fillNow();
  });
  const outside = (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== add) closeMenu();
  };
  const escape = (e) => { if (e.key === 'Escape') closeMenu(); };
  document.addEventListener('pointerdown', outside);
  document.addEventListener('keydown', escape);

  const copyBox = () => {
    const s = getComputedStyle(field);
    for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'wordSpacing',
      'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
      'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderRadius']) {
      mirror.style[p] = s[p];
    }
    mirror.style.width = `${field.offsetWidth}px`;
    mirror.style.height = `${field.offsetHeight}px`;
  };
  const sizes = new ResizeObserver(copyBox);
  sizes.observe(field);

  function destroy() {
    sizes.disconnect();
    clearTimeout(closeTimer);
    clearTimeout(fillTimer);
    document.removeEventListener('pointerdown', outside);
    document.removeEventListener('keydown', escape);
    menu.remove();
    if (active === state) active = null;
  }

  active = state;
  copyBox();
  loadLibrary()
    .then(() => { sync(); refresh(); })
    .catch((err) => {
      note.hidden = false;
      note.textContent = err.message;
    });
  sync();
}

/** Off for a model that does not use them. */
export function detachBriefVars() {
  active?.destroy();
}
