# Runbook 00 — Prerequisites

## Server Requirements

| Item | Detail |
|------|--------|
| OS | Ubuntu 24.04 LTS |
| Hostname | `getouch` |
| User | `deploy` (sudoer) |
| GPU | NVIDIA GPU (`nvidia-smi` working) |
| Network | Tailscale installed, IP `100.103.248.15` |

## Local Machine

- SSH access: `ssh deploy@100.103.248.15`
- Cloudflare account with `getouch.co` domain (Free plan)
- Git + code editor

## Cloudflare

- Domain `getouch.co` added and nameservers pointed to CF
- Zero Trust → Tunnels section accessible
- DNS records will be managed by the tunnel

## Tailscale

```bash
# Verify Tailscale is running on server
tailscale status
```

SSH must only be reachable via Tailscale IP. Confirm `/etc/ssh/sshd_config`:

```
ListenAddress 100.103.248.15
```

Or use UFW to restrict port 22 to Tailscale subnet only:

```bash
sudo ufw allow in on tailscale0 to any port 22
sudo ufw deny 22
```

## Checklist

- [ ] Ubuntu 24.04 installed and updated
- [ ] `deploy` user created with sudo
- [ ] NVIDIA drivers + `nvidia-smi` working
- [ ] Tailscale connected
- [ ] SSH only via Tailscale verified
- [ ] Cloudflare domain active
