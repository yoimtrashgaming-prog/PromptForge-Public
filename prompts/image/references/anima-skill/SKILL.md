---
name: anima-prompt-writing
description: "Create or revise CircleStone Labs Anima prompts through a mandatory two-pass workflow: first a complete natural-language visual description, then a faithful ordered mapping to verified Danbooru/Gelbooru tags and clearly separated Anima text modifiers. Use for Anima prompts, Danbooru-style prompt conversion, and visual-direction prompting for Anima."
---

# Anima Two-Pass Prompt Writing

Turn a visual brief into an Anima-ready prompt without letting tag vocabulary distort the user's idea. Always establish the image in natural language first, then map that established description to tags.

## Load the references

Always read [references/anima-prompting.md](references/anima-prompting.md) for model profiles, syntax, negative baselines, and settings.

Read [references/visual-direction-tags.md](references/visual-direction-tags.md) before mapping any requested style, camera, composition, focus, lighting, palette, atmosphere, weather, material, or post-processing direction. It distinguishes native booru tags from Anima-compatible text modifiers.

Read [references/civitai-showcase-patterns.md](references/civitai-showcase-patterns.md) for ordinary multi-character scenes, literal tag disambiguators, environment-only images, or requests based on Civitai examples.

Read [references/layout-and-binding.md](references/layout-and-binding.md) whenever the request contains panels, grids, comics, collages, fixed regions, exact named-character placement, or a hard no-crop/no-overflow requirement.

## Use the bundled local data

Resolve every data path relative to this skill directory. Do not assume a specific user name, drive, Desktop folder, QWEN UI installation path, or network connection.

- Search [data/anima-1.0.csv](data/anima-1.0.csv) before web lookup when verifying whether a candidate term is a known tag. Its columns are `tag`, `category`, `post_count`, and `aliases`. Prefer the canonical value in the first column; convert underscores to spaces only when formatting the final Anima prompt.
- Read the `body` field of [data/danbooru-attire.json](data/danbooru-attire.json) when identifying or classifying garments, footwear, jewelry, worn accessories, patterns, or costume types.
- Consult [data/character-appearance-cache.json](data/character-appearance-cache.json) for a character already present in the cache. Treat cached frequencies as candidate evidence, not ground truth. Separate `tags` from `attireTags`, ignore expired metadata as an authority claim, and never infer colors or anatomy from low-frequency associations alone.
- Prefer a user-provided image or explicit description over cached data whenever they disagree.
- Web verification remains optional for missing characters, newly released designs, artist aliases, or uncertain tags. The core skill must still work offline with the bundled references and data.

## Non-negotiable two-pass workflow

### Pass 1 — Natural-language visual draft

Write the intended image entirely in grammatical English prose before selecting tags.

- Use complete sentences, not comma-separated tag fragments.
- Do not use Danbooru syntax, prompt weights, quality tokens, artist tokens, or negative tags in this pass.
- Resolve the visible image in this order:
  1. subject identity, count, and defining physical appearance;
  2. outfit, worn accessories, and held props;
  3. expression, gaze, pose, action, and interactions;
  4. environment, background, foreground, and spatial relationships;
  5. framing, composition, viewpoint, camera angle, lens behavior, and focus;
  6. light sources, light direction, exposure, palette, atmosphere, effects, and rendering style.
- Preserve every explicit user constraint.
- Fill harmless omissions only when needed for a coherent image.
- Never invent character colors, anatomy, outfit details, props, or identity traits.
- If the user requests only one domain, such as physical appearance, keep the natural-language draft strictly inside that domain.
- For a named or referenced character, describe the core visible traits even when using the name. Verify unfamiliar or unstable character details from an authoritative visual reference when available.

The natural-language draft is the semantic source of truth for all later output.

### Pass 2 — Tag audit and mapping

Read Pass 1 again from the beginning. Extract only concepts that are actually present, then map them to vocabulary supported by Anima.

Use this exact order for the core positive prompt:

1. **Quality, metadata, period, and safety**
2. **Subject count**
3. **Character identity and series/copyright**
4. **Physical appearance**
5. **Outfit**
6. **Worn accessories and held props**
7. **Expression and gaze**
8. **Pose, action, and interaction**
9. **Environment and background**
10. **Framing and composition**
11. **Viewpoint and camera angle**
12. **Lens, perspective, focus, and depth**
13. **Lighting source, direction, and quality**
14. **Color palette, atmosphere, and mood**
15. **Environmental effects, post-processing, materials, and finish**

