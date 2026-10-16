# Visual Tags Catalogue for Anima

A practical catalogue for **Anima Base**, **Anima Aesthetic**, and **Anima Turbo**, verified on September 2, 2026.

Anima accepts two complementary vocabularies:

- **Native tags:** genuine Danbooru/Gelbooru tags or tags explicitly documented by Anima. They are concise, precise, and usually the most reliable.
- **Text modifiers:** English phrases understood by Anima's Qwen text encoder, but not necessarily official Danbooru tags. They are especially useful for photography, lighting, materials, atmosphere, and art direction.

The blocks below use the recommended Anima syntax: lowercase, comma-separated terms, and spaces instead of underscores. Literal parentheses in Danbooru tags are escaped for ComfyUI.

> **Important limitation:** no catalogue can guarantee that a term will always produce the same effect. Anima was trained with random tag dropout. Selecting a small set of coherent terms is usually better than copying an entire category.

## Recommended prompt order

```text
quality and period, safety, subject count, character, series, @artist, appearance, pose, environment, camera, composition, lighting, atmosphere, color, effects and finish
```

Example:

```text
masterpiece, best quality, newest, highres, safe, 1girl, character name, series name, upper body, from side, depth of field, backlighting, sunset, warm color palette, film grain
```

---

# 1. Quality, resolution, and period

## Tags officially documented by Anima

### Human quality ratings

```text
masterpiece, best quality, good quality, normal quality, low quality, worst quality
```

### Aesthetic scores

```text
score_9, score_8, score_7, score_6, score_5, score_4, score_3, score_2, score_1
```

For **Anima Base** and **Turbo**, a common starting point is `masterpiece, best quality, score_7`. For **Aesthetic**, `score_*` tags are usually unnecessary.

### Resolution and metadata

```text
highres, absurdres, incredibly absurdres, huge filesize, official art, illustration, wallpaper, official wallpaper, anime screencap, game cg, photo, scan
```

### Period

```text
newest, recent, mid, early, old, year 2026, year 2025, year 2024, year 2023, year 2022, year 2021, year 2020
```

### Text-based finish modifiers

```text
ultra detailed, highly detailed, extremely detailed, intricate details, fine details, absurdly detailed composition, 4k, 8k, high resolution, professional quality, polished, refined, crisp details
```

`4k` and `8k` describe an aesthetic intention; they do not change the actual latent resolution.

---

# 2. Visual style and art direction

## Native Danbooru styles

```text
abstract, art deco, art nouveau, cyberpunk, impressionism, ligne claire, minimalism, nihonga, photorealistic, realistic, retro artstyle, sketch, sumi-e, surreal, ukiyo-e, traditional media, faux traditional media, flat color, style parody, fine art parody, mosaic art, photomosaic, pixel art
```

## Illustration and animation styles

```text
anime coloring, cel shading, color trace, lineart, no lineart, outline, flat color, retro artstyle, anime screencap, game cg, official art, visual novel, faux figurine, 3d, live2d, vector trace
```

## Text-based style modifiers

```text
lineless, stylized, semi-realistic, painterly, graphic, illustrative, cinematic, editorial, fashion photography, fine art photography, concept art, key visual, promotional artwork, character illustration, fantasy illustration, dark fantasy, science fantasy, urban fantasy, gothic, baroque, rococo, brutalist, retrofuturism, solarpunk, steampunk, dieselpunk, biopunk, vaporwave, synthwave, dreamcore, weirdcore, surrealism, magical realism, maximalist, minimalist, elegant, luxurious, whimsical, ethereal, gritty, raw, polished
```

## Use realism terms carefully

```text
realistic, photorealistic, semi-realistic, realistic anatomy, natural proportions, detailed skin texture, natural skin tones, lifelike skin, realistic fabric, realistic materials, realistic lighting
```

The official model card states that Anima is primarily designed for anime and non-photographic illustration. `photorealistic` can influence the rendering, but it does not turn Anima into a specialized photography model.

---

# 3. Medium and artistic technique

## Painting

```text
acrylic paint \(medium\), gouache \(medium\), oil painting \(medium\), painting \(medium\), watercolor \(medium\), tempera \(medium\), pastel \(medium\), airbrush \(medium\), canvas \(medium\)
```

