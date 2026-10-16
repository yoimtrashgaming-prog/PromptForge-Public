// Where a checkpoint or a LoRA actually lives, written down once by hand.
//
// The pinboard reads the weight NAMES out of a ComfyUI picture — the
// checkpoint, every enabled LoRA — and a name is where the trail goes cold.
// Civitai resolves a file to its page by SHA256, and ComfyUI records no
// hashes in the PNG at all, so there is nothing in the picture that says
// which model it is. Guessing by filename and presenting the top hit as the
// model would be wrong often and confidently: people rename these files, and
// half of what this group loads is self-trained and has no page anywhere.
//
// So somebody pastes the link once. The first person to pin a picture using
// `TrashGatcha3Dv2.safetensors` adds its URL, and from then on every picture
// that used that checkpoint links to it — including the ones pinned before
// the link existed, because this is keyed on the name rather than stored on
// the pin. The owner's call, 20 Sep 2026: "we can just make it so we can add
// the link manually".
//
// Deliberately NOT part of an entry. A weight is shared between pins and
// between people; copying its URL onto each pin would mean fixing a bad link
// in nine places.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';

// Long enough for a Civitai URL with a version query on it, short enough that
// nobody is storing a document in here.
const URL_MAX = 500;

/**
 * The key a weight is filed under: no folder, no extension, lowercased.
 *
 * `image-gen\Detail_v5.safetensors` and `Detail_v5.safetensors` are the same
 * weight in two people's folder layouts, and they must land on the same link.
 * Lowercased for the same reason every other name in this project is — the
 * authoring box is case-insensitive and the box that runs it is not.
 */
export function weightKey(name) {
  return String(name ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/\.(safetensors|ckpt|pt|sft|gguf|bin)$/i, '')
    .trim()
    .toLowerCase();
}

/**
 * A URL somebody typed, or null.
 *
 * **http and https only, and this is the load-bearing check.** What comes
 * back from here is put in an `href` that four other people click. A
 * `javascript:` URL in that position runs in their session, and this app has
 * no other place where one person's text becomes another person's link — so
 * the scheme is checked against an allowlist here rather than trusted to be
 * sanitised on the way out.
 */
export function cleanUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > URL_MAX) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
}

export function createWeightLinks(rootDir, config) {
  const file = path.resolve(
    rootDir,
    config.paths?.data ?? 'data',
    'weight-links.json'
  );

  function read() {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      // Absent on a fresh install, and a corrupt file must not take the app
      // down over what is a list of bookmarks.
      return {};
    }
  }

  function write(all) {
    mkdirSync(path.dirname(file), { recursive: true });
    // Whole or not at all, the same temp-then-rename every shared file in
    // this project uses. This service has been SIGKILLed often enough that a
    // truncated write is not hypothetical.
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf8');
    renameSync(tmp, file);
  }

  /** Every link, keyed the way the browser will look them up. */
  const list = () => read();

  /**
   * Add a link, or change one you added.
   *
   * Adding is open to anyone: an unset weight has no owner, and the useful
   * case is whoever happens to notice it is missing. CHANGING one is not,
   * for the same reason a pin's prompt is not — somebody's entry being
   * rewritten under them is the thing the owner ruled out. The owner is
   * exempt, as everywhere else.
   */
  function set(name, url, { requester, isOwner = false } = {}) {
    const key = weightKey(name);
    if (!key) {
      throw Object.assign(new Error('Which weight is the link for?'), { statusCode: 400 });
    }
    const href = cleanUrl(url);
    if (!href) {
      throw Object.assign(
        new Error('That is not a link. It needs to start with http:// or https://'),
        { statusCode: 400 }
      );
    }

    const all = read();
    const existing = all[key];
    if (existing && !isOwner && existing.by !== requester) {
      throw Object.assign(
        new Error(`${existing.by} added that link. Ask them, or ask the owner, to change it.`),
        { statusCode: 403 }
      );
    }

    all[key] = {
      url: href,
      by: String(requester ?? 'unknown'),
      at: new Date().toISOString(),
      // The name as it was spelled when the link was added, purely so the
      // list is readable by a person opening the file on the box.
      label: String(name ?? ''),
    };
    write(all);
    return { key, ...all[key] };
  }

  function remove(name, { requester, isOwner = false } = {}) {
    const key = weightKey(name);
    const all = read();
    const existing = all[key];
    if (!existing) return { ok: false, code: 404 };
    if (!isOwner && existing.by !== requester) return { ok: false, code: 403 };
    delete all[key];
    write(all);
    return { ok: true };
  }

  return { list, set, remove, weightKey };
}
