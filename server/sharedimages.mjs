// The shared image library: a picture and the prompt that made it.
//
// Asked for 19 Sep 2026. Five people make things on this box and the prompt
// that produced a good one lives in whoever's head made it — so the useful
// unit to share is not the image and not the prompt but the pair. You upload
// a picture, name it, paste the prompt beside it, and anyone can pull both
// back into the builder.
//
// ── Why two files and not one JSON record ────────────────────────────────
//
// `<name>.png` plus `<name>.txt`, which is the caption-pair convention this
// group already uses for every training dataset. That buys two things a JSON
// blob would not:
//
//   - you can drop a pair into the folder over SSH and it appears in the tab,
//     with no upload step and no format to learn
//   - the folder IS a dataset. Point sd-scripts at it and it works.
//
// So the DIRECTORY is the truth about what exists, and index.json beside it
// only annotates — who added a thing and when. A pair that arrived over SSH
// has no index entry and is listed anyway, with an unknown author, because
// invisible-unless-uploaded-through-the-button would defeat the point.
//
// ── What this deliberately is not ────────────────────────────────────────
//
// Nothing here touches generation. The library hands the browser an image and
// a block of text; attaching that image as a reference is the existing
// reference card's job and the prompt text lands in the brief, so a broken
// entry here can produce a worse prompt but never an unparseable one.
//
// Ownership follows server/storage.mjs's system prompts: no publish step,
// everyone sees everything the moment it goes up. Changing an entry — its
// prompt, the model it names — and removing it are both the author's, or the
// owner's. See update() for why that is not the wiki-style free-for-all it
// started as.

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import path from 'node:path';
import { readComfyMetadata } from './comfymeta.mjs';

// Extension per accepted upload type. Deliberately a fixed table rather than
// anything derived from the filename: the extension on disk is what MIME is
// later inferred FROM when the file is served back, so letting an uploader
// choose it is letting them choose a content-type header.
const EXT_FOR_TYPE = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

// And the inverse, for serving. Any extension not in here is not served.
const TYPE_FOR_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

// Generous. It is a prompt, and h3's run long — the cap exists so a paste
// accident cannot fill the disk, not to shape what anyone writes.
const TEXT_MAX = 20000;

// Names become filenames, so the shape is asserted where the filename is
// built rather than trusted from the request. Lowercase because this runs on
// Linux and half this project's history is Windows case-insensitivity.
const NAME_SHAPE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * A person's chosen name, turned into something that can be a filename.
 *
 * Returns null when nothing usable survives, and the caller asks for a name
 * rather than inventing one — "image-7" is not a name anybody meant.
 */
export function slugify(name) {
  const clean = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')        // don't turn "rin's" into "rin-s"
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');         // a trailing dash from the slice
  return NAME_SHAPE.test(clean) ? clean : null;
}