## Drawing and inking

```text
ballpoint pen \(medium\), brush \(medium\), brushpen \(medium\), calligraphy brush \(medium\), calligraphy pen \(medium\), chalk \(medium\), charcoal \(medium\), color ink \(medium\), colored pencil \(medium\), coupy pencil \(medium\), crayon \(medium\), fudepen \(medium\), g-pen \(medium\), graphite \(medium\), ink \(medium\), marker \(medium\), millipen \(medium\), nib pen \(medium\), pen \(medium\), watercolor pencil \(medium\)
```

## Artistic objects and materials

```text
amigurumi \(medium\), clay \(medium\), lego \(medium\), porcelain \(medium\), graffiti \(medium\), papercraft, paper child, paper cutout, kirigami, print \(medium\), book cover \(medium\), poster, postcard
```

---

# 4. Linework, coloring, and shading

## Native tags

```text
lineart, no lineart, outline, flat color, anime coloring, cel shading, color trace, hatching \(texture\), halftone, dithering, screentones, crosshatching, sketch, unfinished
```

## Text modifiers

```text
lineless, clean lineart, thin lineart, thick lineart, delicate lines, sharp lines, soft lines, expressive linework, loose brushwork, painterly brushstrokes, smooth gradients, hard cel shading, soft cel shading, soft shading, detailed shading, smooth shading, realistic shading, subtle shading
```

Choose either `lineart` or `no lineart`/`lineless`; combining them weakens the direction.

---

# 5. Framing and subject scale

## Reliable native shot tags

```text
close-up, portrait, upper body, cowboy shot, lower body, full body, wide shot, very wide shot, panorama
```

## Deliberate crops and overflow

```text
cropped, cropped shoulders, cropped torso, cropped arms, cropped legs, cropped head, head out of frame, eyes out of frame, feet out of frame, foot out of frame, out of frame, outside border
```

## Canvas and presentation formats

```text
tall image, wide image, widescreen, letterboxed, pillarboxed, border, framed, fading border, rounded corners, viewfinder, projected inset, zoom layer
```

## Text-based framing modifiers

```text
extreme close-up, medium close-up, medium shot, medium full shot, long shot, establishing shot, headshot, bust portrait, waist-up shot, knee-up shot, three-quarter shot, tight framing, loose framing, intimate framing, cinematic framing, environmental portrait, subject fills the frame
```

---

# 6. Camera angle and viewpoint

## Viewing direction

```text
from above, from below, from behind, from side, from outside, from inside, from ground, profile, facing viewer, facing away, facing to the side
```

## Special angles and perspectives

```text
pov, first-person view, camera pov, female pov, multiple pov, dutch angle, fisheye, isometric, bird's-eye view, worm's-eye view, atmospheric perspective, perspective, forced perspective, foreshortening, vanishing point, rotated, sideways, upside-down, partially underwater shot, underwater shot
```

## Text-based camera modifiers

```text
eye-level shot, low-angle shot, high-angle shot, overhead shot, aerial shot, ground-level shot, hip-level shot, shoulder-level shot, knee-level shot, top-down view, bottom-up view, frontal view, rear view, side view, three-quarter view, over-the-shoulder shot, first-person perspective, third-person perspective, subjective camera, objective camera, canted angle
```

---

# 7. Lens, focal length, and distortion

These are primarily text modifiers. Anima can follow them through its natural-language training.

```text
macro lens, wide-angle lens, ultra-wide-angle lens, fisheye lens, normal lens, telephoto lens, long lens, portrait lens, tilt-shift lens, anamorphic lens, 14mm lens, 18mm lens, 24mm lens, 28mm lens, 35mm lens, 50mm lens, 70mm lens, 85mm lens, 105mm lens, 135mm lens, 200mm lens, wide-angle distortion, telephoto compression, barrel distortion, perspective distortion, anamorphic distortion, lens compression
```

Useful reference points:

- `24mm`–`35mm`: visible environment and stronger perspective.
- `50mm`: relatively neutral rendering.
- `85mm`–`135mm`: portrait rendering and compressed background.
- `macro lens`: very small details and extreme close-ups.

---

# 8. Focus and depth

## Native tags

