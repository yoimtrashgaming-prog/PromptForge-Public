// Guidance documents, exposed as a function the model calls.
//
// Why this exists. A user's Anima skill is 54,000 characters across a method and
// four reference documents, and it works on his machine because a Codex skill
// is loaded progressively: the frontmatter description sits in context, the
// method loads when the skill triggers, and a reference loads only when the
// agent opens it. `visual-direction-tags.md` is 26 KB precisely because nobody
// ever reads all of it.
//
// Flattened into a system prompt that becomes ~13,300 tokens on every
// generation, against anima's ~2,545 today, and most of it unread. This gives
// our model the same deal Codex gives his: an index in the tool description,
// and the document itself only when it asks.
//
// **This file reports facts and gives no instructions**, the same rule
// server/tools.mjs follows. It hands back what the document says and nothing
// about what to do with it. What to do is policy, and policy lives in
// prompts/ — see prompts/_shared/guidance.md, appended only when the tool is
// actually offered.
//
// **Not every model gets this.** Tools are a capability the backend reports,
// and `hf.co/OBLITERATUS/Qwen3.8-27B-OBLITERATED:Q4_K_M` does not have it
// while the other Qwens on the box do. So every prompt that names guidance
// must still work with none of it readable — the documents are depth, never
// the method itself. Same rule as the tag search: degrade to exactly the
// behaviour of the day before this existed.

import { readFileSync, existsSync } from 'node:fs';
import { toolArguments } from './tools.mjs';
import path from 'node:path';

/** A document over this many characters is refused rather than truncated. */
const MAX_CHARS = 60_000;

/**
 * @param root  repository root; every path resolves under it
 * @param warn  where to report a document the registry names but disk lacks
 */
export function createGuidance(root, { warn = console.warn } = {}) {
  /**
   * The documents one model may read, from its registry entry.
   *
   * Shape in config/models.yaml:
   *
   *   guidance:
   *     visual-direction:
   *       path: "prompts/image/references/anima-skill/references/..."
   *       about: "one line the model reads to decide whether to open it"
   *
   * The `about` line is the whole index. It is what the model sees on every
   * generation, so it has to be worth its tokens and honest about what is
   * inside — a wrong one costs a round trip and returns something useless.
   */
  function entriesFor(model) {
    const declared = model?.guidance;
    if (!declared || typeof declared !== 'object') return [];
    const out = [];
    for (const [key, spec] of Object.entries(declared)) {
      const rel = typeof spec === 'string' ? spec : spec?.path;
      if (!rel) continue;
      // Never outside the repo. These paths are config, not user input, but a
      // config edit is exactly how a path escapes without anyone noticing.
      const abs = path.resolve(root, rel);
      if (abs !== path.resolve(root) && !abs.startsWith(path.resolve(root) + path.sep)) {
        warn(`[guidance] ${key}: path escapes the repository — ${rel}`);
        continue;
      }
      if (!existsSync(abs)) {
        // Missing is a warning and an absence, never a crash: these are
        // third-party documents fetched at setup on some boxes.
        warn(`[guidance] ${key}: not on disk — ${rel}`);
        continue;
      }
      out.push({ key, abs, about: typeof spec === 'string' ? '' : (spec?.about ?? '') });
    }
    return out;
  }

  /**
   * The schema handed to the backend, or [] when this model declares none.
   *
   * One tool with an enum rather than one tool per document: a model choosing
   * between five names in one schema is a smaller ask than five schemas, and
   * the enum is what stops it inventing a document that does not exist.
   */
  function definitions(model) {
    const entries = entriesFor(model);
    if (!entries.length) return [];
    const index = entries.map((e) => `"${e.key}" — ${e.about}`).join('; ');
    return [
      {
        type: 'function',
        function: {
          name: 'read_guidance',
          description:
            'Open one of this model\'s reference documents and read it in ' +
            'full. These hold detail the system prompt does not: catalogues, ' +
            'worked patterns, vocabulary. Read one when you are about to make ' +
            'a decision it covers, not before. Available: ' + index + '. Each ' +
            'call costs a full generation pass, so open a document because you ' +
            'need what is in it, not to check.',
          parameters: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                enum: entries.map((e) => e.key),
                description: 'Which document to open.',
              },
            },
            required: ['name'],
          },
        },
      },
    ];
  }

  /**
   * Read one document. Returns the toolbox result shape server.mjs expects.
   *
   * Every failure answers rather than throws, for the reason the tag search
   * gives: a thrown error costs the whole generation, and a model told plainly
   * that a document is unavailable can carry on with the method it already has.
   */
  function run(model, rawArgs) {
    // Parsed, not read straight off. The backend hands arguments over as a
    // JSON string and this read `args?.name` off it, so every call this tool
    // ever received answered "needs a document name" — see toolArguments.
    const args = toolArguments(rawArgs);
    // Whatever the model called the field. It is told `name` in the schema and
    // mostly sends that, but a tool whose whole job is one string should not
    // fail because the model wrote `document`; and a bare string is the name.
    const wanted = [args.name, args.document, args.doc, args.key, args.id, args.__text]
      .find((v) => typeof v === 'string' && v.trim())
      ?.trim() ?? '';
    if (!wanted) {
      const have = entriesFor(model).map((e) => e.key);
      return {
        ok: false,
        content: have.length
          ? `read_guidance needs a document name. Available: ${have.join(', ')}.`
          : 'This model has no reference documents.',
      };
    }

    const entry = entriesFor(model).find((e) => e.key === wanted);
    if (!entry) {
      const have = entriesFor(model).map((e) => e.key);
      return {
        ok: false,
        content: have.length
          ? `No document called "${wanted}". Available: ${have.join(', ')}.`
          : 'This model has no reference documents.',
      };
    }

    try {
      const text = readFileSync(entry.abs, 'utf8');
      if (text.length > MAX_CHARS) {
        // Refused whole rather than cut: half a catalogue read as if it were
        // the whole one is worse than none, because the model cannot tell.
        return {
          ok: false,
          content:
            `"${wanted}" is ${text.length} characters, over the ${MAX_CHARS} limit, ` +
            'and was not read. Work from the system prompt.',
        };
      }
      return { ok: true, content: text.trim(), document: wanted };
    } catch (err) {
      return { ok: false, content: `Could not read "${wanted}": ${err.message}` };
    }
  }

  return {
    definitions,
    run,
    /** Whether this model declares any readable document. */
    availableFor: (model) => entriesFor(model).length > 0,
    /** The keys a model can ask for, for tests and for the boot report. */
    keysFor: (model) => entriesFor(model).map((e) => e.key),
  };
}
