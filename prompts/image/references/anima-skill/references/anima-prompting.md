# Anima prompting reference

Use this reference for CircleStone Labs Anima Base, Aesthetic, Aesthetic v1.0b, Aesthetic v1.1, and Turbo.

## Model profiles

| Variant | Positive prefix | Negative baseline | Steps | CFG |
|---|---|---|---:|---:|
| Base | `masterpiece, best quality, score_7, safe` | `worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration` | 30-50 | 4-5 |
| Aesthetic 1.0 / 1.0b | `masterpiece, best quality, safe` | `worst quality, low quality, artist name, blurry, jpeg artifacts, chromatic aberration` | 30-50 | 4-5 |
| Aesthetic 1.1 | `masterpiece, best quality, safe` | `worst quality, low quality, artist name, blurry, jpeg artifacts, chromatic aberration` | 30-50 | 3-6; start at 4 |
| Turbo | `masterpiece, best quality, score_7, safe` | `worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration` | 8-12 | 1 |

Treat `safe` as the ordinary SFW default only when it matches the request. Replace it with the appropriate supported safety tag when needed.

Anima-Aesthetic was tuned on high-quality images after quality labels were removed. Omit `score_*` tags by default for Aesthetic 1.0, v1.0b, and v1.1. Do not strip them from an existing prompt or workflow that the user has already verified locally; empirical local results override this default heuristic.

Aesthetic v1.1 is a partially retrained revision intended to smooth the style and reduce artifacts while retaining detail. Keep Base v1.0 as the general default for this personal skill because it matches the user's current workflow. Prefer v1.1 when available for long English descriptions, complex pose geometry, camera instructions, or structured panel binding.

Anima Base is deliberately neutral and flexible. Give it clearer style, quality, and visual-direction tags than Aesthetic. Prefer Base for LoRA training prompts and maximum style adherence.

## Syntax and ordering

- Use lowercase for tag-style prompts.
- Replace tag underscores with spaces; keep the underscore only in `score_1` through `score_9`.
- Prefix an artist with `@`, for example `@artist name`.
- Escape literal tag disambiguators for ComfyUI, for example `kiriko \(overwatch\)`. Reserve unescaped parentheses for prompt weighting such as `(glitch:2)`.
- Prefer the Gelbooru spelling when Danbooru and Gelbooru use different versions of a tag.
- Use stronger weights than typical SDXL prompts when weighting is necessary; the model author's example is `(chibi:2)`.
- Order tags as follows:
  1. quality, meta, year, and safety
  2. subject count such as `1girl`, `1boy`, or `2girls`
  3. character name
  4. series or copyright
  5. artist
  6. general appearance, pose, clothing, scene, lighting, and composition

Random tag dropout was used during training, so completeness is not the goal. Prefer high-information tags and remove redundant synonyms.

## Artist and tag lookup

- Browse [Anima Style Explorer](https://anima.mooshieblob.com/) to inspect artist previews and copy the displayed artist identity.
- Search [Danbooru](https://danbooru.donmai.us/) when a character, series, artist alias, or general tag is uncertain.
- Convert a verified artist token to Anima prompt form: add `@`, use lowercase, and replace underscores with spaces.
- Preserve meaningful punctuation and disambiguators when they identify a specific tag.
- If live lookup is unavailable, label the artist/tag as unverified or replace it with a plain visual description.

## Natural-language and mixed prompts

Anima accepts Danbooru-style tags, natural-language captions, and mixtures of both.

- Treat the Qwen text encoder as capable of detailed English caption following, not merely isolated simple phrases.
- Use tags to establish identity, series, style, quality, subject count, medium, and common visual concepts.
- Use complete English sentences to define clothing construction, limb and hand geometry, pose sequence, camera angle, foreshortening, environment, and exact spatial relationships.
- Organize a complex natural-language prompt into visual layers: subject and clothing; pose and expression; environment and camera; layout and containment when needed.
- Prefer concrete visual statements over abstract quality prose. Describe what must be visible and how elements relate in the frame.
- For pure natural language, use normal English capitalization and write at least two descriptive sentences.
- For named characters, state both the name and core visual traits.
- For multiple characters, bind each name to appearance, placement, and action to reduce identity mixing.
- Use natural language for spatial relationships, cause-and-effect, and narrative staging that tags express poorly.
- Write natural language as complete captions for visible content. Do not turn layout instructions into comma-separated pseudo-tags.
- For structured panels, define the overall grid first, state that the subjects are distinct and appear once, assign each subject in a full sentence, then state the containment requirement.
- Use a complete negative sentence for duplicated identities, wrong regions, shared bodies, or border crossing before the negative tag list.
- For a non-human scene, place `no humans` immediately after the quality/meta/safety block.

Example mixed structure:

```text
masterpiece, best quality, safe, 2girls, character a, series name, character b, series name, rooftop, sunset, cinematic composition. Character A stands near the railing while Character B approaches from the stairwell; warm backlight separates both silhouettes.
```

## Samplers and resolution

- Use `er_sde` as a neutral default for flat colors and sharp lines.
- Use `euler_a` for softer, thinner lines and a possible 2.5D tendency.
- Use `dpmpp_2m_sde_gpu` for more variation and creative interpretation.
- Use `euler` for a simple, somewhat more creative choice, especially with Turbo or Aesthetic.
- Consider the `beta57` scheduler for more realistic or painterly texture when the required ComfyUI custom nodes are installed.
- Keep total pixel dimensions within the documented 512-square to 1536-square range. Choose portrait, landscape, or square according to the composition.

## Sources

- [CircleStone Labs Anima model card](https://huggingface.co/circlestone-labs/Anima)
- [Anima Style Explorer](https://anima.mooshieblob.com/)
- [Danbooru](https://danbooru.donmai.us/)
