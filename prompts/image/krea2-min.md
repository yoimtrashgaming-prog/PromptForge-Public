# Krea2 — Prose prompt

No negative prompt. Krea2 does not support one — anything you want excluded has
to be handled by describing what *is* there instead.

## Format

Continuous prose. Present tense, third person, plain declarative sentences.

**No weight syntax.** Like every Flux-family model, Krea2 ignores
`(phrase:1.3)` and reads the characters as literal text. Drop any weighting the
brief or the UI hands you, keep the phrase, and emphasise it by position and by
describing it in more detail than its neighbours.

Never emit tags. If the brief arrives as booru tags, converting them is the main
job — `purple_hair, long_hair, goggles_on_head` becomes "her long purple hair is
tied back, and a pair of aviator goggles sits pushed up on her forehead". Score
ladders, `1girl`, rating tags and quality words carry nothing here; convert what
they encode and drop the rest.

## Length

Krea2 follows long, specific prompts accurately; a prompt well past a hundred
words that reads like a shot brief is the format working, not excess. Four
sentences is a floor. Avoid padding, not length — every clause must add a fact
about the image.

## The rules that actually change output

**Name materials, and name their state.** "Brass and copper workbench" beats
"metal workbench". Material rendering is the best thing about this model.

**Ask for real skin.** It was built to avoid waxy, airbrushed faces and delivers
when told: pores, fine lines, freckles, sunburn, stubble, flyaway hair, a shine
of sweat. On any photoreal brief with a person in it, name at least one.

**Avoid the oversaturated register.** Ask for natural colour and describe light
by its behaviour. "Vibrant" and "vivid" pull it back toward the look it was
built to escape.

**Name the light source and its direction.** "Warm amber light from hanging oil
lanterns, mixed with cooler daylight from a high window" is an instruction.
"Good lighting" is not.

**Use verbs.** "She leans over the bench, sleeves pushed to her elbows" places
the body. "Standing pose" does not.

**Two or three concrete objects beat a category.** "A workshop" renders as an
empty room.

**Layer the frame.** Name what is in front of the subject, then the subject,
then what is behind. Depth is built from planes.

**Cut every adjective that doesn't change the image.** "Beautiful", "stunning",
"highly detailed", "8k", "masterpiece" — Stable Diffusion habits that do nothing
here. Strip them silently.

**Put rendered text in double quotes.** Write the exact words inside `"…"` and
do not paraphrase. The quotation marks are how this model is told a string is to
be drawn rather than described.

**Honour the medium the brief names.** "photo of", "illustration of", "painting
of", "sketch of" — when stated, it is a requirement.

**A detailed brief gets polished, not expanded.** Where someone arrives with a
paragraph that already names its light, materials and framing, tighten the
phrasing and keep their direction.

**Do not invent identity** — a garment colour, a prop, a companion nobody
mentioned. **But light, material and skin are not identity.** They are how
anything gets rendered at all, and a brief that says "a woman at a market stall"
has not told you the light is low and raking. Name them on every brief.

## Example

Brief: *"an old woman selling flowers at a market stall early morning,
photoreal"*
Style: Photorealistic · Aspect: 3:4 Portrait · Detail: Very detailed

```
===SEGMENT: Enhanced prompt===
An elderly woman in her seventies stands behind a wooden market stall, both hands working a length of twine around the stems of a bunch of ranunculus. Her face is deeply lined and unmade, with broken capillaries across the cheeks, grey hair pinned back untidily and a few strands loose at the temple. She wears a quilted olive jacket worn shiny at the cuffs over a hand-knitted jumper, and fingerless gloves with the wool pilled and grubby at the fingertips. In the foreground, galvanised buckets crowd the front edge of the stall — tulips, eucalyptus, stems standing in an inch of clouded water that has slopped onto the boards. Behind her the rest of the market is still setting up: a half-raised canvas awning, stacked crates, another trader's back turned. Low early sun comes in almost horizontally from the left, catching the steam off a paper cup on the stall and separating her shoulder from the shadowed depth behind. Shot on an 85mm lens at f/2.8 at eye level, focus on her hands and the twine, background falling gently soft. Shot on a full-frame camera, natural colour, realistic skin texture and fabric detail.
```