```text
depth of field, bokeh, blurry background, blurry foreground, soft focus, eye focus, hair focus, hand focus, foot focus, object focus, reflection focus, solo focus, atmospheric perspective
```

## Text modifiers

```text
sharp focus, tack sharp, selective focus, shallow depth of field, deep depth of field, rack focus, soft focus background, creamy bokeh, circular bokeh, cat-eye bokeh, foreground bokeh, background bokeh, subject separation, focal falloff, crisp subject, blurred environment, layered depth
```

`sharp focus` can describe the subject while `soft focus background` describes only the background. Applying both `sharp focus` and `soft focus` to the whole image is contradictory.

---

# 9. Composition and placement

## Native tags

```text
symmetry, rotational symmetry, polar opposites, negative space, vanishing point, perspective, isometric, lineup, column lineup, collage, multiple views, three sided view, reference sheet, character chart, expression chart, tachi-e, triptych \(art\), partially underwater shot, between fingers, between legs, between thighs
```

## Text-based composition modifiers

```text
centered composition, off-center composition, symmetrical composition, asymmetrical composition, balanced composition, unbalanced composition, rule of thirds, golden ratio, golden spiral, diagonal composition, triangular composition, pyramid composition, circular composition, radial composition, s-curve composition, l-shaped composition, frame within a frame, leading lines, converging lines, strong silhouette, foreground framing, layered composition, foreground interest, middle ground, background depth, visual hierarchy, focal point, central focus, negative space, positive space, dynamic composition, static composition, claustrophobic composition, spacious composition, clean composition, dense composition, minimalist composition, maximalist composition
```

The isolated word `curves` is ambiguous. For composition, use `s-curve composition`; for grading, use `tonal curve` or `contrast curve`.

---

# 10. Light sources

## Native natural and time-based sources

```text
sunlight, dappled sunlight, sunbeam, moonlight, candlelight, window light, twilight, sunrise, sunset, full moon
```

## Native artificial sources

```text
spotlight, neon lights, city lights, stage lights, ceiling light, hanging light, flashlight, searchlight, screen light, red light, string of light bulbs, christmas lights, camera flash
```

## Additional text modifiers

```text
daylight, skylight, starlight, firelight, practical lights, tungsten light, fluorescent light, led light, lantern light, torchlight, campfire light, fireplace light, streetlight, headlights, projector light, monitor glow, phone screen light, bioluminescent light, magical light, ambient light
```

---

# 11. Light direction and placement

## Native tags

```text
backlighting, sidelighting, underlighting, window light, window shadow, face in shadow, eyes in shadow, drop shadow, colored shadow
```

## Text modifiers

```text
front lighting, side lighting, top lighting, bottom lighting, back lighting, rim lighting, edge lighting, hair light, kicker light, key light, fill light, bounce light, reflected light, reflection light, cross lighting, split lighting, loop lighting, butterfly lighting, clamshell lighting, broad lighting, short lighting, three-point lighting, overhead lighting, underlighting, contour lighting, silhouette lighting
```

---

# 12. Light quality and character

## Tags or phrases commonly effective in Anima

```text
natural lighting, cinematic lighting, dim lighting, soft lighting, hard lighting, harsh lighting, dramatic lighting, moody lighting, diffused lighting, directional lighting, ambient lighting, studio lighting, volumetric lighting, warm lighting, cool lighting, colored lighting, mixed lighting, low-key lighting, high-key lighting, chiaroscuro, high contrast, subtle shadows, soft shadows, hard shadows, deep shadows, glowing light, light rays, god rays, light particles
```

## Photographic lighting modifiers

```text
softbox lighting, beauty dish lighting, ring light, fresnel lighting, gobo lighting, diffused sunlight, overcast lighting, golden hour lighting, blue hour lighting, available light, practical lighting, motivated lighting, dramatic rim light, soft rim light, strong rim light
```

---

# 13. Exposure, contrast, and tonal range

## Native tags

```text
high contrast, contrast, overexposure, silhouette, drop shadow, dark, darkness, pale color, muted color, monochrome, greyscale, sepia
```

## Text modifiers

