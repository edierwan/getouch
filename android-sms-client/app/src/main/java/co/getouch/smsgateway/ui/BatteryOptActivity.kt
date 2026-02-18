package co.getouch.smsgateway.ui

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.widget.Button
import androidx.appcompat.app.AppCompatActivity
import co.getouch.smsgateway.GatewayApp
import co.getouch.smsgateway.R

/**
 * One-time screen guiding user to disable battery optimization
 * for reliable background SMS relay.
 */
class BatteryOptActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_battery_opt)

        val prefs = (application as GatewayApp).securePrefs

        findViewById<Button>(R.id.btnOpenSettings).setOnClickListener {
            prefs.batteryOptShown = true
            try {
                val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = Uri.parse("package:$packageName")
                }
                startActivity(intent)
            } catch (_: Exception) {
                // Fallback to battery settings
                startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            }
            finish()
        }

        findViewById<Button>(R.id.btnSkip).setOnClickListener {
            prefs.batteryOptShown = true
            finish()
        }

        // Auto-skip if already ignoring battery optimizations
        val pm = getSystemService(PowerManager::class.java)
        if (pm?.isIgnoringBatteryOptimizations(packageName) == true) {
            prefs.batteryOptShown = true
            finish()
        }
    }
}