Mapping rules:

- Prefer verified, concise Danbooru/Gelbooru tags for concrete visible concepts.
- Use lowercase and spaces instead of underscores, except in `score_1` through `score_9`.
- Prefix verified artist tags with `@`.
- Escape literal disambiguation parentheses for ComfyUI, for example `kiriko \(overwatch\)`.
- Remove redundant synonyms and tags already implied by a more precise tag.
- Do not add a tag merely because it commonly accompanies another tag.
- Do not convert uncertainty into a false visual fact.
- Do not present invented English fragments as official booru tags.
- Put Anima-compatible non-booru phrases in a separately labeled **Text modifiers** line.
- When a spatial relationship, exact count, garment construction, or camera geometry has no safe tag equivalent, retain it as a complete sentence in **Natural-language remainder**.
- The tag pass must never contradict or broaden Pass 1.

## Required versus optional content

The **Core tags** contain only information explicitly requested, visibly necessary, or already fixed by the source material.

Place discretionary visual suggestions under **Optional tags**, grouped by purpose. Useful optional groups include:

- style and medium;
- period and metadata;
- artist influence, only when requested and verified;
- framing and lens;
- advanced lighting;
- palette and mood;
- weather and particles;
- realism, skin, fabric, and material rendering;
- optical effects and color grading;
- extra quality intensifiers.

Optional suggestions must obey these limits:

- Never propose a different character identity, anatomy, hair or eye color, body type, outfit, sexualization level, or extra subject as an optional enhancement.
- Never insert optional terms into the core prompt without the user's request.
- Offer a small coherent selection, not a dump of the catalogue.
- Flag mutually exclusive options as alternatives.
- Omit the optional section when no suggestion would materially help.

## Style and artist handling

- Do not add an artist tag unless the user supplies one or asks for a recommendation.
- Verify artist tags with Anima Style Explorer when network access is available.
- Use one primary artist by default. Blend two only when explicitly requested.
- If verification fails, describe visual traits with general tags or natural language.
- Treat `photorealistic` as a directional influence, not a guarantee; Anima is primarily an illustration model.

## Structured layouts and identity binding

For multiple characters or fixed regions:

- Define the overall layout and exact subject count in Pass 1.
- Bind each identity to appearance, position, and action in a complete sentence.
- State that each distinct character appears once when that is required.
- Define margins and containment when cropping matters.
- Avoid tags such as `multiple views`, `collage`, `everyone`, or `group picture` when they conflict with distinct identity-to-region binding.
- Prefer natural-language binding over pseudo-tags. Use masks, regional conditioning, or deterministic assembly only when requested or after a well-formed single-pass prompt fails.

## Negative prompt

Build the negative prompt only after both positive passes are complete.

- Start from the selected model profile's baseline.
- Add only failure modes relevant to the established image.
- Do not negate requested attributes.
- Express exact-count, identity-duplication, shared-body, wrong-region, or border-crossing failures as one clear English sentence before verified negative tags.
- Avoid indiscriminate negative-tag dumps.

## Settings

Follow an explicitly named Anima variant. Otherwise default to Anima Base v1.0 and disclose the assumption briefly.

Choose resolution, sampler, scheduler when relevant, steps, and CFG from the model reference. Treat settings as starting points, not guarantees.

## Default output

Return both passes unless the user explicitly asks for only one format.

**Natural-language prompt**

```text
[Pass 1: complete grammatical English description]
```

**Core tags**

```text
[Pass 2: ordered, copy-ready native tags]
```

**Text modifiers**

```text
[requested Anima-compatible non-booru phrases]
```

**Natural-language remainder**

```text
[only relationships or constraints that cannot be mapped safely]
```

**Optional tags**

List compact groups with their intended effect. Omit when unnecessary.

**Negative prompt**

```text
[scene-relevant negative prompt]
```

**Settings:** model, resolution, sampler, scheduler if relevant, steps, CFG.

Omit empty sections. If the user asks for only a prompt, keep the response copy-ready and omit commentary that is not needed to use it. When revising an existing prompt, change only the requested dimensions while still performing the two-pass audit internally.

## Final consistency check

Before responding, verify that:

- every core tag can be traced to Pass 1;
- every explicit detail from Pass 1 is represented by a tag, text modifier, or natural-language remainder;
- core and optional content are not mixed;
- no character trait or color was inferred from lighting, shadows, or stylized highlights;
- no requested constraint is contradicted;
- no mutually exclusive style, lighting, focus, period, or palette terms appear together accidentally.
