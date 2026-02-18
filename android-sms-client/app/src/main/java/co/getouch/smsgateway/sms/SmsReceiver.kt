package co.getouch.smsgateway.sms

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.provider.Telephony
import android.telephony.SmsManager
import android.telephony.SmsMessage
import android.util.Log
import co.getouch.smsgateway.GatewayApp
import co.getouch.smsgateway.network.ApiClient
import co.getouch.smsgateway.network.OfflineQueue
import kotlinx.coroutines.*
import java.util.UUID

/**
 * BroadcastReceiver for incoming SMS messages.
 * Forwards received SMS to the server via OfflineQueue.
 */
class SmsReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return

        val app = context.applicationContext as GatewayApp
        if (!app.securePrefs.isPaired) return

        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent)
        if (messages.isNullOrEmpty()) return

        // Group multipart SMS
        val grouped = mutableMapOf<String, StringBuilder>()
        var sender = ""
        for (msg in messages) {
            sender = msg.originatingAddress ?: continue
            grouped.getOrPut(sender) { StringBuilder() }.append(msg.messageBody ?: "")
        }

        val apiClient = ApiClient(app.securePrefs)
        val queue = OfflineQueue(apiClient)

        CoroutineScope(Dispatchers.IO).launch {
            for ((from, body) in grouped) {
                try {
                    val messageRef = UUID.randomUUID().toString()
                    queue.queueInbound(
                        fromNumber = from,
                        toNumber = null, // Could detect SIM number if needed
                        body = body.toString(),
                        receivedAt = System.currentTimeMillis(),
                        messageRef = messageRef
                    )
                    Log.d(TAG, "Inbound SMS from $from queued (ref: ${messageRef.take(8)})")
                } catch (e: Exception) {
                    Log.e(TAG, "Error processing inbound SMS", e)
                }
            }
        }
    }

    companion object {
        private const val TAG = "SmsReceiver"
    }
}

/**
 * SMS sending utility with delivery tracking.
 * Sends SMS locally and reports status back to server.
 */
object SmsSender {

    private const val TAG = "SmsSender"
    private const val ACTION_SENT = "co.getouch.smsgateway.SMS_SENT"
    private const val ACTION_DELIVERED = "co.getouch.smsgateway.SMS_DELIVERED"

    /**
     * Send an SMS message and track sent/delivered status.
     * Returns true if SMS was handed to the system successfully.
     */
    fun sendSms(
        context: Context,
        messageId: String,
        toNumber: String,
        body: String,
        onResult: (status: String, errorCode: String?, errorMessage: String?) -> Unit
    ) {
        try {
            val smsManager = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                context.getSystemService(SmsManager::class.java)
            } else {
                @Suppress("DEPRECATION")
                SmsManager.getDefault()
            }

            val parts = smsManager.divideMessage(body)
            val sentIntents = ArrayList<PendingIntent>()
            val deliveredIntents = ArrayList<PendingIntent>()

            // Register sent receiver
            val sentReceiver = object : BroadcastReceiver() {
                private var partsReceived = 0
                private var allSent = true

                override fun onReceive(ctx: Context, intent: Intent) {
                    partsReceived++
                    if (resultCode != android.app.Activity.RESULT_OK) {
                        allSent = false
                        val errorCode = when (resultCode) {
                            SmsManager.RESULT_ERROR_GENERIC_FAILURE -> "GENERIC_FAILURE"
                            SmsManager.RESULT_ERROR_NO_SERVICE -> "NO_SERVICE"
                            SmsManager.RESULT_ERROR_NULL_PDU -> "NULL_PDU"
                            SmsManager.RESULT_ERROR_RADIO_OFF -> "RADIO_OFF"
                            SmsManager.RESULT_ERROR_SHORT_CODE_NOT_ALLOWED -> "SHORT_CODE_BLOCKED"
                            else -> "UNKNOWN_$resultCode"
                        }
                        Log.w(TAG, "SMS send failed: $errorCode (part $partsReceived/${parts.size})")
                    }

                    if (partsReceived >= parts.size) {
                        try { context.unregisterReceiver(this) } catch (_: Exception) {}
                        if (allSent) {
                            onResult("sent", null, null)
                        } else {
                            onResult("failed", "SEND_FAILED", "One or more parts failed to send")
                        }
                    }
                }
            }

            // Register delivery receiver
            val deliveryReceiver = object : BroadcastReceiver() {
                private var partsDelivered = 0

                override fun onReceive(ctx: Context, intent: Intent) {
                    partsDelivered++
                    if (partsDelivered >= parts.size) {
                        try { context.unregisterReceiver(this) } catch (_: Exception) {}

                        val app = ctx.applicationContext as GatewayApp
                        val apiClient = ApiClient(app.securePrefs)
                        val queue = OfflineQueue(apiClient)

                        CoroutineScope(Dispatchers.IO).launch {
                            queue.queueDelivery(messageId, "delivered")
                        }
                    }
                }
            }

            val sentAction = "$ACTION_SENT.$messageId"
            val deliveredAction = "$ACTION_DELIVERED.$messageId"

            val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
            } else {
                PendingIntent.FLAG_UPDATE_CURRENT
            }

            context.registerReceiver(sentReceiver, IntentFilter(sentAction),
                Context.RECEIVER_NOT_EXPORTED)
            context.registerReceiver(deliveryReceiver, IntentFilter(deliveredAction),
                Context.RECEIVER_NOT_EXPORTED)

            for (i in parts.indices) {
                sentIntents.add(PendingIntent.getBroadcast(
                    context, i, Intent(sentAction), flags
                ))
                deliveredIntents.add(PendingIntent.getBroadcast(
                    context, i, Intent(deliveredAction), flags
                ))
            }

            smsManager.sendMultipartTextMessage(
                toNumber, null, parts, sentIntents, deliveredIntents
            )

            Log.d(TAG, "SMS queued to system: $toNumber (${parts.size} parts, id: ${messageId.take(8)})")

        } catch (e: Exception) {
            Log.e(TAG, "SMS send exception", e)
            onResult("failed", "EXCEPTION", e.message)
        }
    }
}