```text
low contrast, medium contrast, crushed blacks, lifted blacks, deep blacks, rich blacks, bright highlights, soft highlights, specular highlights, blown highlights, clipped highlights, preserved highlights, deep shadows, open shadows, underexposed, overexposed, balanced exposure, natural exposure, long exposure, double exposure, high dynamic range, hdr, wide dynamic range, tonal range, smooth tonal transitions, cinematic contrast, matte contrast, tonal curve, contrast curve
```

---

# 14. Color and palette

## Native color themes

```text
aqua theme, black theme, blue theme, brown theme, green theme, grey theme, orange theme, pink theme, purple theme, red theme, white theme, yellow theme
```

## Native color treatments

```text
colorful, pastel colors, pale color, muted color, neon palette, limited palette, monochrome, greyscale, sepia, high contrast, inverted colors, partially colored, spot color, gradient, rainbow, rainbow order, color connection, colorized, multiple monochrome
```

## Text-based palette modifiers

```text
vibrant colors, saturated colors, highly saturated, desaturated colors, low saturation, warm color palette, cool color palette, neutral color palette, earthy color palette, jewel tones, candy colors, dusty colors, soft pastels, rich colors, bold colors, complementary colors, analogous colors, split-complementary palette, triadic palette, tetradic palette, duotone, tritone, teal and orange color grading, cyan and magenta palette, red and black palette, blue and gold palette, pink and blue palette, green and purple palette, warm highlights and cool shadows, cool highlights and warm shadows, natural skin tones, color harmony
```

---

# 15. Atmosphere, mood, and emotional tone

This category primarily uses text modifiers. They work best when supported by coherent lighting, palette, and environment choices.

## Positive and peaceful

```text
serene, peaceful, calm, tranquil, cozy, warm, intimate, tender, romantic, dreamy, whimsical, joyful, cheerful, uplifting, hopeful, nostalgic, sentimental, idyllic, heavenly, ethereal, magical, enchanting
```

## Dramatic and intense

```text
dramatic, cinematic, epic, majestic, heroic, powerful, tense, suspenseful, urgent, dynamic, explosive, monumental, awe-inspiring, grandiose, theatrical
```

## Dark and unsettling

```text
moody, melancholic, somber, gloomy, ominous, eerie, unsettling, mysterious, haunting, sinister, foreboding, claustrophobic, lonely, desolate, bleak, grim, gritty, horror atmosphere, dark fantasy atmosphere, uncanny, liminal
```

## Modern and energetic

```text
vibrant, stylish, glamorous, fashionable, luxurious, playful, energetic, rebellious, punk, futuristic, cyberpunk atmosphere, nightlife atmosphere, urban atmosphere, neon-soaked, high-energy
```

---

# 16. Time of day and atmospheric conditions

## Time and sky — native tags

```text
day, night, dawn, dusk, twilight, sunrise, sunset, cloudy sky, starry sky, full moon, huge moon, aurora, above clouds
```

## Weather and atmosphere — native tags

```text
rain, snow, snowing, snowflakes, wind, storm, fog, smoke, steam, dust, dust cloud, embers, fireflies, light particles, after rain, dark cloud, cumulonimbus cloud
```

## Additional text modifiers

```text
golden hour, blue hour, midday sun, overcast day, moonlit night, rainy night, foggy morning, mist, misty forest, hazy atmosphere, humid air, dry air, dusty air, smoky atmosphere, stormy sky, approaching storm, light rain, heavy rain, torrential rain, drizzle, snowfall, blizzard, strong wind, gentle breeze, heat haze, atmospheric haze, volumetric fog
```

---

# 17. Optical effects and post-processing

## Native tags

```text
chromatic aberration, chromatic aberration abuse, lens flare, lens flare abuse, non-circular lens flare, diffraction spikes, bloom, bokeh, depth of field, film grain, heavy film grain, vignetting, scanlines, anaglyph, glitch, jpeg artifacts, overexposure, double exposure, blurry edges, optical illusion, caustics
```

## Text modifiers

```text
cinematic color grading, filmic color grading, color grading, teal and orange grading, bleach bypass, cross processing, day-for-night, soft glow, halation, light leak, film burn, analog film look, vintage film look, retro film look, kodachrome look, polaroid look, hdr look, matte finish, glossy finish, split toning, bloom effect, glow effect, vignette, lens distortion, anamorphic flare, ray tracing, subtle film grain, coarse film grain, clean digital image
```

