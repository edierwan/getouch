package co.getouch.smsgateway.data

import androidx.room.*

/**
 * Offline queue: persists events when server is unreachable.
 * Events are retried with exponential backoff until acknowledged.
 */
@Entity(tableName = "pending_events")
data class PendingEvent(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    @ColumnInfo(name = "event_type") val eventType: String,   // inbound, outbound_ack, delivery
    @ColumnInfo(name = "payload") val payload: String,         // JSON body
    @ColumnInfo(name = "created_at") val createdAt: Long = System.currentTimeMillis(),
    @ColumnInfo(name = "attempts") val attempts: Int = 0,
    @ColumnInfo(name = "next_retry_at") val nextRetryAt: Long = System.currentTimeMillis(),
    @ColumnInfo(name = "last_error") val lastError: String? = null
)

@Dao
interface PendingEventDao {
    @Query("SELECT * FROM pending_events WHERE next_retry_at <= :now ORDER BY created_at ASC LIMIT :limit")
    suspend fun getRetryable(now: Long = System.currentTimeMillis(), limit: Int = 20): List<PendingEvent>

    @Insert
    suspend fun insert(event: PendingEvent): Long

    @Delete
    suspend fun delete(event: PendingEvent)

    @Query("UPDATE pending_events SET attempts = attempts + 1, next_retry_at = :nextRetry, last_error = :error WHERE id = :id")
    suspend fun markRetry(id: Long, nextRetry: Long, error: String)

    @Query("SELECT COUNT(*) FROM pending_events")
    suspend fun count(): Int

    @Query("DELETE FROM pending_events")
    suspend fun deleteAll()
}

@Database(entities = [PendingEvent::class], version = 1, exportSchema = false)
abstract class AppDatabase : RoomDatabase() {
    abstract fun pendingEventDao(): PendingEventDao

    companion object {
        @Volatile
        private var INSTANCE: AppDatabase? = null

        fun getInstance(context: android.content.Context): AppDatabase {
            return INSTANCE ?: synchronized(this) {
                Room.databaseBuilder(
                    context.applicationContext,
                    AppDatabase::class.java,
                    "getouch_sms_gateway.db"
                )
                    .fallbackToDestructiveMigration()
                    .build()
                    .also { INSTANCE = it }
            }
        }
    }
}
