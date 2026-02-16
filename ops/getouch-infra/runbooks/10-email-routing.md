# 10 — Email Routing (Cloudflare → Gmail)

> Corporate email for **@getouch.co** without running a mail server.
> Cloudflare Email Routing forwards inbound mail; Gmail "Send mail as" handles outbound.

---

## Architecture

```
Sender ──► MX (Cloudflare) ──► Email Routing rules ──► your-gmail@gmail.com
                                                            │
Reply ◄── Gmail "Send mail as: admin@getouch.co" ◄─────────┘
```

No SMTP server needed. All mail stays inside Gmail.

---

## Prerequisites

| Item | Notes |
|------|-------|
| **Domain on Cloudflare** | `getouch.co` — DNS already managed by Cloudflare |
| **Gmail account** | The actual mailbox that receives/sends mail |
| **Cloudflare dashboard access** | Email → Email Routing |

---

## Part A — Inbound (Cloudflare Email Routing)

### 1. Enable Email Routing

1. Cloudflare Dashboard → **getouch.co** → **Email** → **Email Routing**
2. Click **Get started** (first time only)
3. Cloudflare will add the required MX and verification TXT records automatically
4. Wait for DNS propagation (usually < 5 min with Cloudflare DNS)

### 2. Add destination address

1. **Email Routing** → **Destination addresses** → **Add destination address**
2. Enter your Gmail address (e.g. `yourname@gmail.com`)
3. Open Gmail, click the verification link Cloudflare sends
4. Status should change to **Verified**

### 3. Create routing rules

Create one rule per alias:

| Custom address | Action | Destination |
|----------------|--------|-------------|
| `admin@getouch.co` | Send to | `yourname@gmail.com` |
| `support@getouch.co` | Send to | `yourname@gmail.com` |
| `sales@getouch.co` | Send to | `yourname@gmail.com` |
| `billing@getouch.co` | Send to | `yourname@gmail.com` |
| `noreply@getouch.co` | Drop | — |

**Steps per rule:**
1. **Email Routing** → **Routing rules** → **Create address**
2. Custom address: `admin` → Action: **Send to an email** → select destination
3. Save

### 4. (Optional) Catch-all

To catch `anything@getouch.co`:

1. **Routing rules** → **Catch-all address** → **Edit**
2. Action: **Send to an email** → select destination
3. Save

> ⚠️ Catch-all attracts spam. Consider enabling only if needed.

---

## Part B — Outbound (Gmail "Send mail as")

This lets you compose/reply in Gmail with the **From: admin@getouch.co** header.

### 1. Gmail settings

1. Gmail → **Settings** (⚙️) → **See all settings** → **Accounts and Import**
2. **Send mail as** → **Add another email address**
3. Fill in:
   - Name: `Getouch` (or `Getouch Support`, etc.)
   - Email: `admin@getouch.co`
   - ☐ Uncheck "Treat as an alias" only if you want separate inbox handling
4. Click **Next Step**

### 2. SMTP configuration

Gmail needs an SMTP relay. Two options:

#### Option A — Gmail's own SMTP (simplest)

| Field | Value |
|-------|-------|
| SMTP Server | `smtp.gmail.com` |
| Port | `587` |
| Username | `yourname@gmail.com` |
| Password | App Password (generate at https://myaccount.google.com/apppasswords) |
| Secured connection | TLS |

> Requires 2FA enabled on the Gmail account to generate an App Password.

#### Option B — Free SMTP relay (e.g., Brevo/Sendinblue, Mailgun sandbox)

Use if you hit Gmail sending limits or want better deliverability tracking.

### 3. Verify ownership

1. Gmail sends a confirmation code to `admin@getouch.co`
2. That email arrives in Gmail (via Cloudflare routing you set up in Part A!)
3. Enter the code in the Gmail popup
4. Done — `admin@getouch.co` now appears in the "From" dropdown

### 4. Set as default (optional)

In **Accounts and Import** → **Send mail as** → click **make default** next to `admin@getouch.co`.

---

## Part C — DNS Records

Cloudflare Email Routing auto-creates MX records. Add these manually for deliverability:

### SPF (TXT record)

| Type | Name | Content |
|------|------|---------|
| TXT | `@` | `v=spf1 include:_spf.mx.cloudflare.net include:_spf.google.com ~all` |

> Includes both Cloudflare (inbound routing) and Google (outbound via Gmail SMTP).

### DMARC (TXT record)

| Type | Name | Content |
|------|------|---------|
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:admin@getouch.co; adkim=r; aspf=r; pct=100` |

> Start with `p=none` (monitoring). Move to `p=quarantine` → `p=reject` once confirmed working.

### DKIM

- **Cloudflare side:** Automatically handled by Email Routing
- **Gmail side:** Gmail signs with `d=gmail.com` by default. For `d=getouch.co` signing, you'd need Google Workspace (not free Gmail). This is fine for most use cases.

---

## Verification Checklist

Run these after setup is complete:

```bash
# MX records (should show Cloudflare)
dig MX getouch.co +short
# Expected: 86 isaac.mx.cloudflare.net.
#           7  linda.mx.cloudflare.net.
#           68 amir.mx.cloudflare.net.

# SPF record
dig TXT getouch.co +short | grep spf
# Expected: "v=spf1 include:_spf.mx.cloudflare.net include:_spf.google.com ~all"

# DMARC record
dig TXT _dmarc.getouch.co +short
# Expected: "v=DMARC1; p=none; ..."
```

### End-to-end test

1. Send an email **to** `admin@getouch.co` from a different email account
2. Confirm it arrives in Gmail
3. Reply from Gmail, choosing `admin@getouch.co` in the "From" dropdown
4. Confirm the recipient gets the reply with `From: admin@getouch.co`

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Email to `admin@getouch.co` bounces | MX records not propagated | Check `dig MX getouch.co`; wait for propagation |
| Email arrives but goes to spam | SPF/DMARC not set | Add SPF and DMARC TXT records |
| Gmail "Send mail as" verification email never arrives | Routing rule not created yet | Create the rule in Part A first, then retry |
| Gmail SMTP rejects App Password | 2FA not enabled | Enable 2FA on Gmail, then generate App Password |
| Reply shows `via gmail.com` | Normal for free Gmail | Only Google Workspace removes this; functionally fine |
| Catch-all getting too much spam | Expected | Disable catch-all; use explicit rules only |

---

## Hardening (later)

Once email is confirmed working for 1-2 weeks:

1. Tighten DMARC: change `p=none` → `p=quarantine` → `p=reject`
2. Review `rua` DMARC reports in your inbox
3. Consider adding a dedicated `noreply@getouch.co` with Drop action for transactional sends that shouldn't receive replies

---

## Quick Reference

```
Inbound:  sender → Cloudflare MX → Email Routing → Gmail inbox
Outbound: Gmail "Send mail as" → smtp.gmail.com → recipient
DNS:      MX (auto) + SPF (manual) + DMARC (manual)
```
