package app.mysignet

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Re-arm the bunker service after boot or app self-update (Charter pattern). */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED -> {
                val prefs = context.getSharedPreferences("signet_bunker_service", Context.MODE_PRIVATE)
                if (prefs.getBoolean("enabled", false)) {
                    val pubkeys = prefs.getString("pubkeysCsv", "") ?: ""
                    val relay = prefs.getString("relayUrl", "") ?: ""
                    if (relay.isNotEmpty()) BunkerForegroundService.start(context, pubkeys, relay)
                }
            }
        }
    }
}
