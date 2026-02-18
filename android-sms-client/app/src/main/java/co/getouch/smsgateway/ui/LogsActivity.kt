package co.getouch.smsgateway.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import co.getouch.smsgateway.GatewayApp
import co.getouch.smsgateway.R
import co.getouch.smsgateway.data.EventLog
import kotlinx.coroutines.*
import java.text.SimpleDateFormat
import java.util.*

/**
 * Displays the last 200 gateway events for debugging.
 * Shows heartbeats, inbound/outbound SMS, errors, pairing events.
 * All secrets are masked before display.
 */
class LogsActivity : AppCompatActivity() {

    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private lateinit var recyclerView: RecyclerView
    private lateinit var emptyText: TextView
    private val adapter = LogAdapter()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_logs)

        recyclerView = findViewById(R.id.logsRecycler)
        emptyText = findViewById(R.id.emptyText)

        recyclerView.layoutManager = LinearLayoutManager(this)
        recyclerView.adapter = adapter

        findViewById<View>(R.id.btnBack).setOnClickListener { finish() }
        findViewById<View>(R.id.btnClear).setOnClickListener { clearLogs() }

        loadLogs()
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun loadLogs() {
        scope.launch {
            val logs = withContext(Dispatchers.IO) {
                (application as GatewayApp).database.eventLogDao().getRecent(200)
            }
            if (logs.isEmpty()) {
                emptyText.visibility = View.VISIBLE
                recyclerView.visibility = View.GONE
            } else {
                emptyText.visibility = View.GONE
                recyclerView.visibility = View.VISIBLE
                adapter.setLogs(logs)
            }
        }
    }

    private fun clearLogs() {
        scope.launch {
            withContext(Dispatchers.IO) {
                (application as GatewayApp).database.eventLogDao().deleteAll()
            }
            adapter.setLogs(emptyList())
            emptyText.visibility = View.VISIBLE
            recyclerView.visibility = View.GONE
        }
    }
}

class LogAdapter : RecyclerView.Adapter<LogAdapter.LogViewHolder>() {

    private var logs: List<EventLog> = emptyList()
    private val dateFormat = SimpleDateFormat("MM-dd HH:mm:ss", Locale.US)

    fun setLogs(newLogs: List<EventLog>) {
        logs = newLogs
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): LogViewHolder {
        val view = LayoutInflater.from(parent.context)
            .inflate(R.layout.item_log, parent, false)
        return LogViewHolder(view)
    }

    override fun onBindViewHolder(holder: LogViewHolder, position: Int) {
        holder.bind(logs[position])
    }

    override fun getItemCount() = logs.size

    inner class LogViewHolder(view: View) : RecyclerView.ViewHolder(view) {
        private val timeText: TextView = view.findViewById(R.id.logTime)
        private val levelText: TextView = view.findViewById(R.id.logLevel)
        private val tagText: TextView = view.findViewById(R.id.logTag)
        private val messageText: TextView = view.findViewById(R.id.logMessage)

        fun bind(log: EventLog) {
            timeText.text = dateFormat.format(Date(log.timestamp))
            levelText.text = log.level
            tagText.text = log.tag
            messageText.text = log.message

            val levelColor = when (log.level) {
                "ERROR" -> 0xFFEF4444.toInt()
                "WARN" -> 0xFFF59E0B.toInt()
                else -> 0xFF22C55E.toInt()
            }
            levelText.setTextColor(levelColor)
        }
    }
}
