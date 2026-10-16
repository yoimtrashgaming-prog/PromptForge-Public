#!/usr/bin/env bash
# Start PromptForge on the Linux deployment box.
#
#   ./start.sh
#
# Deliberately does NOT set OLLAMA_FLASH_ATTENTION or OLLAMA_KV_CACHE_TYPE.
# start.bat sets them for a recent card that supports them; a Pascal card such
# as the Tesla P40 does not. Setting them on one does not fail loudly, it just
# does nothing or degrades — cap context in config/server.local.yaml instead.
#
# For an unattended box, prefer the systemd unit: see deploy/promptforge.service.
set -euo pipefail

cd "$(dirname "$0")"

# Ollama has to be up before the first generate, not before the server starts —
# the app reports a backend that is down rather than refusing to boot. Checked
# anyway, because "why is every generation failing" is a worse first five
# minutes than one line here.
if ! curl -sf --max-time 3 http://127.0.0.1:11434/api/tags >/dev/null; then
  echo "warning: Ollama is not answering on 127.0.0.1:11434 — start it first," >&2
  echo "         or the app will boot and every generation will fail." >&2
fi

exec npm start
