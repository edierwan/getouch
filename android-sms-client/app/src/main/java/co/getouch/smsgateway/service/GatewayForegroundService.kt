package co.getouch.smsgateway.service

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.IBinder
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.util.Log
import androidx.core.app.NotificationCompat
import co.getouch.smsgateway.GatewayApp
import co.getouch.smsgateway.R
import co.getouch.smsgateway.data.EventLogger
import co.getouch.smsgateway.network.ApiClient
import co.getouch.smsgateway.network.ApiResult
import co.getouch.smsgateway.network.OfflineQueue
import co.getouch.smsgateway.sms.SmsSender
import co.getouch.smsgateway.ui.MainActivity
import kotlinx.coroutines.*
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Foreground service that keeps the SMS gateway alive.
 *
 * Responsibilities:
 * 1. Heartbeat every 30s
 * 2. Poll for outbound messages every 10s
 * 3. Process offline queue every 60s
 * 4. Send SMS when outbound messages are pulled
 */
class GatewayForegroundService : Service() {

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val isRunning = AtomicBoolean(false)

    private lateinit var apiClient: ApiClient
    private lateinit var offlineQueue: OfflineQueue

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Log.d(TAG, "Service created")

        val app = application as GatewayApp
        apiClient = ApiClient(app.securePrefs)
        offlineQueue = OfflineQueue(apiClient)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }

        startForeground(NOTIFICATION_ID, buildNotification("Starting…"))

        val app = application as GatewayApp
        if (!app.securePrefs.isPaired) {
            Log.w(TAG, "Not paired, stopping service")
            stopSelf()
            return START_NOT_STICKY
        }

        if (isRunning.compareAndSet(false, true)) {
            startWorkerLoops()
        }

        return START_STICKY
    }

    override fun onDestroy() {
        isRunning.set(false)
        scope.cancel()
        Log.d(TAG, "Service destroyed")
        super.onDestroy()
    }

    private fun startWorkerLoops() {
        // Heartbeat loop (every 30 seconds)
        scope.launch {
            while (isActive && isRunning.get()) {
                try {
                    sendHeartbeat()
                } catch (e: Exception) {
                    Log.e(TAG, "Heartbeat error", e)
                }
                delay(30_000)
            }
        }

        // Outbound poll loop (every 10 seconds)
        scope.launch {
            delay(3_000) // Initial delay
            while (isActive && isRunning.get()) {
                try {
                    pollOutbound()
                } catch (e: Exception) {
                    Log.e(TAG, "Poll error", e)
                }
                delay(10_000)
            }
        }

        // Offline queue processing (every 60 seconds)
        scope.launch {
            delay(10_000) // Initial delay
            while (isActive && isRunning.get()) {
                try {
                    offlineQueue.processQueue()
                    val pending = offlineQueue.pendingCount()
                    if (pending > 0) {
                        updateNotification("Online · $pending queued")
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Queue processing error", e)
                }
                delay(60_000)
            }
        }
    }

    private suspend fun sendHeartbeat() {
        val batteryStatus = getBatteryInfo()
        val networkType = getNetworkType()

        val result = apiClient.heartbeat(
            batteryPct = batteryStatus.first,
            isCharging = batteryStatus.second,
            networkType = networkType,
            appVersion = getAppVersion()
        )

        when (result) {
            is ApiResult.Success -> {
                val app = application as GatewayApp
                app.securePrefs.lastSyncTime = System.currentTimeMillis()
                val statusMsg = "Online" +
                    (batteryStatus.first?.let { " · ${it}%" } ?: "") +
                    " · ${networkType ?: "unknown"}"
                updateNotification(statusMsg)
                EventLogger.info("Heartbeat", "OK · $statusMsg")
            }
            is ApiResult.Error -> {
                updateNotification("Offline · ${result.message}")
                EventLogger.warn("Heartbeat", "Failed: ${result.message}")
                Log.w(TAG, "Heartbeat failed: ${result.message}")
            }
        }
    }

    private suspend fun pollOutbound() {
        val result = apiClient.pullOutbound()
        when (result) {
            is ApiResult.Success -> {
                val messages = result.data.messages
                if (messages.isNotEmpty()) {
                    Log.d(TAG, "Got ${messages.size} outbound message(s)")
                    EventLogger.info("Outbound", "Pulled ${messages.size} message(s) to send")
                    for (msg in messages) {
                        sendOutboundSms(msg.message_id, msg.to_number, msg.body)
                    }
                }
            }
            is ApiResult.Error -> {
                if (!result.isNetworkError) {
                    Log.w(TAG, "Poll outbound failed: ${result.message}")
                }
            }
        }
    }

    private fun sendOutboundSms(messageId: String, toNumber: String, body: String) {
        SmsSender.sendSms(this, messageId, toNumber, body) { status, errorCode, errorMessage ->
            scope.launch {
                try {
                    offlineQueue.queueOutboundAck(messageId, status, errorCode, errorMessage)
                    EventLogger.info("SMS Send", "$messageId → $status")
                    Log.d(TAG, "Outbound $messageId: $status")
                } catch (e: Exception) {
                    Log.e(TAG, "ACK queue error", e)
                }
            }
        }
    }

    // ── Helpers ──────────────────────────────────────

    private fun getBatteryInfo(): Pair<Int?, Boolean?> {
        return try {
            val bm = getSystemService(BatteryManager::class.java)
            val level = bm?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
            val charging = bm?.isCharging
            Pair(level, charging)
        } catch (_: Exception) {
            Pair(null, null)
        }
    }

    private fun getNetworkType(): String? {
        return try {
            val cm = getSystemService(ConnectivityManager::class.java) ?: return null
            val network = cm.activeNetwork ?: return "none"
            val caps = cm.getNetworkCapabilities(network) ?: return "unknown"
            when {
                caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
                else -> "other"
            }
        } catch (_: Exception) { null }
    }

    private fun getAppVersion(): String {
        return try {
            packageManager.getPackageInfo(packageName, 0).versionName ?: "1.0.0"
        } catch (_: Exception) { "1.0.0" }
    }

    private fun buildNotification(text: String): Notification {
        val pendingIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, GatewayApp.CHANNEL_ID)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setSilent(true)
            .build()
    }

    private fun updateNotification(text: String) {
        val notification = buildNotification(text)
        try {
            val nm = getSystemService(android.app.NotificationManager::class.java)
            nm.notify(NOTIFICATION_ID, notification)
        } catch (_: Exception) {}
    }

    companion object {
        private const val TAG = "GatewayService"
        private const val NOTIFICATION_ID = 1001
        const val ACTION_STOP = "co.getouch.smsgateway.STOP_SERVICE"

        fun start(context: Context) {
            val intent = Intent(context, GatewayForegroundService::class.java)
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            val intent = Intent(context, GatewayForegroundService::class.java).apply {
                action = ACTION_STOP
            }
            context.startService(intent)
        }
    }
}
