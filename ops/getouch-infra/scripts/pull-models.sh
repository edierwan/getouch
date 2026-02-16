#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Getouch — Phase 4: Pull AI models in Ollama
#
# Models:
#   1. llama3.1:8b          (keep existing — fast)
#   2. qwen2.5:14b-instruct (new — smarter, instructional)
#
# Usage:
#   bash pull-models.sh
# ─────────────────────────────────────────────────────────────
set -euo pipefail

OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"

echo "──────────────────────────────────────────"
echo "  Getouch · Phase 4 — Pull AI Models"
echo "  Ollama: ${OLLAMA_URL}"
echo "──────────────────────────────────────────"

MODELS=(
  "llama3.1:8b"
  "qwen2.5:14b-instruct"
)

for MODEL in "${MODELS[@]}"; do
  echo ""
  echo "[+] Pulling ${MODEL}…"
  curl -sf "${OLLAMA_URL}/api/pull" \
    -d "{\"name\": \"${MODEL}\"}" \
    --no-buffer | while IFS= read -r line; do
      STATUS=$(echo "$line" | grep -o '"status":"[^"]*"' | cut -d'"' -f4 || true)
      if [ -n "$STATUS" ]; then
        printf "\r    %s" "$STATUS"
      fi
    done
  echo ""
  echo "    ✓ ${MODEL} ready"
done

echo ""
echo "──────────────────────────────────────────"
echo "  ✓ All models pulled"
echo ""

# Verify
echo "  Installed models:"
curl -sf "${OLLAMA_URL}/api/tags" | \
  grep -o '"name":"[^"]*"' | \
  cut -d'"' -f4 | \
  while IFS= read -r m; do echo "    - ${m}"; done

echo "──────────────────────────────────────────"
