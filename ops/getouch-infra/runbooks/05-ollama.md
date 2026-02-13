# Runbook 05 — Ollama (GPU)

## Overview

Ollama runs as a Docker container with NVIDIA GPU passthrough, serving the Qwen2.5 7B model. App containers on `getouch_data` network can call its API.

## Compose Service

Defined in `docker-compose.ollama.yml`:

```yaml
services:
  ollama:
    image: ollama/ollama:latest
    restart: unless-stopped
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
    volumes:
      - /opt/getouch/data/ollama:/root/.ollama
    networks:
      - getouch_data
    ports: []  # no host port — internal only
```

## Deploy

```bash
cd /opt/getouch/compose
docker compose -f docker-compose.ollama.yml up -d
```

## Pull Model

```bash
docker exec -it ollama ollama pull qwen2.5:7b
```

## Verification

```bash
docker compose -f docker-compose.ollama.yml ps
docker exec ollama ollama list
curl http://localhost:11434/api/tags  # if port mapped for debugging
```

## Test Inference

```bash
docker exec ollama ollama run qwen2.5:7b "Hello, how are you?"
```

## Notes

- Models are stored in `/opt/getouch/data/ollama` for persistence.
- The container uses the NVIDIA runtime automatically via `deploy.resources.reservations.devices`.
- No host port is exposed; services reach Ollama at `ollama:11434` on the `getouch_data` network.