---

# 18. Motion and visual energy

## Native tags

```text
motion blur, motion lines, speed lines, emphasis lines, afterimage, light trail, smoke trail, wind, wind lift, foreshortening, dynamic pose
```

## Text modifiers

```text
dynamic motion, frozen motion, high-speed photography, long-exposure motion blur, directional motion blur, radial blur, zoom blur, panning shot, action shot, impact frame, kinetic composition, flowing movement, explosive motion, subtle movement, hair blowing in the wind, clothes flowing in the wind, suspended particles
```

---

# 19. Background and scene depth

## Native tags

```text
simple background, white background, black background, grey background, gradient background, transparent background, dark background, sparkle background, starry sky background, rainbow background, scenery, landscape, cityscape, indoors, outdoors, science fiction, fantasy, blurry background, blurry foreground
```

## Text modifiers

```text
photo background, realistic background, detailed background, environmental background, cinematic background, soft focus background, out-of-focus background, shallow-focus background, atmospheric background, abstract background, studio background, seamless background, textured background, painted background, minimalist background, cluttered background, layered background, foreground elements, middle-ground elements, distant background, atmospheric depth
```

---

# 20. Skin, materials, and physical rendering

These terms are primarily textual. They are useful for semi-realistic rendering, but should not all be stacked together.

## Skin

```text
detailed skin texture, natural skin texture, realistic skin, natural skin tones, skin pores, fine pores, subtle pores, skin folds, subtle skin folds, skin creases, fine wrinkles, peach fuzz, subsurface scattering, translucent skin, soft skin, smooth skin, dewy skin, matte skin, moist skin, skin sheen, specular skin highlights, natural blush, uneven skin tone, freckles, beauty marks
```

## Hair, eyes, and fabric

```text
detailed hair strands, individual hair strands, soft hair, glossy hair, realistic hair, detailed irises, realistic eyes, eye reflections, wet eyes, realistic fabric, detailed fabric texture, fabric folds, cloth wrinkles, fine stitching, embroidery detail, translucent fabric, sheer fabric, velvet texture, silk texture, satin sheen, leather texture, wool texture, denim texture, lace texture
```

## Surfaces and materials

```text
realistic materials, physically based rendering, pbr materials, metallic reflections, brushed metal, polished metal, rough metal, glossy surface, matte surface, wet surface, reflective surface, translucent material, transparent material, subsurface scattering, ambient occlusion, contact shadows, microtexture, surface imperfections, scratches, dust, patina, weathering
```

---

# 21. Environmental effects and particles

## Native tags

```text
light particles, sparkle, embers, fireflies, snowflakes, dust, dust cloud, smoke, steam, fog, rain, snow, colored smoke, glowing petals, glowing butterfly, caustics
```

## Text modifiers

```text
floating particles, glowing particles, suspended dust, dust motes, airborne particles, pollen, drifting petals, falling leaves, falling snow, raindrops, water droplets, spray, sea spray, sparks, ash particles, magical particles, glitter particles, glowing motes, volumetric particles, atmospheric particles, bokeh lights
```

---

# 22. Graphic formats and layouts

```text
poster, cover, album cover, magazine cover, manga cover, book cover \(medium\), video game cover, fake cover, character single, reference sheet, character chart, expression chart, diagram, collage, triptych \(art\), comic, 1koma, 2koma, 3koma, 4koma, multiple 4koma, borderless panels, icon, logo, wallpaper, official wallpaper, card \(medium\), calendar \(medium\)
```

For exact layouts, use complete sentences that describe every canvas region. Tags alone cannot guarantee element placement.

---

# 23. Coherent copy-ready presets

## Semi-realistic cinematic

```text
cinematic, semi-realistic, realistic anatomy, detailed skin texture, natural skin tones, subsurface scattering, cinematic lighting, rim lighting, subtle shadows, depth of field, soft focus background, sharp focus, film grain, cinematic color grading, absurdres, ultra detailed
```

## Natural and dark cinematic

```text
natural lighting, dim lighting, backlighting, rim lighting, light rays, subtle shadows, low-key lighting, depth of field, blurry background, film grain, muted color, moody, cinematic
```

## Clean and vibrant anime

