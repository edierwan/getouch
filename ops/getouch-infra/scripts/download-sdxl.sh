#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Getouch — Download SDXL model assets for ComfyUI
#
# Downloads to /opt/getouch/data/comfyui/models/checkpoints/
# Requires: wget or curl, ~7GB disk space
#
# Usage:
#   sudo bash download-sdxl.sh
# ─────────────────────────────────────────────────────────────
set -euo pipefail

MODELS_DIR="${COMFYUI_MODELS_DIR:-/opt/getouch/data/comfyui/models}"
CKPT_DIR="${MODELS_DIR}/checkpoints"
VAE_DIR="${MODELS_DIR}/vae"

echo "──────────────────────────────────────────"
echo "  Getouch · Download SDXL Model Assets"
echo "  Target: ${MODELS_DIR}"
echo "──────────────────────────────────────────"

mkdir -p "${CKPT_DIR}" "${VAE_DIR}"

# ── 1. SDXL Base 1.0 checkpoint (~6.9 GB) ─────────────────
SDXL_URL="https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors"
SDXL_FILE="${CKPT_DIR}/sd_xl_base_1.0.safetensors"

if [ -f "${SDXL_FILE}" ]; then
  echo "[✓] SDXL Base 1.0 already exists ($(du -h "${SDXL_FILE}" | cut -f1))"
else
  echo "[+] Downloading SDXL Base 1.0 (~6.9 GB)…"
  if command -v wget &> /dev/null; then
    wget -q --show-progress -O "${SDXL_FILE}" "${SDXL_URL}"
  else
    curl -L --progress-bar -o "${SDXL_FILE}" "${SDXL_URL}"
  fi
  echo "    ✓ SDXL Base 1.0 downloaded ($(du -h "${SDXL_FILE}" | cut -f1))"
fi

# ── 2. SDXL VAE (optional, included in checkpoint) ────────
# The VAE is baked into the base checkpoint, so a separate
# download is optional. Uncomment if you want a standalone VAE.
#
# SDXL_VAE_URL="https://huggingface.co/stabilityai/sdxl-vae/resolve/main/sdxl_vae.safetensors"
# SDXL_VAE_FILE="${VAE_DIR}/sdxl_vae.safetensors"
# if [ ! -f "${SDXL_VAE_FILE}" ]; then
#   echo "[+] Downloading SDXL VAE…"
#   wget -q --show-progress -O "${SDXL_VAE_FILE}" "${SDXL_VAE_URL}"
# fi

echo ""
echo "──────────────────────────────────────────"
echo "  ✓ SDXL model assets ready"
echo ""
echo "  Models directory:"
find "${MODELS_DIR}" -type f -name "*.safetensors" -exec du -h {} \;
echo ""
echo "  Next steps:"
echo "    1. Start ComfyUI: docker compose -f docker-compose.ollama.yml up -d comfyui"
echo "    2. Check health:  curl -s http://localhost:8188/system_stats | python3 -m json.tool"
echo "    3. Test generate:  curl -X POST http://localhost:3000/v1/image/generate \\"
echo "         -H 'Content-Type: application/json' \\"
echo "         -d '{\"prompt\": \"a red cat on a bench\"}'"
echo "──────────────────────────────────────────"
