# Anima — the vendor's own prompting guide

Taken from the official model card, `huggingface.co/circlestone-labs/Anima`,
read 30 August 2026. **This is the authoritative source on Anima's prompt
format.** Where `../anima.md` and this file disagree about what the model
expects, this one is right and `anima.md` should be corrected — not the other
way round.

Written down rather than paraphrased from memory, because the whole reason h3
carries its official guides is that a field name recalled from training data is
a field name the model does not recognise. Same risk here.

Short strings — the recommended prefix, the tag order template — are quoted
exactly, because they are functional. The prose around them is a digest.

---

## Recommended prefix and negative

The card's own recommendation, verbatim:

```
positive prefix: masterpiece, best quality, score_7, safe,
negative:        worst quality, low quality, score_1, score_2, score_3,
                 artist name, blurry, jpeg artifacts, chromatic aberration
```

## Tag order

```
[quality/meta/year/safety tags] [1girl/1boy/1other etc] [character] [series] [artist] [general tags]
```

Order **within** a section does not matter.

## Tag formatting

- Lowercase, and **spaces rather than underscores**.
- **Score tags are the one exception** and keep their underscores: `score_7`.
- Where Danbooru and Gelbooru disagree on a tag's spelling, **prefer the
  Gelbooru form**.
- Weighting needs **higher values than usual** on this model — the card's own
  example is `(chibi:2)`.

## The tag vocabularies

| Category | Values |
|---|---|
| Quality, human-scored | `masterpiece`, `best quality`, `good quality`, `normal quality`, `low quality`, `worst quality` |
| Quality, aesthetic-model | `score_9` down to `score_1` |
| Year, specific | `year 2025`, `year 2024`, … |
| Year, period | `newest`, `recent`, `mid`, `early`, `old` |
| Meta | `highres`, `absurdres`, `anime screenshot`, `jpeg artifacts`, `official art` |
| Safety | `safe`, `sensitive`, `nsfw`, `explicit` |
| Artist | `@`-prefixed, e.g. `@big chungus`. **The `@` is mandatory.** |

## Natural language

Tags, natural language, or both mixed in any order — all three are supported.

- Use **standard English capitalisation** for character and series names in the
  natural-language portion. (Tags stay lowercase.)
- Aim for **at least two sentences** when writing descriptively.
- With more than one character, **name them first, then describe each one's
  basic appearance**, so the model can keep them apart.

## Per-variant settings

Not emitted by PromptForge — recorded because a prompt written for Turbo and
run at Base settings is a fair test of neither.

| Variant | Steps | CFG |
|---|---|---|
| Anima-Base | 30–50 | 4–5 |
| Anima-Aesthetic | 30–50 | 4–5 |
| Anima-Turbo | 8–12 | 1 |

Resolution 512² to 1536² on every variant. Suggested samplers: `er_sde`,
`euler_a`, `dpmpp_2m_sde_gpu`, `euler`.

## Anima-Aesthetic takes no score tags

*"Anima-Aesthetic is fine-tuned only on high quality images, with all of the
quality tags stripped out from the captions."*

So `score_*` should not be used on that variant — the quality is already baked
in and the tags mean nothing to it. PromptForge does not currently know which
variant anyone is running, so its quality presets are written for Base.

## Stated limitations

- **It does not do realism well, and that is deliberate.** The registry's
  "Realistic" style is offered but will always pull weakly here.
- Text rendering is limited.
- Anima-Base has a neutral, plain default style, having had no aesthetic
  tuning.