export function createSharedImages(rootDir, config) {
  const dir = path.resolve(rootDir, config.paths?.shared_images ?? 'data/shared-images');
  const indexFile = path.join(dir, 'index.json');

  const ensureDir = () => {
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  // Made at boot rather than on first upload. scripts/check-portability.mjs
  // asserts that every path in config/server.yaml resolves on disk character
  // for character — the check that stops a `data/Shared-Images` reaching a
  // case-sensitive filesystem — and a directory that only appears once
  // somebody uses the feature would fail it on a fresh deployment.
  ensureDir();

  /**
   * Whole or not at all, the same temp-then-rename storage.mjs uses. This
   * service has been SIGKILLed often enough that a truncated index is not
   * hypothetical, and every reader here treats an unreadable index as empty —
   * so an interrupted write would silently orphan everyone's authorship.
   */
  function writeJson(file, value) {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    renameSync(tmp, file);
  }

  function readIndex() {
    try {
      const parsed = JSON.parse(readFileSync(indexFile, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      // Absent on a fresh install, and absent for a folder somebody filled
      // over SSH. Neither is an error.
      return {};
    }
  }

  const writeIndex = (all) => {
    ensureDir();
    writeJson(indexFile, all);
  };

  /** The image file for a name, or null. The name is validated, never joined raw. */
  function imagePath(name) {
    if (!NAME_SHAPE.test(String(name ?? ''))) return null;
    for (const ext of Object.keys(TYPE_FOR_EXT)) {
      const file = path.join(dir, `${name}${ext}`);
      // Containment is a property of NAME_SHAPE — no dots, no separators can
      // pass it — but assert it here too, because this path gets streamed to
      // a browser and the cost of being wrong is the whole filesystem.
      if (!file.startsWith(dir + path.sep)) return null;
      if (existsSync(file) && statSync(file).isFile()) return { file, ext, type: TYPE_FOR_EXT[ext] };
    }
    return null;
  }

  const textPath = (name) => path.join(dir, `${name}.txt`);

  // The brief lives in its own file, not in `<name>.txt`.
  //
  // `<name>.txt` has to stay the FINISHED prompt, because that pairing is
  // what makes the folder a caption dataset you can point sd-scripts at. A
  // brief in there would be a caption describing something the picture is
  // not. `.brief.txt` sits beside it, is ignored by every dataset tool
  // (they look for `.txt`), and is still a plain file somebody can read or
  // grep on the box.
  const briefPath = (name) => path.join(dir, `${name}.brief.txt`);

  function readFileOr(file) {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  }

  const readText = (name) => readFileOr(textPath(name));
  const readBrief = (name) => readFileOr(briefPath(name));

  /**
   * Every pair in the folder, newest first.
   *
   * Driven by the images: a stray .txt with no picture beside it is somebody's
   * notes, not an entry, and listing it would put a card with no thumbnail in
   * a grid of thumbnails.
   */
  function list() {
    ensureDir();
    const index = readIndex();
    const entries = [];
    for (const file of readdirSync(dir)) {
      const ext = path.extname(file).toLowerCase();
      if (!TYPE_FOR_EXT[ext]) continue;
      const name = path.basename(file, path.extname(file));
      if (!NAME_SHAPE.test(name)) continue;   // hand-dropped file with a name we cannot address
      const meta = index[name] ?? {};
      let bytes = 0;
      try {
        bytes = statSync(path.join(dir, file)).size;
      } catch {
        continue;                              // vanished between readdir and stat
      }
      entries.push({
        name,
        file,
        type: TYPE_FOR_EXT[ext],
        bytes,
        text: readText(name),
        // What was given to PromptForge, as opposed to what came out of it.
        //
        // Two prompts and not one, asked for by a user on 20 Sep 2026 and
        // for the right reason: the finished prompt is the one that made
        // THIS picture, and the brief is the one you can reuse. Taking
        // somebody's final prompt and changing the character means editing
        // every tag by hand; taking their brief means swapping the subject
        // and generating again.
        brief: readBrief(name),
        // Unknown rather than blank for a pair that arrived over SSH. The tab
        // says so, which is more honest than attributing it to nobody.
        author: typeof meta.author === 'string' ? meta.author : null,
        at: typeof meta.at === 'string' ? meta.at : null,
        // Which image model made it, as a registry key. Carried in the
        // listing because it is a badge on every tile and a thing people
        // filter by — unlike the graph below, it is four characters.
        model: typeof meta.model === 'string' ? meta.model : null,
        // Whatever is already recorded, and nothing is parsed here. A grid
        // of thirty tiles must not turn into thirty file reads; the detail
        // view fetches the entry on its own and that is where an unparsed
        // one gets read. `has_comfy` rather than the settings themselves for
        // the same reason the pictures are not base64'd into this listing.
        has_comfy: Boolean(meta.comfy),
      });
    }
    return entries.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
  }

  // ComfyUI writes its settings into text chunks that sit BEFORE the pixels,
  // so the front of the file is all that has to be read. The alternative is
  // loading every picture in the folder whole to answer a question about six
  // numbers. 1 MB is well past the largest graph seen here (the owner's test
  // file spends 16 KB on both chunks together) and still cheap.
  const HEAD_BYTES = 1024 * 1024;

  function readHead(file) {
    let fd;
    try {
      fd = openSync(file, 'r');
      const buf = Buffer.alloc(HEAD_BYTES);
      const read = readSync(fd, buf, 0, HEAD_BYTES, 0);
      return buf.subarray(0, read);
    } catch {
      return null;
    } finally {
      if (fd !== undefined) try { closeSync(fd); } catch { /* already gone */ }
    }
  }

  /**
   * The ComfyUI settings for one entry, read once and remembered.
   *
   * Uploads are parsed as they arrive, from bytes already in memory. This
   * path is for the other way in — a pair copied into the folder over SSH,
   * which has no index row at all. Parsed the first time somebody opens it
   * and cached in the index, so the folder stays the thing you can write to
   * by hand without losing what the app can tell you about it.
   *
   * `false` is cached for a picture that has none, and is why the check is
   * `=== undefined` rather than a falsy test: re-reading a JPEG on every open
   * to re-learn that a JPEG carries no ComfyUI graph is the loop this avoids.
   */
  function comfyFor(name, index = readIndex()) {
    const recorded = index[name]?.comfy;
    if (recorded !== undefined) return recorded === false ? null : recorded;

    const img = imagePath(name);
    if (!img) return null;
    const head = readHead(img.file);
    const parsed = head ? readComfyMetadata(head) : null;

    index[name] = { ...(index[name] ?? {}), comfy: parsed ?? false };
    try {
      writeIndex(index);
    } catch {
      // A read-only folder must not stop the settings being shown once.
    }
    return parsed;
  }

  function get(name) {
    if (!NAME_SHAPE.test(String(name ?? ''))) return null;
    const img = imagePath(name);
    if (!img) return null;
    const index = readIndex();
    const meta = index[name] ?? {};
    return {
      name,
      type: img.type,
      text: readText(name),
      brief: readBrief(name),
      author: typeof meta.author === 'string' ? meta.author : null,
      at: typeof meta.at === 'string' ? meta.at : null,
      model: typeof meta.model === 'string' ? meta.model : null,
      comfy: comfyFor(name, index),
    };
  }

  /** The file itself, for the route that streams it. Null when there is none. */
  function fileFor(name) {
    return imagePath(name);
  }

  /**
   * Take a name somebody typed and make it unique in the folder.
   *
   * Collisions are appended to rather than refused. Two people uploading
   * `catgirl` a week apart is the normal case in a shared folder, and an
   * error that says "that name is taken, pick another" makes the second
   * person think about filenames instead of about the picture.
   */
  function uniqueName(base) {
    if (!imagePath(base) && !existsSync(textPath(base))) return base;
    for (let n = 2; n < 100; n += 1) {
      const candidate = `${base}-${n}`.slice(0, 64).replace(/-+$/, '');
      if (!NAME_SHAPE.test(candidate)) break;
      if (!imagePath(candidate) && !existsSync(textPath(candidate))) return candidate;
    }
    throw Object.assign(
      new Error(`There are already a hundred things called ${base}. Pick another name.`),
      { statusCode: 409 }
    );
  }

  /**
   * Add a pair. The image is required; the prompt text is not.
   *
   * An entry with no text is a picture somebody wanted to share and had
   * nothing to say about — still worth having in the grid, still attachable
   * as a reference. Requiring the prompt would mean people paste a full stop
   * to get past the validation.
   */
  function save({ username, name, bytes, contentType, text = '', brief = '', model = null }) {
    const ext = EXT_FOR_TYPE[String(contentType ?? '').toLowerCase()];
    if (!ext) {
      throw Object.assign(
        new Error(`${contentType || 'That file'} is not an image this box accepts.`),
        { statusCode: 415 }
      );
    }
    if (!bytes?.length) {
      throw Object.assign(new Error('The upload was empty.'), { statusCode: 400 });
    }
    const base = slugify(name);
    if (!base) {
      throw Object.assign(
        new Error('Give it a name — letters and numbers, at least one.'),
        { statusCode: 400 }
      );
    }
    const body = String(text ?? '').trim();
    if (body.length > TEXT_MAX) {
      throw Object.assign(
        new Error(`Prompts here are capped at ${TEXT_MAX} characters; that one is ${body.length}.`),
        { statusCode: 400 }
      );
    }

    ensureDir();
    const final = uniqueName(base);

    // Image first, then text, then the index. Each step leaves something
    // coherent behind if the process dies: an image with no text is a valid
    // entry, and an entry with no index row lists as an unknown author.
    const imgFile = path.join(dir, `${final}${ext}`);
    const tmp = `${imgFile}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, imgFile);

    // Always written, even empty, so the pair is a pair on disk — that is
    // what makes the folder usable as a dataset directly.
    writeFileSync(textPath(final), body, 'utf8');
    // Written whatever it is, empty included, so the trio on disk is always
    // the same shape and nothing has to test for a missing file.
    writeFileSync(briefPath(final), String(brief ?? '').trim(), 'utf8');

    // Read from the bytes in hand rather than off the disk again. Null for
    // most pictures — a JPEG, a screenshot, anything re-encoded — and that is
    // not a failure, it is the normal answer. Stored as false so the lazy
    // path above knows the question has been asked and answered.
    const comfy = readComfyMetadata(bytes);

    const at = new Date().toISOString();
    const index = readIndex();
    index[final] = { author: String(username ?? 'unknown'), at, model, comfy: comfy ?? false };
    writeIndex(index);

    return {
      name: final,
      type: TYPE_FOR_EXT[ext],
      text: body,
      brief: String(brief ?? '').trim(),
      model,
      author: String(username ?? 'unknown'),
      at,
      bytes: bytes.length,
      comfy,
    };
  }

  /**
   * Rewrite the prompt beside a picture. Whoever put it up, or the owner.
   *
   * **The same gate as deleting, deliberately.** This was open to everyone
   * when the feature shipped, on the reasoning that a shared prompt is a wiki
   * entry and the useful case is somebody fixing one that is missing the tags
   * that make it work. The owner's call, 20 Sep 2026, is that it is not: what
   * somebody pinned is theirs, and a prompt edited under them is a change to
   * their entry that they never see happen.
   *
   * Nothing is lost by it. Taking a pin into the builder copies the prompt
   * into your own brief, where it can be rewritten freely — the board is what
   * stays fixed, not what you do with it.
   *
   * A pair copied in over SSH has no author to compare against, so only the
   * owner can edit it, for the same reason remove() gives.
   */
  function update(name, { text, brief = "", model = null } = {}, { requester, isOwner = false } = {}) {
    if (!imagePath(name)) {
      throw Object.assign(new Error(`No shared image called ${name}.`), { statusCode: 404 });
    }
    const index = readIndex();
    const author = index[name]?.author ?? null;
    if (!isOwner && (author === null || author !== requester)) {
      throw Object.assign(
        new Error('Only the person who put it up, or the owner, can change it.'),
        { statusCode: 403 }
      );
    }
    const body = String(text ?? '').trim();
    const briefBody = String(brief ?? '').trim();
    for (const [label, value] of [['Prompts', body], ['Briefs', briefBody]]) {
      if (value.length > TEXT_MAX) {
        throw Object.assign(
          new Error(`${label} here are capped at ${TEXT_MAX} characters; that one is ${value.length}.`),
          { statusCode: 400 }
        );
      }
    }
    writeFileSync(textPath(name), body, 'utf8');
    writeFileSync(briefPath(name), briefBody, 'utf8');

    // The model lives in the index rather than in the .txt, because the .txt
    // is the prompt and nothing else — that is what makes the folder usable
    // as a caption dataset without stripping a header off every file first.
    index[name] = { ...(index[name] ?? {}), model };
    writeIndex(index);

    return get(name);
  }

  /**
   * Remove a pair. Whoever uploaded it, or the owner.
   *
   * A pair with no index entry — one dropped in over SSH — has no author to
   * compare against, so only the owner can remove it. Anything else would
   * make "put it there by hand" mean "anyone can delete it".
   */
  function remove(name, { requester, isOwner = false } = {}) {
    const img = imagePath(name);
    if (!img) return { ok: false, code: 404 };
    const index = readIndex();
    const author = index[name]?.author ?? null;
    if (!isOwner && (author === null || author !== requester)) return { ok: false, code: 403 };

    rmSync(img.file, { force: true });
    rmSync(textPath(name), { force: true });
    // The brief goes with it. A `.brief.txt` left behind would sit in the
    // folder forever: nothing lists it, because the listing is driven by the
    // images, so nothing would ever clean it up either.
    rmSync(briefPath(name), { force: true });
    if (index[name]) {
      delete index[name];
      writeIndex(index);
    }
    return { ok: true };
  }

  /** What the tab needs to render its upload form without hardcoding anything. */
  function info() {
    return {
      accepted_types: Object.keys(EXT_FOR_TYPE),
      text_max: TEXT_MAX,
      dir,
    };
  }

  return { list, get, fileFor, save, update, remove, info };
}
