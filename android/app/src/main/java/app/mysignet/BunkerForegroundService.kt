package app.mysignet

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Foreground service for always-on bunker serving (GrapheneOS-first: no
 * FCM). Three duties:
 *  1. Keep the process + WebView alive (FGS + partial wake lock) so the
 *     JS NIP-46 server keeps signing with the screen off (MainActivity also
 *     keeps the page from being frozen). Swiping the app away ends the page;
 *     that is reported at once (pageClosed).
 *  2. When nothing is serving (boot, process restart, locked, relay socket
 *     not open — JS heartbeat stale), say so: the ongoing notification changes and a one-off
 *     "tap to unlock" alert is posted. Nothing signs before an unlock; no
 *     key is held at rest without the PIN or biometric.
 *  3. Fallback: in that state, poll the relay directly and post a blind
 *     "request waiting" notification (Charter warden pattern).
 */
class BunkerForegroundService : Service() {

    companion object {
        private const val CHANNEL_FGS = "signet-bunker"
        private const val CHANNEL_ALERTS = "signet-requests"
        private const val NOTIF_FGS_ID = 1001
        private const val NOTIF_REQUEST_ID = 2001
        private const val NOTIF_UNLOCK_ID = 2002
        private const val SLOW_TICK_MS = 60_000L
        private const val HEARTBEAT_STALE_MS = 90_000L
        private const val POLL_LOOKBACK_S = 48 * 3600L
        private const val PREFS = "signet_bunker_service"

        @Volatile private var temporaryUntilMs: Long = 0
        @Volatile private var lastHeartbeatMs: Long = 0
        @Volatile private var pubkeysCsv: String = ""
        @Volatile private var relayUrl: String = ""
        private val unlockAlerted = AtomicBoolean(false)

        /**
         * `fromBoot`: nothing has unlocked yet, so the service starts in the
         * "locked — not signing" state instead of assuming a live page.
         */
        fun start(context: Context, pubkeys: String, relay: String, fromBoot: Boolean = false) {
            temporaryUntilMs = 0
            pubkeysCsv = pubkeys
            relayUrl = relay
            lastHeartbeatMs = if (fromBoot) 0 else System.currentTimeMillis()
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putBoolean("enabled", true)
                .putString("pubkeysCsv", pubkeys)
                .putString("relayUrl", relay)
                .apply()
            val intent = Intent(context, BunkerForegroundService::class.java)
            context.startForegroundService(intent)
        }

        fun startTemporary(context: Context, pubkeys: String, relay: String, durationMs: Long) {
            // An explicit always-on setting takes precedence over a short handoff.
            if (context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("enabled", false)) return
            pubkeysCsv = pubkeys
            relayUrl = relay
            lastHeartbeatMs = System.currentTimeMillis()
            temporaryUntilMs = SystemClock.elapsedRealtime() + durationMs.coerceIn(1L, 30 * 60_000L)
            context.startForegroundService(Intent(context, BunkerForegroundService::class.java))
        }

        fun stopTemporary(context: Context) {
            temporaryUntilMs = 0
            if (!context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("enabled", false)) {
                context.stopService(Intent(context, BunkerForegroundService::class.java))
            }
        }

        fun stop(context: Context) {
            temporaryUntilMs = 0
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putBoolean("enabled", false).apply()
            unlockAlerted.set(false)
            (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTIF_UNLOCK_ID)
            context.stopService(Intent(context, BunkerForegroundService::class.java))
        }

        fun heartbeat(context: Context, pubkeys: String, relay: String) {
            lastHeartbeatMs = System.currentTimeMillis()
            if (pubkeys.isNotEmpty()) pubkeysCsv = pubkeys
            if (relay.isNotEmpty()) relayUrl = relay
            // Keep the boot receiver's copy current: the set the service was
            // started with can predate the serve routes, and after a reboot
            // the fallback poll has only what is stored here.
            if (isPersistent(context) && (pubkeys.isNotEmpty() || relay.isNotEmpty())) {
                val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                val edit = prefs.edit()
                var changed = false
                if (pubkeys.isNotEmpty() && prefs.getString("pubkeysCsv", "") != pubkeys) { edit.putString("pubkeysCsv", pubkeys); changed = true }
                if (relay.isNotEmpty() && prefs.getString("relayUrl", "") != relay) { edit.putString("relayUrl", relay); changed = true }
                if (changed) edit.apply()
            }
            if (isPersistent(context) && unlockAlerted.compareAndSet(true, false)) {
                showServingState(context.applicationContext, serving = true)
            }
        }

        private fun isPersistent(context: Context): Boolean =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("enabled", false)

        private fun heartbeatFresh(): Boolean =
            System.currentTimeMillis() - lastHeartbeatMs <= HEARTBEAT_STALE_MS

        /** Always-on is set and an unlocked page is serving right now. */
        /** The persistent always-on setting is on. */
        @JvmStatic fun isAlwaysOn(context: Context): Boolean = isPersistent(context)

        /**
         * The serving page has gone (app swiped away). Nothing signs until
         * the app is opened and unlocked again; say so straight away.
         */
        @JvmStatic fun pageClosed(context: Context) {
            lastHeartbeatMs = 0
            unlockAlerted.set(true)
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.notify(NOTIF_FGS_ID, fgsNotification(context, serving = false))
            postUnlockAlert(context, "Signet stopped signing for your family", "Tap to turn it back on")
        }

        @JvmStatic fun isServingPersistently(context: Context): Boolean = isPersistent(context) && heartbeatFresh()

        /** Ongoing notification + unlock alert for the current state. */
        private fun showServingState(context: Context, serving: Boolean) {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.notify(NOTIF_FGS_ID, fgsNotification(context, serving))
            if (serving) nm.cancel(NOTIF_UNLOCK_ID) else postUnlockAlert(context)
        }

        private fun launchIntent(context: Context): PendingIntent = PendingIntent.getActivity(
            context, 0,
            context.packageManager.getLaunchIntentForPackage(context.packageName),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        private fun fgsNotification(context: Context, serving: Boolean): Notification {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_FGS, "Bunker serving", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Keeps the Signet bunker reachable while the screen is off"
                }
            )
            val builder = Notification.Builder(context, CHANNEL_FGS)
                .setSmallIcon(R.drawable.ic_stat_signet)
                .setContentIntent(launchIntent(context))
                .setOngoing(true)
            if (serving || !isPersistent(context)) {
                builder.setContentTitle("Signet bunker is serving")
                    .setContentText("Signing requests are handled while Signet is closed")
            } else {
                builder.setContentTitle("Signet isn't signing right now")
                    .setContentText("Tap to open and unlock Signet so it can sign for your family again")
            }
            return builder.build()
        }

