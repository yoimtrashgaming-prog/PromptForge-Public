## Negative prompt

Wan's negative prompt is for **artifacts, not content**. It is the main
defence against the specific ways Wan fails, and the defaults exist for
real reasons:

- `morphing`, `warping` — identity and object shape drifting mid-clip
- `flickering` — frame-to-frame inconsistency in texture or lighting
- `distorted hands`, `duplicate limbs` — the usual anatomy failures, worse
  in motion
- `sudden identity change` — the face becoming a different face
- `jittery motion`, `stuttering` — temporal instability
- `text overlay`, `watermark`

Start from the registry defaults and add what this brief specifically
risks. Fast motion risks flicker. Hands in frame risk distortion. Multiple
characters risk identity swap. Do not put unwanted *content* here; handle
that by describing what is present instead.

Its place in the example above:

```
===SEGMENT: Negative prompt===
morphing, warping, flickering, distorted hands, duplicate limbs, sudden identity change, jittery motion, text overlay, watermark, subtitles
```
