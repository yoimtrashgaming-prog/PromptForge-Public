# Anima — Hybrid tag + natural language prompt

The reference above specifies the format. This file covers what it does not.

Anima's text encoder is a **language model**, not CLIP. It parses sentences
properly and was also trained on Danbooru-tagged material, so it reads tags
natively too, and takes both mixed in one prompt. Two limitations that matter:
it does not do realism, whatever the brief's adjectives suggest, and it renders
text badly — one or two words at most.

## Segments to emit

1. `Positive prompt`
2. `Negative prompt`
3. `Reasoning`

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

## Example

Brief: *"2b from nier walking through a flooded overgrown ruin, ankle deep
water, vines growing through broken machinery"*
Preset: Masterpiece · Style: Cinematic lighting · Aspect: 3:2 Landscape ·
Detail: Very detailed

```
===SEGMENT: Positive prompt===
masterpiece, best quality, score_9, score_8, absurdres, newest, safe, 1girl, solo, 2b \(nier:automata\), nier:automata, cinematic lighting, white hair, short hair, black hairband, blindfold, covered eyes, mole under mouth, black dress, juliet sleeves, black gloves, thighhighs, ruins, flooded, shallow water, vines, moss, broken machinery, rubble, sunbeam, wading, She is mid-stride through still water that reaches just above her ankles, one foot lifted and trailing a thin curl of water, the hem of her dress darkened where it has wicked upward. Broken servos and a collapsed gantry lie half-submerged around her, their edges softened by moss and threaded through with pale green vines that climb toward the light. A single shaft of midday sun comes down through a hole in the ceiling ahead of her and lands on the water, throwing a shifting net of reflected light across the wall to her right and leaving the rest of the hall in cool shadow. The camera sits low and level with the surface, so the reflection fills the foreground and she is framed against the lit water beyond.

===SEGMENT: Negative prompt===
worst quality, low quality, normal quality, score_1, score_2, score_3, artist name, bad anatomy, bad hands, extra fingers, missing fingers, fused fingers, extra limbs, malformed limbs, blurry, lowres, jpeg artifacts, uncanny, photorealistic, 3d, multiple girls, deep water, night

===SEGMENT: Reasoning===
Split the work the way this model wants it: tags carry identity and discrete objects, prose carries what collapses into nothing as tags — the mid-stride weight, the water line on the dress, where the one light source lands. Wrote it unweighted, which is the default here.
```

The prose never repeats a tag for its own sake. It says what the tags cannot:
where the weight is, where the camera is, which direction the light comes from.
That is the standard.
