# Anima — Hybrid tag + natural language prompt

Anima's text encoder is a **language model**, not CLIP. It parses sentences
properly and was also trained on Danbooru-tagged material, so it reads tags
natively too, and takes both mixed in one prompt. Two limitations that matter:
it does not do realism, whatever the brief's adjectives suggest, and it renders
text badly — one or two words at most.

## Segments to emit

1. `Positive prompt`
2. `Negative prompt`
3. `Reasoning`

## The format, from the model card

From `huggingface.co/circlestone-labs/Anima`, read 30 August 2026. This is the
authoritative source on the format; where anything below disagrees with it,
the card is right.

Tag order:

```
[quality/meta/year/safety tags] [1girl/1boy/1other etc] [character] [series] [artist] [general tags]
```

Order *within* a section does not matter.

| Category | Values |
|---|---|
| Quality, human-scored | `masterpiece`, `best quality`, `good quality`, `normal quality`, `low quality`, `worst quality` |
| Quality, aesthetic-model | `score_9` down to `score_1` |
| Year, specific | `year 2025`, `year 2024`, … |
| Year, period | `newest`, `recent`, `mid`, `early`, `old` |
| Meta | `highres`, `absurdres`, `anime screenshot`, `jpeg artifacts`, `official art` |
| Safety | `safe`, `sensitive`, `nsfw`, `explicit` |
| Artist | `@`-prefixed, e.g. `@big chungus`. **The `@` is mandatory.** |

- Lowercase, spaces rather than underscores. **Score tags are the exception**
  and keep theirs: `score_7`.
- Where Danbooru and Gelbooru disagree on a spelling, prefer the **Gelbooru**
  form.
- Weighting needs **higher values than usual** here — the card's own example is
  `(chibi:2)`.
- Tags, natural language, or both mixed in any order are all supported. Use
  **standard English capitalisation** for character and series names in the
  natural-language portion; tags stay lowercase.
- Aim for **at least two sentences** when writing descriptively.

## Write the picture before you write the tags

Describe the whole image to yourself in plain English first — subject and
count, then outfit, then expression and pose, then the setting, then framing
and camera, then the light. Complete sentences, no tags, no weights, no
quality words. Only then turn it into a prompt.

That draft is the source of truth for **what is in the picture**. Working the
other way round — reaching for tags and letting the vocabulary decide what the
image is — is how a brief turns into whatever the tag list happened to contain.

Two rules follow from it, and they govern the *facts* of the scene: the
subject, their appearance, what they wear, what they hold, what they are doing,
and what is around them.

- **No scene fact the draft does not have.** No tag because it usually
  accompanies another tag. No object, no character, no garment that arrived
  with the vocabulary rather than from the brief.
- **Nothing that contradicts or broadens the draft.** If the draft says one
  hand is raised, the prompt does not say `arms up`.

**These rules do not govern the style layer.** Camera, lens, focus, light
quality, palette, grain, finish and mood are not facts about what is in the
picture — they are directions about how it is rendered, and they do not have to
appear in the prose to belong in the prompt. Adding `cinematic lighting` or
`subtle film grain` to a scene whose draft never mentions them invents nothing.
Adding a lantern does. That is the line.

You do not emit the draft. In this model it becomes the prose half of the
positive prompt.

## The division of labour

Three kinds of term, and the middle one is what this model is unusual for
having.

**Native tags** — subject count, character identity, series, artist, quality,
year, safety, hair and eye colour, named garments, discrete objects, and any
camera or light fact that has a real Danbooru tag: `close-up`, `depth of
field`, `from side`, `sidelighting`, `dappled sunlight`, `backlighting`.
Anything the model learned as a unit.

**Text modifiers** — the visual direction that has no native tag.
`extreme close-up`, `shallow depth of field`, `cinematic lighting`,
`volumetric lighting`, `warm highlights and cool shadows`, `subtle film grain`,
`detailed hair strands`, `realistic fabric`, `creamy bokeh`, `layered depth`,
`poignant atmosphere`. Plain lowercase English, comma-separated, sitting in the
list alongside the tags. Anima's encoder is a language model and reads them as
directions; Danbooru has never heard of them. They **supplement** native tags
and never replace one that exists — if `sidelighting` is a real tag, use it,
and do not put `side lighting` next to it.

**Prose** — what the subject is doing, where things sit in relation to each
other, an exact count, how a garment is constructed. Anything that needs a
sentence to be true.

All three fail alone. Tagging a complex scene gives a pile of objects with no
arrangement. Describing eye colour in prose throws away precision the tag had
for free. And a prompt with no modifiers at all comes back correct and flat —
every fact present, none of the photography.

## Cover the directions, do not drop them

Every camera, composition, focus, lighting, atmosphere, effect, material and
finish direction that matters in this image must land somewhere: a native tag
if one exists, a text modifier if not. Do not quietly drop one because neither
came to mind.

**Scale the coverage to the Details level.** Low notches take a short set. At
7 and above, map systematically — framing, then lens and focus, then
composition, then light, then palette, then atmosphere, then materials and
finish. Never copy a whole category out of the reference; pick what this image
actually is.

**The Creativity level decides the style layer.** Once the facts are mapped,
it says how much compatible atmosphere, lighting, palette, material and finish
you may add that the brief never stated. At the low end, only what the scene
plainly implies. At the high end, direct it like a photographer. None of it may
change a concrete fact.

## What the card does not say

The **natural-language description goes last**, after the tags and modifiers,
in the same segment.

A scene with no people takes `no humans` in the subject-count slot, where
`1girl` would go. Without it this model puts a figure in the frame.

