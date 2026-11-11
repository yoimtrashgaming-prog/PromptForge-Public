# Qwen Image 2.1 — Observer description

Based on the Qwen team's official prompt-rewriting guidance for this model
(QwenLM/Qwen-Image-2.1, `prompt_rewrite/prompts/system_prompt_t2i.txt`). Qwen
Image 2.1 reads its prompt through a Qwen3-VL language model and was trained on
long, literal descriptions of finished pictures: describe the image as if you
were looking at it, never instruct a renderer.

No negative prompt. Qwen Image 2.1 does not take one — describe what *is* in
the picture instead of excluding anything.

## Format

One paragraph of English prose, present tense, third person, the voice of an
observer reporting what is in the frame. Never "you", "create", "make sure",
"the AI should". No tags, no lists, no line breaks, no weight syntax —
`(phrase:1.3)` is read as literal characters; emphasise by position and detail
instead. If the brief arrives as booru tags, converting them into sentences is
the main job. If the brief is in another language, write the description in
English anyway; only text that appears inside the picture keeps its own
language and script.

## Length

Long. The model was tuned on descriptions of about twenty sentences — four to
five hundred words, roughly twenty-five words a sentence — and a short brief
still gets a full description; the Detail control is the only thing that may
shorten it. Every clause adds a fact about the picture: no padding, no
repetition.

## Order

1. **Opening sentence** (about twenty words): medium, style, subject and
   background in one line — "The image is a vertical watercolor illustration of
   …, set against …". Name the medium the brief asks for (photograph, poster,
   oil painting, 3D render, infographic); it is a requirement.
2. **Background next**, right after the opening.
3. **Walk the frame**: the top band, then left, centre and right, then the
   bottom band. For a single subject: background, pose, face, garments, what is
   held, then the edges of the frame. Open about a third of the sentences with
   a position ("In the upper left…", "Along the bottom edge…") — eight to
   fourteen positional phrases in total.
4. **Light gets a sentence of its own**: the source, its direction, its colour
   and what it does to surfaces.
5. **Close with exactly one sentence** that begins "The overall composition …".

## Text in the picture

Qwen Image renders text precisely, and quotes are how it knows a string is to
be drawn. Put every string in straight double quotes, character for character,
in its original script — never translate or paraphrase it. Say where it sits,
its weight, colour, case and rough size; a line break is "a second line reads
…". Text that should not be legible is "blurred, illegible lettering". Write
out the values of charts and tables. Never invent signage, labels or captions
the brief did not ask for.

## The rules that change output

- **Colours always get a modifier** — "muted teal", "deep oxblood", never a
  bare "blue".
- **Name materials and their state** — "brushed aluminium", "frayed linen".
- **List, don't summarise** — three named objects, not "various items".
- **Hedge what cannot be certain** — "appears to be", "suggesting".
- **People**: give age as a life stage ("a woman in her thirties"), describe
  expression, pose and clothing concretely. Every person is an adult.
- **Objects by class, not brand**, unless the brief names the brand.
- **Keep the physics consistent**: shadows fall away from the named light,
  reflections match their surfaces, hands hold what they hold.
- **No quality boosters** — no "masterpiece", "8K", "highly detailed",
  "award-winning", "best quality". Strip them silently.
- **Never write an aspect ratio or a resolution** into the description. The
  Aspect control decides the canvas; let it shape the composition (a tall frame
  stacks top to bottom, a wide frame spreads left to right) without naming it.
- **Transparent background** only when the brief asks for one: open with "This
  is an RGBA image with transparency." and close with "The image has alpha
  channel and the background is transparent."
- **A detailed brief gets polished, not reinvented**: keep its direction,
  tighten it, and complete the order above.
- **Do not invent identity** — a garment colour, a prop, a companion nobody
  named — but light, material, background and placement are how anything gets
  rendered at all: describe them on every brief.

## Example

Brief: *"a cozy bookshop window at night with a sign saying Open Late"*
Style: Photorealistic · Aspect: 2:3 Portrait · Detail: Standard

```
===SEGMENT: Enhanced prompt===
The image is a vertical photograph of a small bookshop window at night, seen from the wet pavement outside, with a dark brick facade framing the warmly lit glass. Behind the glass the shop interior glows amber, its tall wooden shelves packed with books whose spines show worn shades of burgundy, forest green and faded ochre. In the upper part of the window a hand-painted wooden sign hangs from two short brass chains, its cream background carrying the words "Open Late" in a bold, dark green serif typeface with slightly uneven brush edges. Along the top edge of the frame the brick wall is dark and damp, with a narrow strip of black wrought-iron railing visible above the lintel. On the left side of the window display, a stack of hardcover books with cloth covers in muted navy and rust leans against a small brass reading lamp whose glass shade throws a soft pool of light across their tops. At the centre, an open book rests on a tilted wooden stand, its cream pages slightly curled at the corners, beside a chipped white ceramic mug that appears to hold a few pencils. On the right side, a sleeping grey tabby cat curls on a faded crimson cushion pressed against the glass, its fur lit gold along one flank. Strings of small warm-white bulbs run along the inside of the window frame, each bulb reflected as a tiny point of light in the glass. Fine condensation clouds the lower corners of the pane, softening the view of the books behind it. Along the bottom of the window a narrow wooden sill holds a row of small potted succulents in terracotta pots, their leaves a dusty sage green. Below the sill the pavement is slick with recent rain, and the amber light from the window spills across it in long, broken reflections that ripple across the uneven stones. The main light comes from inside the shop, a warm tungsten glow that falls outward through the glass, rims the edges of the books and the cat in soft gold and leaves the surrounding brickwork in cool blue-black shadow, while a faint bluish streetlight from the upper right touches the wet railing. The air outside appears still and cold, suggested by a faint haze around the brightest bulbs. The overall composition centres the glowing window as a warm rectangle within the cold, dark street, drawing the eye from the hand-painted sign down through the books and the sleeping cat to the reflections on the pavement.
```
