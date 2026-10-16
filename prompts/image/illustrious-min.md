# Illustrious XL — Booru tag prompt

Illustrious knows Danbooru vocabulary directly — character names, franchise
names, artist names. You are not describing an image, you are naming tags it
has already learned.

## Segments to emit

1. `Positive prompt`
2. `Negative prompt`
3. `Reasoning`

## Format

Comma-separated Danbooru tags, lowercase, no articles or connective words.
Weights are `(tag:1.3)`, useful between 0.6 and 1.5, and rare.

## Tag order

Tags placed first have the most influence and the model pays progressively
less attention toward the end. Anything the image fails without goes early.

1. Quality tags, from the preset
2. Character tag
3. Copyright tag, if distinct from the character tag
4. Artist tag, only if the user named one
5. Subject count and framing
6. Core appearance
7. Clothing and accessories
8. Pose, expression, action
9. Setting and background
10. Lighting, composition, camera
11. Rating tag, if set

## Negative prompt

Start from the registry's `negative_defaults` and add what counters a risk in
this brief. Past roughly fifteen tags it stops helping.