```text
anime coloring, cel shading, clean lineart, vibrant colors, high contrast, colorful, sharp focus, dynamic composition, dramatic lighting, bloom, light particles, absurdres
```

## Stylized lineless rendering

```text
no lineart, lineless, stylized, painterly, soft shading, smooth gradients, vibrant colors, subtle shadows, atmospheric perspective, depth of field, polished
```

## Beauty portrait

```text
portrait, close-up, 85mm lens, shallow depth of field, creamy bokeh, soft lighting, butterfly lighting, soft rim light, detailed skin texture, natural skin tones, subtle pores, peach fuzz, subsurface scattering, sharp eyes, soft focus background
```

## Neon night

```text
night, neon lights, neon palette, colored lighting, rim lighting, glowing light, city lights, wet surface, reflection, depth of field, bokeh, cinematic color grading, cyberpunk atmosphere
```

## Romantic golden hour

```text
sunset, golden hour lighting, warm color palette, backlighting, dappled sunlight, light rays, soft rim light, dreamy, romantic, depth of field, film grain
```

## Atmospheric horror

```text
horror \(theme\), dark, fog, silhouette, underlighting, deep shadows, chiaroscuro, muted color, film grain, ominous, eerie, unsettling, claustrophobic composition
```

## Traditional painting

```text
traditional media, oil painting \(medium\), canvas \(medium\), painterly brushstrokes, rich colors, chiaroscuro, soft edges, textured surface, fine art, dramatic composition
```

---

# 24. Combinations to avoid or use deliberately

| Combination | Likely issue |
|---|---|
| `photorealistic` + `anime screencap` | Competing rendering families. |
| `lineart` + `no lineart` + `lineless` | Opposing contour instructions. |
| `flat color` + `detailed skin texture` + `subsurface scattering` | Flat rendering conflicts with realistic volume. |
| `sharp focus` + `soft focus` | Contradictory when both apply to the whole image. |
| `day` + `night` | Best reserved for split scenes or transitions. |
| `high-key lighting` + `low-key lighting` | Opposing exposure strategies. |
| `warm lighting` + `cool lighting` | Works only with separate light sources or deliberate warm/cool contrast. |
| `monochrome` + `vibrant colors` | Contradictory unless selective coloring is intended. |
| `minimalist composition` + `absurdly detailed composition` | Can create an indecisive visual result. |
| Too many quality terms | Redundant and displaces useful visual information. |

---

# 25. Recommended visual-layer construction

Usually select:

1. **One primary style:** `semi-realistic`, `anime coloring`, `oil painting \(medium\)`, etc.
2. **One framing choice:** `close-up`, `upper body`, `cowboy shot`, or `full body`.
3. **One angle:** `from below`, `from side`, `dutch angle`, etc.
4. **One depth treatment:** `depth of field`, `blurry background`, `sharp focus`.
5. **One primary lighting treatment:** `natural lighting`, `cinematic lighting`, `backlighting`, etc.
6. **One secondary light or effect:** `rim lighting`, `light rays`, `bloom`.
7. **One atmosphere:** `dreamy`, `moody`, `romantic`, `ominous`, etc.
8. **One palette:** `muted color`, `pastel colors`, `warm color palette`, etc.
9. **One finish:** `film grain`, `detailed skin texture`, `subsurface scattering`, etc.

Compact example:

```text
semi-realistic, upper body, from side, depth of field, natural lighting, rim lighting, moody, muted color, film grain, detailed skin texture
```

---

# Sources and methodology

- [Official CircleStone Labs Anima model card](https://huggingface.co/circlestone-labs/Anima): syntax, tag order, quality, period, safety, artist prompting, Danbooru tags, and natural-language captions.
- [Public Danbooru Tag Counts dataset](https://huggingface.co/datasets/HDiffusion/historical-danbooru-tag-counts), dated September 2, 2026: verification of native tag names and existence.
- [Danbooru Diffusion Prompt Builder](https://github.com/wfjsw/danbooru-diffusion-prompt-builder): the `style`, `perspective`, `composition`, `effects`, `color`, and `format` groups provided the initial thematic classification.
- Phrases labeled as **text modifiers** are descriptive instructions for the Qwen encoder; they are not presented as official Danbooru tags.


