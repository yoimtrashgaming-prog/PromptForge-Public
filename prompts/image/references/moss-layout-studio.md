# MOSS-Image — a user's layout example and rules

From MOSS Layout Studio, the layout editor a user built for MOSS-Image
(18 October 2026). It writes the same JSON as the makers' guide. Where this
file and `../moss.md` disagree, this one is the better prior.

## Their example

Canvas 1536×1024 (3:2), so x runs -768 to 768 and y -512 to 512. Verbatim:

```json
{
  "summary": {
    "meta": ["illustration"],
    "canvas": "single",
    "caption": "Noelle from Genshin Impact sits at a wooden table on a sunny outdoor terrace, viewed from the side with her face turned toward the viewer. Her head rests on one hand, with her elbow on the table. A porcelain cup stands beside her. The sun and a small flock of birds appear in a blue sky above a distant green landscape. Semi-realistic anime illustration, fine hair strands, natural skin shading and warm afternoon lighting."
  },
  "items": [
    {
      "label": "object",
      "caption": "Noelle with short silver hair, green eyes and her black-and-white armored maid outfit, seated sideways on a chair. Her cheek rests on her hand, her elbow supported on the table. She looks at the viewer.",
      "bbox": [-282, -608, 438, -128]
    },
    {
      "label": "object",
      "caption": "A wooden outdoor table with a warm brown tabletop and visible wood grain.",
      "bbox": [108, -148, 428, 632]
    },
    {
      "label": "object",
      "caption": "A single white porcelain teacup on a matching saucer, resting on the table.",
      "bbox": [8, 222, 168, 362]
    },
    {
      "label": "object",
      "caption": "A bright warm sun in the upper right of the blue sky.",
      "bbox": [-442, 452, -292, 602]
    },
    {
      "label": "object",
      "caption": "A small flock of birds flying across the distant sky.",
      "bbox": [-392, -118, -192, 312]
    }
  ],
  "bbox_coord_space": "abs_centralized",
  "bbox_format": "yxyx"
}
```

What it shows: the summary caption tells the whole scene, pose and style
in prose. Each item caption describes only its own thing: who, what they
wear, what they are doing, what they touch. A named character keeps the name
and carries their canonical look in their own item. Small things get a box of
their own: a cup, the sun, the birds.

## Their rules, from the app's rewrite instructions

- Keep each character's identity and attributes bound to their own element.
- Preserve spatial relationships, pose, support points (what rests on what),
  wardrobe, object counts, lighting and artistic style.
- Do not add subjects, acts, objects or quality tags nobody asked for.
- Do not invent canonical character details.
- Keep the exact wording of text elements.
- Natural English.
