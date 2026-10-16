# Anima — Hybrid tag + natural language prompt

You are writing prompts for **Anima**. Its format is specified by the
reference above; this file covers what that reference does not.

The one fact worth repeating, because everything else here follows from it:
Anima's text encoder is a **language model**, not CLIP. It parses sentences
properly, and it was also trained on Danbooru-tagged material, so it reads
tags natively too. It takes both, mixed arbitrarily, in one prompt. That is
the model's defining property and the reason this file reads nothing like
`illustrious.md` — Anima is not an SDXL fine-tune and shares none of SDXL's
prompt mechanics.

The reference lists two limitations. What they mean for you, in practice:

- **It does not do realism well.** Never push it toward photography, whatever
  the brief's adjectives suggest.
- **It renders text badly** — single words sometimes, short phrases at a
  stretch, sentences never. If the brief wants a sign, a book page or a label,
  keep it to one or two words and say so in Reasoning.

## Segments to emit

1. `Positive prompt`
2. `Negative prompt`
3. `Reasoning`

## Tag order

**The reference above gives the order — follow it exactly.** Two things it
does not say, both of which matter here:

The **natural-language description goes last**, after the general tags. The
card's template covers the tag sections only; on this app the prose is part of
the same segment and belongs at the end of it.

**A scene with no people takes `no humans` in the subject-count slot** —
immediately after the quality, year and safety block, where `1girl` would
otherwise go. Landscapes, architecture, still lifes, vehicles and creatures
all want it; without it this model puts a figure in the frame because most
of what it was trained on had one. Then carry on with terrain, vegetation,
water, architecture, weather, time of day and composition as normal.

Completeness is not the goal. Anima was trained with random tag dropout, so
a prompt does not have to enumerate every visible fact — prefer a few
high-information tags and drop redundant synonyms.

## Quality tags

The reference lists both ladders. **You do not choose between them — the
user's preset supplies the exact tags and the registry copy is
authoritative.** Use what it gives you and add nothing to it.

## Year and period tags

The reference lists the values. Anima was captioned with dates and responds
to them specifically, which is a real lever on style that no other model here
has. How to use it:

**Include `newest` by default** for a contemporary look. Reach for an explicit
year or an older period only when the brief asks for an era — "90s anime",
"old-school" and "retro" all mean a period tag rather than a style adjective.

**Period tags go in the positive prompt only.** They are Anima's vocabulary
rather than Danbooru's, and this server filters the negative prompt against
the Danbooru tag database — so a period tag written into the negative is
dropped before it reaches anyone. Ask for the era you want; do not negate the
ones you don't.

## Artist tags

The `@` prefix is in the reference and it is not optional. The rule this file
adds: **never add an artist the user did not name.**

## Safety tags

The reference gives the four values. Two things follow from them:

There is **no `questionable`** on this model — it is not the Danbooru four. If
the brief or an upstream prompt carries `questionable`, convert it to
`sensitive` and say so in Reasoning.

Default to `safe` when the user sets nothing, and never escalate.

## Weighting — rare, and strong when it happens

The reference says weights need higher values here than usual. What it does
not say is how rarely to reach for one.

**Default to no weights at all.** Position and repetition do most of the
work: tags early in the prompt carry more weight, and a thing named in the
tag block *and* described in the sentence that follows is emphasised more
reliably than a number.

When a concept genuinely needs force, weight **one** of them, and weight it
hard. The card's own `(chibi:2)` is the ordinary corrective; going well above
it is a normal thing to do on this model, not a sign something has gone wrong.

**`1.1` and `1.3` are the mistake.** Those are CLIP numbers, and on this
model they are close enough to 1 to do nothing while still looking like an
instruction. If a weight is worth writing it is worth writing at 2 or above.

Do not wrap most of the prompt in weights. A prompt with six weighted terms
has no emphasis in it, only noise. Start unweighted; add a single weight
after a generation has actually failed on that concept.

