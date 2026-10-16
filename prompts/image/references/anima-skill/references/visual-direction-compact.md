# Compact visual-direction vocabulary for Anima

Use this reference when the full visual catalogue cannot fit in the local model context.

- Native tags belong in `Core tags:` and must pass the local catalogue validator.
- Text modifiers belong in `Text modifiers:`. They are English directions understood by Anima's Qwen encoder, not official Danbooru tags.
- Core tags are Anima's primary control signal. Every concrete visible subject, appearance trait, object, state, action, pose, interaction, environment and camera fact must use a verified native tag whenever one exists.
- Text modifiers supplement native tags for concepts without a suitable native equivalent; they never replace an available native tag.
- Every important camera, composition, focus, lighting, atmosphere, effect, material, and finish direction in the authoritative brief or natural-language draft must be mapped explicitly to one of those two lines. Do not silently drop major visual directions.
- Scale coverage to the tag-detail level. At levels 7–10, build a broad systematic mapping rather than a small compact set. Never copy whole categories. After factual mapping, compatible style, atmosphere, lighting, palette, material and finish choices may be added according to the creativity level even when they are not literally stated in the prose; they must not alter concrete scene facts.

## Native tags

Framing: `close-up`, `portrait`, `upper body`, `cowboy shot`, `lower body`, `full body`, `wide shot`, `very wide shot`, `panorama`, `cropped`, `wide image`, `widescreen`.

Viewpoint and perspective: `from above`, `from below`, `from behind`, `from side`, `profile`, `facing viewer`, `pov`, `dutch angle`, `fisheye`, `bird's-eye view`, `worm's-eye view`, `atmospheric perspective`, `perspective`, `forced perspective`, `foreshortening`, `vanishing point`.

Focus and depth: `depth of field`, `bokeh`, `blurry background`, `blurry foreground`, `soft focus`, `eye focus`, `hair focus`, `hand focus`, `object focus`, `reflection focus`, `solo focus`.

Composition: `symmetry`, `negative space`, `vanishing point`, `perspective`, `isometric`, `collage`, `multiple views`, `triptych \(art\)`.

Light and tone: `sunlight`, `dappled sunlight`, `sunbeam`, `moonlight`, `candlelight`, `window light`, `twilight`, `sunrise`, `sunset`, `spotlight`, `neon lights`, `screen light`, `camera flash`, `backlighting`, `sidelighting`, `underlighting`, `window shadow`, `face in shadow`, `drop shadow`, `high contrast`, `dark`, `darkness`, `muted color`, `monochrome`, `greyscale`, `sepia`, `light rays`, `light particles`.

Palette, atmosphere, and weather: `colorful`, `pastel colors`, `pale color`, `muted color`, `neon palette`, `limited palette`, `gradient`, native color-theme tags, `day`, `night`, `dawn`, `dusk`, `rain`, `snow`, `wind`, `storm`, `fog`, `smoke`, `steam`, `dust`, `embers`, `fireflies`.

Effects and finish: `chromatic aberration`, `lens flare`, `bloom`, `film grain`, `heavy film grain`, `vignetting`, `scanlines`, `glitch`, `overexposure`, `double exposure`, `blurry edges`, `caustics`, `motion blur`, `motion lines`, `speed lines`, `afterimage`, `dynamic pose`, `anime coloring`, `cel shading`, `lineart`, `no lineart`, `flat color`, `halftone`, `dithering`, `screentones`, `sketch`.

Background and particles: `simple background`, `white background`, `black background`, `grey background`, `gradient background`, `dark background`, `scenery`, `landscape`, `cityscape`, `indoors`, `outdoors`, `blurry background`, `sparkle`, `snowflakes`, `glowing petals`.

## Text modifiers

Framing and camera: `extreme close-up`, `medium close-up`, `medium shot`, `three-quarter shot`, `tight framing`, `cinematic framing`, `subject fills the frame`, `eye-level shot`, `low-angle shot`, `high-angle shot`, `overhead shot`, `ground-level shot`, `frontal view`, `rear view`, `side view`, `three-quarter view`, `over-the-shoulder shot`.

Lens, focus, and depth: `macro lens`, `wide-angle lens`, `telephoto lens`, `portrait lens`, focal-length phrases such as `35mm lens` or `85mm lens`, `sharp focus`, `selective focus`, `shallow depth of field`, `deep depth of field`, `soft focus background`, `creamy bokeh`, `subject separation`, `focal falloff`, `crisp subject`, `blurred environment`, `layered depth`.

Composition: `centered composition`, `off-center composition`, `symmetrical composition`, `asymmetrical composition`, `rule of thirds`, `diagonal composition`, `triangular composition`, `frame within a frame`, `leading lines`, `strong silhouette`, `foreground framing`, `layered composition`, `visual hierarchy`, `focal point`, `central focus`, `dynamic composition`, `claustrophobic composition`, `spacious composition`.

Lighting and palette: `natural lighting`, `cinematic lighting`, `dim lighting`, `soft lighting`, `hard lighting`, `harsh lighting`, `dramatic lighting`, `moody lighting`, `diffused lighting`, `ambient lighting`, `volumetric lighting`, `warm lighting`, `cool lighting`, `low-key lighting`, `chiaroscuro`, `subtle shadows`, `deep shadows`, `ambient light`, `rim lighting`, `key light`, `fill light`, `reflected light`, `split lighting`, `three-point lighting`, `overhead lighting`, `softbox lighting`, `diffused sunlight`, `golden hour lighting`, `blue hour lighting`, `available light`, `crushed blacks`, `deep blacks`, `specular highlights`, `balanced exposure`, `cinematic contrast`, `warm color palette`, `cool color palette`, `earthy color palette`, `jewel tones`, `teal and orange color grading`, `warm highlights and cool shadows`, `color harmony`.

Atmosphere, materials, and effects: mood words such as `serene`, `poignant`, `moody`, `melancholic`, `ominous`, `eerie`, `intimate`, `dreamy`, `cinematic`; `cinematic color grading`, `soft glow`, `halation`, `light leak`, `matte finish`, `glossy finish`, `subtle film grain`, `detailed skin texture`, `subsurface scattering`, `detailed hair strands`, `realistic fabric`, `reflective surface`, `surface imperfections`, `water droplets`, `drifting petals`, `falling leaves`, `suspended dust`, `floating particles`.

Example: a brief in which a character tilts a watering can over a wilting flower while droplets hang in the air and a petal falls must retain the watering action in prose. It should use native controls such as `holding watering can`, `watering can`, `water drop`, `flower`, `falling petals`, `close-up`, `depth of field`, `object focus` and `sidelighting` when supported by the finished scene. Phrases such as `extreme close-up`, `shallow depth of field`, `soft diffused lighting` and `poignant atmosphere` belong in `Text modifiers:` only when actually established.
