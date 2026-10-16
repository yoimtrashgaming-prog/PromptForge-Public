// Per-user data on disk: saved prompt library, preferences.
//
// Storage is one JSON file per entry under data/users/{username}/. No
// database — this is five people saving prompts, and a directory of JSON
// files is trivially inspectable, trivially backed up, and survives any
// schema change without a migration.
//
// The full user system is Phase 7. Until then the username arrives in the
// x-promptforge-user header, defaulting to the configured owner, which is
// the same mechanism the admin gate already uses.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Usernames become directory names, so they must not escape the data dir. */
export function safeUsername(name, fallback) {
  const clean = String(name ?? '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(clean) ? clean : fallback;
}

const newId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

/**
 * Ids become filenames, so they must not escape the user's own directory.
 *
 * Nothing was reachable through them before this — a traversal attempt was
 * tested against every route that takes one and came back 404 every time — but
 * both reasons it failed live in code this file does not own. `new URL()`
 * removes dot segments from a pathname, so a literal `../` never arrives; and
 * the pathname keeps `%2F` encoded, so an encoded one arrives as a strange
 * filename that simply does not exist. Neither is stated anywhere, and one
 * `decodeURIComponent` added to a route in six months would quietly undo both.
 *
 * So the property is asserted here, where the filename is actually built, and
 * pinned by tests that try to walk out.
 */
const ID_SHAPE = /^[a-z]+_[a-z0-9]{8,64}$/;
function safeId(id) {
  return ID_SHAPE.test(String(id ?? '')) ? String(id) : null;
}

/**
 * Write a JSON file whole or not at all: a sibling first, then a rename over
 * the original, which the filesystem does in one step. The same pattern
 * server/auth.mjs has always used for accounts and sessions.
 *
 * Until 11 Sep 2026 these were written in place. A process killed mid-write
 * leaves a truncated file, and every reader here treats an unreadable file
 * as empty — so for the shared files (notes, system prompts) the next write
 * would have replaced everyone's entries with one. The service was SIGKILLed
 * six times between 7 and 9 Sep 2026, so a kill mid-write is not
 * hypothetical. The temp name does not end in .json, so a leftover one is
 * never read as an entry.
 */
function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, file);
}

