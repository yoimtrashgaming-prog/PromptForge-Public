# Setting up the image taggers

Image Analysis, and the tagger read of reference pictures, need three tagger
models. They are not in git: together they are about 4.4 GB, and GitHub
refuses files over 100 MB. This page says exactly what to get, where it goes,
and how to check it worked. You can follow it by hand, or hand it to an AI
coding assistant (Claude Code or similar) with "set up the taggers from
docs/taggers-setup.md".

**The easy way is the Setup panel** (owner only, top bar): paste a folder
to search, or press Download for the WD taggers. This page is for doing it by
hand, for animetimm's one-time conversion, and for an AI assistant.

Nothing here is required to run PromptForge. A missing tagger makes Image
Analysis report itself unavailable and nothing else changes.

## What goes where

Everything goes in the project's `taggers/` folder (create it if missing; it
is gitignored). The file names must be exactly these:

| Tagger (config key) | File in `taggers/` | Comes from | Size |
|---|---|---|---|
| `wd14_eva02` | `wd-eva02-large-tagger-v3.onnx` | `model.onnx` from [SmilingWolf/wd-eva02-large-tagger-v3](https://huggingface.co/SmilingWolf/wd-eva02-large-tagger-v3) | 1,260,435,999 bytes |
| | `wd-eva02-large-tagger-v3.csv` | `selected_tags.csv` from the same repo | 308,468 bytes |
| `wd14_moat` | `wd-v1-4-moat-tagger-v2.onnx` | `model.onnx` from [SmilingWolf/wd-v1-4-moat-tagger-v2](https://huggingface.co/SmilingWolf/wd-v1-4-moat-tagger-v2) | 326,197,340 bytes |
| | `wd-v1-4-moat-tagger-v2.csv` | `selected_tags.csv` from the same repo | 253,906 bytes |
| `animetimm_convnextv2` (the default) | `animetimm-convnextv2-huge-dbv4.onnx` | **converted** from [animetimm/convnextv2_huge.dbv4-full](https://huggingface.co/animetimm/convnextv2_huge.dbv4-full) — see step 3 | 343,949 bytes |
| | `animetimm-convnextv2-huge-dbv4.onnx.data` | written by the same conversion | 2,770,470,152 bytes |
| | `animetimm-convnextv2-huge-dbv4.csv` | `selected_tags.csv` from that repo, copied by the conversion | 3,392,375 bytes |

The sizes are the ones on the group's server. A file of a different size is
a different file.

Licences: both WD taggers are Apache-2.0. animetimm is GPL-3.0.

## Step 1 — reuse what ComfyUI already has

If ComfyUI is installed with the **WD14 Tagger** node, it has probably
downloaded the WD models already, to:

```
<ComfyUI>/custom_nodes/comfyui-wd14-tagger/models/wd-eva02-large-tagger-v3.onnx
<ComfyUI>/custom_nodes/comfyui-wd14-tagger/models/wd-eva02-large-tagger-v3.csv
<ComfyUI>/custom_nodes/comfyui-wd14-tagger/models/wd-v1-4-moat-tagger-v2.onnx
<ComfyUI>/custom_nodes/comfyui-wd14-tagger/models/wd-v1-4-moat-tagger-v2.csv
```

Either copy them into `taggers/`, or leave them where they are and point at
them: copy `config/taggers.local.example.yaml` to `config/taggers.local.yaml`
and fill in the real paths. That file is per-machine and gitignored.

ComfyUI may also hold the animetimm **original** (not the converted file) at
`<ComfyUI>/models/animetimm/convnextv2_huge.dbv4-full/`. If so, skip the
download in step 3 and convert from there.

Search for these by filename rather than trusting the paths above — portable
installs, custom node forks and `extra_model_paths.yaml` all move them.

## Step 2 — download the WD taggers (no login needed)

For each WD repo, download `model.onnx` and `selected_tags.csv` and save them
under the names in the table:

```bash
mkdir -p taggers
curl -L -o taggers/wd-eva02-large-tagger-v3.onnx https://huggingface.co/SmilingWolf/wd-eva02-large-tagger-v3/resolve/main/model.onnx
curl -L -o taggers/wd-eva02-large-tagger-v3.csv  https://huggingface.co/SmilingWolf/wd-eva02-large-tagger-v3/resolve/main/selected_tags.csv
curl -L -o taggers/wd-v1-4-moat-tagger-v2.onnx   https://huggingface.co/SmilingWolf/wd-v1-4-moat-tagger-v2/resolve/main/model.onnx
curl -L -o taggers/wd-v1-4-moat-tagger-v2.csv    https://huggingface.co/SmilingWolf/wd-v1-4-moat-tagger-v2/resolve/main/selected_tags.csv
```

## Step 3 — animetimm: download and convert

This one takes two extra steps, and both are why it cannot simply be
downloaded ready-made:

1. **The repo is gated.** Open
   [animetimm/convnextv2_huge.dbv4-full](https://huggingface.co/animetimm/convnextv2_huge.dbv4-full)
   while signed in to Hugging Face and accept its terms (it is approved
   automatically). Downloads without that return HTTP 401.
2. **It ships as PyTorch, and this app runs ONNX** with a specific input and
   output contract. `scripts/export-animetimm-onnx.py` does the conversion and
   builds the channel order, scaling, normalisation and sigmoid into the graph,
   so the app loads it with no code changes.

Download these four files from the repo into one folder (about 2.8 GB):
`config.json`, `preprocess.json`, `pytorch_model.bin`, `selected_tags.csv`.
With the Hugging Face CLI, after `huggingface-cli login`:

```bash
huggingface-cli download animetimm/convnextv2_huge.dbv4-full config.json preprocess.json pytorch_model.bin selected_tags.csv --local-dir animetimm-src
```

Then convert. It needs Python with `torch`, `timm`, `onnx` and `onnxruntime`
— ComfyUI's embedded Python already has all four; otherwise
`pip install torch timm onnx onnxruntime`:

```bash
python scripts/export-animetimm-onnx.py --src animetimm-src
```

It writes the three `animetimm-convnextv2-huge-dbv4.*` files into `taggers/`,
and **refuses to finish if the converted model disagrees with the original**
(it compares their outputs on the same input). A run that ends with
`OK - parity holds` is a good file. The `animetimm-src` folder can be deleted
afterwards.

The `.onnx` and `.onnx.data` are a pair: keep them together, with exactly
those names.

## Step 4 — check

```bash
npm run doctor
```

Each tagger should say `ready`. One that says `not installed` names the file
it could not find. Then restart PromptForge: taggers are loaded at start.

## Notes for an AI assistant doing this

- Work from the project root. Do not edit `config/taggers.yaml`; any path that
  differs from `taggers/` goes in `config/taggers.local.yaml`, using the keys
  `animetimm_convnextv2`, `wd14_eva02`, `wd14_moat` exactly.
- Look for existing copies before downloading (step 1). Compare file sizes
  with the table.
- The animetimm download needs the person to accept the gate and log in to
  Hugging Face themselves. Ask them to; never ask for or handle their token.
- All three run on the CPU. Do not change `device`.
- Finish with `npm run doctor` and report its tagger lines.
