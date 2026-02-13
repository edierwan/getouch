#!/usr/bin/env bash
# bootstrap.sh — One-shot server setup for getouch platform
# Run as: bash bootstrap.sh  (with sudo privileges)
set -euo pipefail

echo "=== Getouch Platform Bootstrap ==="

# --- 1. Install baseline tools ---
echo "[1/7] Installing baseline tools..."
sudo apt-get update -qq
sudo apt-get install -y curl ca-certificates gnupg jq unzip

# --- 2. Install Docker ---
echo "[2/7] Installing Docker Engine..."
for pkg in docker.io docker-doc docker-compose podman-docker containerd runc; do
  sudo apt-get remove -y "$pkg" 2>/dev/null || true
done

sudo install -m 0755 -d /etc/apt/keyrings
if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
    sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
fi

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update -qq
sudo apt-get install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin

sudo usermod -aG docker "${USER}"

# --- 3. Install NVIDIA Container Toolkit ---
echo "[3/7] Installing NVIDIA Container Toolkit..."
if ! dpkg -l | grep -q nvidia-container-toolkit; then
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
    sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg 2>/dev/null || true
  curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
    sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
    sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
  sudo apt-get update -qq
  sudo apt-get install -y nvidia-container-toolkit
  sudo nvidia-ctk runtime configure --runtime=docker
  sudo systemctl restart docker
fi

# --- 4. Create directories ---
echo "[4/7] Creating /opt/getouch directory structure..."
sudo mkdir -p /opt/getouch/{compose,data,config,backups,monitoring,scripts,apps}
sudo mkdir -p /opt/getouch/data/{postgres,ollama,wa-sessions}
sudo mkdir -p /opt/getouch/apps/{landing,bot,wa,api}
sudo chown -R "${USER}:${USER}" /opt/getouch

# --- 5. Create Docker networks ---
echo "[5/7] Creating Docker networks..."
docker network create getouch_ingress 2>/dev/null || echo "  getouch_ingress already exists"
docker network create getouch_app     2>/dev/null || echo "  getouch_app already exists"
docker network create getouch_data    2>/dev/null || echo "  getouch_data already exists"

# --- 6. Copy config files ---
echo "[6/7] Verifying setup..."
docker version --format '{{.Server.Version}}'
docker compose version --short

echo ""
echo "[7/7] Done! Summary:"
echo "  Docker:   $(docker version --format '{{.Server.Version}}')"
echo "  Compose:  $(docker compose version --short)"
echo "  Networks: $(docker network ls --filter name=getouch --format '{{.Name}}' | tr '\n' ' ')"
echo "  Layout:   $(ls /opt/getouch/)"
echo ""
echo "⚠  Log out and back in for docker group to take effect (if needed)."
echo "   Then proceed to deploy Caddy (Issue 3)."