export function createStorage(rootDir, config) {
  const usersDir = path.resolve(rootDir, config.paths?.users ?? 'data/users');

  function userDir(username, sub) {
    const dir = sub ? path.join(usersDir, username, sub) : path.join(usersDir, username);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  // ── library ──────────────────────────────────────────────
  const libraryDir = (username) => userDir(username, 'library');

  function listLibrary(username) {
    const dir = libraryDir(username);
    const entries = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        entries.push(JSON.parse(readFileSync(path.join(dir, file), 'utf8')));
      } catch {
        // A corrupt entry must not take out the whole list.
        console.warn(`[storage] skipping unreadable library entry ${file}`);
      }
    }
    // Newest first.
    return entries.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  function getLibraryEntry(username, id) {
    const clean = safeId(id);
    if (!clean) return null;
    const file = path.join(libraryDir(username), `${clean}.json`);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  }

  function saveLibraryEntry(username, { title, model, brief, segments, tags }) {
    if (!Array.isArray(segments) || segments.length === 0) {
      throw Object.assign(new Error('Nothing to save — generate a prompt first.'), { statusCode: 400 });
    }
    const entry = {
      id: newId('lib'),
      user: username,
      // Fall back to the opening of the brief so a saved entry is never
      // called "Untitled" in the list.
      title: String(title ?? '').trim() || String(brief ?? '').trim().slice(0, 60) || 'Untitled prompt',
      model,
      created_at: new Date().toISOString(),
      brief: String(brief ?? ''),
      segments: segments.map((s) => ({ label: String(s.label), body: String(s.body) })),
      tags: Array.isArray(tags) ? tags.map(String) : [],
    };
    writeJson(path.join(libraryDir(username), `${entry.id}.json`), entry);
    return entry;
  }

  function deleteLibraryEntry(username, id) {
    const clean = safeId(id);
    if (!clean) return false;
    const file = path.join(libraryDir(username), `${clean}.json`);
    if (!existsSync(file)) return false;
    // Windows will not delete a file another process holds open; the cleanup
    // routine has the same constraint. Log and report rather than crash.
    try {
      rmSync(file);
      return true;
    } catch (err) {
      if (err.code === 'EBUSY' || err.code === 'EPERM') {
        throw Object.assign(new Error('File is locked by another process — try again.'), {
          statusCode: 409,
        });
      }
      throw err;
    }
  }

  // ── chats ────────────────────────────────────────────────
  //
  // One JSON file per conversation, beside the library, in the same per-user
  // directory. Same reasoning as the library: five people, a handful of files
  // each, and a directory listing is a perfectly good index at that size. If
  // this ever needs paging it needs a database, and it will not.
  const chatsDir = (username) => userDir(username, 'chats');

  // Pictures a conversation made (edits from chat, 4 Oct 2026), beside its
  // JSON as <id>.files/. They follow the conversation's own rules, the
  // owner's call: kept while it is, swept with it, forever when it is locked
  // or pinned. Not the pictures people send in — those stay in memory only,
  // see server/chatpictures.mjs.
  const chatFilesDir = (username, id) => path.join(chatsDir(username), `${id}.files`);
  const PICTURE_ID = /^p_[a-f0-9]{24}$/;

  /** Keep a picture with a conversation. Returns its id. */
  function saveChatPicture(username, chatId, bytes) {
    const clean = safeId(chatId);
    if (!clean || !existsSync(path.join(chatsDir(username), `${clean}.json`))) {
      throw Object.assign(new Error('No such conversation.'), { statusCode: 404 });
    }
    const id = `p_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    mkdirSync(chatFilesDir(username, clean), { recursive: true });
    writeFileSync(path.join(chatFilesDir(username, clean), `${id}.png`), bytes);
    return id;
  }

  /** Where a conversation's picture is on disk, or null. Both ids are checked before they touch a path. */
  function chatPicturePath(username, chatId, pictureId) {
    const clean = safeId(chatId);
    if (!clean || !PICTURE_ID.test(String(pictureId))) return null;
    const file = path.join(chatFilesDir(username, clean), `${pictureId}.png`);
    return existsSync(file) ? file : null;
  }

  function readChatFile(username, id) {
    const clean = safeId(id);
    if (!clean) return null;
    const file = path.join(chatsDir(username), `${clean}.json`);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  function writeChatFile(username, chat) {
    writeJson(path.join(chatsDir(username), `${chat.id}.json`), chat);
    return chat;
  }

  /**
   * The sidebar list: summaries, never message bodies. A hundred conversations
   * of a hundred messages each is a few megabytes, and the sidebar needs none
   * of it.
   */
  function listChats(username) {
    const dir = chatsDir(username);
    const out = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      let chat;
      try {
        chat = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
      } catch {
        // One unreadable conversation must not empty the sidebar.
        console.warn(`[storage] skipping unreadable chat ${file}`);
        continue;
      }
      out.push({
        id: chat.id,
        title: chat.title,
        model: chat.model,
        created_at: chat.created_at,
        updated_at: chat.updated_at,
        // Locked conversations are never swept. Coerced rather than passed
        // through, so a file written before locking existed reads as false
        // instead of undefined.
        locked: Boolean(chat.locked),
        pinned: Boolean(chat.pinned),
        message_count: Array.isArray(chat.messages) ? chat.messages.length : 0,
      });
    }
    // Pinned ones on top (26 Sep 2026), then most recently spoken to first,
    // which is the order a chat sidebar is always read in.
    return out.sort((a, b) =>
      Number(b.pinned) - Number(a.pinned) || String(b.updated_at).localeCompare(String(a.updated_at)));
  }

  function getChat(username, id) {
    return readChatFile(username, id);
  }

  function createChat(username, { model, title } = {}) {
    const now = new Date().toISOString();
    return writeChatFile(username, {
      id: newId('chat'),
      user: username,
      // Untitled until the first message names it — see titleFromMessage.
      title: String(title ?? '').trim() || 'New chat',
      model: model ?? null,
      created_at: now,
      updated_at: now,
      // Exempt from the retention sweep. Off by default: a conversation has to
      // be worth keeping before it is kept, or the window means nothing.
      locked: false,
      messages: [],
    });
  }

  /**
   * The first thing someone says is the best title available without asking a
   * model for one, which would cost a second generation on a box where the
   * first one is already the slow part.
   */
  function titleFromMessage(text) {
    const line = String(text ?? '').trim().split(/[\r\n]/)[0].trim();
    if (!line) return 'New chat';
    return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line;
  }

  function appendMessage(username, id, message) {
    const chat = readChatFile(username, id);
    if (!chat) throw Object.assign(new Error('No such conversation.'), { statusCode: 404 });
    const entry = {
      role: message.role,
      content: String(message.content ?? ''),
      at: new Date().toISOString(),
    };
    // Optional, and only ever set by the search path. Absent rather than null
    // when there was no search, so a stored conversation says plainly whether
    // one happened.
    if (message.searched) entry.searched = message.searched;
    if (Array.isArray(message.citations) && message.citations.length) {
      entry.citations = message.citations;
    }
    // How many pictures came with it - never the pictures, which are held in
    // memory only (server/chatpictures.mjs).
    if (Number.isInteger(message.pictures) && message.pictures > 0) entry.pictures = message.pictures;
    // A reply written by chat's write_prompt tool: which model and what brief,
    // so a later turn replays it as a tool call, not as text the model wrote.
    if (message.tool?.name) {
      entry.tool = { name: String(message.tool.name), model: String(message.tool.model ?? ''), brief: String(message.tool.brief ?? '') };
      // The prompt it produced, so chat's "render that" can draw exactly it.
      if (message.tool.positive) entry.tool.positive = String(message.tool.positive).slice(0, 20000);
      if (message.tool.negative) entry.tool.negative = String(message.tool.negative).slice(0, 20000);
      // edit_picture: the instruction the editor was given.
      if (message.tool.prompt) entry.tool.prompt = String(message.tool.prompt).slice(0, 20000);
    }
    // A picture chat edited, kept beside this conversation (saveChatPicture)
    // and on its clock. The id is checked; the url is built here, not taken.
    if (message.edit?.picture && /^p_[a-f0-9]{24}$/.test(String(message.edit.picture))) {
      const e = message.edit;
      entry.edit = {
        picture: e.picture,
        url: `/api/chat/${chat.id}/pictures/${e.picture}.png`,
        prompt: String(e.prompt ?? '').slice(0, 20000),
        settings: e.settings ?? {},
        ms: Number(e.ms) || 0,
      };
    }
    // A picture chat rendered: where it is and how it was made. The picture
    // itself lives in the renders folder on its own 24-hour clock.
    if (message.render?.id && /^r_[a-f0-9]{24}$/.test(String(message.render.id))) {
      const r = message.render;
      entry.render = { id: r.id, url: `/api/render/${r.id}.png`, model: String(r.model ?? ''), settings: r.settings ?? {}, ms: Number(r.ms) || 0 };
    }
    chat.messages.push(entry);
    chat.updated_at = entry.at;
    if (chat.title === 'New chat' && entry.role === 'user') {
      chat.title = titleFromMessage(entry.content);
    }
    if (message.model) chat.model = message.model;
    return writeChatFile(username, chat);
  }

  /**
   * Rename or pin one conversation (26 Sep 2026). Neither touches updated_at,
   * for the reason given on setChatLocked below: it is not talking. A pinned
   * conversation sits at the top of the list and, like a locked one, is never
   * swept - something pinned vanishing on its own would be a nasty surprise.
   */
  function renameChat(username, id, title) {
    const chat = readChatFile(username, id);
    if (!chat) throw Object.assign(new Error('No such conversation.'), { statusCode: 404 });
    const clean = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!clean) throw Object.assign(new Error('A name cannot be empty.'), { statusCode: 400 });
    chat.title = clean;
    return writeChatFile(username, chat);
  }

  function setChatPinned(username, id, pinned) {
    const chat = readChatFile(username, id);
    if (!chat) throw Object.assign(new Error('No such conversation.'), { statusCode: 404 });
    chat.pinned = Boolean(pinned);
    return writeChatFile(username, chat);
  }

  /**
   * Lock or unlock one conversation. A locked conversation is exempt from the
   * retention sweep and nothing else about it changes — it is still deletable
   * by hand, because a lock that also blocked the delete button would be a
   * conversation you could not get rid of.
   *
   * Deliberately does NOT touch updated_at. Locking is not talking, and if it
   * counted as activity then locking something would silently restart its
   * retention clock, which is a confusing way to be told the lock worked.
   */
  function setChatLocked(username, id, locked) {
    const chat = readChatFile(username, id);
    if (!chat) throw Object.assign(new Error('No such conversation.'), { statusCode: 404 });
    chat.locked = Boolean(locked);
    return writeChatFile(username, chat);
  }

  /**
   * Delete conversations nobody has added to in `retentionDays`.
   *
   * Age is measured from the last message rather than from creation, so one
   * you keep coming back to never ages out. Locked conversations are skipped
   * whatever their age, and a conversation with no readable timestamp is
   * skipped too: an unparseable date is a reason to leave a file alone, not a
   * reason to delete it.
   *
   * `now` is injectable so this is testable without waiting a fortnight.
   */
  function sweepChats(username, retentionDays, now = Date.now()) {
    const days = Number(retentionDays);
    // 0, absent, or nonsense means keep everything. The sweep has to fail
    // safe: a typo in config should never quietly delete people's history.
    if (!Number.isFinite(days) || days <= 0) return { swept: [], kept: 0, skipped: 0 };

    const cutoff = now - days * 24 * 60 * 60 * 1000;
    const swept = [];
    let kept = 0;
    let skipped = 0;

    for (const file of readdirSync(chatsDir(username))) {
      if (!file.endsWith('.json')) continue;
      let chat;
      try {
        chat = JSON.parse(readFileSync(path.join(chatsDir(username), file), 'utf8'));
      } catch {
        skipped += 1;
        continue;
      }
      const last = Date.parse(chat.updated_at ?? chat.created_at ?? '');
      if (chat.locked || chat.pinned || !Number.isFinite(last) || last > cutoff) {
        kept += 1;
        continue;
      }
      try {
        rmSync(path.join(chatsDir(username), file));
        rmSync(chatFilesDir(username, file.slice(0, -5)), { recursive: true, force: true });
        swept.push({ id: chat.id, title: chat.title, updated_at: chat.updated_at });
      } catch {
        // Windows will not delete a file another process holds open. It will
        // be caught by the next sweep.
        skipped += 1;
      }
    }
    return { swept, kept, skipped };
  }

  /** The same sweep across everyone, for the timer the server runs. */
  function sweepAllChats(retentionDays, now = Date.now()) {
    const out = [];
    for (const username of listUsers()) {
      const { swept } = sweepChats(username, retentionDays, now);
      for (const chat of swept) out.push({ user: username, ...chat });
    }
    return out;
  }

  function deleteChat(username, id) {
    const clean = safeId(id);
    // A malformed id deletes nothing and reports the same "no such
    // conversation" as one that never existed.
    if (!clean) return false;
    const file = path.join(chatsDir(username), `${clean}.json`);
    if (!existsSync(file)) return false;
    try {
      rmSync(file);
      rmSync(chatFilesDir(username, clean), { recursive: true, force: true });
      return true;
    } catch (err) {
      if (err.code === 'EBUSY' || err.code === 'EPERM') {
        throw Object.assign(new Error('File is locked by another process — try again.'), {
          statusCode: 409,
        });
      }
      throw err;
    }
  }

  // ── preferences ──────────────────────────────────────────
  const DEFAULT_PREFS = {
    // One default across all ten targets; the frontend derives whether that
    // is an image or a video model from the registry rather than storing it
    // twice. Replaced default_image_model/default_video_model on 20 Aug.
    default_model: 'illustrious',
    default_tagger: 'both',
    // Who reads a reference image you attach: the taggers, or the model you
    // write prompts with. 'taggers' is the default because it is what this
    // app has always done and it costs no GPU — the ONNX pair runs on a CPU
    // that is otherwise idle while the card writes prompts.
    //
    // Tab 3's analysis is unaffected and keeps its own tagger picker. This is
    // the reference cards only. See server/visiontags.mjs.
    reference_analysis: 'taggers',
    // The read-back is the point of attaching a picture, so it is what the
    // builder opens on. The chip list is one click away and loses nothing.
    reference_mode: 'analysis',
    // Which LLM writes your prompts. Empty means the one in server.yaml.
    //
    // This exists because the base model declines some of what this group
    // actually makes — an uncensored variant is a legitimate choice for
    // prompt writing on a Civitai box, and the alternative was editing config
    // and restarting the server for everyone.
    prompt_llm: '',
    chat_temperature: 0.7,
    // Which language the interface is drawn in. Per account rather than per
    // browser: localStorage would put someone signing in from a phone back
    // into a language they do not read, and picking once is the whole point.
    // Validated against LANGUAGES in server/preferences.mjs.
    language: 'en',
    // A line of your own in every prompt you generate. Empty is off, which
    // is the default, because a standing instruction nobody asked for would
    // change everyone's output the day it shipped.
    custom_instruction: '',
    // Per model, the id of a self-written system prompt to use INSTEAD of the
    // one this repo ships. Empty means everyone gets the shipped prompts,
    // which is the state the whole dialect suite describes.
    system_prompts: {},
    // Per model, the segment labels this person does not want written.
    // Same shape as system_prompts above and for the same reason: what a
    // Reasoning segment is worth differs by model — krea2's "What changed"
    // says what it rewrote, illustrious's explains a tag list — so this is
    // not one global switch. Empty means everyone gets every segment, which
    // is what the app did before the switch existed.
    omit_segments: {},
    force_search: 'auto',
    keep_datasets_by_default: false,
    // How the app looks, per person. 'midnight' is the original palette and
    // lives in styles.css :root rather than in a themes block, so it is the
    // one value that means "set no attribute at all". See web/themes.css.
    theme: 'midnight',
    font: 'default',
    text_size: 'normal',
    // The guided tour. 'unasked' puts one box in front of you after you sign
    // in, asking whether you want it; either answer is stored, so it is asked
    // once. Your account panel can start it again any time. Owner's call,
    // 15 Oct 2026: optional, offered once, and kept in settings.
    tour: 'unasked',
  };


  // Values written by an older version that no longer mean anything.
  //
  // `theme: "dark"` is the one that exists in the wild: DEFAULT_PREFS said so
  // until 26 Aug 2026, and setPrefs writes the WHOLE merged object, so every
  // account that ever saved a preference has it on disk — including the
  // owner's. The validator stopped accepting it, but the file still holds it,
  // and a stored value with no palette behind it is exactly the kind of thing
  // that lies dormant until someone adds a theme by that name.
  //
  // Rewritten on read rather than by a migration script, because there is no
  // migration step in this project and adding one for a single string would
  // be the larger change. Harmless if it never matches.
  const LEGACY_PREFS = { theme: { dark: 'midnight', light: 'paper' } };

  function migratePrefs(stored) {
    const out = { ...stored };
    for (const [key, map] of Object.entries(LEGACY_PREFS)) {
      if (typeof out[key] === 'string' && map[out[key]]) out[key] = map[out[key]];
    }
    return out;
  }

  function getPrefs(username) {
    const file = path.join(userDir(username), 'preferences.json');
    if (!existsSync(file)) return { username, ...DEFAULT_PREFS };
    try {
      return { username, ...DEFAULT_PREFS, ...migratePrefs(JSON.parse(readFileSync(file, 'utf8'))) };
    } catch {
      return { username, ...DEFAULT_PREFS };
    }
  }

  function setPrefs(username, patch) {
    const merged = { ...getPrefs(username), ...patch, username };
    writeJson(path.join(userDir(username), 'preferences.json'), merged);
    return merged;
  }

  function listUsers() {
    if (!existsSync(usersDir)) return [];
    return readdirSync(usersDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  }

  // ── shared notes on the installed LLMs ───────────────────
  //
  // "Have a user notes section for the LLMs so they can recommend each other
  // models based off what they are good at" - 25 Aug 2026. Shared rather than
  // per-user, and everyone may write: the whole point is that a note reaches
  // the other four, so a private scratchpad would be the wrong shape.
  //
  // One file rather than a directory per model. Five people and a handful of
  // models means the entire thing is a few kilobytes, and the read is the
  // common operation - the notes panel wants every model at once, which as
  // separate files would be one readdir plus N reads to answer one request.
  //
  // Keyed by the model tag exactly as Ollama reports it, so a note follows
  // the thing it is about. A model that is later removed keeps its notes; the
  // panel simply stops listing it, and pulling it again brings them back.
  const notesFile = path.resolve(
    rootDir,
    config.paths?.data ?? 'data',
    'llm-notes.json'
  );

  function readNotes() {
    try {
      const raw = readFileSync(notesFile, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      // Absent on a fresh install, and a corrupt file must not take the app
      // down over what is a comment board.
      return {};
    }
  }

  function writeNotes(all) {
    mkdirSync(path.dirname(notesFile), { recursive: true });
    writeJson(notesFile, all);
  }

  /** Every note, keyed by model tag, newest first within each model. */
  function listLlmNotes() {
    const all = readNotes();
    const out = {};
    for (const [model, entries] of Object.entries(all)) {
      if (!Array.isArray(entries)) continue;
      out[model] = [...entries].sort((a, b) => String(b.at).localeCompare(String(a.at)));
    }
    return out;
  }

  const NOTE_MAX_CHARS = 600;

  function addLlmNote(model, author, text) {
    const tag = String(model ?? '').trim();
    const body = String(text ?? '').trim();
    if (!tag) {
      throw Object.assign(new Error('Which model is the note about?'), { statusCode: 400 });
    }
    if (!body) {
      throw Object.assign(new Error('The note is empty.'), { statusCode: 400 });
    }
    if (body.length > NOTE_MAX_CHARS) {
      throw Object.assign(
        new Error(`Notes are capped at ${NOTE_MAX_CHARS} characters; that one is ${body.length}.`),
        { statusCode: 400 }
      );
    }
    const all = readNotes();
    const entry = {
      id: newId('note'),
      author: String(author ?? 'unknown'),
      text: body,
      at: new Date().toISOString(),
    };
    all[tag] = [...(Array.isArray(all[tag]) ? all[tag] : []), entry];
    writeNotes(all);
    return entry;
  }

  /**
   * Remove one note. The author may delete their own; the owner may delete
   * any. Everything else is a 403 rather than a silent no-op, or a note that
   * refuses to go would look like a bug.
   */
  function deleteLlmNote(model, id, { requester, isOwner = false } = {}) {
    const tag = String(model ?? '').trim();
    const all = readNotes();
    const entries = Array.isArray(all[tag]) ? all[tag] : null;
    if (!entries) return { ok: false, code: 404 };
    const found = entries.find((e) => e.id === id);
    if (!found) return { ok: false, code: 404 };
    if (!isOwner && found.author !== requester) return { ok: false, code: 403 };
    all[tag] = entries.filter((e) => e.id !== id);
    if (!all[tag].length) delete all[tag];
    writeNotes(all);
    return { ok: true };
  }

  /**
   * Rewrite one note's text. Same who-may rule as delete: the author, or the
   * owner. Asked for 11 Sep 2026 by a user — the only way to fix a typo was
   * to delete the note and post it again, which also reset its date.
   *
   * `at` is kept, so an edit does not jump a note to the top of the list, and
   * `edited_at` is stamped beside it so the panel can say it changed.
   */
  function editLlmNote(model, id, text, { requester, isOwner = false } = {}) {
    const tag = String(model ?? '').trim();
    const body = String(text ?? '').trim();
    if (!body) return { ok: false, code: 400, message: 'The note is empty.' };
    if (body.length > NOTE_MAX_CHARS) {
      return {
        ok: false,
        code: 400,
        message: `Notes are capped at ${NOTE_MAX_CHARS} characters; that one is ${body.length}.`,
      };
    }
    const all = readNotes();
    const entries = Array.isArray(all[tag]) ? all[tag] : null;
    if (!entries) return { ok: false, code: 404 };
    const found = entries.find((e) => e.id === id);
    if (!found) return { ok: false, code: 404 };
    if (!isOwner && found.author !== requester) return { ok: false, code: 403 };
    found.text = body;
    found.edited_at = new Date().toISOString();
    writeNotes(all);
    return { ok: true, entry: found };
  }
  // ── system prompts people write themselves ───────────────
  //
  // "The system prompt that would allow users to inject into a model like how
  // we do" — 28 Aug 2026. Not the generated output, which is the library
  // above: the INSTRUCTIONS. Someone writes their own Anima prompt, switches
  // it on, and generates against it instead of the one this repo ships.
  //
  // Two calls from the owner shape this, and both are load-bearing:
  //
  //   1. **A block REPLACES the model's file**, it does not append to it.
  //      Composition is house-rules plus their text — see prompts.mjs.
  //   2. **Blocks are visible to the group as they are written**, with no
  //      publish step. Five friends comparing prompt files is the point; a
  //      private draft nobody can see is the library's job, not this one.
  //
  // Consequence worth stating plainly: whoever writes a block owns the
  // segment contract for their own generations. A block that never says
  // `===SEGMENT: Positive prompt===` produces output the parser rejects, and
  // the generate route names the block in that error rather than blaming the
  // model. That is the deal, and it is why the shipped prompt is always one
  // click away.
  const blocksFile = path.resolve(
    rootDir,
    config.paths?.data ?? 'data',
    'system-prompts.json'
  );

  // A fresh install starts with the owner's proven blocks - Illustrious v2 and
  // Anima v3 to v5 plus the Gemma variant - rather than an empty list. Copied
  // once, only when this install has never had a blocks file, so a box with
  // its own (the P40) is never touched and deleting them all stays deleted.
  // The shipped copy is prompts/starter/system-prompts.json; the live one
  // stays gitignored, because what people write here is theirs.
  const starterFile = path.resolve(rootDir, 'prompts', 'starter', 'system-prompts.json');
  if (!existsSync(blocksFile) && existsSync(starterFile)) {
    try {
      mkdirSync(path.dirname(blocksFile), { recursive: true });
      writeFileSync(blocksFile, readFileSync(starterFile, 'utf8'), 'utf8');
    } catch (err) {
      console.warn(`[storage] could not copy the starter system prompts: ${err.message}`);
    }
  }

  // A model prompt is a big document — krea2.md is 11,600 characters and h3's
  // is far larger. This is generous on purpose; the cap exists to stop a
  // paste accident filling the disk, not to shape what anyone writes.
  const BLOCK_MAX = 40000;

  function readBlocks() {
    try {
      const parsed = JSON.parse(readFileSync(blocksFile, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeBlocks(all) {
    mkdirSync(path.dirname(blocksFile), { recursive: true });
    writeJson(blocksFile, all);
  }

  // Blocks written before 28 Aug 2026 carry a single `model`. Read through
  // this rather than migrating the file: one shape on disk that both readers
  // understand is cheaper than a migration step this project does not have.
  const modelsOf = (b) =>
    Array.isArray(b?.models) && b.models.length ? b.models : b?.model ? [b.model] : [];

  /** Every block, newest first. Bodies included: the point is reading them. */
  function listSystemPrompts() {
    return [...readBlocks()]
      .map((b) => ({ ...b, models: modelsOf(b) }))
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  }

  function getSystemPrompt(id) {
    const found = readBlocks().find((b) => b.id === id);
    return found ? { ...found, models: modelsOf(found) } : null;
  }

  /**
   * Write one, or edit one you already own.
   *
   * Editing is by id and restricted to the author — with the owner NOT
   * exempted, unlike deletion. Deleting someone's block is housekeeping;
   * silently rewriting the instructions they are generating against is
   * something else, and nobody should be able to do it.
   */
  function saveSystemPrompt(username, { id = null, title, models, body }) {
    const text = String(body ?? '').trim();
    const name = String(title ?? '').trim();
    if (!name) {
      throw Object.assign(new Error('Give it a name.'), { statusCode: 400 });
    }
    if (!text) {
      throw Object.assign(new Error('The prompt is empty.'), { statusCode: 400 });
    }
    if (text.length > BLOCK_MAX) {
      throw Object.assign(
        new Error(`System prompts are capped at ${BLOCK_MAX} characters; that one is ${text.length}.`),
        { statusCode: 400 }
      );
    }

    const all = readBlocks();
    const now = new Date().toISOString();

    if (id) {
      const existing = all.find((b) => b.id === id);
      if (!existing) {
        throw Object.assign(new Error('No system prompt by that id.'), { statusCode: 404 });
      }
      if (existing.author !== username) {
        throw Object.assign(
          new Error('Only the person who wrote it can edit it. Copy it instead.'),
          { statusCode: 403 }
        );
      }
      Object.assign(existing, { title: name, models, body: text, updated_at: now });
      writeBlocks(all);
      return existing;
    }

    const created = {
      id: newId('sys'),
      author: username,
      title: name,
      // Which models this is a prompt FOR — plural, from 28 Aug 2026.
      //
      // It began as one model per block for a good reason: an Anima prompt is
      // not an H3 prompt, and offering one where the other belongs is how ten
      // models start producing one dialect. But a booru prompt written well
      // for Illustrious usually runs on Pony and Anima too, and making
      // somebody paste it three times to say so was the wrong shape. The
      // author states where it works, the same way a shared prompt does.
      //
      // The route validates these against the registry, so a key here is a
      // model that exists.
      models,
      body: text,
      created_at: now,
      updated_at: now,
    };
    writeBlocks([...all, created]);
    return created;
  }

  /**
   * The group's default block for one model, or null (26 Sep 2026). It is what
   * everyone who has not picked something runs, in place of the shipped
   * prompt; "Base" is still there for anyone who picks it. An archived block
   * is never the default.
   */
  function defaultSystemPrompt(modelKey) {
    const found = readBlocks().find(
      (b) => !b.archived && Array.isArray(b.default_for) && b.default_for.includes(modelKey)
    );
    return found ? { ...found, models: modelsOf(found) } : null;
  }

  /**
   * Owner-only housekeeping (the route checks): archive or restore a block,
   * or make it the default for one model. Making one the default takes that
   * model off every other block, so a model has at most one. Archiving also
   * drops its defaults - an archived block is out of everyone's list.
   */
  function setSystemPromptFlags(id, { archived, defaultFor, isDefault } = {}) {
    const all = readBlocks();
    const found = all.find((b) => b.id === id);
    if (!found) throw Object.assign(new Error('No system prompt by that id.'), { statusCode: 404 });
    if (typeof archived === 'boolean') {
      found.archived = archived;
      if (archived) delete found.default_for;
    }
    if (defaultFor) {
      if (!modelsOf(found).includes(defaultFor)) {
        throw Object.assign(new Error(`That prompt is not written for ${defaultFor}.`), { statusCode: 400 });
      }
      if (isDefault && found.archived) {
        throw Object.assign(new Error('Restore it before making it the default.'), { statusCode: 400 });
      }
      for (const b of all) {
        if (Array.isArray(b.default_for)) b.default_for = b.default_for.filter((k) => k !== defaultFor);
        if (b.default_for && !b.default_for.length) delete b.default_for;
      }
      if (isDefault) found.default_for = [...(found.default_for ?? []), defaultFor];
    }
    writeBlocks(all);
    return { ...found, models: modelsOf(found) };
  }

  /** Author may delete their own; the owner may delete any. */
  function deleteSystemPrompt(id, { requester, isOwner = false } = {}) {
    const all = readBlocks();
    const found = all.find((b) => b.id === id);
    if (!found) return { ok: false, code: 404 };
    if (!isOwner && found.author !== requester) return { ok: false, code: 403 };
    writeBlocks(all.filter((b) => b.id !== id));
    return { ok: true };
  }

  /** Somebody else's block, copied so you can change it without touching theirs. */
  function copySystemPrompt(username, id) {
    const src = getSystemPrompt(id);
    if (!src) {
      throw Object.assign(new Error('No system prompt by that id.'), { statusCode: 404 });
    }
    return saveSystemPrompt(username, {
      title: `${src.title} (from ${src.author})`,
      models: modelsOf(src),
      body: src.body,
    });
  }

  return {
    listChats,
    getChat,
    createChat,
    appendMessage,
    deleteChat,
    setChatLocked,
    renameChat,
    setChatPinned,
    sweepChats,
    sweepAllChats,
    saveChatPicture,
    chatPicturePath,
    titleFromMessage,
    listLibrary,
    getLibraryEntry,
    saveLibraryEntry,
    deleteLibraryEntry,
    getPrefs,
    setPrefs,
    // Exposed so `npm run test-auth` can walk every key and hold each one to
    // being either round-trippable or named in preferences.mjs's UNACCEPTED
    // list. A key defined here and accepted nowhere returns 200 and stores
    // nothing, which is the failure mode that hid three of these until now.
    DEFAULT_PREFS,
    listLlmNotes,
    listSystemPrompts,
    getSystemPrompt,
    saveSystemPrompt,
    deleteSystemPrompt,
    defaultSystemPrompt,
    setSystemPromptFlags,
    copySystemPrompt,
    addLlmNote,
    editLlmNote,
    deleteLlmNote,
    listUsers,
  };
}
