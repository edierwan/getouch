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
| **Heartbeat** | 30 s interval, battery + network telemetry |
| **Offline Queue** | Room DB, exponential back-off retries |
| **Foreground Service** | Survives app-switch and doze mode |
| **Boot Receiver** | Auto-starts after reboot |
| **Encrypted Storage** | Device token stored in `EncryptedSharedPreferences` |

## Quick Start

### 1. Register a Device in Admin

1. Go to **getouch.co/admin → SMS Gateway → Devices**
2. Click **+ Add Device**, name it, copy the **Device Token**
3. Optionally click **Show QR** to display the pairing QR code

### 2. Install the APK

Download the latest APK from [GitHub Releases](../../releases) or build from source (see below).

### 3. Pair

- **QR**: Tap **Pair Device → Scan QR Code** and point at the QR
- **Manual**: Enter the server URL (`https://sms.getouch.co`) and paste the token

### 4. Battery Optimization

Follow the on-screen prompt to disable battery optimization so the service isn't killed.

## Build from Source

```bash
# Clone
git clone https://github.com/AryaBagaworksworksworker/getouch-android-sms.git
cd getouch-android-sms

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
| `ci.yml` | Push to `main`, any PR | Debug APK (unsigned) |
| `release.yml` | Tag `v*` | Signed release APK uploaded to GitHub Releases |

### Release Signing

Store your keystore and passwords in **GitHub → Settings → Secrets**:

| Secret | Description |
|--------|-------------|
| `KEYSTORE_BASE64` | Base64-encoded `.jks` keystore |
| `KEYSTORE_PASSWORD` | Keystore password |
| `KEY_ALIAS` | Key alias name |
| `KEY_PASSWORD` | Key password |

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

Proprietary — © Getouch 2025
