package co.getouch.smsgateway.ui

import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.*
import androidx.appcompat.app.AppCompatActivity
import co.getouch.smsgateway.GatewayApp
import co.getouch.smsgateway.R
import co.getouch.smsgateway.data.EventLogger
import co.getouch.smsgateway.network.ApiClient
import co.getouch.smsgateway.network.ApiResult
import co.getouch.smsgateway.service.GatewayForegroundService
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.*
import org.json.JSONObject

class PairingActivity : AppCompatActivity() {

    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private lateinit var prefs: co.getouch.smsgateway.data.SecurePrefs

    // Views
    private lateinit var serverUrlInput: EditText
    private lateinit var tokenInput: EditText
    private lateinit var connectButton: Button
    private lateinit var scanQrButton: Button
    private lateinit var progressBar: ProgressBar
    private lateinit var statusText: TextView
    private lateinit var manualSection: View

    // QR scanner launcher
    private val qrLauncher = registerForActivityResult(ScanContract()) { result ->
        if (result.contents != null) {
            handleQrResult(result.contents)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_pairing)

        prefs = (application as GatewayApp).securePrefs

        serverUrlInput = findViewById(R.id.inputServerUrl)
        tokenInput = findViewById(R.id.inputToken)
        connectButton = findViewById(R.id.btnConnect)
        scanQrButton = findViewById(R.id.btnScanQr)
        progressBar = findViewById(R.id.pairingProgress)
        statusText = findViewById(R.id.pairingStatus)
        manualSection = findViewById(R.id.manualSection)

        // Defaults
        serverUrlInput.setText("https://sms.getouch.co")

        scanQrButton.setOnClickListener {
            val options = ScanOptions().apply {
                setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                setPrompt("Scan the device QR code from Getouch Admin")
                setBeepEnabled(false)
                setOrientationLocked(true)
                setCameraId(0)
            }
            qrLauncher.launch(options)
        }

        connectButton.setOnClickListener {
            val url = serverUrlInput.text.toString().trimEnd('/')
            val token = tokenInput.text.toString().trim()
            if (url.isBlank() || token.isBlank()) {
                statusText.text = "Please enter server URL and token"
                statusText.visibility = View.VISIBLE
                return@setOnClickListener
            }
            doPairing(url, token)
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    /**
     * Handle QR code content.
     * Expected format: JSON { "server": "https://sms.getouch.co", "token": "...", "device_id": "..." }
     * Or just the raw token string.
     */
    private fun handleQrResult(content: String) {
        try {
            val json = JSONObject(content)
            val server = json.optString("server", "https://sms.getouch.co").trimEnd('/')
            val token = json.optString("token", "")

            if (token.isBlank()) {
                statusText.text = "QR code doesn't contain a valid token"
                return
            }

            serverUrlInput.setText(server)
            tokenInput.setText(token)
            doPairing(server, token)

        } catch (_: Exception) {
            // Treat as raw token
            tokenInput.setText(content.trim())
            statusText.text = "Token scanned. Tap Connect to pair."
        }
    }

    private fun doPairing(serverUrl: String, deviceToken: String) {
        setLoading(true)
        statusText.text = "Connecting to server…"
        statusText.visibility = View.VISIBLE

        val deviceInfo = mapOf(
            "model" to "${Build.MANUFACTURER} ${Build.MODEL}",
            "android_version" to "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})",
            "app_version" to getAppVersion()
        )

        scope.launch {
            val apiClient = ApiClient(prefs)
            val result = withContext(Dispatchers.IO) {
                apiClient.pair(serverUrl, deviceToken, deviceInfo)
            }

            when (result) {
                is ApiResult.Success -> {
                    val data = result.data
                    prefs.serverUrl = serverUrl
                    prefs.deviceToken = deviceToken
                    prefs.deviceId = data.device_id
                    prefs.deviceName = data.device_name
                    prefs.tenantName = data.tenant_name
                    prefs.isPaired = true

                    statusText.text = "Paired! Device: ${data.device_name}"
                    EventLogger.info("Pairing", "Paired as ${data.device_name} (tenant: ${data.tenant_name})")

                    // Start the gateway service
                    GatewayForegroundService.start(this@PairingActivity)

                    delay(1000)

                    // Show battery optimization guide if not shown
                    if (!prefs.batteryOptShown) {
                        startActivity(android.content.Intent(
                            this@PairingActivity,
                            BatteryOptActivity::class.java
                        ))
                    }

                    finish()
                }
                is ApiResult.Error -> {
                    setLoading(false)
                    statusText.text = "Pairing failed: ${result.message}"
                    EventLogger.error("Pairing", "Failed: ${result.message}")
                }
            }
        }
    }

    private fun setLoading(loading: Boolean) {
        progressBar.visibility = if (loading) View.VISIBLE else View.GONE
        connectButton.isEnabled = !loading
        scanQrButton.isEnabled = !loading
    }

    private fun getAppVersion(): String {
        return try {
            packageManager.getPackageInfo(packageName, 0).versionName ?: "1.0.0"
        } catch (_: Exception) { "1.0.0" }
    }
}