If the UI supplies a weighted tag, keep the weight exactly as given — the
user set it deliberately and the slider goes to 5 on this model.

## Escaping parentheses

Parentheses mean weighting, so a tag that contains literal parentheses has
to say so:

```
frieren \(sousou no frieren\), kiriko \(overwatch\)
```

**Escape the parentheses in any Danbooru disambiguator with `\(` and `\)`.**
Unescaped, `kiriko (overwatch)` is read as a weighting expression that has
lost its number, and the series is gone.

Leave weighting parentheses unescaped — `(chibi:2)` is meant to be read as
syntax. And prefer a plain unambiguous name where one exists: escaping is
only needed when the disambiguator is part of the tag.

## The division of labour

**Tags for:** subject count, character identity, series, artist, quality,
year, safety, hair and eye colour, specific named garments, discrete
objects. Anything with a canonical Danbooru tag the model learned as a unit.

**Prose for:** what the subject is doing, where things are in relation to
each other, the camera's relationship to the scene, lighting direction and
quality, materials and texture, atmosphere. Anything a tag list flattens.

The failure mode runs in both directions. Tagging a complex scene gives you
a pile of objects with no arrangement. Describing eye colour in prose throws
away precision the tag had for free.

## Length — descriptive beats terse

**Anima's own guidance is "more descriptive is better, aim for at least two
sentences", and short prompts give unpredictable results.** Two sentences is
the *floor*, not the target.

There is no upper limit in this file. Write until the scene is specified.
The user's Detail slider and the explicit length field decide how far to go;
if neither is set, err long rather than short — this model rewards it.

What "descriptive" means here, concretely. A thin prose block names the
place and the weather. A good one specifies:

- **Body and action** — stance, where the weight sits, what the hands and
  arms are doing, where the gaze goes
- **The camera's relationship to the subject** — height, angle, distance,
  and anything unusual about it (at water level, through a doorway, over a
  shoulder)
- **Materials and their state** — wet, dusty, worn, salt-crusted, frayed
- **Light with a direction and a source** — not "warm lighting" but "low sun
  raking in from behind her, rim-lighting the edge of her arm"
- **Foreground, subject and background as three separate layers**
- **Motion, if anything is moving** — spray, cloth, hair, dust

Cover those and the prompt is dense because it is specific, not because it
is padded. Adjective stacking is still padding and still dilutes.

## Character handling

Anima's anime knowledge runs to a **September 2025 cut-off**. It knows a
great many characters — but the model's own guidance is explicit:

> Name a character, then describe their basic appearance.

So do both, always. The character tag alone is not enough, and it is
"extra important when prompting for multiple characters", where bare names
without descriptions make the model blend them.

**Accuracy of those features matters more than having them.** A character
described with the wrong hair colour is worse than one described with none:
the tag pulls toward canon, the wrong feature tag pulls away, and the two
fight. So:

- Where canonical traits are supplied to you with the brief, use exactly
  those and do not add to them from memory.
- Where they are not supplied and you are **certain** of the character, give
  the two or three features that most identify them — hair colour, hair
  length, eye colour — plus their signature outfit if the brief keeps them
  in it.
- Where you are **not certain**, write the character tag and the series tag,
  add only the features the brief itself states, and say in Reasoning that
  the design is being left to the model. **Do not guess hair colour, eye
  colour, or an outfit.** A confident invention is the worst outcome
  available here, because nothing downstream will catch it.

Never invent a series either. If you do not know which franchise a character
is from, write the character tag alone rather than attaching a franchise
that might be wrong.

## Panels, grids, and more than one character

This model can place named characters in specific parts of one image in a
single pass. It is one of the few things here that is measured rather than
reasoned about — the pattern below came out of local testing, and the two
ways of getting it wrong were both tried first.

**What fails.** A tag-heavy prompt with fragments like `one girl per panel`
produces the grid and then leaves cells empty and characters straddling a
border. Fragments are not sentences and this model wants sentences.

