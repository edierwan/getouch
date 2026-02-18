package co.getouch.smsgateway.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Centralized event logger that persists events to Room DB.
 * Used for the Logs screen. Auto-trims old entries.
 */
object EventLogger {

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var dao: EventLogDao? = null

    fun init(dao: EventLogDao) {
        this.dao = dao
    }

    fun info(tag: String, message: String, details: String? = null) {
        log("INFO", tag, message, details)
    }

    fun warn(tag: String, message: String, details: String? = null) {
        log("WARN", tag, message, details)
    }

    fun error(tag: String, message: String, details: String? = null) {
        log("ERROR", tag, message, details)
    }

    private fun log(level: String, tag: String, message: String, details: String?) {
        scope.launch {
            try {
                dao?.insert(EventLog(
                    level = level,
                    tag = tag,
                    message = maskSecrets(message),
                    details = details?.let { maskSecrets(it) }
                ))
                // Trim every ~50 inserts
                val count = dao?.count() ?: 0
                if (count > 500) {
                    dao?.trim()
                }
            } catch (_: Exception) { /* ignore logging failures */ }
        }
    }

    /** Mask tokens and secrets in log messages */
    private fun maskSecrets(text: String): String {
        // Mask anything that looks like a token (32+ hex/alphanum chars)
        return text.replace(Regex("[a-zA-Z0-9]{32,}")) { match ->
            val v = match.value
            if (v.length >= 16) "${v.take(6)}…${v.takeLast(4)}" else v
        }
    }
}
