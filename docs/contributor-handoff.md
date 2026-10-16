# PromptForge — second contributor handoff

## If you are the human reading this

You do not need to understand any of this. Three steps:

1. Install [Node.js](https://nodejs.org). That is the only thing you need.

   You do **not** need Ollama, an AI model, or a GPU. Every task below is
   verified by tests that run offline. If `npm run doctor` warns about Ollama,
   ignore it.

2. Open a terminal and run these one at a time:

   ```
   git clone https://github.com/yoimtrashgaming-prog/PromptForge-public.git promptforge
   cd promptforge
   npm install
   npm run doctor
   ```

   Keep fixing what `doctor` tells you until it says **"Everything is ready."**

3. Open Claude Code in that folder and paste this:

   > Read `docs/contributor-handoff.md` and work through the tasks in the
   > order it gives. Follow its rules exactly. Push a branch per task and
   > tell me the branch names when you're done.

Then leave it alone. When it finishes, tell the owner the branch names.

### If the agent asks you a question

It shouldn't — everything is already decided below. But if it does, these are
the answers, and you can give them without knowing anything about the code:

| If it asks… | Say |
|---|---|
| "Should I fix this bug I found?" | **No. Write it in the PR description and move on.** |
| "Should I change a prompt file?" | **No. Never.** |
| "Should I push to main?" | **No. Branch only.** |
| "Which schema / name / approach should I use?" | **The one in the handoff doc.** |
| "Should I also do X while I'm here?" | **No. Only the listed tasks.** |
| "Tests are failing, should I change the test to pass?" | **No. Report it.** |
| Anything else | **"I don't know — leave it and ask the owner."** |

That last one is a correct answer here, not a cop-out. Nothing in these tasks
requires your judgement.

---

## Everything below is for the agent

You are contributing to someone else's project. The owner has final say. Land
well-defined changes without breaking things they care about.

**Read first:** [`../HANDOFF.md`](../HANDOFF.md) and [`../CLAUDE.md`](../CLAUDE.md).

**Do the tasks in this order: A, then C, then B.** A is the smallest, C is the
most valuable, B needs no code at all and can be done last.

### Rules that are not negotiable

Each has already cost this project time. Breaking one is worse than doing
nothing.

1. **Never edit anything under `prompts/`.** Those files are the product. Not
   a rewrite, not a summary, not a typo fix. If a task looks like it needs a
   prompt edit, it is out of scope — stop and say so.
2. **Never edit `config/` with PowerShell `Set-Content`.** It corrupts those
   files two ways: `Get-Content` decodes as ANSI so em-dashes become mojibake
   on *read*, and `-Encoding utf8` adds a BOM. `utf8NoBOM` does not exist in
   Windows PowerShell 5.1. **Use Node's `fs`.** This has already happened once.
3. **Never name a model in `web/app.js`.** No `if (model === 'h3')`, ever.
   Everything derives from `GET /api/models`. Per-model behaviour goes in the
   registry as *data*. This is the most important rule here.
4. **Found a bug? Report it, do not fix it.** Write it in the PR description.
   An unrequested fix in the same branch makes the change unreviewable, and
   the owner may already be working in that file.
5. **Never weaken a test to make it pass.** If a test fails, either your change
   is wrong or you found a real bug — see rule 4. Deleting the assertion is
   neither.
6. **Lowercase paths, LF line endings.** This project migrates to Linux.
7. **Run it before claiming it works.** Paste real output.

### Decisions already made — do not re-ask these

- Test files go in `scripts/`, named `test-*.mjs`, wired into `package.json`
  as `npm run test-<thing>`.
- Tests print `PASS` / `FAIL` per assertion and exit non-zero on failure.
  Copy the style from `scripts/test-failures.mjs` exactly.
- Tests must not need Ollama, a model, or a GPU.
- `npm run check` runs every suite that needs no model, in about 19 seconds,
  and prints one line each. Run it before you push. If it is green you have
  not broken anything that can be checked without a GPU.
- A test that cannot run (missing optional data) prints `SKIP` with the reason.
  It must never pass silently.
- One branch per task, named `task/<letter>-<short-name>`.
- Do not merge anything. Do not push to `main`.

### Git

```
git pull                       # main has moved; start from current
git checkout -b task/a-segment-field-aliases
# ...work...
git push -u origin task/a-segment-field-aliases
```

Commit messages here carry the *reasoning* and any measured evidence, not just
what changed. Match that.

---

## Task A — segment copy pastes a doubled field label

Code only. Do this first.

### The bug, measured

Generating with the `h3` model in T2VA mode, the `Music` segment body came back
as exactly:

```
non_diegetic_music: N/A
```

`stripPrefix()` in [`../web/app.js`](../web/app.js) builds its regex from the
segment's **UI label**. That label is `Music`, so the regex is
`^\s*Music\s*:\s*`. The body starts with `non_diegetic_music:`, which does not
match at `^`. The prefix survives the copy.

The user pastes into a ComfyUI node whose field is literally named
`non_diegetic_music`, and gets the label twice:

```
non_diegetic_music: non_diegetic_music: N/A
```

That defeats the stated purpose of the function — the comment above it says
copying "Summary" must not paste `summary:`.

**The prefix is intermittent, and that does not make the bug less real.**
`SKILL.md` tells the model to write `non_diegetic_music: N/A` for an absent
score, and across later runs it complied roughly two times in three. A
generation without the prefix proves nothing. Do not go hunting for it by
generating repeatedly — **you do not need a model at all**. `stripPrefix` is a
pure function of `(label, body)`; feed it the body above directly.

### Implement exactly this

A segment can have two names: a UI label (`Music`) and an official field name
(`non_diegetic_music`). Make that declared data, not a special case.

**1. `config/models.yaml`** — add an optional `segment_fields` map to a model.
Leave the existing `segments:` list of strings **exactly as it is**; nine other
models depend on it and the validator checks it. Add to the `h3` model only:

```yaml
segment_fields:
  Music: non_diegetic_music
```

Only that one entry. Other segments may deserve entries, but which ones is a
product decision belonging to the owner.

**2. `server/registry.mjs`** — accept `segment_fields` as optional. Validate
that every key also appears in that model's `segments` list, and fail at boot
naming the offending key if not. Match how the neighbouring checks report.

**3. `GET /api/models`** — include `segment_fields` in each model's payload.

**4. `web/app.js`** — `stripPrefix` strips **either** the UI label or the
declared field name. Pass the model's `segment_fields` in rather than reaching
for a global.

### Definition of done

Paste the output of each:

- `npm test` green. It cross-checks every model's segments against its prompt
  file. **Do not weaken that check.**
- `node scripts/test-segments.mjs` green.
- A new test: a body prefixed with the official field name, under a segment
  whose UI label differs, strips correctly.
- Existing behaviour intact: a plain-label prefix still strips, and a body with
  no prefix is untouched.
- This prints nothing:

  ```
  grep -nE "h3|illustrious|pony|krea2|flux|wan|ltx|cog|sdxl|anima" web/app.js
  ```

- `config/models.yaml` survived editing — this prints `true` then `false`:

  ```
  node -e "const t=require('fs').readFileSync('config/models.yaml','utf8');console.log(t.includes('—'),t.includes('â'))"
  ```

---

## Task C — tests for three untested surfaces

Do this second. It is the most valuable task here. Tests only: **you should not
be changing any file outside `scripts/` and `package.json`.**

Create `scripts/test-library.mjs`, wired as `npm run test-library`. Copy the
structure of `scripts/test-failures.mjs` — it already spawns a server on
`PROMPTFORGE_PORT`, waits for it, and tears it down. Use
`PROMPTFORGE_LLM_BACKEND=mock` so no Ollama is needed.

### 1. The owner gate

`CLAUDE.md` calls the admin surface a non-negotiable: enforced server-side, not
just a hidden button. Exactly one route is gated and **nothing verifies it**.

`POST /api/prompts/reload` reads the `x-promptforge-user` header and returns
403 `forbidden` unless it equals `owner_username` from `config/server.yaml`
(currently `owner`). Assert:

- no header → 403
- a non-owner name → 403
- the owner → 200, and the body reports a count of reloaded prompts
- the 403 body has `error: "forbidden"` and a message that explains the refusal

Read the owner name from `config/server.yaml` rather than hardcoding it, or the
test breaks the day it changes.

### 2. The library

`/api/library` is verified only by someone having clicked it once in a browser.
Routes, from [`../server.mjs`](../server.mjs):

| Method | Path | Expected |
|---|---|---|
| GET | `/api/library` | 200 `{ user, entries }` |
| GET | `/api/library/:id` | 200 the entry, or 404 `not_found` |
| POST | `/api/library` | 201 the saved entry |
| DELETE | `/api/library/:id` | 200 `{ deleted: id }`, or 404 |
| PUT | `/api/library` | 405 `method_not_allowed` |

Assert the round trip (save → appears in list → fetch by id → delete → gone),
the 404s, and the 405.

**Per-user separation matters most.** The user comes from `x-promptforge-user`,
defaulting to the owner. An entry saved as user X must not appear in a list
requested as user Y. Assert that explicitly.

**Use a throwaway username** like `testrunner_<random>` so the run does not
write into anyone's real library under `data/users/`. Delete what you create.

### 3. Tag variants

`archive/docs/status.md` claims: *"Illustrious gets `purple_hair`, Pony gets
`purple-hair` — the same query returns nothing for Pony under the wrong
variant."* That was checked by hand once. Pin it down.

`GET /api/tags/search?q=&variant=underscore|dash` and `&model=<key>`, which
derives the variant from that model's `tag_style`.

- `variant=underscore` returns `purple_hair`
- `variant=dash` returns `purple-hair`
- a model with `tag_style: underscore` gets the underscore spelling
- a model without it gets the dash spelling
- no model is named in the test — read the keys from `GET /api/models`

The tag database is optional and large. If it is absent, print `SKIP` with the
reason for this section only; the other two sections must still run.

### Definition of done

- `npm run test-library` passes, and its output is pasted.
- Every existing suite still passes: `npm test`,
  `node scripts/test-segments.mjs`, `npm run test-failures`,
  `npm run test-taggers`.
- `git diff --name-only main` lists only files under `scripts/` and
  `package.json`.
- Anything that failed and looked like a real bug is written up in the PR
  description and **left unfixed** (rule 4).

---

## Task B — does our H3 output fit the Director node?

Research only. Produces a document, not a code change. Do this last.

darksidewalker's `ComfyUI-DaSiWa-Nodes` has a MiniMax H3 Director node whose
three fields are `integrated_multimodal_description`, `overall_soundscape` and
`non_diegetic_music`. Those are not invented — they are exactly the three core
fields of H3's **base** format, per
[`../prompts/video/h3/references/h3-base-official.md`](../prompts/video/h3/references/h3-base-official.md)
section 2.2, which is committed in this repo.

Read the node's source and answer three questions:

1. Does it match on field *names*, or take free text per field? This decides
   whether label mismatches matter at all.
2. It has three fields. H3's full-reference format has **six** sections (see
   `h3-reference-official.md` section 1). Is there a path for the other three,
   or does full-reference output simply not fit this node?
3. Does it impose its own character limit, or rely on H3's 7,000?

Write the answer into
[`../PromptForge-Project-Context.md`](../PromptForge-Project-Context.md) — the
project's "why" document, where findings belong. Change no code.

---

## Explicitly NOT yours

Listed so you do not wander in thinking you are helping.

- **Anything in `prompts/`.**
- **Tab 4 (Tag Suggestions) and Tab 5 (Chat).** Real work exists there and the
  owner may hand it over later. Do not start it unasked.
- **Tab 3 / image analysis, `server/taggers.mjs`, `config/taggers.yaml`.** The
  owner is actively working in these files. Touching them causes conflicts.
- **`thinking: true` for h3.** It is `false` deliberately. Turning it on makes
  the model brute-force a character count and never answer. Diagnosis is in the
  context doc under "The H3 counting loop".
- **The Pony dash/space question** in the context doc under "Open: Pony gets
  dashes". It needs a loaded 27B and judgement about output quality.
- **Docker, SearXNG, TrainFlow.**

Finished all three and want more? Ask the owner rather than picking something.