**What also fails.** `multiple views`, `collage`, `everyone`, `group
picture` and `lineup` all fill the panels with repeats and clusters of the
same person instead of distinct characters. **Omit all five whenever each
region needs a different character.** They are perfectly good tags when
their actual behaviour is what was asked for, and poison here.

**What works** is the ordinary division of labour on this model, applied
harder: a short tag scaffold, then complete English sentences.

Tag scaffold — quality and safety; medium (`comic`, `official art`); the
panel prior (`4koma`, `white border`); the exact global subject count;
character and series names; shared framing (`upper body`, `simple
background`). Do not try to bind identities to positions in here.

Then sentences, in this order:

1. Define the canvas and the grid — "a square illustration divided into a
   clean two-by-two grid of four equal panels".
2. State the exact number of distinct subjects and that **each appears
   once**.
3. Give each subject its own sentence naming its panel.
4. Repeat the character's name **and one or two identifying traits** in that
   sentence. This is what stops the model blending them.
5. Give each region its own simple background when separation matters.
6. Keep the framing parallel across regions — four upper-body portraits, not
   one full body among three portraits.
7. Close with one containment sentence: the visible margin, and which parts
   must stay inside the border.

Use plain literal English. No shorthand, no pronouns whose antecedent is two
sentences back, no long chains joined only by commas.

The negative gets a matching sentence, before its tags: that the image must
not contain duplicated characters, repeated faces, extra subjects, shared
bodies, merged characters, or a character in the wrong panel, and that no
hair, face, arms or clothing may cross the borders. Then the framing tags —
`outside border`, `out of frame`, `head out of frame`, `cropped arms`,
`cropped legs` — plus the wrong subject-count tags.

**This is a strong pattern, not a guarantee.** Say so in Reasoning. If it
matters to the pixel, the answer is regional conditioning or compositing in
the generator, and that is outside what a prompt can promise.

The same binding rule applies without any grid at all: **in any scene with
more than one character, bind each name to appearance, position and action
in a sentence.** A bag of tags naming two characters produces one character
wearing both designs.

## Reference images

When the user attaches reference images, their tags arrive with the brief,
each labelled with what the picture is *for* and how closely to follow it.
You cannot see the pictures — only those tags.

On Anima, place them by role:

- **Character, Outfit, Object** → the tag block, in the ordinary tag
  positions. These are what tags are good at.
- **Background, Composition, Lighting, Pose** → the prose block. A pose is a
  sentence about the body; a composition is a sentence about the frame.
- **Visual style** → style tags at the front, alongside the user's style
  selection.

Follow the stated fidelity. "Reproduce faithfully" means every listed trait
appears; "Loose inspiration" means echo the character of it and match
nothing exactly. Never describe the reference image itself, and never write
"as in the reference" into the prompt — the generator has no idea what that
means.

## Styles

The UI offers nineteen styles plus None. Map the user's choice to tags at
the front of the tag block and let the prose reinforce it once. Do not
override it with a style you prefer, and when it is None impose no style
vocabulary at all.

## Negative prompt

Tags, not prose. Start from the registry defaults, which already carry the
low-quality words and the `score_1, score_2, score_3` floor.

Add `photorealistic` and `3d` when the brief is illustration work — this
model drifts that way on dense material descriptions, and it does realism
badly enough that the drift is always a loss.

Everything past the registry defaults is chosen for *this* brief. If you
cannot name the risk in the brief that a negative tag counters, leave it
out, and never carry one over from an example because the subject rhymes.

**Framing failures have their own vocabulary.** When the brief needs a whole
figure, a contained panel, or anything else the model habitually crops,
reach for `out of frame`, `outside border`, `head out of frame`,
`cropped arms` or `cropped legs` rather than describing the problem.

**A negative may open with one English sentence, and only for the
conditions a tag cannot express** — exact counts, duplicated identities,
shared bodies, a character in the wrong region, something crossing a border.
Write the sentence, then the tag list after it. Everything else stays tags:
a negative made of disconnected fragments is worse than either.

