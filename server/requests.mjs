// Model requests: someone asks the owner to pull an LLM, the owner says yes or
// no.
//
// Box-wide rather than per-user, so these live in data/requests/ beside the
// queue rather than under data/users/{name}/. One JSON file per request, same
// reasoning as the library and the chats: five people, a handful of files, and
// a directory listing is a perfectly good index at that size.
//
// The spec's line is "users submit requests from the Chat tab (name, link,
// reason). The owner approves (triggering a pull) or denies." **Nothing here
// pulls anything.** Downloading a 17GB model onto a shared box is Tab 6's
// installed-models surface, which is out of scope; approving records the
// decision and hands the owner the exact command. A request that silently
// started a multi-gigabyte download from a modal would be a worse answer than
// one that says what to run.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const newId = () => `req_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

// Same shape rule as storage.mjs: ids become filenames, so they must not
// escape the requests directory.
const ID_SHAPE = /^req_[a-z0-9]{8,64}$/;
const safeId = (id) => (ID_SHAPE.test(String(id ?? '')) ? String(id) : null);

const STATUSES = ['pending', 'approved', 'denied'];

// An Ollama tag, or a Hugging Face one — `hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q3_K_XL`
// is a real tag on this box, so the pattern has to allow slashes and dots. What
// it must not allow is whitespace or a shell metacharacter, because the whole
// point of approving one is that the owner pastes it into a terminal.
const TAG_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,120}$/;

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * A link is optional and comes from a person typing into a box, so it is
 * checked rather than trusted: http and https only.
 *
 * Fails closed for the same reason the search parser does — a `javascript:`
 * URL rendered as a link in the owner's admin panel is the one thing in this
 * feature that could do real damage, and the owner is exactly the account
 * where it would matter most.
 */
function cleanUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw bad('That link is not a URL. Paste the full address, or leave it blank.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw bad('Links have to be http or https.');
  }
  return parsed.href;
}

export function createRequestStore(rootDir, config) {
  const dir = path.resolve(rootDir, config.paths?.requests ?? 'data/requests');
  mkdirSync(dir, { recursive: true });

  const fileFor = (id) => path.join(dir, `${id}.json`);

  function read(id) {
    const clean = safeId(id);
    if (!clean) return null;
    const file = fileFor(clean);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      // One unreadable request must not empty the owner's list.
      console.warn(`[requests] skipping unreadable request ${clean}`);
      return null;
    }
  }

  function write(entry) {
    writeFileSync(fileFor(entry.id), JSON.stringify(entry, null, 2), 'utf8');
    return entry;
  }

  /** Everything, newest first. Pending ones first within that, since those are the ones with a decision waiting. */
  function list() {
    const out = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        out.push(JSON.parse(readFileSync(path.join(dir, file), 'utf8')));
      } catch {
        console.warn(`[requests] skipping unreadable request ${file}`);
      }
    }
    return out.sort((a, b) => {
      const pending = Number(b.status === 'pending') - Number(a.status === 'pending');
      return pending || String(b.created_at).localeCompare(String(a.created_at));
    });
  }

  /** One person's own requests, so the form can say what happened to the last one. */
  function listFor(username) {
    return list().filter((r) => r.user === username);
  }

  function create(username, { tag, url, reason }) {
    const wanted = String(tag ?? '').trim();
    if (!wanted) throw bad('Name the model — the Ollama tag if you know it.');
    if (!TAG_SHAPE.test(wanted)) {
      throw bad(
        'That does not look like a model tag. Expected something like ' +
          'family:size, with no spaces.'
      );
    }

    // A second request for something already waiting is noise in the owner's
    // list, not a second vote. Says who asked, because "someone already asked"
    // without a name reads as the app losing the request.
    const open = list().find((r) => r.status === 'pending' && r.tag === wanted);
    if (open) {
      throw bad(
        open.user === username
          ? `You already asked for ${wanted} — it is still waiting on the owner.`
          : `${open.user} already asked for ${wanted}, and it is still waiting on the owner.`,
        409
      );
    }

    return write({
      id: newId(),
      user: username,
      tag: wanted,
      url: cleanUrl(url),
      reason: String(reason ?? '').trim().slice(0, 1000),
      status: 'pending',
      created_at: new Date().toISOString(),
      decided_by: null,
      decided_at: null,
      note: '',
    });
  }

  /**
   * Approve or deny. Records who decided and when.
   *
   * A decision is not undoable through this — re-deciding something already
   * settled is a 409 rather than a silent overwrite, so two owners clicking at
   * once cannot produce a record that disagrees with what either of them saw.
   */
  function decide(id, verb, by, note) {
    const entry = read(id);
    if (!entry) throw bad('No such request.', 404);
    if (verb !== 'approve' && verb !== 'deny') {
      throw bad(`Unknown verb "${verb}" — approve or deny.`);
    }
    if (entry.status !== 'pending') {
      throw bad(`That request was already ${entry.status}.`, 409);
    }
    entry.status = verb === 'approve' ? 'approved' : 'denied';
    entry.decided_by = by ?? null;
    entry.decided_at = new Date().toISOString();
    if (note != null) entry.note = String(note).trim().slice(0, 1000);
    return write(entry);
  }

  /** Removing a settled request is how the list stays short. Pending ones are decided, not deleted. */
  function remove(id) {
    const entry = read(id);
    if (!entry) return false;
    if (entry.status === 'pending') {
      throw bad('Decide it first — a pending request is answered, not discarded.', 409);
    }
    rmSync(fileFor(entry.id));
    return true;
  }

  function info() {
    const all = list();
    return {
      dir,
      total: all.length,
      pending: all.filter((r) => r.status === 'pending').length,
    };
  }

  return { list, listFor, get: read, create, decide, remove, info, STATUSES };
}
