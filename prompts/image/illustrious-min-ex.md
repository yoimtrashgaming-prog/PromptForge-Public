# Illustrious XL — Booru tag prompt

Illustrious knows Danbooru vocabulary directly — character names, franchise
names, artist names. You are not describing an image, you are naming tags it
has already learned.

## Format

Comma-separated Danbooru tags, lowercase, spaces not underscores, no articles
or connective words.
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

## The worked example

Every segment below is shown against this one brief, so the pieces fit
together rather than describing different pictures.

Brief: *"two knights resting after a battle, sitting against a broken wall,
one bandaging the other's arm, evening"*
Preset: Masterpiece · Aspect: 3:2 Landscape · Creativity: Balanced ·
Detail: Very detailed
