package co.getouch.smsgateway.network

import android.util.Log
import co.getouch.smsgateway.GatewayApp
import co.getouch.smsgateway.data.PendingEvent
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import kotlinx.coroutines.*

/**
 * Offline-resilient event queue.
 * When server is unreachable, events are persisted to Room DB
 * and retried with exponential backoff.
 */
class OfflineQueue(private val apiClient: ApiClient) {

    private val dao = GatewayApp.instance.database.pendingEventDao()
    private val gson = Gson()
    private var retryJob: Job? = null

    /**
     * Queue an inbound SMS event for delivery to server
     */
    suspend fun queueInbound(
        fromNumber: String,
        toNumber: String?,
        body: String,
        receivedAt: Long,
        messageRef: String
    ) {
        val payload = mutableMapOf<String, Any>(
            "from_number" to fromNumber,
            "body" to body,
            "received_at" to receivedAt,
            "message_ref" to messageRef
        )
        toNumber?.let { payload["to_number"] = it }

        // Try sending directly first
        val result = apiClient.reportInbound(fromNumber, toNumber, body, receivedAt, messageRef)
        if (result is ApiResult.Success) {
            Log.d(TAG, "Inbound sent directly: $messageRef")
            return
        }

        // Queue for retry
        Log.w(TAG, "Inbound queued for retry: $messageRef")
        dao.insert(PendingEvent(
            eventType = "inbound",
            payload = gson.toJson(payload)
        ))
    }

    /**
     * Queue an outbound ACK for delivery to server
     */
    suspend fun queueOutboundAck(
        messageId: String,
        status: String,
        errorCode: String? = null,
        errorMessage: String? = null,
        externalRef: String? = null
    ) {
        val result = apiClient.outboundAck(messageId, status, errorCode, errorMessage, externalRef)
        if (result is ApiResult.Success) {
            Log.d(TAG, "ACK sent directly: $messageId=$status")
            return
        }

        val payload = mutableMapOf<String, Any>(
            "message_id" to messageId,
            "status" to status
        )
        errorCode?.let { payload["error_code"] = it }
        errorMessage?.let { payload["error_message"] = it }
        externalRef?.let { payload["external_ref"] = it }

        dao.insert(PendingEvent(
            eventType = "outbound_ack",
            payload = gson.toJson(payload)
        ))
    }

    /**
     * Queue a delivery report
     */
    suspend fun queueDelivery(
        messageId: String,
        status: String,
        externalRef: String? = null
    ) {
        val result = apiClient.reportDelivery(messageId, status, externalRef)
        if (result is ApiResult.Success) {
            Log.d(TAG, "Delivery sent directly: $messageId=$status")
            return
        }

        val payload = mutableMapOf<String, Any>(
            "message_id" to messageId,
            "status" to status
        )
        externalRef?.let { payload["external_ref"] = it }

        dao.insert(PendingEvent(
            eventType = "delivery",
            payload = gson.toJson(payload)
        ))
    }

    /**
     * Process queued events — called periodically
     */
    suspend fun processQueue() {
        val events = dao.getRetryable()
        if (events.isEmpty()) return

        Log.d(TAG, "Processing ${events.size} queued events")

        for (event in events) {
            val success = processEvent(event)
            if (success) {
                dao.delete(event)
            } else {
                // Exponential backoff: 30s, 2m, 8m, 32m (cap at 30 min)
                val delay = minOf(
                    30_000L * (1L shl minOf(event.attempts, 6)),
                    30 * 60 * 1000L
                )
                dao.markRetry(
                    event.id,
                    System.currentTimeMillis() + delay,
                    "Retry ${event.attempts + 1}"
                )
            }
        }
    }

    private suspend fun processEvent(event: PendingEvent): Boolean {
        val payload: Map<String, Any> = gson.fromJson(
            event.payload,
            object : TypeToken<Map<String, Any>>() {}.type
        )

        val result: ApiResult<*> = when (event.eventType) {
            "inbound" -> apiClient.reportInbound(
                fromNumber = payload["from_number"] as String,
                toNumber = payload["to_number"] as? String,
                body = payload["body"] as String,
                receivedAt = (payload["received_at"] as Double).toLong(),
                messageRef = payload["message_ref"] as String
            )
            "outbound_ack" -> apiClient.outboundAck(
                messageId = payload["message_id"] as String,
                status = payload["status"] as String,
                errorCode = payload["error_code"] as? String,
                errorMessage = payload["error_message"] as? String,
                externalRef = payload["external_ref"] as? String
            )
            "delivery" -> apiClient.reportDelivery(
                messageId = payload["message_id"] as String,
                status = payload["status"] as String,
                externalRef = payload["external_ref"] as? String
            )
            else -> {
                Log.w(TAG, "Unknown event type: ${event.eventType}")
                return true // Delete unknown events
            }
        }

        return result is ApiResult.Success
    }

    /** Get pending count for UI display */
    suspend fun pendingCount(): Int = dao.count()

    companion object {
        private const val TAG = "OfflineQueue"
    }
}
