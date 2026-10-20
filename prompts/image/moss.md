# MOSS-Image — Prose prompt

MOSS-Image reads three prompt formats: natural language, natural language
with a tag sequence, and a JSON layout. The person's Mode picks one. The
prose below is the heart of all three: the tag line is added in front of it,
and the layout places the same picture box by box.

## The prose

Continuous English prose, present tense, plain declarative sentences — the
shape of the long captions MOSS-Image was trained on: composition, the
subjects and what they are doing, the setting, colours, lighting, and the
medium and style.

**No weight syntax.** `(phrase:1.3)` is read as literal characters. Drop the
weighting, keep the phrase, and emphasise it by describing it in more detail
than its neighbours.

**Tags in the brief are content, not format.** `purple_hair, goggles_on_head`
becomes "her purple hair is tied back, a pair of goggles pushed up on her
forehead". A named character and series stay named — "Noelle from Genshin
Impact" — and say what she looks like as well.

**Text is quoted and placed.** The exact words go inside `"…"`, never
paraphrased or translated, with where they sit, their size, colour and
lettering. Where the line breaks matter, break the lines inside the quotes.

**Name the light source and its direction, name materials, use verbs.** "She
leans over the bench" places a body; "standing pose" does not. Two or three
concrete objects beat a category.

**Honour the medium the brief names** — photo, illustration, poster,
painting — and state it once, plainly.

**Do not invent identity** — a garment colour, a prop, a companion nobody
mentioned. Light, material and placement are not identity; name them.

Cut words that do not change the image: "beautiful", "8k", "masterpiece".

## Example

Brief: *"anime girl reading on a café window seat, rainy day, little sign in
the window that says OPEN"*
Aspect: 3:2 Landscape

```
===SEGMENT: Enhanced prompt===
A young woman with shoulder-length black hair sits sideways on a cushioned window seat in a small café, knees drawn up, a paperback held open in both hands. She wears an oversized cream knit sweater with the sleeves pulled over her knuckles, and a white ceramic mug stands on the sill beside her. Behind her, rain runs down a tall window, and the street outside is a soft grey blur of wet pavement and passing umbrellas. A small wooden sign hangs in the upper left of the window, painted with the word "OPEN" in white capital letters. Cool overcast daylight from the window rims her hair from behind, while a warm pendant lamp above lights the pages and her face. Anime illustration, clean linework, soft cel shading, muted rainy-day colour with warm highlights.
```
