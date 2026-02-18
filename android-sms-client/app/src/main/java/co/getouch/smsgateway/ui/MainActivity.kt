package co.getouch.smsgateway.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import co.getouch.smsgateway.GatewayApp
import co.getouch.smsgateway.R
import co.getouch.smsgateway.network.ApiClient
import co.getouch.smsgateway.network.OfflineQueue
import co.getouch.smsgateway.service.GatewayForegroundService
import kotlinx.coroutines.*

class MainActivity : AppCompatActivity() {

    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private val handler = Handler(Looper.getMainLooper())
    private val refreshRunnable = object : Runnable {
        override fun run() {
            refreshStatus()
            handler.postDelayed(this, 5000)
        }
    }

    private lateinit var prefs: co.getouch.smsgateway.data.SecurePrefs

    // Views
    private lateinit var statusDot: View
    private lateinit var statusText: TextView
    private lateinit var deviceNameText: TextView
    private lateinit var tenantText: TextView
    private lateinit var serverText: TextView
    private lateinit var lastSyncText: TextView
    private lateinit var queueCountText: TextView
    private lateinit var pairButton: Button
    private lateinit var unpairButton: Button
    private lateinit var statusCard: View
    private lateinit var notPairedCard: View

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        prefs = (application as GatewayApp).securePrefs

        // Bind views
        statusDot = findViewById(R.id.statusDot)
        statusText = findViewById(R.id.statusText)
        deviceNameText = findViewById(R.id.deviceName)
        tenantText = findViewById(R.id.tenantName)
        serverText = findViewById(R.id.serverUrl)
        lastSyncText = findViewById(R.id.lastSync)
        queueCountText = findViewById(R.id.queueCount)
        pairButton = findViewById(R.id.btnPair)
        unpairButton = findViewById(R.id.btnUnpair)
        statusCard = findViewById(R.id.statusCard)
        notPairedCard = findViewById(R.id.notPairedCard)

        pairButton.setOnClickListener {
            startActivity(Intent(this, PairingActivity::class.java))
        }

        unpairButton.setOnClickListener {
            showUnpairConfirmation()
        }

        requestPermissions()
    }

    override fun onResume() {
        super.onResume()
        updateUI()
        handler.post(refreshRunnable)
    }

    override fun onPause() {
        handler.removeCallbacks(refreshRunnable)
        super.onPause()
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun updateUI() {
        if (prefs.isPaired) {
            statusCard.visibility = View.VISIBLE
            notPairedCard.visibility = View.GONE
            deviceNameText.text = prefs.deviceName.ifBlank { "Unknown Device" }
            tenantText.text = prefs.tenantName.ifBlank { "Default" }
            serverText.text = prefs.serverUrl
            refreshStatus()
        } else {
            statusCard.visibility = View.GONE
            notPairedCard.visibility = View.VISIBLE
        }
    }

    private fun refreshStatus() {
        if (!prefs.isPaired) return

        val lastSync = prefs.lastSyncTime
        if (lastSync > 0) {
            val ago = (System.currentTimeMillis() - lastSync) / 1000
            lastSyncText.text = when {
                ago < 60 -> "${ago}s ago"
                ago < 3600 -> "${ago / 60}m ago"
                else -> "${ago / 3600}h ago"
            }

            // Online if synced within last 2 minutes
            val isOnline = ago < 120
            statusDot.setBackgroundResource(
                if (isOnline) R.drawable.dot_online else R.drawable.dot_offline
            )
            statusText.text = if (isOnline) "Online" else "Offline"
        } else {
            lastSyncText.text = "Never"
            statusDot.setBackgroundResource(R.drawable.dot_offline)
            statusText.text = "Connecting…"
        }

        // Queue count
        scope.launch(Dispatchers.IO) {
            try {
                val count = (application as GatewayApp).database.pendingEventDao().count()
                withContext(Dispatchers.Main) {
                    queueCountText.text = if (count > 0) "$count pending" else "Empty"
                }
            } catch (_: Exception) {}
        }
    }

    private fun showUnpairConfirmation() {
        AlertDialog.Builder(this)
            .setTitle("Unpair Device")
            .setMessage("This will disconnect this device from the SMS gateway. You can re-pair later with a new token.")
            .setPositiveButton("Unpair") { _, _ ->
                GatewayForegroundService.stop(this)
                prefs.clear()
                updateUI()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun requestPermissions() {
        val needed = mutableListOf<String>()
        val perms = arrayOf(
            Manifest.permission.SEND_SMS,
            Manifest.permission.RECEIVE_SMS,
            Manifest.permission.READ_SMS,
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.CAMERA
        )
        for (p in perms) {
            if (ContextCompat.checkSelfPermission(this, p) != PackageManager.PERMISSION_GRANTED) {
                needed.add(p)
            }
        }
        if (needed.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, needed.toTypedArray(), 1001)
        } else if (prefs.isPaired && !prefs.batteryOptShown) {
            startActivity(Intent(this, BatteryOptActivity::class.java))
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 1001) {
            if (prefs.isPaired) {
                GatewayForegroundService.start(this)
                if (!prefs.batteryOptShown) {
                    startActivity(Intent(this, BatteryOptActivity::class.java))
                }
            }
        }
    }
}
