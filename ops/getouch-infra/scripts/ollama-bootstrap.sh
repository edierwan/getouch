#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Getouch — Ollama Model Bootstrap
# Detects existing models and pulls missing ones.
# Run on the host or inside the ollama container.
#
# Usage:
#   ./scripts/ollama-bootstrap.sh            # from host (uses docker exec)
#   docker exec ollama bash /scripts/ollama-bootstrap.sh --inside
# ─────────────────────────────────────────────────────────────
set -euo pipefail

REQUIRED_MODELS=(
  "llama3.1:8b"
  "qwen2.5:14b-instruct"
)

# Determine how to call ollama
if [[ "${1:-}" == "--inside" ]]; then
  OLLAMA_CMD="ollama"
else
  OLLAMA_CMD="docker exec ollama ollama"
fi

echo "╔══════════════════════════════════════════════════╗"
echo "║    Getouch — Ollama Model Bootstrap              ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# 1) Wait for Ollama to be healthy
echo "⏳ Waiting for Ollama to be ready..."
for i in $(seq 1 30); do
  if $OLLAMA_CMD list &>/dev/null; then
    echo "✅ Ollama is ready."
    break
  fi
  if [[ $i -eq 30 ]]; then
    echo "❌ Ollama did not start within 60 seconds."
    exit 1
  fi
  sleep 2
done

# 2) Get existing models
echo ""
echo "📋 Currently installed models:"
$OLLAMA_CMD list
echo ""

EXISTING=$($OLLAMA_CMD list 2>/dev/null | tail -n +2 | awk '{print $1}')

# 3) Pull missing models
for model in "${REQUIRED_MODELS[@]}"; do
  if echo "$EXISTING" | grep -qF "$model"; then
    echo "✅ $model — already present"
  else
    echo "📥 Pulling $model ..."
    $OLLAMA_CMD pull "$model"
    echo "✅ $model — pulled successfully"
  fi
done

echo ""
echo "📋 Final model list:"
$OLLAMA_CMD list

# 4) Quick inference test
echo ""
echo "🧪 Testing inference on each model..."
for model in "${REQUIRED_MODELS[@]}"; do
  echo -n "  $model: "
  RESPONSE=$($OLLAMA_CMD run "$model" "Say hello in exactly 3 words." 2>&1 | head -1)
  echo "$RESPONSE"
done

echo ""
echo "🎉 Bootstrap complete. All models are ready."
