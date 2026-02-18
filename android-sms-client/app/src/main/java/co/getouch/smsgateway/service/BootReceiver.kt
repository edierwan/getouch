package co.getouch.smsgateway.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import co.getouch.smsgateway.GatewayApp

/**
 * Restarts the foreground service after device reboot.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            val app = context.applicationContext as GatewayApp
            if (app.securePrefs.isPaired) {
                Log.d("BootReceiver", "Device booted, restarting SMS gateway service")
                GatewayForegroundService.start(context)
            }
        }
    }
}
