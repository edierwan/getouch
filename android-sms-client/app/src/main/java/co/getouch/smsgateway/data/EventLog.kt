package co.getouch.smsgateway.data

import androidx.room.*

/**
 * Persistent event log for debugging and audit.
 * Shows last 200 events in the Logs screen.
 */
@Entity(tableName = "event_log")
data class EventLog(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    @ColumnInfo(name = "timestamp") val timestamp: Long = System.currentTimeMillis(),
    @ColumnInfo(name = "level") val level: String = "INFO",       // INFO, WARN, ERROR
    @ColumnInfo(name = "tag") val tag: String,                     // e.g. "Heartbeat", "Inbound", "Outbound"
    @ColumnInfo(name = "message") val message: String,
    @ColumnInfo(name = "details") val details: String? = null      // extra JSON, masked
)

@Dao
interface EventLogDao {
    @Query("SELECT * FROM event_log ORDER BY timestamp DESC LIMIT :limit")
    suspend fun getRecent(limit: Int = 200): List<EventLog>

    @Insert
    suspend fun insert(log: EventLog): Long

    @Query("DELETE FROM event_log WHERE id NOT IN (SELECT id FROM event_log ORDER BY timestamp DESC LIMIT 500)")
    suspend fun trim()

    @Query("DELETE FROM event_log")
    suspend fun deleteAll()

    @Query("SELECT COUNT(*) FROM event_log")
    suspend fun count(): Int
}
