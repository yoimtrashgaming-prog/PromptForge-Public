# PromptForge

AI-powered prompt engineering tool for image and video generation models (Illustrious XL, Anima, Krea2, MiniMax H3, Wan 2.2, LTX 2.3). Uses a local LLM backend to transform short briefs into model-specific optimized prompts.

## Features

- **One dialect per model**: Booru tags (Illustrious), hybrid tags + natural language (Anima), prose (Krea2), and the structured video formats of MiniMax H3, Wan 2.2 and LTX 2.3. Each model has its own controls and its own system prompt
- **Characters from the brief**: name a character and their canon look (hair, eyes, outfit) is looked up and written in, so the image model gets it right
- **Reference pictures**: attach a picture and a vision-capable LLM looks at it before writing; a tagger reads it too
- **MiniMax H3 picture labels**: in REF2VA, say what each picture is — Character 1, a group of characters, a place, a style, the first or last frame — and the subject definitions are written from the labels in code, so even small models get the cast right
- **MiniMax H3 shots**: let the model choose how many shots, or pick 1 to 5. Cut times that would fall at or past the end of the clip are moved back inside it
- **Render in ComfyUI** (optional): a Render button under a finished prompt sends it to your ComfyUI and shows the picture, with model, LoRA, sampler and size choices, live progress, your own uploaded workflows, and render-from-chat. Image models only for now
- **Edit pictures** (optional, with rendering): an Edit tab where you describe a change to a photo or a render — recolour a jacket, make it night, remove the cars — and Qwen Image 2.1 makes it in ComfyUI. Chat can edit a picture too
- **Setup wizard**: the first account created becomes the owner and is walked through setup step by step. Pick what you want — just prompt writing, or image taggers, rendering and LoRA training too — and only those steps follow. Anything skipped can be switched on later from **Setup**
- **Live backend switching**: change the LLM backend, its address and the default model from the web UI without restarting
- **Optional HTTPS**: self-signed EC P-256 TLS generated on demand, swappable for your own certificates (off by default)
- **Podman/Docker deployment**: containerized with port mapping, no host networking required

## Quick Start (Docker or Podman)