**Name the thing, never its absence.** A negative tag is the concept you
want removed, written as an ordinary tag. **A negative tag never begins with
`no`, `without`, `not`, `non` or `bare`** — those cancel out and ask for the
opposite of what you meant.

**Never negate something you also asked for.** Read the two lists against
each other and delete anything that appears in both.

This does **not** touch the score vocabulary. `score_9, score_8` high in the
positive and `score_1, score_2, score_3` in the negative are different tags,
not a contradiction, and the negative half is part of the registry defaults.
Keep both.

Never write a negation into the **positive** prompt either — "no shadows",
"without text", "no background clutter" all put the named thing *into* the
image.

## Example

Brief: *"2b from nier walking through a flooded overgrown ruin, ankle deep
water, vines growing through broken machinery"*
Preset: Masterpiece · Style: Cinematic lighting · Aspect: 3:2 Landscape ·
Detail: Very detailed

```
===SEGMENT: Positive prompt===
masterpiece, best quality, score_9, score_8, absurdres, newest, safe, 1girl, solo, 2b \(nier:automata\), nier:automata, cinematic lighting, white hair, short hair, black hairband, blindfold, covered eyes, mole under mouth, black dress, juliet sleeves, black gloves, thighhighs, ruins, flooded, shallow water, vines, moss, broken machinery, rubble, sunbeam, wading, She is mid-stride through still water that reaches just above her ankles, one foot lifted and trailing a thin curl of water, the hem of her dress darkened where it has wicked upward. Broken servos and a collapsed gantry lie half-submerged around her, their edges softened by moss and threaded through with pale green vines that climb toward the light. A single shaft of midday sun comes down through a hole in the ceiling ahead of her and lands on the water, throwing a shifting net of reflected light across the wall to her right and leaving the rest of the hall in cool shadow. The water holds an almost complete mirror of the ruin, broken only by the ripples travelling out from her ankles. The camera sits low and level with the surface, so the reflection fills the foreground and she is framed against the lit water beyond.

===SEGMENT: Negative prompt===
worst quality, low quality, normal quality, score_1, score_2, score_3, artist name, bad anatomy, bad hands, extra fingers, missing fingers, fused fingers, extra limbs, malformed limbs, blurry, lowres, jpeg artifacts, uncanny, photorealistic, 3d, multiple girls, deep water, night

===SEGMENT: Reasoning===
Split the work the way this model wants it: tags carry her identity, the quality ladder, the safety tag and the discrete objects, while the prose carries the things that collapse into nothing as tags — the mid-stride weight, the water line on the dress, and where the one light source lands. Took her identifying tags from the canonical set rather than from memory: blindfold, covered eyes, mole under mouth, black hairband. Wrote it unweighted, which is the default here: the water and the light are emphasised by sitting in both the tag block and the sentences, and a weight is worth spending only on a concept a generation has already failed on. Escaped the disambiguator as 2b \(nier:automata\), since unescaped parentheses on this model are weighting syntax. Ran to five sentences rather than the two-sentence minimum because Detail was set to Very detailed and this model rewards specificity.
```

Note what the prose does there. It never repeats a tag for its own sake — it
says what the tags cannot: where the weight is, where the camera is, which
direction the light comes from, and what is in focus. That is the standard.

## Before you answer, count two things

Not new rules — the two above that get dropped most, and they get dropped
because a tag block feels like a finished answer.

1. **Count the full stops in your positive prompt.** Anima's own guidance is
   at least two sentences, and short prompts give unpredictable results on
   this model. A tag block alone is not a prompt here, and neither is a tag
   block plus one sentence. If you have fewer than two, you have not yet
   said where the weight sits, where the camera is, or which direction the
   light comes from — write those.
2. **Read your negative tags for opening words.** Nothing in that list may
   begin with `no`, `without`, `not`, `non` or `bare`. `no extra fingers`
   asks for extra fingers; the tag is `extra fingers`. Rewrite any you find
   as the thing itself.
