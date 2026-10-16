# A contributor's Anima prompt-writing skill, as received

Dropped in 4 Sep 2026 from `anima-prompt-writing-portable.zip`. This is his
package, unedited, kept whole so the original is always recoverable — when his
build and ours disagree about Anima, his is the better prior.

**Nothing here is loaded by the app yet.** `config/models.yaml` still points
anima at `prompts/image/anima-min.md` and `anima-official.md`. Adapting it is a
separate decision, and the reason is a budget:

| | tokens |
|---|---|
| anima's system prompt today | ~2,545 |
| this package, loaded whole | ~13,300 |

## Why it cannot just be pointed at

It is written for a Codex agent with a filesystem, and says so throughout:
*"Read references/visual-direction-tags.md before mapping any requested
style"*, *"Search data/anima-1.0.csv before web lookup"*. Our model gets one
static system prompt and no file access, so every conditional read has to
become unconditional context. That is the whole of the 5x.

Three other things would have to change:

1. **The output contract.** The skill returns six labelled blocks — Natural-
   language prompt, Core tags, Text modifiers, Natural-language remainder,
   Optional tags, Negative prompt, plus a Settings line. The app parses
   `===SEGMENT: Label===` and anima declares three segments: Positive prompt,
   Negative prompt, Reasoning. Something has to give, and which way is a
   product call rather than a mechanical one.

2. **The data files.** Two of the three duplicate work the server already does,
   which is why they are not in this folder:

   - `anima-1.0.csv` (3.1 MB) — tag, category, post_count, aliases. This is our
     tag database. The model already reaches it through the tag-search tool and
     through `server/candidates.mjs`, both of which verify against real post
     counts rather than a snapshot.
   - `character-appearance-cache.json` (62 KB) — cached character appearance.
     This is `characterCanon()` in server.mjs plus `server/traits.mjs`, which
     resolves from danbooru live and caches for 30 days. A frozen copy would
     go stale and would argue with the live one.

   `danbooru-attire.json` (15 KB) IS kept: a garment/footwear/jewelry taxonomy
   is something we have no equivalent of, and it is small enough to be usable.

3. **The two-pass method is the valuable part.** Prose first, then an ordered
   map to verified tags, with a rule that the tag pass may never contradict or
   broaden the prose pass. That is a method, not a catalogue, and it is roughly
   2,400 tokens rather than 13,000. `visual-direction-tags.md` is 26 KB of
   lookup table — the kind of thing that belongs behind a tool, not in front of
   a model on every generation.

## If it is adapted

Keep this folder as received. Write the adaptation into `prompts/image/` like
every other prompt file, and cite this as the source.
