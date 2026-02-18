package co.getouch.smsgateway.network

import android.util.Log
import co.getouch.smsgateway.data.SecurePrefs
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * HTTP client for communication with sms.getouch.co server.
 * All requests include HMAC-SHA256 signature for device authentication.
 */
class ApiClient(private val prefs: SecurePrefs) {

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()

    private val gson = Gson()
    private val jsonType = "application/json; charset=utf-8".toMediaType()

    /**
     * Pair device with server (no HMAC needed for initial pairing)
     */
    suspend fun pair(serverUrl: String, deviceToken: String): ApiResult<PairResponse> {
        val body = gson.toJson(mapOf("device_token" to deviceToken))
        val request = Request.Builder()
            .url("$serverUrl/v1/sms/internal/android/pair")
            .post(body.toRequestBody(jsonType))
            .header("Content-Type", "application/json")
            .build()

        return execute(request)
    }

    /**
     * Send heartbeat with device status
     */
    suspend fun heartbeat(
        batteryPct: Int? = null,
        isCharging: Boolean? = null,
        networkType: String? = null
    ): ApiResult<HeartbeatResponse> {
        val payload = mutableMapOf<String, Any>()
        batteryPct?.let { payload["battery_pct"] = it }
        isCharging?.let { payload["is_charging"] = it }
        networkType?.let { payload["network_type"] = it }

        return signedPost("/v1/sms/internal/android/heartbeat", payload)
    }

    /**
     * Pull outbound messages to send
     */
    suspend fun pullOutbound(): ApiResult<PullOutboundResponse> {
        return signedPost("/v1/sms/internal/android/pull-outbound", emptyMap<String, Any>())
    }

    /**
     * ACK outbound send result
     */
    suspend fun outboundAck(
        messageId: String,
        status: String,
        errorCode: String? = null,
        errorMessage: String? = null,
        externalRef: String? = null
    ): ApiResult<AckResponse> {
        val payload = mutableMapOf<String, Any>(
            "message_id" to messageId,
            "status" to status
        )
        errorCode?.let { payload["error_code"] = it }
        errorMessage?.let { payload["error_message"] = it }
        externalRef?.let { payload["external_ref"] = it }

        return signedPost("/v1/sms/internal/android/outbound-ack", payload)
    }

    /**
     * Report inbound SMS received
     */
    suspend fun reportInbound(
        fromNumber: String,
        toNumber: String?,
        body: String,
        receivedAt: Long,
        messageRef: String
    ): ApiResult<InboundResponse> {
        val payload = mutableMapOf<String, Any>(
            "from_number" to fromNumber,
            "body" to body,
            "received_at" to receivedAt,
            "message_ref" to messageRef
        )
        toNumber?.let { payload["to_number"] = it }

        return signedPost("/v1/sms/internal/android/inbound", payload)
    }

    /**
     * Report delivery status
     */
    suspend fun reportDelivery(
        messageId: String,
        status: String,
        externalRef: String? = null
    ): ApiResult<DeliveryResponse> {
        val payload = mutableMapOf<String, Any>(
            "message_id" to messageId,
            "status" to status
        )
        externalRef?.let { payload["external_ref"] = it }

        return signedPost("/v1/sms/internal/android/delivery", payload)
    }

    // ── Internal helpers ────────────────────────────────

    private inline fun <reified T> signedPost(
        path: String,
        payload: Map<String, Any>
    ): ApiResult<T> {
        val serverUrl = prefs.serverUrl
        val deviceId = prefs.deviceId
        val deviceToken = prefs.deviceToken

        if (serverUrl.isBlank() || deviceToken.isBlank()) {
            return ApiResult.Error("Not paired")
        }

        val bodyJson = gson.toJson(payload)
        val timestamp = System.currentTimeMillis().toString()
        val nonce = UUID.randomUUID().toString().replace("-", "").take(16)

        // HMAC-SHA256: deviceId:timestamp:nonce:body
        val signPayload = "$deviceId:$timestamp:$nonce:$bodyJson"
        val signature = hmacSha256(deviceToken, signPayload)

        val request = Request.Builder()
            .url("$serverUrl$path")
            .post(bodyJson.toRequestBody(jsonType))
            .header("Content-Type", "application/json")
            .header("X-Device-Signature", signature)
            .header("X-Device-Id", deviceId)
            .header("X-Timestamp", timestamp)
            .header("X-Nonce", nonce)
            .header("X-Device-Token", deviceToken)
            .build()

        return execute(request)
    }

    private inline fun <reified T> execute(request: Request): ApiResult<T> {
        return try {
            val response = client.newCall(request).execute()
            val bodyStr = response.body?.string() ?: ""

            if (response.isSuccessful) {
                val data = gson.fromJson<T>(bodyStr, object : TypeToken<T>() {}.type)
                ApiResult.Success(data)
            } else {
                val errorMsg = try {
                    val map = gson.fromJson<Map<String, Any>>(bodyStr, object : TypeToken<Map<String, Any>>() {}.type)
                    map["error"]?.toString() ?: "HTTP ${response.code}"
                } catch (_: Exception) {
                    "HTTP ${response.code}"
                }
                Log.w(TAG, "API error ${response.code}: $errorMsg (${request.url.encodedPath})")
                ApiResult.Error(errorMsg, response.code)
            }
        } catch (e: IOException) {
            Log.w(TAG, "Network error: ${e.message} (${request.url.encodedPath})")
            ApiResult.Error("Network error: ${e.message}", isNetworkError = true)
        } catch (e: Exception) {
            Log.e(TAG, "Unexpected error", e)
            ApiResult.Error("Unexpected error: ${e.message}")
        }
    }

    private fun hmacSha256(key: String, data: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        return mac.doFinal(data.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
    }

    companion object {
        private const val TAG = "ApiClient"
    }
}

// ── Response models ─────────────────────────────────────

sealed class ApiResult<out T> {
    data class Success<T>(val data: T) : ApiResult<T>()
    data class Error(
        val message: String,
        val httpCode: Int = 0,
        val isNetworkError: Boolean = false
    ) : ApiResult<Nothing>()
}

data class PairResponse(
    val ok: Boolean,
    val device_id: String,
    val device_name: String,
    val tenant_name: String,
    val server_time: Long
)

data class HeartbeatResponse(
    val ok: Boolean,
    val device_id: String,
    val server_time: Long
)

data class PullOutboundResponse(
    val messages: List<OutboundMessage>
)

data class OutboundMessage(
    val message_id: String,
    val to_number: String,
    val body: String,
    val send_ref: String
)

data class AckResponse(val ok: Boolean, val message_id: String)
data class InboundResponse(val ok: Boolean, val id: String)
data class DeliveryResponse(val ok: Boolean, val message_id: String)
