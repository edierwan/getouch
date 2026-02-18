package co.getouch.smsgateway.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Secure credential storage using EncryptedSharedPreferences.
 * Stores pairing token, server URL, device ID — all encrypted at rest.
 */
class SecurePrefs(context: Context) {

    private val masterKey = MasterKey.Builder(context)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()

    private val prefs: SharedPreferences = EncryptedSharedPreferences.create(
        context,
        "getouch_sms_secure_prefs",
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )

    var serverUrl: String
        get() = prefs.getString(KEY_SERVER_URL, "") ?: ""
        set(value) = prefs.edit().putString(KEY_SERVER_URL, value).apply()

    var deviceToken: String
        get() = prefs.getString(KEY_DEVICE_TOKEN, "") ?: ""
        set(value) = prefs.edit().putString(KEY_DEVICE_TOKEN, value).apply()

    var deviceId: String
        get() = prefs.getString(KEY_DEVICE_ID, "") ?: ""
        set(value) = prefs.edit().putString(KEY_DEVICE_ID, value).apply()

    var deviceName: String
        get() = prefs.getString(KEY_DEVICE_NAME, "") ?: ""
        set(value) = prefs.edit().putString(KEY_DEVICE_NAME, value).apply()

    var tenantName: String
        get() = prefs.getString(KEY_TENANT_NAME, "") ?: ""
        set(value) = prefs.edit().putString(KEY_TENANT_NAME, value).apply()

    var isPaired: Boolean
        get() = prefs.getBoolean(KEY_IS_PAIRED, false)
        set(value) = prefs.edit().putBoolean(KEY_IS_PAIRED, value).apply()

    var batteryOptShown: Boolean
        get() = prefs.getBoolean(KEY_BATTERY_OPT_SHOWN, false)
        set(value) = prefs.edit().putBoolean(KEY_BATTERY_OPT_SHOWN, value).apply()

    var lastSyncTime: Long
        get() = prefs.getLong(KEY_LAST_SYNC, 0L)
        set(value) = prefs.edit().putLong(KEY_LAST_SYNC, value).apply()

    fun clear() {
        prefs.edit().clear().apply()
    }

    /** Mask token for logging: show first 8 + last 4 chars */
    fun maskedToken(): String {
        val t = deviceToken
        if (t.length < 16) return "****"
        return "${t.take(8)}…${t.takeLast(4)}"
    }

    companion object {
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_DEVICE_TOKEN = "device_token"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_DEVICE_NAME = "device_name"
        private const val KEY_TENANT_NAME = "tenant_name"
        private const val KEY_IS_PAIRED = "is_paired"
        private const val KEY_BATTERY_OPT_SHOWN = "battery_opt_shown"
        private const val KEY_LAST_SYNC = "last_sync_time"
    }
}
