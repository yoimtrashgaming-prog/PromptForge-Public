#!/bin/sh
# Container start-up (see Dockerfile).
#
# Third-party documents are not baked into the image - it may be published,
# and they are not ours to redistribute - so they are fetched here, on the
# machine that runs it, the same way `npm run fetch-h3-refs` does on a normal
# install:
#
#   - MiniMax's two official H3 prompt-writing guides, then sliced into the
#     per-mode files the registry loads (scripts/section-h3-references.mjs)
#   - the DaSiWa H3 Director documentation, for the h3 panel's help
#
# Only once the owner has agreed to MiniMax's licence in the setup wizard or
# the Setup panel (20 Oct 2026): the agreement is kept in data/h3-guides.json,
# on the data volume, and a fresh container does not keep prompts/, so this
# fetches them again on every start after that. Until then nothing is
# downloaded and H3 runs in its reduced mode, saying so.
#
# Already-present files are skipped, so this is quick after the first start.
# No network, or a download that fails, is not fatal: H3 runs degraded and
# says so, as it always has without the guides. Everything else is unaffected.

if grep -q '"accepted": true' data/h3-guides.json 2>/dev/null; then
  node scripts/fetch-h3-references.mjs || echo "[start] H3 guides not fetched - H3 will run degraded"

  if [ -f prompts/video/h3/references/h3-base-official.md ] && [ ! -f prompts/video/h3/references/h3-core.md ]; then
    node scripts/section-h3-references.mjs || echo "[start] H3 guides not sectioned - H3 will run degraded"
  fi
fi

exec node server.mjs
