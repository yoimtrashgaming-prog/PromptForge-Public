## Layout JSON

The picture is laid out on the **Canvas** line the request gives you — its
size in pixels, with the origin at the centre. Every box is measured on that
canvas and nothing else.

Each important thing in the picture is one item: the main subject or each
person, the large objects the composition is built from, and every piece of
text. Background is described in `summary.caption`, not boxed, unless it is
a distinct thing in a distinct place — a sun, a window, a sign.

Boxes are where the thing is in the frame, `[y_min, x_min, y_max, x_max]`.
Negative y is the top half, negative x the left half. A person's box runs
from the top of the head to wherever the frame cuts them. Boxes may overlap
where things overlap — a cup on a table sits inside the table's box.

One JSON object and nothing else in the segment — no code fence, no comment.
In this format the prose is not a segment of its own: it is
`summary.caption`, written in full by everything above — the scene, who is
in it and what they are doing, the light, the style. `summary.meta` is one
word for the medium, from what the brief says it is. Each item's `caption` describes that thing alone, in
one or two sentences; a `text` item carries the exact words in `text`, and
its caption says how they look. Its place in the example above, on the
1248×832 canvas:

```
===SEGMENT: Layout JSON===
{
  "summary": {
    "meta": ["illustration"],
    "canvas": "single",
    "caption": "A young woman with shoulder-length black hair sits sideways on a cushioned window seat in a small café, knees drawn up, a paperback held open in both hands. She wears an oversized cream knit sweater with the sleeves pulled over her knuckles, and a white ceramic mug stands on the sill beside her. Behind her, rain runs down a tall window, and the street outside is a soft grey blur of wet pavement and passing umbrellas. A small wooden sign hangs in the upper left of the window, painted with the word \"OPEN\" in white capital letters. Cool overcast daylight from the window rims her hair from behind, while a warm pendant lamp above lights the pages and her face. Anime illustration, clean linework, soft cel shading, muted rainy-day colour with warm highlights."
  },
  "items": [
    {
      "label": "object",
      "caption": "A young woman with shoulder-length black hair in an oversized cream sweater, seated sideways with her knees drawn up, reading a paperback held in both hands.",
      "bbox": [-230, -60, 340, 400]
    },
    {
      "label": "object",
      "caption": "A tall rain-streaked café window, the wet grey street blurred behind the glass.",
      "bbox": [-400, -600, 200, 600]
    },
    {
      "label": "object",
      "caption": "A white ceramic mug on the window sill.",
      "bbox": [120, -200, 210, -120]
    },
    {
      "label": "text",
      "caption": "A small wooden hanging sign with white painted capital letters.",
      "text": "OPEN",
      "bbox": [-330, -520, -240, -350]
    }
  ],
  "bbox_coord_space": "abs_centralized",
  "bbox_format": "yxyx"
}
```

`"canvas": "single"`, `bbox_coord_space` and `bbox_format` are always exactly
these. Every coordinate is a whole number inside the canvas.
