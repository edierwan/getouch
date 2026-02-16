# Getouch AI Platform — Bring-up Runbook

## Prerequisites

- Ubuntu 22.04+ server with NVIDIA GPU
- Docker + Docker Compose v2 installed
- nvidia-container-toolkit installed
- Cloudflare Tunnel configured
- PostgreSQL running (`docker-compose.db.yml`)

## 1. Pull Latest Code

```bash
ssh deploy@100.103.248.15
cd /opt/getouch
git pull origin develop
```

## 2. Run Database Migration

```bash
# Apply the AI platform tables (settings, images, image_usage, chat_messages)
docker exec -i postgres psql -U getouch -d getouch < /opt/getouch/services/landing/migrations/001_ai_platform.sql
```

**Verify:**
```sql
\dt settings
\dt images
\dt image_usage
SELECT * FROM settings;
-- Should see: ai.default_text_model, ai.enable_image, ai.image.max_per_day_free
```

## 3. Bootstrap Ollama Models

```bash
# From host (uses docker exec)
bash /opt/getouch/scripts/ollama-bootstrap.sh

# Or inside container directly:
docker exec ollama ollama list
```

**Verify both models exist:**
```bash
docker exec ollama ollama list
# NAME                           SIZE
# llama3.1:8b                    4.7 GB
# qwen2.5:14b-instruct          9.0 GB
```

**Test inference:**
```bash
docker exec ollama ollama run llama3.1:8b "Say hello in 3 words."
docker exec ollama ollama run qwen2.5:14b-instruct "Say hello in 3 words."
```

## 4. Prepare ComfyUI Directories

```bash
sudo mkdir -p /opt/getouch/data/comfyui/{models,output}
sudo mkdir -p /opt/getouch/data/images
sudo chown -R 1000:1000 /opt/getouch/data/comfyui
sudo chown -R 1000:1000 /opt/getouch/data/images
```

### Download SDXL Model

```bash
# Download SDXL base model into ComfyUI models folder
cd /opt/getouch/data/comfyui/models/checkpoints
wget https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors
```

## 5. Update Environment

```bash
cd /opt/getouch/compose
cp .env .env.backup

# Add these to .env:
echo "ADMIN_TOKEN=$(openssl rand -hex 32)" >> .env
echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .env
echo "COMFYUI_HOST=comfyui" >> .env
echo "COMFYUI_PORT=8188" >> .env
```

## 6. Deploy Services

```bash
cd /opt/getouch/compose

# Rebuild and restart all services
docker compose -f docker-compose.ollama.yml up -d
docker compose -f docker-compose.apps.yml up -d --build
docker compose up -d  # Caddy + Cloudflared

# Check all services
docker compose -f docker-compose.apps.yml ps
docker compose -f docker-compose.ollama.yml ps
```

## 7. Verify Endpoints

### Health Checks
```bash
curl -s http://landing:3000/health | jq .
curl -s http://localhost:11434/  # Ollama
curl -s http://comfyui:8188/system_stats  # Inside Docker network
```

### Text Chat (SSE Streaming)
```bash
curl -N -X POST https://getouch.co/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{"message": "Hello, what can you do?"}'
# Should stream SSE events:
# event: token
# data: {"delta":"Hello"}
# ...
# event: done
# data: {"model":"llama3.1:8b","usage":{...}}
```

### Model List
```bash
curl -s https://getouch.co/v1/chat/models | jq .
```

### Image Generation
```bash
curl -X POST https://getouch.co/v1/image/generate \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "a beautiful sunset over mountains"}'
# Returns: { id, image_url, seed, timings }
```

### Image Quota
```bash
curl -s https://getouch.co/v1/image/quota | jq .
```

### Admin Settings
```bash
# List settings
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://getouch.co/v1/admin/settings | jq .

# Switch default model to Smart
curl -X PUT -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"value": "qwen2.5:14b-instruct"}' \
  https://getouch.co/v1/admin/settings/ai.default_text_model

# Disable image generation
curl -X PUT -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"value": false}' \
  https://getouch.co/v1/admin/settings/ai.enable_image
```

## 8. QA Checklist

- [ ] Visit https://getouch.co — landing shows chat interface with model selector
- [ ] Type a question → response streams token-by-token with blinking cursor
- [ ] Switch to "Getouch Image" → prompt generates an image
- [ ] After 5 images → quota error shown
- [ ] Visit https://getouch.co/admin/ → AI Settings section visible
- [ ] Change default model → landing uses new model
- [ ] Toggle image generation off → landing shows "disabled" error
- [ ] Restart all containers → models persist (Ollama volume), images persist
- [ ] Health checks pass for all services
- [ ] ComfyUI is NOT publicly accessible (no Caddy route)

## Troubleshooting

### Ollama not responding
```bash
docker logs ollama --tail 50
docker compose -f docker-compose.ollama.yml restart ollama
```

### ComfyUI not starting
```bash
docker logs comfyui --tail 50
# Verify GPU is available:
nvidia-smi
# Verify SDXL model exists:
ls -la /opt/getouch/data/comfyui/models/checkpoints/
```

### Landing can't reach Ollama
```bash
# Verify network connectivity
docker exec landing ping -c 3 ollama
docker exec landing curl -s http://ollama:11434/
# Ensure landing is on getouch_data network
docker inspect landing | grep -A 10 Networks
```

### Settings not loading
```bash
# Check database
docker exec postgres psql -U getouch -d getouch -c "SELECT * FROM settings;"
# Check landing logs
docker logs landing --tail 50
```
