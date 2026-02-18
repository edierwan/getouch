# Coolify Admin Recovery — Runbook

> **Last updated:** 2026-02-17
> **Audience:** Server administrators with SSH access
> **Instance:** `coolify.getouch.co` (Cloudflare Access protected)

---

## Quick Reference

| Method | When to Use | Access Required |
|--------|------------|----------------|
| **Option A: CLI Reset** | Forgot password, have SSH | SSH + Docker |
| **Option B: Recovery Token** | Need UI-based reset | SSH + Docker (to generate token) |
| **Option C: Emergency Env** | Boot-time provisioning / first setup | SSH + Docker |

---

## Prerequisites

- SSH access to the Getouch server
- Docker access (root or docker group)
- Coolify containers running: `coolify` + `coolify-db`

Verify containers:
```bash
docker ps --format 'table {{.Names}}\t{{.Status}}' | grep coolify
```

---

## Option A: CLI Password Reset (Recommended)

The safest and most direct method. Runs entirely on the server via Docker.

### Usage

```bash
# SSH into the server
ssh root@your-server-ip

# Navigate to scripts
cd /opt/getouch/scripts
# — OR if using the repo —
cd ~/getouch/ops/getouch-infra/scripts

# Interactive mode (lists users, prompts for email and password)
sudo bash coolify-admin-reset.sh

# Non-interactive mode
sudo bash coolify-admin-reset.sh --email edierwan@gmail.com
```

### What it does

1. Lists all existing Coolify users (ID, email, name, created date)
2. Prompts for target email (or accepts `--email` flag)
3. Prompts for new password (typed twice, min 8 chars)
4. Resets password via Laravel artisan tinker (preferred) or direct DB update (fallback)
5. If user doesn't exist, creates a new admin
6. Logs everything to `/data/coolify/recovery-audit.log`

### Security

- Rate limited: max **5 resets per hour**
- Requires server-level access (not exposed to internet)
- Old password is never printed or logged
- All actions are audit-logged

---

## Option B: One-Time Recovery Token

Generates a time-limited token for password reset. Useful when you need a web-based flow or want to delegate the reset to someone with SSH tunnel access.

### Generate Token

```bash
ssh root@your-server-ip
cd /opt/getouch/scripts

# Interactive
sudo bash coolify-recovery-token.sh

# Non-interactive
sudo bash coolify-recovery-token.sh --email edierwan@gmail.com
```

### Use the Token

The token creates a URL accessible only from localhost:

```
http://127.0.0.1:8000/admin-recovery?token=<TOKEN>
```

If you're remote, use an SSH tunnel:
```bash
ssh -L 8000:127.0.0.1:8000 root@your-server-ip
# Then open in browser: http://localhost:8000/admin-recovery?token=<TOKEN>
```

### Token Properties

| Property | Value |
|----------|-------|
| Validity | 10 minutes |
| Uses | Single-use (invalidated after first use) |
| Storage | `admin_recovery_tokens` table in coolify DB |
| Rate limit | Max 3 tokens per hour |
| Cleanup | Expired tokens auto-deleted after 24h |

> **Note:** The recovery page endpoint would need to be added to Coolify's Laravel routes for the UI flow to work. For now, the CLI method (Option A) is the primary approach. The token infrastructure is in place for future UI integration.

---

## Option C: Emergency Admin via Environment

Provisions an admin user at boot time using environment variables. Useful for:
- First-time setup when registration is disabled
- Automated recovery in CI/CD pipelines
- Container orchestration systems

### Usage

```bash
# Set env vars
export ENABLE_EMERGENCY_ADMIN=true
export EMERGENCY_ADMIN_EMAIL=edierwan@gmail.com
export EMERGENCY_ADMIN_PASSWORD=YourSecurePassword123

# Run the script
sudo -E bash coolify-emergency-admin.sh

# IMPORTANT: Clear password from environment
unset EMERGENCY_ADMIN_PASSWORD
unset ENABLE_EMERGENCY_ADMIN
```

### Idempotency

- Creates a marker file at `/data/coolify/.emergency-admin-done`
- Subsequent runs skip if marker exists
- To re-run: `rm /data/coolify/.emergency-admin-done`

