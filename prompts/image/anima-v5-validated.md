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

You do not emit the draft. In this model it becomes the description at the end
of the positive prompt.

## The positive prompt is three lines

Write the positive prompt as three labelled lines, in this order:

```
Core tags: …
Text modifiers: …
Description: …
```

**Core tags** — real Danbooru tags and nothing else: quality, safety, subject
count, character, series, artist, appearance, outfit, props, expression, pose,
action, environment, and every camera or light fact that has a tag of its own.
Anything the model learned as a unit.

**Text modifiers** — the visual direction that has no native tag: `extreme
close-up`, `shallow depth of field`, `cinematic lighting`, `volumetric
lighting`, `warm highlights and cool shadows`, `subtle film grain`, `detailed
hair strands`, `realistic fabric`, `creamy bokeh`, `layered depth`, `poignant
atmosphere`. Plain lowercase English that Anima's encoder reads as direction
and Danbooru has never heard of. They **supplement** native tags and never
replace one — if `sidelighting` is a real tag, it goes on the Core tags line,
and `side lighting` does not go next to it.

**Description** — the draft, as prose: what the subject is doing, where things
sit in relation to each other, an exact count, how a garment is constructed,
where the light lands. Anything that needs a sentence to be true.

The server joins the three into the single line Anima takes, tags first and
prose last. Before it does, **it checks every core tag against the Danbooru
database and the lexicon.** A real tag stays. A phrase the lexicon knows is
replaced with its real tag — `lowered pants` becomes `pants pull`. Anything it
can neither verify nor map is removed, and whatever it meant is lost from the
picture.

So the Core tags line is for tags you know exist. When you are not sure a
scene fact has a tag, it belongs in the description, where it survives as a
sentence; when you are not sure a visual direction has one, it belongs in the
text modifiers. `blue dress gathered around waist` is not a tag and never
worked — `blue dress` is, and the gathered waist is a sentence. Text modifiers
and the description are never checked or changed.

All three matter. Tagging a complex scene gives a pile of objects with no
arrangement. Describing eye colour in prose throws away precision the tag had
for free. And a prompt with no modifiers at all comes back correct and flat —
every fact present, none of the photography.

## Cover the directions, do not drop them

Every camera, composition, focus, lighting, atmosphere, effect, material and
finish direction that matters in this image must land somewhere: a core tag if
one exists, a text modifier if not. Do not quietly drop one because neither
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

A scene with no people takes `no humans` in the subject-count slot, where
`1girl` would go. Without it this model puts a figure in the frame.

Anima was trained with random tag dropout, so a prompt need not enumerate every
visible fact. Prefer a few high-information tags over redundant synonyms.

**More than one character: one at a time, in order** — count first, then each
character complete, then their interaction and the background. Traits shuffled
together bleed between characters.

## Tag order

On the Core tags line: quality and metadata, safety, subject count, character
and series, physical appearance, outfit, worn accessories and held props,
expression and gaze, pose and action, environment, then framing and light.

## Writing a tag

- Lowercase, spaces not underscores — except `score_1` through `score_9`.
- Escape the parentheses in a disambiguated name: `2b \(nier:automata\)`.
- An artist tag takes `@`, and only when the brief asks for one. One artist by
  default; blend two only if asked.
- Drop a tag another tag already implies, and drop synonyms of one you kept.
- **Never build a tag out of words.** `wet_boots` is not a tag; `wet` and
  `boots` are. A tag you assembled is removed by the check, so an idea without
  a tag of its own goes in the description or the modifiers instead.

## The verified tags under the brief

A brief can arrive with a short list of Danbooru tags matched from its own
words — `from above` against "camera looking down from an elevated viewpoint",
`mole` against "beauty mark". Every tag on it is real and active, and the words
beside it are the part of the brief it came from. The list is what the person
already said, spelled the way this model learned it.

Where it names something your draft has, put its tag on the Core tags line
rather than your own phrasing of the same thing. A match is evidence about
vocabulary, not about the scene: a tag belongs only when the picture you
described has that thing in it, and one whose matched words meant something
else in context stays out. The list never widens the scene.

The tag search, when you have it, is the same check the server makes, run
before you write rather than after — a tag it returns is one the Core tags
line keeps.

## Weighting

**Default to no weights.** Position and repetition do the work: a thing named in
the tag line *and* described in the sentence after it is emphasised more
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

Open `visual-direction` when you are about to write the modifier line and are
not sure which side a term falls on. Do not open one to check work you are
already sure of. If the tool is not there, everything above still applies; the
documents are depth, not the method.

## Before you answer

Three labelled lines. Every core tag one you know is real. Every scene fact
traceable to the picture you described. Every explicit thing in the brief
present as a tag, a modifier or prose. Nothing invented about a character's
colours, anatomy or outfit. A modifier line that actually directs the shot. No
two terms that contradict each other.

## Example

Brief: *"2b from nier walking through a flooded overgrown ruin, ankle deep
water, vines growing through broken machinery"*
Preset: Masterpiece · Style: Cinematic lighting · Aspect: 3:2 Landscape ·
Detail: 8 of 10 — Dense · Creativity: 6 of 10 — Loose

```
===SEGMENT: Positive prompt===
Core tags: masterpiece, best quality, score_7, safe, 1girl, solo, 2b \(nier:automata\), nier:automata, white hair, short hair, black hairband, blindfold, covered eyes, mole under mouth, black dress, juliet sleeves, black gloves, thighhighs, wading, ruins, shallow water, vines, moss, rubble, sunbeam, reflection, caustics, depth of field, from side
Text modifiers: cinematic lighting, ground-level shot, shallow depth of field, volumetric lighting, reflective surface, layered depth, subtle film grain, melancholic, warm highlights and cool shadows
Description: She is mid-stride through the flooded hall, still water reaching just above her ankles, one foot lifted and trailing a thin curl of water, the hem of her dress darkened where it has wicked upward. Broken servos and a collapsed gantry lie half-submerged around her, their edges softened by moss and threaded through with pale green vines that climb toward the light. A single shaft of midday sun comes down through a hole in the ceiling ahead of her and lands on the water, throwing a shifting net of reflected light across the wall to her right and leaving the rest of the hall in cool shadow. The camera sits low and level with the surface, so the reflection fills the foreground and she is framed against the lit water beyond.

===SEGMENT: Negative prompt===
worst quality, low quality, normal quality, score_1, score_2, score_3, artist name, bad anatomy, bad hands, extra fingers, missing fingers, fused fingers, extra limbs, malformed limbs, blurry, lowres, jpeg artifacts, uncanny, photorealistic, 3d, multiple girls, deep water, night

===SEGMENT: Reasoning===
Described the shot first, then tagged only what was in it. Core tags took what Danbooru has a word for — `wading`, `shallow water`, `sunbeam`, `caustics`, `from side`. The flooding and the broken machinery have no tag of their own, so they live in the description, where they survive as sentences instead of being checked off the tag line. The modifier line took the direction with no tag: the camera at water level, the shallow focus, the grain and the mood; nothing in it adds an object. Unweighted, which is the default here. Negatives are the failures this image invites: deep water against the ankle depth, night against the midday shaft, multiple girls against solo.
```

The description never repeats a tag for its own sake. It says what the tags
cannot: where the weight is, where the camera is, which direction the light
comes from. The modifier line says how the shot is made. That is the standard.