You need an LLM server first — [Ollama](https://ollama.com) is the easiest (`ollama pull qwen3-vl:8b`, or any model you like; a vision model lets it read reference pictures).

**On Linux, let the container reach Ollama.** Ollama on Linux only answers its own machine by default, and the container counts as another one, so the setup wizard finds no models. Make it listen on every address with `sudo systemctl edit ollama`, add these two lines, then `sudo systemctl restart ollama`:

```ini
[Service]
Environment="OLLAMA_HOST=0.0.0.0"
```

That also lets other devices on your network use Ollama, so only do it behind a firewall or router. Docker Desktop on Windows and Mac needs none of this.

```bash
git clone https://github.com/yoimtrashgaming-prog/PromptForge-public.git PromptForge
cd PromptForge
docker compose up -d --build        # or: podman-compose up -d --build
```

Open **http://localhost:8090** and create an account — the first one becomes the owner. The setup wizard then opens by itself:

1. **What do you want?** Prompt writing is always on. Tick image taggers, rendering pictures in ComfyUI or LoRA training if you want them, or leave them all off and download nothing else
2. **LLM server**: pick the kind (Ollama, llama.cpp / llama-swap, vLLM) and its address — from inside the container, Ollama on the same machine is `http://host.docker.internal:11434/v1` — then choose the default model
3. **Who can connect**: just this PC, or other devices and friends too
4. Then one step for each extra you ticked. For ComfyUI and TrainFlow, either paste the folder or address of the one you have, or follow the link to install it first ([DaSiWa ComfyUI Installer](https://github.com/darksidewalker/dasiwa-comfyui-installer), [DaSiWa TrainFlow](https://github.com/darksidewalker/DaSiWa-TrainFlow))

Everything can be changed or switched on later from **Setup** in the top bar, which also has a **Setup wizard** button to run it again. The Grafana dashboards are not part of the wizard, because they are extra containers; see [Monitoring](#monitoring-optional). The CPU, RAM and VRAM strip across the top needs no setup.

Everyone who registers after you waits in the Accounts panel until you approve them.

### Or straight from Docker Hub, no clone

The same app, prebuilt: [trashai/promptforge](https://hub.docker.com/r/trashai/promptforge).

```bash
docker run -d --name promptforge -p 8090:8090 \
  --add-host host.docker.internal:host-gateway \
  -v promptforge-data:/app/data -v promptforge-logs:/app/logs \
  --restart unless-stopped trashai/promptforge:latest
```

Then open **http://localhost:8090** and follow the same first-run steps. Your accounts, settings and history live in the `promptforge-data` volume, so updating is `docker pull trashai/promptforge:latest`, then `docker rm -f promptforge` and the same `docker run` again.

## Quick Start (no container)

Needs Node 22+.

```bash
git clone https://github.com/yoimtrashgaming-prog/PromptForge-public.git PromptForge
cd PromptForge
npm ci
npm start
```

Open http://localhost:8090 and follow the same first-run steps. Ollama on the same machine is `http://127.0.0.1:11434/v1`.

### On Windows, without a console window

After `npm ci`, run this once in the PromptForge folder:

```powershell
powershell -ExecutionPolicy Bypass -File windows\make-shortcuts.ps1
```

It puts **PromptForge** and **Stop PromptForge** on your desktop and in the Start menu. PromptForge starts the server with no window and opens it in your browser; clicking it again while it runs just opens the browser. Stop PromptForge stops it. The server's output goes to `logs\server.log` and `logs\server-error.log`.

Add `-Startup` to also start PromptForge (without opening a browser) when you sign in to Windows, or `-Remove` to take the shortcuts away again. `start.bat` still works if you'd rather have the console window.

## Configuration

### LLM Backend

The app works with any OpenAI-compatible API backend (Ollama, llama.cpp, vLLM). Configure via, highest priority first:

1. **Web UI**: the first-run setup, or the **Setup** button in the header (owner only). Saved to `data/backend.json`, which survives restarts and is never committed
2. **Environment variable**: `PROMPTFORGE_LLM_BASE_URL=http://host.docker.internal:8888/v1`
3. **This machine's config**: `config/server.local.yaml` (gitignored — copy `config/server.local.example.yaml`). Put anything specific to your box here, not in `server.yaml`, so `git pull` never fights your edits
4. **Shared defaults**: `config/server.yaml`

Per-target model defaults (for example, a bigger model just for MiniMax H3) go in `llm.model_defaults` in your `server.local.yaml`.

### HTTPS / TLS

Off by default — behind NetBird or Tailscale the link is already encrypted. The compose file turns it on (`PROMPTFORGE_TLS=1`); outside a container set `server.tls.enabled: true` in `config/server.local.yaml`.

When enabled with no cert configured, a self-signed EC P-256 certificate is generated into `data/certs/`. To use your own, set `server.tls.cert` / `server.tls.key`, or replace the generated files:

```bash
cp my-server.crt data/certs/server.crt
cp my-server.key data/certs/server.key
docker compose restart
```

If the HTTPS port cannot be opened, the app logs it and keeps serving HTTP.

### Port Mapping

| Host Port | Container Port | Protocol | Description |
|-----------|----------------|----------|-------------|
| 8090      | 8090           | HTTP     | Web UI (HTTP) |
| 30443     | 8443           | HTTPS    | Web UI (HTTPS, self-signed) |

High host ports avoid conflicts with other containers. To use standard port 443 on the host:

```bash
sudo sysctl -w net.ipv4.ip_unprivileged_port_start=443
# Then change compose.yaml to "443:8443"
```

### Image taggers

Image Analysis, and reading reference pictures, use three taggers that are too big for git. Open **Setup** (owner only) and look under **Image taggers**:

- **Already have them?** Paste the folder they're in — your ComfyUI folder works — and press **Search this folder**. Whatever it finds switches on straight away, no restart.
- **Don't have the WD taggers?** Press **Download** next to each. They're free and need no login (about 1.6 GB together).
- **animetimm** needs a one-time conversion first, because its maker asks you to accept their terms on Hugging Face and it ships in a format this app can't run directly. [docs/taggers-setup.md](docs/taggers-setup.md) walks through it step by step, and you can hand that file to an AI coding assistant to do it for you.

**Use animetimm if you can.** It's the default on purpose: in the group's own use it reads characters better than the WD taggers — on one test picture with two known characters, WD found one and animetimm found both. The WD taggers still run alongside it on reference pictures, so installing all three gives the best result. WD alone works if animetimm is too much hassle.

### Rendering with ComfyUI (optional)

PromptForge can send a finished prompt to [ComfyUI](https://github.com/comfyanonymous/ComfyUI) on the same machine and show the picture under it. It is off until you switch it on, and needs nothing installed beyond ComfyUI itself. Image models only (Illustrious, Anima, Krea2); video is not wired up yet.

**1. ComfyUI.** The easiest route is the [DaSiWa ComfyUI Installer](https://github.com/darksidewalker/dasiwa-comfyui-installer) (Windows and Linux): one program with a setup page in the browser that installs ComfyUI with its own Python, picks a PyTorch build for your GPU, and can add node packs and download models. It puts the environment in `ComfyUI/venv`, which is where PromptForge looks, so step 2 only needs that folder. On an older card, check the PyTorch it chooses: Volta cards such as the V100 need a CUDA 12.6 build (torch 2.10 is the last with Volta), and the installer lets you pick by hand. Installing ComfyUI the usual way works just as well.

The starter workflows in `config/comfyui/` use the [rgthree](https://github.com/rgthree/rgthree-comfy) node pack (its Power Lora Loader) and these files:

| Model | Files |
|---|---|
| Illustrious | `checkpoints/Illustrious-XL-v0.1.safetensors` |
| Anima | `diffusion_models/anima-base-v1.0.safetensors`, `text_encoders/qwen_3_06b_base.safetensors`, `vae/qwen_image_vae.safetensors` |
| Krea2 | `diffusion_models/krea2_turbo_fp8_scaled.safetensors` (and `krea2_raw_fp8_scaled` for the Raw preset), `text_encoders/qwen3vl_4b_fp8_scaled.safetensors`, `vae/qwen_image_vae.safetensors` |
| Edit tab (Qwen Image 2.1) | `diffusion_models/qwen_image_2.1_int8_convrot.safetensors`, `text_encoders/qwen3vl_8b_int8_convrot.safetensors`, `vae/qwen_image_2.1_vae_bf16.safetensors`. Optional: `loras/Qwen-Image-2.1-Fun-Acc-4Step.safetensors` (alibaba-pai) turns on the Fast · 4 steps choice. Needs a ComfyUI recent enough to have the Qwen Image 2.1 nodes, about 12 GB of VRAM and about 19 GB of free system RAM (24 GB of VRAM runs it all on the card). **About this editor** on the tab has the measurements and smaller options |

Different files are fine: add your own in **Render models** (step 3).

**2. Switch it on.** Open **Setup** (owner only), go to **Render pictures (ComfyUI)**, paste the folder ComfyUI is in and press **Connect**. It finds `main.py` and ComfyUI's Python by itself: in the ComfyUI folder, the folder above it, a `venv`/`.venv`, or the Windows portable build's `python_embeded`. If ComfyUI is already running, put its address in instead. No restart needed.

Or set it by hand in `config/server.local.yaml` and restart PromptForge. That outranks the Setup panel:

```yaml
comfyui:
  enabled: true
  dir: "/path/to/ComfyUI"     # the folder with main.py
```

With `dir` set, PromptForge starts ComfyUI when someone renders (from `<dir>/venv/bin/python`, or `<dir>\venv\Scripts\python.exe` on Windows; set `comfyui.python` if yours lives elsewhere) and stops it again after 5 idle minutes. A ComfyUI you started yourself is used as it is and never stopped. In Docker, leave `dir` empty, run ComfyUI on the host with `--listen` so the container can reach it, and set `comfyui.url: "http://host.docker.internal:8188"`. Only do that on a machine whose port 8188 is not reachable from outside. Without `dir`, PromptForge cannot read the LoRA files themselves, so tick which model each LoRA is for in **Render models**.

Everything else in the `comfyui:` block of `config/server.yaml` has a sensible default: the step and size caps, how long pictures are kept (24 hours), how much VRAM a render needs before the LLM is unloaded to make room.

**3. Use it.** The owner can render straight away; everyone else needs **Allow rendering** in **Accounts**. Under a finished prompt:

- **Render** sends it; progress shows which ComfyUI node is running, with a live preview when PromptForge started ComfyUI.
- **⚙ Settings** picks the workflow, preset, model file, text encoder, VAE, LoRAs and strengths, size and seed. LoRAs are matched to a model by what their own file says they were trained on, and their trigger words are added while they are switched on.
- **Manage models…** (owner only) decides which model files each model offers, each with its own steps, CFG, sampler, prefix and negative, and corrects LoRA matches and trigger words.
- **Your own workflows**: in ComfyUI use *Workflow → Export (API)* and upload the file. It needs one KSampler, text nodes on its positive and negative, an Empty Latent and a Save Image. The owner approves each workflow someone else uploads before it can run.
- In **Chat**, ask for a picture ("make me a Krea2 picture of…") and it writes the prompt with that model's own writer and renders it.

Pictures are kept on the server for 24 hours and only their maker can open them; **Pin** puts one on the shared pinboard to keep. The PNG carries the prompt and the workflow, so it reopens in ComfyUI.

### Using it from another PC, or hosting friends

It is the same install either way: the first account owns it, and everyone who registers after waits in **Accounts** until the owner approves them. The only difference is who can reach it.

1. Open **Setup** (owner only) and tick **Let other devices connect**, then restart PromptForge. The panel then lists the addresses to use — the one for your home network works from any PC or phone on it.
2. **For friends outside your home**, put the PC on a private mesh network such as [NetBird](https://netbird.io) or [Tailscale](https://tailscale.com) and invite them to it. Their address (100.x.x.x) shows in the same list. Don't forward the port on your router instead; the mesh keeps PromptForge off the open internet.
3. Approve them in **Accounts** as they sign up.

In Docker, the ports line in `compose.yaml` decides this instead: `"8090:8090"` lets other devices in, `"127.0.0.1:8090:8090"` keeps it to that PC.

### Monitoring (optional)

A Prometheus + Grafana dashboard: queue depth, generations and latency per model, CPU, RAM, and VRAM, load and temperature per GPU, kept for 15 days (capped at 1 GB, about 1 MB a day). Off unless you ask for it — a solo install does not need it:

```bash
cp .env.example .env        # set GRAFANA_ADMIN_PASSWORD
docker compose --profile monitoring up -d --build
```

The owner then gets a **Monitoring** button in the top bar, which opens the dashboard through PromptForge's own login. Nobody else can open it. Grafana and Prometheus listen on this machine only (`127.0.0.1:30300` and `:30909`); sign in to Grafana there with the `.env` login to edit dashboards.

### Reaching Host Services from Container

The container uses `host.docker.internal` to reach services on the host machine (e.g., llama.cpp on localhost:8888). This is configured via `extra_hosts` in `compose.yaml`. Inside the container, `127.0.0.1` is the container itself, not your machine.

## Architecture

- **Backend**: Node.js HTTP server (no framework), SSE streaming for token-by-token output
- **Frontend**: Vanilla JS, no build step
- **LLM Communication**: OpenAI-compatible API (`/v1/chat/completions`)
- **Data Storage**: JSON files in `data/` directory (users, preferences, library)
- **Python Dependency**: Used for `randomizer.py` (prompt randomization feature)

### Running it as a service (Linux)

`deploy/promptforge.service` is a systemd unit for running PromptForge at boot, and `deploy/llama-swap.service` with `deploy/llama-swap.config.example.yaml` set up [llama-swap](https://github.com/mostlygeek/llama-swap) to serve several llama.cpp models from one address. Each file says what to change for your machine.

## Security Notes

- No secrets, API keys, or credentials are committed to the repository
- User accounts stored in untracked `data/users/` directory
- TLS certificates stored in untracked `data/certs/` directory
- `data/backend.json` holds a machine's own LLM address and is gitignored

## What ships with it

A fresh install starts with the same tag data and prompts the group's own server runs on. They are copied into place on first start, and never over anything that already exists:

- **Danbooru tag list** (`data/seed/tags.sqlite`), 342,748 tags pulled from danbooru.donmai.us on 7 Sep 2026. `npm run update-tags` refreshes it later.
- **Character table** (`data/seed/character_traits.sqlite`), built by `scripts/import-character-traits.mjs` from [Laxhar/noob-wiki](https://huggingface.co/datasets/Laxhar/noob-wiki) (Apache-2.0) and [deepghs/character_index](https://huggingface.co/datasets/deepghs/character_index) (MIT).
- **Paraphrase lexicon** (`data/seed/danbooru-visual-paraphrases.json`), which Anima v4/v5 uses to check every tag it writes. It was built against the tag list above, so the two ship as a matched pair.
- **Starter system prompts** (`prompts/starter/system-prompts.json`): Illustrious v2, Anima v3, v4 and v5, and V5 gemma.

Fetched on first start, not shipped: MiniMax's official H3 prompt-writing guides (and the H3 Director notes from the [DaSiWa node pack](https://github.com/darksidewalker/ComfyUI-DaSiWa-Nodes)), which `npm run fetch-h3-refs` downloads on a normal install and the container downloads itself. They are MiniMax's documents under the [MiniMax H3 Community License](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE), so each install gets them from MiniMax directly rather than from us. Without them H3 still works, in a reduced mode, and says so.

Not included: the image tagger weights for Image Analysis (about 4.4 GB — see **Image taggers** above), and anything a group makes — accounts, the pinboard, saved prompts and notes stay on the machine that made them.

## Special thanks

PromptForge is what it is because of two people who gave their time to it:

- **azmagane** — a massive help across the whole project. He tested every corner of it, reported every bug he ran into no matter how small, usually with the screenshot that made it easy to fix, and stuck around to help work out what was actually wrong. He's also the prompt craft this app is built around: the Anima and Krea2 skill documents, the text-modifier vocabulary, the paraphrase lexicon, and a long run of "that tag is wrong" that made every model's output better. A lot of what works in PromptForge works because he kept checking, and he never asked for credit for any of it.
- **Darksidewalker** — the Docker setup, HTTPS, live backend switching and the first-run ownership that turned a one-box group server into something anyone can install, plus TrainFlow for LoRA training.

## License

PromptForge is free software under the [GNU General Public License v3.0 or later](LICENSE). You can use, change and share it; if you share a changed version, it has to stay under the same licence, with its source.

Some of what ships with it comes from elsewhere and keeps its own terms: the Danbooru tag data, and the character table (built from Apache-2.0 and MIT datasets, credited above). The Anima skill documents in `prompts/image/references/anima-skill/` were written for this project and are part of it. MiniMax's H3 guides are not included at all; each install downloads them under MiniMax's own licence.
