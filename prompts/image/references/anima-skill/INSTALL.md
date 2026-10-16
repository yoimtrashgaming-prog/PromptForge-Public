# Anima Two-Pass Prompting — Portable Package

This folder is self-contained. It includes the skill instructions, all referenced guidance, the visual-direction catalogue, and the three local data files used by the original QWEN UI setup.

## Install as a Codex skill

Copy the entire `anima-prompt-writing-portable` folder into the recipient's Codex skills directory and rename the copied folder to `anima-prompt-writing`:

```text
<CODEX_HOME>/skills/anima-prompt-writing/
```

If `CODEX_HOME` is not configured, the usual personal location is:

```text
~/.codex/skills/anima-prompt-writing/
```

Keep `SKILL.md`, `agents/`, `references/`, and `data/` together. The skill uses only relative paths and does not depend on the sender's computer.

## Use the data with QWEN UI

If the recipient's QWEN UI expects its databases in a separate application data folder, copy these three bundled files from `data/` into that UI's own `data/` directory:

```text
anima-1.0.csv
danbooru-attire.json
character-appearance-cache.json
```

Back up files with the same names before replacing them. The character cache contains dated entries and may later be refreshed by the UI.

## Included files

```text
anima-prompt-writing-portable/
|-- SKILL.md
|-- INSTALL.md
|-- MANIFEST.sha256
|-- agents/
|   `-- openai.yaml
|-- references/
|   |-- anima-prompting.md
|   |-- civitai-showcase-patterns.md
|   |-- layout-and-binding.md
|   `-- visual-direction-tags.md
`-- data/
    |-- anima-1.0.csv
    |-- danbooru-attire.json
    `-- character-appearance-cache.json
```

## What works offline

- The mandatory natural-language first pass.
- Ordered conversion into native tags and text modifiers.
- Local tag and alias lookup.
- Clothing taxonomy lookup.
- Cached character-appearance lookup.
- Visual-direction, camera, composition, lighting, mood, palette, and material guidance.

Internet access is useful only for optional verification of missing or recent characters, uncertain tags, and artist identities.

`MANIFEST.sha256` contains checksums for the distributed files so the recipient can verify that the package was transferred intact.
