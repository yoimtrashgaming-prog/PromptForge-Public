# MOSS-Image — the makers' own prompting guide

A digest of `USERGUIDE.md` in `github.com/OpenMOSS/MOSS-Image`, read
18 October 2026. **This is the authoritative source on MOSS-Image's prompt
format.** Where `../moss.md` and this file disagree, this one is right and
`moss.md` should be corrected.

Short strings that are functional — the negative tags, the tag order, the
layout example — are quoted exactly. The prose around them is a digest.

---

## Formats it reads

Natural language, tag sequences, and JSON layouts — and natural language and
structured input combined. English has the most training data; Chinese and
other languages also work.

## Negative prompt

The makers' tested negative tags, verbatim:

```
nsfw, worst quality, bad anatomy, watermark, jpeg artifact
```

## Tag order

For tag sequences: Quality -> Score -> Meta -> Year -> Character -> Series ->
Artist -> General. Their example, verbatim:

```
best quality, highres, hatsune miku, vocaloid, @foo bar, 1girl, blue hair
```

An artist is written with `@` in front.

## Text

The model renders text and breaks lines by itself, but not always where you
want. For accurate text, or exact line breaks, put the line breaks (`\n` or a
real newline) into the prompt. Both of their examples put the text to render
in quotation marks and say where it sits and how it is written — handwritten
on a glass board, handwritten on a sticky note on a fridge door.

## Layout prompts (experimental)

Their example, verbatim:

```json
{
  "summary": {
    "meta": ["poster"],
    "canvas": "single",
    "caption": "A minimalist travel poster with a cream background, a blue mountain illustration, and the title EXPLORE at the top."
  },
  "items": [
    {
      "label": "text",
      "caption": "Large dark-blue uppercase title centered at the top.",
      "text": "EXPLORE",
      "bbox": [-416, -384, -288, 384]
    },
    {
      "label": "object",
      "caption": "A flat blue mountain illustration in the lower center.",
      "bbox": [-192, -288, 384, 288]
    }
  ],
  "bbox_coord_space": "abs_centralized",
  "bbox_format": "yxyx"
}
```

- `summary.caption` — the whole scene and its style.
- `items` — each element's category (`label`), description (`caption`) and
  box (`bbox`). `text` holds the exact words when the element is text.
- `bbox_format: "yxyx"` — `[y_min, x_min, y_max, x_max]`.
- `bbox_coord_space: "abs_centralized"` — absolute pixels, origin at the
  centre of the canvas, x to the right, y downward. A 1024×1024 canvas runs
  -512 to +512 on both axes. From ordinary top-left pixels on a W×H canvas,
  subtract W/2 from x and H/2 from y.

Absolute pixels on purpose, so the boxes belong to one output size: the
picture has to be generated at the size the boxes were measured on. The JSON
does not carry that size.

The guide defines nothing else: `meta` and `canvas` appear only in the
example, and `text` and `object` are the only labels it shows.

## Settings (for the person, not the prompt)

1M, 1.5M or 2M pixels; any aspect ratio, both sides multiples of 16. 50+
steps, Euler, shift 5.0, CFG 3.0 (3.0–6.0; raise it for short prompts).
