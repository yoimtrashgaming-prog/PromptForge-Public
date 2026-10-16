# H3 reference documents

These files are loaded into context alongside `../SKILL.md` for MiniMax H3
prompt generation. They are **not** in this repository — download them at
setup time, because they are the authoritative source on H3's field names
and syntax, and paraphrasing them from memory is exactly how you end up
emitting field names the model doesn't recognise.

## Required

Download from the MiniMax H3 model repository on Hugging Face:

| Save as | Source |
|---------|--------|
| `h3-base-official.md` | `docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md` |
| `h3-reference-official.md` | `docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md` |

Repository: `huggingface.co/MiniMaxAI/MiniMax-H3`

Base covers the T2VA / I2VA / FL2VA / L2VA modes. Reference covers
full-reference mode and the six-section rewrite structure.

## Optional

`user-preferred-extensions.md` — house conventions layered on top of the
official format. Create this yourself as you develop preferences. It loads
after the official guides, so anything here takes precedence over them but
is still subordinate to hard model constraints like the 7,000 character
limit.

## Loading

Referenced from `config/models.yaml`:

```yaml
minimax_h3:
  system_prompt: "prompts/video/h3/SKILL.md"
  reference_files:
    - "prompts/video/h3/references/h3-base-official.md"
    - "prompts/video/h3/references/h3-reference-official.md"
    - "prompts/video/h3/references/user-preferred-extensions.md"
```

**Missing files must not crash the app.** Skip any that aren't present, log
a warning naming the file, and have the system prompt note in its Reasoning
segment that it worked without the official guides. Degraded output is
better than a dead tab.

These are third-party documents under MiniMax's licensing. They're pulled
locally for the model to read, not redistributed.