### Docker Compose Override (optional)

To integrate with container startup, add to your `.env`:

```env
ENABLE_EMERGENCY_ADMIN=true
EMERGENCY_ADMIN_EMAIL=edierwan@gmail.com
EMERGENCY_ADMIN_PASSWORD=YourSecurePassword123
```

Then after boot, run:
```bash
sudo -E bash /opt/getouch/scripts/coolify-emergency-admin.sh
```

> **Warning:** Remove `EMERGENCY_ADMIN_PASSWORD` from `.env` after use.

---

## Finding Existing Users

### Quick list
```bash
sudo bash coolify-admin-list.sh
```

### Direct DB query
```bash
docker exec coolify-db psql -U coolify -d coolify \
    -c "SELECT id, email, name, created_at FROM users ORDER BY id;"
```

### Via artisan tinker
```bash
docker exec coolify php artisan tinker --execute="
    App\Models\User::all(['id','name','email','created_at'])->each(function(\$u){
        echo \$u->id.' | '.\$u->email.' | '.\$u->name.PHP_EOL;
    });
"
```

---

## Audit Log

All recovery operations are logged to:

```
/data/coolify/recovery-audit.log
```

Format:
```
2026-02-17T12:00:00Z | action=RESET_SUCCESS | user=root | ip=console | email=edierwan@gmail.com user_id=1
```

View recent entries:
```bash
tail -20 /data/coolify/recovery-audit.log
```

---

## Disable Recovery Mode After Use

1. **CLI script (Option A):** No cleanup needed — it's one-shot.

2. **Recovery tokens (Option B):** Tokens auto-expire. To force cleanup:
   ```bash
   docker exec coolify-db psql -U coolify -d coolify \
       -c "DELETE FROM admin_recovery_tokens;"
   ```

3. **Emergency admin (Option C):**
   ```bash
   # Remove env vars from .env file
   # Remove marker to allow future use if needed
   rm /data/coolify/.emergency-admin-done
   unset ENABLE_EMERGENCY_ADMIN EMERGENCY_ADMIN_PASSWORD
   ```

---

## Troubleshooting

### "Container 'coolify' is not running"
```bash
cd /opt/getouch/compose
docker compose -f docker-compose.coolify.yml --env-file .env up -d
```

### "Container 'coolify-db' is not running"
Coolify manages its own DB. Check:
```bash
docker ps -a | grep coolify
docker logs coolify --tail 30
```

### "Artisan tinker failed"
The script falls back to direct DB queries. If that also fails:
```bash
# Check DB connectivity
docker exec coolify-db psql -U coolify -d coolify -c "SELECT 1;"

# Check Coolify logs
docker logs coolify --tail 50
```

### "Rate limit exceeded"
Wait 1 hour, or manually clear the rate limit counter:
```bash
# View current log
cat /data/coolify/recovery-audit.log

# If you must bypass (not recommended):
# Temporarily rename the log
mv /data/coolify/recovery-audit.log /data/coolify/recovery-audit.log.bak
```

### Password works in CLI but login fails on web
- Clear browser cookies for `coolify.getouch.co`
- Check Cloudflare Access is allowing your email
- Try incognito/private browsing window

---

## File Locations

| File | Path | Purpose |
|------|------|---------|
| CLI Reset | `/opt/getouch/scripts/coolify-admin-reset.sh` | Password reset/create |
| Token Generator | `/opt/getouch/scripts/coolify-recovery-token.sh` | One-time token |
| Emergency Admin | `/opt/getouch/scripts/coolify-emergency-admin.sh` | Boot-time provisioning |
| User Listing | `/opt/getouch/scripts/coolify-admin-list.sh` | Show all users |
| Audit Log | `/data/coolify/recovery-audit.log` | All recovery events |
| Marker File | `/data/coolify/.emergency-admin-done` | Emergency admin idempotency |

---

## Registration Policy

Registration remains **disabled** (`Registration is disabled. Please contact the administrator.`). New users can only be created by:
1. Server admin using Option A (CLI reset script with new email)
2. An existing admin via Coolify's admin panel
