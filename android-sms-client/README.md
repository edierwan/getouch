# Getouch SMS Gateway — Android Client

Turns any Android phone (API 26+) into an SMS relay device for [Getouch](https://getouch.co).  
Pairs with **sms.getouch.co**, sends/receives SMS on behalf of tenants, and reports delivery status — all over HTTPS with HMAC-SHA256 signed requests.

## Features

| Feature | Details |
|---------|---------|
| **QR Pairing** | Scan QR from admin panel — instant setup |
| **Outbound SMS** | Pull-based polling (10 s), multipart support |
| **Inbound SMS** | `BroadcastReceiver` captures incoming messages |
| **Delivery Reports** | Sent / delivered / failed with error codes |
| **Heartbeat** | 30 s interval, battery + network + app_version telemetry |
| **Offline Queue** | Room DB, exponential back-off retries |
| **Foreground Service** | Survives app-switch and doze mode |
| **Boot Receiver** | Auto-starts after reboot |
| **Encrypted Storage** | Device token stored in `EncryptedSharedPreferences` |
| **Event Logs** | Last 200 events viewable in-app (secrets masked) |
| **Device Info** | Sends model, Android version, app version on pairing |

## Quick Start (No Build Required)

### 1. Download the APK

- **From GitHub Actions**: Go to [Actions → CI workflow](../../actions) → click latest run → download `getouch-sms-debug` artifact → extract the APK
- **From Releases**: Go to [Releases](../../releases) → download the latest `.apk` file

### 2. Install on Android

1. Transfer the APK to your Android phone (ADB, email, USB, etc.)
2. Open the `.apk` file on the phone
3. If prompted, enable **"Install from unknown sources"** for your file manager
4. Tap **Install**

### 3. Register a Device in Admin

1. Go to **getouch.co → Admin → SMS Gateway → Devices**
2. Click **+ Add Device**, give it a name, and click **Create**
3. Click **Rotate** on the new device to generate a pairing token
4. Copy the token (or click **Show QR** for the QR code)

### 4. Pair the App

- **QR method**: Open the app → **Pair Device** → **Scan QR Code** → point at QR
- **Manual method**: Open the app → **Pair Device** → Enter `https://sms.getouch.co` as server URL → Paste the token → **Connect**

### 5. Verify

- The device should appear as **Online** in the admin panel within **60 seconds**
- The app shows a green dot with "Online" status and last sync time
- Check **Event Logs** in the app to confirm heartbeats are working

### 6. Battery Optimization

Follow the on-screen prompt to **disable battery optimization** so the service isn't killed by Android. This is critical for reliable SMS relay.

## Build from Source

```bash
# Clone
git clone <your-repo-url>
cd android-sms-client

# Debug APK
./gradlew assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk

# Release APK (requires signing config)
./gradlew assembleRelease
```

### Requirements

- Android Studio Hedgehog (2023.1+) or CLI
- JDK 17
- Gradle 8.5 (wrapper included)

## CI / CD

GitHub Actions builds are triggered automatically:

| Workflow | Trigger | Artifact |
|----------|---------|----------|
| `ci.yml` | Push to `main`, any PR | Debug APK uploaded as artifact |
| `release.yml` | Tag `v*` | Release APK attached to GitHub Release |

### Release Signing (Optional)

If signing secrets are configured, the release APK will be signed. If not, an **unsigned APK** is built as fallback (documented in the release notes).

Store your keystore and passwords in **GitHub → Settings → Secrets**:

| Secret | Description |
|--------|-------------|
| `KEYSTORE_BASE64` | Base64-encoded `.jks` keystore |
| `KEYSTORE_PASSWORD` | Keystore password |
| `KEY_ALIAS` | Key alias name |
| `KEY_PASSWORD` | Key password |

## App Screens

| Screen | Purpose |
|--------|---------|
| **Home** | Status (Online/Offline), device info, queue count, unpair |
| **Pair Device** | QR scan or manual token entry |
| **Event Logs** | Last 200 events with timestamps, level, and masked secrets |
| **Battery Opt** | One-time guide to disable battery optimization |

## Architecture

```
┌────────────────────────────────────────┐
│          Android Device                │
│                                        │
│  SmsReceiver ──► OfflineQueue ──►──┐   │
│                                    │   │
│  GatewayForegroundService          │   │
│   ├─ heartbeat loop (30s)      ApiClient
│   ├─ poll outbound loop (10s)      │   │
│   └─ queue retry loop (60s)        │   │
│                                    │   │
│  SmsSender ◄── pull-outbound ◄─────┘   │
│                                        │
│  EventLogger → Room DB → LogsActivity  │
└────────────────────────────────────────┘
                   │  HTTPS + HMAC-SHA256
                   ▼
          sms.getouch.co
```

### HMAC Authentication

Every request (except pairing) is signed:

```
signature = HMAC-SHA256(device_token, "deviceId:timestamp:nonce:body")
```

Headers: `X-Device-Signature`, `X-Device-Id`, `X-Timestamp`, `X-Nonce`, `X-Device-Token`

### Server Endpoints

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `POST /v1/sms/internal/android/pair` | Token in body | Initial device pairing |
| `POST /v1/sms/internal/android/heartbeat` | HMAC-SHA256 | 30s heartbeat |
| `POST /v1/sms/internal/android/pull-outbound` | HMAC-SHA256 | Pull messages to send |
| `POST /v1/sms/internal/android/outbound-ack` | HMAC-SHA256 | Report send result |
| `POST /v1/sms/internal/android/inbound` | HMAC-SHA256 | Forward received SMS |
| `POST /v1/sms/internal/android/delivery` | HMAC-SHA256 | Delivery confirmation |

## Acceptance Tests

| Test | Expected Result |
|------|-----------------|
| Pair with token | Device status becomes **Online** in admin within 60s |
| Create outbound in admin | Device sends SMS, status updates to **sent** then **delivered** |
| Send SMS to SIM | Inbound appears in admin inbox |
| Kill app + reboot | Service auto-restarts, device goes back online |
| Airplane mode → reconnect | Queued events are retried and delivered |

## Permissions

| Permission | Why |
|------------|-----|
| `RECEIVE_SMS` | Capture inbound messages |
| `SEND_SMS` | Send outbound messages |
| `READ_PHONE_STATE` | Detect SIM state |
| `INTERNET` | Communicate with server |
| `FOREGROUND_SERVICE` | Keep service alive |
| `RECEIVE_BOOT_COMPLETED` | Auto-start on reboot |
| `CAMERA` | QR code scanning |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | Prevent doze killing service |

## License

Proprietary — (c) Getouch 2025-2026
