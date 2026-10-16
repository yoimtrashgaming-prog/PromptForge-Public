#!/usr/bin/env bash
#
# Paired engine benchmark: Ollama vs source-built llama.cpp, with and without
# multi-token prediction. Linux deployment box only - it needs a llama.cpp
# built for this card's compute capability, which the Windows dev box has no
# reason to have.
#
#   bash scripts/bench-engines.sh
#
# Every arm runs ALONE on the card. Ollama's model is unloaded with
# keep_alive:0 before each llama.cpp arm and free VRAM is printed so an arm
# that silently shared the card is visible in the output rather than quietly
# depressing its own number. Ollama is restored to keep_alive:-1 at the
# configured context on exit, including on failure, via a trap.
#
# Results as of 1 Sep 2026 are in docs/engine-eval-2026-09-01.md. Re-measure
# rather than trusting them: this project's standing rule is that an
# unverified number is worse than an absent one.
#
# Override any of these from the environment:
#
#   MODEL_BLOB  GGUF llama.cpp loads. Ollama's own blob is fine and means both
#               engines are measured on byte-identical weights.
#   MTP_HEAD    Standalone MTP head GGUF. Skipped if absent.
#   OLLAMA_TAG  The same weights as Ollama names them.
#   CTX         Context length. Must match config/server.local.yaml or the
#               comparison is meaningless.
#   NPREDICT    Tokens to generate per run. Keep it >=300; short runs are
#               dominated by per-request overhead and flatter whichever engine
#               has the cheaper setup path.
set -u

MODEL_BLOB=${MODEL_BLOB:-/usr/share/ollama/.ollama/models/blobs/sha256-8c2a45ff85e7674ca185ec8eb6cdeab0e617ed9d8018caed0b64380eb2a67a5e}
MTP_HEAD=${MTP_HEAD:-$HOME/models/mtp-Qwen3.8-27B-Q4_0.gguf}
OLLAMA_TAG=${OLLAMA_TAG:-hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q3_K_XL}
SERVER=${SERVER:-$HOME/llama.cpp/build/bin/llama-server}
CTX=${CTX:-12288}
NPREDICT=${NPREDICT:-300}
PORT=${PORT:-8099}
RUNS=${RUNS:-2}

PROMPT='Write a detailed description of a rain-soaked city street at night, covering the lights, the people, the sounds and the reflections. Be specific and vivid.'

vram() { nvidia-smi --query-gpu=memory.used --format=csv,noheader; }

ollama_unload() {
  curl -s http://127.0.0.1:11434/api/generate \
    -d "{\"model\":\"$OLLAMA_TAG\",\"keep_alive\":0}" > /dev/null
  sleep 5
}

restore_ollama() {
  echo
  echo "== restoring ollama: ctx $CTX, keep_alive -1 =="
  curl -s -m 300 http://127.0.0.1:11434/api/generate \
    -d "{\"model\":\"$OLLAMA_TAG\",\"keep_alive\":-1,\"options\":{\"num_ctx\":$CTX}}" > /dev/null
  sleep 3
  ollama ps
}
trap restore_ollama EXIT

echo "model : $MODEL_BLOB"
echo "ctx   : $CTX   tokens/run: $NPREDICT   runs/arm: $RUNS"

# ── Ollama ──────────────────────────────────────────────────────────────────
echo
echo "===== ollama ====="
ollama_unload
for r in $(seq 1 $RUNS); do
  curl -s -m 600 http://127.0.0.1:11434/api/generate \
    -d "{\"model\":\"$OLLAMA_TAG\",\"prompt\":\"$PROMPT\",\"stream\":false,\"keep_alive\":-1,\"options\":{\"num_ctx\":$CTX,\"num_predict\":$NPREDICT,\"temperature\":0.7}}" \
    | python3 -c "
import sys, json
d = json.load(sys.stdin)
n, ns = d.get('eval_count', 0), d.get('eval_duration', 1) / 1e9
print('  run $r: %3d tok  %6.2f tok/s' % (n, n / ns if ns else 0))
"
done
echo -n '  vram : '; vram
ollama_unload

# ── llama.cpp arms ──────────────────────────────────────────────────────────
run_case() {
  local label="$1"; shift
  echo
  echo "===== llama.cpp $label ====="
  echo -n '  vram before : '; vram

  "$SERVER" -m "$MODEL_BLOB" -c "$CTX" -ngl 999 \
    --host 127.0.0.1 --port "$PORT" "$@" > "/tmp/bench-$label.log" 2>&1 &
  local pid=$!

  local i
  for i in $(seq 1 200); do
    curl -s -m 2 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"ok"' && break
    if ! kill -0 $pid 2>/dev/null; then
      echo "  SERVER DIED:"; tail -12 "/tmp/bench-$label.log"; return 1
    fi
    sleep 2
  done

  # Warm the prefix so the measured runs are decode, not prefill.
  curl -s -m 300 "http://127.0.0.1:$PORT/completion" \
    -d '{"prompt":"warmup","n_predict":8}' > /dev/null

  local r
  for r in $(seq 1 $RUNS); do
    curl -s -m 600 "http://127.0.0.1:$PORT/completion" \
      -d "{\"prompt\":\"$PROMPT\",\"n_predict\":$NPREDICT,\"temperature\":0.7}" \
      | python3 -c "
import sys, json
d = json.load(sys.stdin); t = d.get('timings', {})
print('  run $r: %3d tok  %6.2f tok/s' % (t.get('predicted_n', 0), t.get('predicted_per_second', 0)))
for k in sorted(t):
    if 'draft' in k or 'accept' in k:
        print('         %-20s %s' % (k, t[k]))
"
  done
  echo -n '  vram : '; vram
  kill $pid 2>/dev/null; wait $pid 2>/dev/null
  sleep 4
}

run_case baseline

if [ -f "$MTP_HEAD" ]; then
  run_case mtp -md "$MTP_HEAD"
  echo
  echo "== draft acceptance =="
  grep -oE 'draft acceptance = [0-9.]+ \([^)]*\), mean len = *[0-9.]+' /tmp/bench-mtp.log | tail -5
else
  echo
  echo "== mtp skipped: no head at $MTP_HEAD =="
  echo "   unsloth ships one at MTP/mtp-Qwen3.8-27B-Q4_0.gguf (1.37GB)."
fi
