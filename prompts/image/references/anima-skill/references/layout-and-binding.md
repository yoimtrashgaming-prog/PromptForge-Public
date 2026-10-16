# Layout and identity binding

Use this reference for panels, grids, collages, fixed regions, exact named-character placement, repeated-identity failures, or border containment.

## Contents

- [What local tests show](#what-local-tests-show)
- [Prompt architecture](#prompt-architecture)
- [Validated 2x2 pattern](#validated-2x2-pattern)
- [Conflict tags](#conflict-tags)
- [Layout vocabulary](#layout-vocabulary)
- [Failure handling](#failure-handling)

## What local tests show

Local Anima testing produced three useful outcomes:

1. A tag-heavy prompt with short fragments such as `one girl per panel` generated a 2x2 canvas but left cells empty and placed partial characters across a border.
2. A prompt using `multiple views`, `collage`, `everyone`, and `group picture` filled the four panels with repeated and grouped characters instead of four distinct identities.
3. A hybrid prompt using a compact tag scaffold followed by complete English sentences successfully generated a single 2x2 image with four distinct named characters, explicit panel assignments, separate backgrounds, and improved containment. The user reported that this version worked very well.

Conclude that Anima can perform one-pass structured layouts. The failures came from weak sentence fragments and conflicting visual tags, not from a general inability to understand English.

The Qwen text encoder can also follow long English descriptions of clothing, hand geometry, pose, perspective, environment, and camera angle. Use this capability directly.

## Prompt architecture

Build structured prompts in two layers.

### 1. Tag scaffold

Use a short tag block to establish:

- quality and safety;
- medium such as `official art` or `comic`;
- panel prior such as `4koma` and `white border`;
- exact global subject count;
- character and series identities;
- common framing such as `upper body`, `looking at viewer`, and `simple background`.

Do not attempt complete identity binding inside this comma-separated block.

### 2. English binding description

Write full sentences in this order:

1. Define the complete canvas and grid orientation.
2. State the exact number of distinct subjects and that each appears once.
3. Assign each subject to one location in a separate sentence.
4. Repeat the subject's name and one or two identifying traits in that sentence.
5. Give each region a distinct simple background when it helps separation.
6. Define framing consistently, for example separate upper-body portraits.
7. State the required visible margin and which elements must remain inside each border.

Use simple, literal English. Avoid shorthand fragments, pronouns with unclear antecedents, and long chains joined only by commas.

## Validated 2x2 pattern

Use this generalized template for a single generated image:

```text
[quality tags], comic, 4koma, white border, [exact subject count], [character names], [series], upper body, looking at viewer, simple background. A square anime illustration divided into a clean two-by-two grid with four equal panels. The image contains exactly four different characters, and each character appears only once. The upper-left panel shows [character A] with [traits] against [background]. The upper-right panel shows [character B] with [traits] against [background]. The lower-left panel shows [character C] with [traits] against [background]. The lower-right panel shows [character D] with [traits] against [background]. Each panel is a separate upper-body portrait. Every face, hairstyle, shoulder, and piece of clothing remains inside its panel, with visible empty space between the character and the white border.
```

Use a paired negative structure:

```text
This image must not contain duplicated characters, repeated faces, extra subjects, shared bodies, merged characters, or characters appearing in the wrong panel. No hair, face, arms, clothing, or props may cross the white borders. [model negative baseline], outside border, out of frame, head out of frame, cropped arms, [wrong subject-count tags], text, speech bubble, watermark, logo
```

Treat this as an empirically successful pattern, not a pixel-level guarantee.

## Conflict tags

For a different named character in every panel, omit these otherwise valid tags:

- `multiple views`: encourages repeated depictions or views of the same identity;
- `collage`: encourages uncontrolled image grouping;
- `everyone`: can increase group density instead of separation;
- `group picture`: encourages several subjects inside the same region;
- `lineup`: encourages a shared row rather than panel binding.

Use those tags only when their visual behavior matches the request.

## Layout vocabulary

The following tags appear in a public Danbooru-derived tag index. Convert underscores to spaces in final Anima prompts.

| Raw tag | Prompt form | Corpus count | Use |
|---|---|---:|---|
| `comic` | `comic` | 474986 | Establish comic presentation. |
| `4koma` | `4koma` | 92575 | Establish a four-panel prior; use English to specify 2x2 rather than vertical. |
| `border` | `border` | 88504 | Request a visible border. |
| `white_border` | `white border` | 50865 | Request white separators or framing. |
| `outside_border` | `outside border` | 34702 | Put in negative when border crossing is unwanted. |
| `full_body` | `full body` | 624413 | Use when entire figures must be visible. |
| `upper_body` | `upper body` | 595301 | Easier than full body for multi-panel portraits. |
| `simple_background` | `simple background` | 1420030 | Improve identity and panel separation. |
| `out_of_frame` | `out of frame` | 28722 | Put in negative for framing failures. |

Counts are vocabulary evidence from the [WD EVA02 Large Tagger v3 tag index](https://huggingface.co/SmilingWolf/wd-eva02-large-tagger-v3/blob/main/selected_tags.csv), not proof of conditioning strength.

## Failure handling

When a structured prompt fails:

1. Inspect whether the panel structure, character count, identity binding, or containment failed.
2. Remove tags that visually contradict the intended binding before adding more words.
3. Strengthen the relevant full sentence by repeating the proper name and a defining visual trait.
4. Keep sentence structure simple and parallel across regions.
5. Try two or three seeds before declaring the prompt pattern ineffective.
6. Use regional conditioning, masked refinement, or deterministic assembly only when hybrid prompting remains unstable or the user requires pixel-level certainty.
