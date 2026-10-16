# Anima — Hybrid tag + natural language prompt

The reference above specifies the format. This file covers what it does not.

Anima's text encoder is a **language model**, not CLIP. It parses sentences
properly and was also trained on Danbooru-tagged material, so it reads tags
natively too, and takes both mixed in one prompt. Two limitations that matter:
it does not do realism, whatever the brief's adjectives suggest, and it renders
text badly — one or two words at most.

## Write the picture before you write the tags

Describe the whole image to yourself in plain English first — subject and
count, then outfit, then expression and pose, then the setting, then framing
and camera, then the light. Complete sentences, no tags, no weights, no
quality words. Only then turn it into a prompt.

That draft is the source of truth for everything after it. Working the other
way round — reaching for tags and letting the vocabulary decide what the image
is — is how a brief turns into whatever the tag list happened to contain.

Two rules follow from it, and they are the point of the exercise:

- **The prompt may not contain anything the draft does not.** No tag because
  it usually accompanies another tag. No detail that arrived with the
  vocabulary rather than from the brief.
- **The prompt may not contradict or broaden the draft.** If the draft says
  one hand is raised, the prompt does not say `arms up`.

You do not emit the draft. In this model it becomes the prose half of the
positive prompt, and what it changes is the tag half: every tag traceable to
something you had already decided was in the picture.

## What the reference does not say

The **natural-language description goes last**, after the general tags, in the
same segment.

A scene with no people takes `no humans` in the subject-count slot, where
`1girl` would go. Without it this model puts a figure in the frame.

Anima was trained with random tag dropout, so a prompt need not enumerate every
visible fact. Prefer a few high-information tags over redundant synonyms.

**More than one character: one at a time, in order** — count first, then each
character complete, then their interaction and the background. Traits shuffled
together bleed between characters.

## The division of labour

**Tags for:** subject count, character identity, series, artist, quality, year,
safety, hair and eye colour, named garments, discrete objects — anything with a
canonical Danbooru tag the model learned as a unit.

**Prose for:** what the subject is doing, where things sit in relation to each
other, the camera's relationship to the scene, lighting direction and quality,
materials, atmosphere — anything a tag list flattens.

Both directions fail. Tagging a complex scene gives a pile of objects with no
arrangement. Describing eye colour in prose throws away precision the tag had
for free.

## Tag order

Quality and metadata, safety, subject count, character and series, physical
appearance, outfit, worn accessories and held props, expression and gaze, pose
and action, environment, framing and composition, then the prose.

## Writing a tag

- Lowercase, spaces not underscores — except `score_1` through `score_9`.
- Escape the parentheses in a disambiguated name: `2b \(nier:automata\)`.
- An artist tag takes `@`, and only when the brief asks for one. One artist by
  default; blend two only if asked.
- Drop a tag another tag already implies, and drop synonyms of one you kept.
- **Never invent a compound.** `wet_boots` is not a tag; `wet` and `boots`
  are. If you are unsure whether something is real, look it up rather than
  writing it — a made-up compound reads as neither a tag nor a phrase.
- Something with no safe tag — an exact count, a spatial relationship, how a
  garment is constructed, where the camera is — stays as a sentence in the
  prose. That is what the prose is for. Do not force it into a tag.

## Weighting

**Default to no weights.** Position and repetition do the work: a thing named in
the tag block *and* described in the sentence after it is emphasised more
reliably than a number.

When something genuinely needs force, weight **one** term and weight it hard.
`(chibi:2)` is the ordinary corrective and going above it is normal here.
**`1.1` and `1.3` are the mistake** — those are CLIP numbers, close enough to 1
to do nothing while still looking like an instruction. If a weight is worth
writing it is worth writing at 2 or above. Keep any weight the UI supplies
exactly as given.

## Length

Anima's own guidance is "more descriptive is better, aim for at least two
sentences", and short prompts give unpredictable results. Two sentences is the
floor, not the target.

## Reference documents

Four are available through `read_guidance` when the tool is offered:
`anima-model` for profiles and settings, `visual-direction` for which style,
camera, lighting, palette and material terms are real tags rather than plain
phrases, `showcase-patterns` for multi-character and environment-only scenes,
`layout-binding` for panels, grids and fixed regions.

Open one when a direction in the brief is one you cannot map confidently —
most often a lighting, lens or material term. Do not open one to check work
you are already sure of. If the tool is not there, everything above still
applies; the documents are depth, not the method.

## Before you answer

Every tag traceable to the picture you described. Every explicit thing in the
brief present as a tag or as prose. Nothing invented about a character's
colours, anatomy or outfit. No two terms that contradict each other.

## Example

Brief: *"2b from nier walking through a flooded overgrown ruin, ankle deep
water, vines growing through broken machinery"*
Preset: Masterpiece · Style: Cinematic lighting · Aspect: 3:2 Landscape ·
Detail: Very detailed

```
===SEGMENT: Positive prompt===
masterpiece, best quality, score_9, score_8, absurdres, newest, safe, 1girl, solo, 2b \(nier:automata\), nier:automata, cinematic lighting, white hair, short hair, black hairband, blindfold, covered eyes, mole under mouth, black dress, juliet sleeves, black gloves, thighhighs, ruins, flooded, shallow water, vines, moss, broken machinery, rubble, sunbeam, wading, She is mid-stride through still water that reaches just above her ankles, one foot lifted and trailing a thin curl of water, the hem of her dress darkened where it has wicked upward. Broken servos and a collapsed gantry lie half-submerged around her, their edges softened by moss and threaded through with pale green vines that climb toward the light. A single shaft of midday sun comes down through a hole in the ceiling ahead of her and lands on the water, throwing a shifting net of reflected light across the wall to her right and leaving the rest of the hall in cool shadow. The camera sits low and level with the surface, so the reflection fills the foreground and she is framed against the lit water beyond.
```

The prose never repeats a tag for its own sake. It says what the tags cannot:
where the weight is, where the camera is, which direction the light comes from.
That is the standard.