        private fun postUnlockAlert(
            context: Context,
            title: String = "Signet isn't signing",
            text: String = "Tap to open and unlock Signet so it can sign for your family again",
        ) {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ALERTS, "Signing requests", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "A child or connected app is waiting for your approval"
                    lockscreenVisibility = Notification.VISIBILITY_PRIVATE
                }
            )
            nm.notify(
                NOTIF_UNLOCK_ID,
                Notification.Builder(context, CHANNEL_ALERTS)
                    .setContentTitle(title)
                    .setContentText(text)
                    .setSmallIcon(R.drawable.ic_stat_signet)
                    .setContentIntent(launchIntent(context))
                    .setAutoCancel(true)
                    .build()
            )
        }
    }

    private lateinit var worker: HandlerThread
    private lateinit var handler: Handler
    @Volatile private var running = false
    private var wakeLock: PowerManager.WakeLock? = null
    private val http = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .build()

    private val slowTick = object : Runnable {
        override fun run() {
            if (!running) return
            try {
                val enabled = getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("enabled", false)
                if (!enabled && temporaryUntilMs <= SystemClock.elapsedRealtime()) {
                    // Belt-and-braces: an orphaned service (e.g. after account
                    // deletion) winds itself down instead of ticking forever.
                    stopSelf()
                    return
                }
                val stale = !heartbeatFresh()
                if (enabled) {
                    if (stale && unlockAlerted.compareAndSet(false, true)) {
                        showServingState(this@BunkerForegroundService, serving = false)
                    } else if (!stale && unlockAlerted.compareAndSet(true, false)) {
                        showServingState(this@BunkerForegroundService, serving = true)
                    }
                }
                if (stale && pubkeysCsv.isNotEmpty() && relayUrl.startsWith("wss://")) {
                    pollOnce()
                }
            } catch (_: Throwable) {
                // never let a poll failure kill the loop
            }
            handler.postDelayed(this, SLOW_TICK_MS)
        }
    }

    override fun onCreate() {
        super.onCreate()
        val serving = heartbeatFresh()
        startForeground(NOTIF_FGS_ID, fgsNotification(this, serving))
        if (!serving && isPersistent(this) && unlockAlerted.compareAndSet(false, true)) {
            postUnlockAlert(this)
        }
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "signet:bunker").apply { acquire() }
        // Config survives process death via prefs (boot / restart path).
        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (pubkeysCsv.isEmpty()) pubkeysCsv = prefs.getString("pubkeysCsv", "") ?: ""
        if (relayUrl.isEmpty()) relayUrl = prefs.getString("relayUrl", "") ?: ""
        worker = HandlerThread("signet-bunker-worker").apply { start() }
        handler = Handler(worker.looper)
        running = true
        handler.postDelayed(slowTick, SLOW_TICK_MS)
    }

    private val expireTemporary = Runnable {
        if (temporaryUntilMs > 0 && temporaryUntilMs <= SystemClock.elapsedRealtime()) stopTemporary(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        handler.removeCallbacks(expireTemporary)
        if (temporaryUntilMs > 0) {
            handler.postDelayed(expireTemporary, (temporaryUntilMs - SystemClock.elapsedRealtime()).coerceAtLeast(0))
            return START_NOT_STICKY
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        try { wakeLock?.release() } catch (_: Throwable) {}
        worker.quitSafely()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    /** Connection-per-poll (Charter pattern): REQ, drain to EOSE or 8s, close. */
    private fun pollOnce() {
        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val now = System.currentTimeMillis() / 1000
        val cursor = prefs.getLong("cursor", 0).coerceAtLeast(now - POLL_LOOKBACK_S)
        val filter = JSONObject()
            .put("kinds", JSONArray().put(24133))
            .put("#p", JSONArray().apply { pubkeysCsv.split(',').filter { it.isNotEmpty() }.forEach { put(it) } })
            .put("since", cursor)
        val req = JSONArray().put("REQ").put("fb").put(filter).toString()

        var sawEvent = false
        val done = CountDownLatch(1)
        val ws = http.newWebSocket(
            Request.Builder().url(relayUrl).build(),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) { webSocket.send(req) }
                override fun onMessage(webSocket: WebSocket, text: String) {
                    try {
                        val arr = JSONArray(text)
                        when (arr.optString(0)) {
                            "EVENT" -> { sawEvent = true }
                            "EOSE" -> { done.countDown() }
                        }
                    } catch (_: Throwable) {}
                }
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { done.countDown() }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { done.countDown() }
            }
        )
        done.await(8, TimeUnit.SECONDS)
        ws.close(1000, null)
        if (sawEvent) {
            prefs.edit().putLong("cursor", now).apply()
            postRequestNotification()
        }
    }

    private fun postRequestNotification() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ALERTS, "Signing requests", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "A child or connected app is waiting for your approval"
                lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            }
        )
        val tap = PendingIntent.getActivity(
            this, 0,
            packageManager.getLaunchIntentForPackage(packageName),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        nm.notify(
            NOTIF_REQUEST_ID,
            Notification.Builder(this, CHANNEL_ALERTS)
                .setContentTitle("Signing request waiting")
                .setContentText("Open Signet to review")
                .setSmallIcon(R.drawable.ic_stat_signet)
                .setContentIntent(tap)
                .setAutoCancel(true)
                .build()
        )
    }
}