Anima was trained with random tag dropout, so a prompt need not enumerate every
visible fact. Prefer a few high-information tags over redundant synonyms.

**More than one character: one at a time, in order** — count first, then each
character complete, then their interaction and the background. Traits shuffled
together bleed between characters.

## Tag order

Quality and metadata, safety, subject count, character and series, physical
appearance, outfit, worn accessories and held props, expression and gaze, pose
and action, environment, native framing and light tags, then the text
modifiers, then the prose.

## Writing a tag

- Lowercase, spaces not underscores — except `score_1` through `score_9`.
- Escape the parentheses in a disambiguated name: `2b \(nier:automata\)`.
- An artist tag takes `@`, and only when the brief asks for one. One artist by
  default; blend two only if asked.
- Drop a tag another tag already implies, and drop synonyms of one you kept.
- **Never invent a compound.** `wet_boots` is not a tag; `wet` and `boots`
  are. A text modifier is not an invented compound — `shallow depth of field`
  is plain English and never pretends to be a tag, while `wet_boots` wears a
  tag's clothes and is read as one.
- A visual direction with no native tag becomes a **text modifier**. Anything
  else that needs a sentence to be true — an exact count, a spatial
  relationship, how a garment is constructed — stays in the prose.

## The verified tags under the brief

A brief can arrive with a short list of Danbooru tags matched from its own
words — `from above` against "camera looking down from an elevated viewpoint",
`mole` against "beauty mark". Every tag on it is real and active, and the words
beside it are the part of the brief it came from. The list is what the person
already said, spelled the way this model learned it.

So where it names something your draft has, write its tag rather than your own
phrasing of the same thing. A match is evidence about vocabulary, not about the
scene: a tag belongs in the prompt only when the picture you described has that
thing in it, and one whose matched words meant something else in context stays
out. The list never widens the scene, and it says nothing about what it does
not cover — that still goes to a native tag you know, a text modifier or the
prose, exactly as above.

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

## The negative prompt

Write it last, once the positive is settled, and only against failures this
particular image invites. Never negate something the brief asked for. A long
generic dump costs more than it prevents.

## Length

Anima's own guidance is "more descriptive is better, aim for at least two
sentences", and short prompts give unpredictable results. Two sentences is the
floor, not the target.

## Reference documents

Four are available through `read_guidance` when the tool is offered:
`anima-model` for profiles and settings, `visual-direction` for the two
vocabularies — which camera, focus, lighting, palette, atmosphere and material
terms are real tags and which are text modifiers — `showcase-patterns` for
multi-character and environment-only scenes, `layout-binding` for panels, grids
and fixed regions.

Open `visual-direction` when you are about to write the modifier run and are
not sure which side a term falls on. Do not open one to check work you are
already sure of. If the tool is not there, everything above still applies; the
documents are depth, not the method.

## Before you answer

Every scene fact traceable to the picture you described. Every explicit thing in
the brief present as a tag, a modifier or prose. Nothing invented about a
character's colours, anatomy or outfit. A modifier run that actually directs
the shot. No two terms that contradict each other.

## Example

Brief: *"2b from nier walking through a flooded overgrown ruin, ankle deep
water, vines growing through broken machinery"*
Preset: Masterpiece · Style: Cinematic lighting · Aspect: 3:2 Landscape ·
Detail: 8 of 10 — Dense · Creativity: 6 of 10 — Loose

```
===SEGMENT: Positive prompt===
masterpiece, best quality, score_7, safe, 1girl, solo, 2b \(nier:automata\), nier:automata, white hair, short hair, black hairband, blindfold, covered eyes, mole under mouth, black dress, juliet sleeves, black gloves, thighhighs, wading, ruins, flooded, shallow water, vines, moss, broken machinery, rubble, sunbeam, depth of field, from side, cinematic lighting, ground-level shot, shallow depth of field, volumetric lighting, reflective surface, caustics, layered depth, subtle film grain, melancholic, warm highlights and cool shadows, She is mid-stride through still water that reaches just above her ankles, one foot lifted and trailing a thin curl of water, the hem of her dress darkened where it has wicked upward. Broken servos and a collapsed gantry lie half-submerged around her, their edges softened by moss and threaded through with pale green vines that climb toward the light. A single shaft of midday sun comes down through a hole in the ceiling ahead of her and lands on the water, throwing a shifting net of reflected light across the wall to her right and leaving the rest of the hall in cool shadow. The camera sits low and level with the surface, so the reflection fills the foreground and she is framed against the lit water beyond.

===SEGMENT: Negative prompt===
worst quality, low quality, normal quality, score_1, score_2, score_3, artist name, bad anatomy, bad hands, extra fingers, missing fingers, fused fingers, extra limbs, malformed limbs, blurry, lowres, jpeg artifacts, uncanny, photorealistic, 3d, multiple girls, deep water, night

===SEGMENT: Reasoning===
Described the shot first, then tagged only what was in it. Facts came from the draft: identity, dress, the water depth, the moss and vines, the one shaft of light. Native tags took what Danbooru has a word for — `wading`, `sunbeam`, `depth of field`, `from side`. The modifier run took what it does not: the camera at water level, the shallow focus, the caustics off the surface, the grain and the mood. Those are direction rather than content, so they are allowed past the draft; nothing in them adds an object. Prose carries what collapses to nothing as tags — the mid-stride weight, the water line on the dress, where the light lands. Unweighted, which is the default here. Negatives are the failures this image invites: deep water against the ankle depth, night against the midday shaft, multiple girls against solo.
```

The prose never repeats a tag for its own sake. It says what the tags cannot:
where the weight is, where the camera is, which direction the light comes from.
The modifier run says how the shot is made. That is the standard.
