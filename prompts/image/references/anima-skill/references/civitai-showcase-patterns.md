# Civitai official showcase patterns

Checked 2026-07-14 against the public official [Anima model page](https://civitai.com/models/2458426/anima). The sample set contains public, ordinary-rated showcase images posted by `circlestone_labs`:

- Aesthetic v1.0b: [136147968](https://civitai.com/images/136147968), [136147961](https://civitai.com/images/136147961), [136147960](https://civitai.com/images/136147960)
- Base v1.0: [130697922](https://civitai.com/images/130697922), [130697920](https://civitai.com/images/130697920), [130697924](https://civitai.com/images/130697924), [130697925](https://civitai.com/images/130697925), [130697933](https://civitai.com/images/130697933)
- Aesthetic v1.1: [136614294](https://civitai.com/images/136614294), [136614290](https://civitai.com/images/136614290), [136614296](https://civitai.com/images/136614296)

Use the findings below as structural evidence, not as a prompt corpus to copy verbatim.

## High-value patterns

1. Start with a small control block.
   - Base examples usually begin with human quality tags, `score_7`, and a safety tag.
   - Aesthetic examples begin with human quality tags and a safety tag, with no positive score tag.
   - Keep this block short; the showcase does not rely on long quality-token chains.

2. Build a character prompt in semantic layers.
   - Use subject count first.
   - Follow with character and series identity.
   - Add appearance, clothing, pose, expression, props, environment, lighting, and composition.
   - Do not separate identity from its defining traits by a long unrelated tag list.

3. Use a hybrid prompt for relationships.
   - Establish subjects and scene using tags.
   - Add one direct sentence that says who is doing what, where each subject is placed, or how a character relates to a large object.
   - Apply this pattern to groups, conversations, fights, picnics, character-plus-mecha scenes, and other relational compositions.
   - Extend this pattern to panel assignment by using complete English sentences, not comma fragments. See `layout-and-binding.md` for the validated structure and conflict-tag rules.

4. Escape literal parentheses in ComfyUI.
   - Character or series disambiguators appear as `name \(series\)`.
   - Keep weighting syntax unescaped, for example `(effect:2)`.
   - Avoid using parentheses when a plain unambiguous name works.

5. Weight only the concept that needs extra force.
   - Showcase prompts use a weight near `2` for a difficult effect or corrective concept.
   - Do not wrap most of the prompt in weights; start unweighted and add one targeted weight after a failed generation.

6. Keep multi-character prompts explicit.
   - State the exact subject count.
   - Name each character and the shared series.
   - Assign actions or expressions in a short sentence instead of relying on a bag of disconnected tags.

7. Mark environment-only images directly.
   - Use `no humans` before landscape or environment tags when people would be unwanted.
   - Then specify terrain, vegetation, water, architecture, weather, time, and composition.

8. Keep negatives compact.
   - Official examples use a short quality/artifact baseline.
   - Add anatomy, duplicate-subject, text, or watermark negatives only when relevant to the requested scene.

## Settings observed in the sample

- Base v1.0 examples: 30 steps, CFG 5, mostly `er_sde`; `beta57` appeared with a painterly artist-led composition.
- Aesthetic v1.0b examples: 30 steps, CFG 4, `er_sde` or Euler with the simple scheduler.
- Aesthetic v1.1 examples: 30 steps, usually CFG 4; a landscape example used CFG 6 and `beta57`.

Treat these as tested starting points. Retain the wider ranges from the model card for iteration.

## Resolve the Aesthetic score-tag discrepancy

The v1.0b showcase negatives include low score tags, but the author's model-level prompting guidance recommends omitting `score_*` tags from both positive and negative prompts for Aesthetic. Follow the model-level guidance by default. Reproduce the showcase-style score negatives only when the user explicitly asks to match those examples or reports better local results with them.
