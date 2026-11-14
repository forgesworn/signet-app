package app.mysignet

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.Build
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
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
 *  3. Fallback: in that state, let JobScheduler check for waiting requests
 *     with network access and a system-managed wake lock only during a check.
 */
class BunkerForegroundService : Service() {

    companion object {
        private const val CHANNEL_FGS = "signet-bunker"
        private const val CHANNEL_ALERTS = "signet-requests"
        private const val NOTIF_FGS_ID = 1001
        private const val NOTIF_REQUEST_ID = 2001
        private const val NOTIF_UNLOCK_ID = 2002
        private const val HEARTBEAT_STALE_MS = 90_000L
        internal const val PREFS = "signet_bunker_service"

        @Volatile private var temporaryUntilMs: Long = 0
        @Volatile private var lastHeartbeatMs: Long = -1
        private val unlockAlerted = AtomicBoolean(false)
        /** The quiet "on standby" ongoing notification is the one showing. */
        private val standbyShown = AtomicBoolean(false)
        /**
         * A page has run since this process started (cleared when the page closes).
         * A sticky restart or a boot has none, which is what lets a not-needed
         * service stop itself instead of idling.
         */
        @Volatile private var pageAlive = false

        private const val KEY_NEEDED = "dependNeeded"
        private const val KEY_TITLE = "dependTitle"
        private const val KEY_TEXT = "dependText"
        private const val DEFAULT_TITLE = "Signet isn't signing"
        private const val DEFAULT_TEXT = "Tap to open and unlock Signet so it can sign again."
        @Volatile private var liveService: BunkerForegroundService? = null

        private fun refreshLiveService() {
            val service = liveService ?: return
            service.mainHandler.post {
                if (liveService === service) service.refreshPowerState()
            }
        }

        /**
         * `fromBoot`: nothing has unlocked yet, so the service starts in the
         * "locked — not signing" state instead of assuming a live page.
         */
        fun start(context: Context, pubkeys: String, relay: String, fromBoot: Boolean = false) {
            temporaryUntilMs = 0
            lastHeartbeatMs = if (fromBoot) -1 else SystemClock.elapsedRealtime()
            if (!fromBoot) pageAlive = true
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putBoolean("enabled", true)
                .putString("pubkeysCsv", pubkeys)
                .putString("relayUrl", relay)
                .apply()
            val intent = Intent(context, BunkerForegroundService::class.java)
            ContextCompat.startForegroundService(context, intent)
        }

        fun startTemporary(context: Context, durationMs: Long) {
            // An explicit always-on setting takes precedence over a short handoff.
            if (context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("enabled", false)) return
            lastHeartbeatMs = SystemClock.elapsedRealtime()
            temporaryUntilMs = SystemClock.elapsedRealtime() + durationMs.coerceIn(1L, 30 * 60_000L)
            ContextCompat.startForegroundService(context, Intent(context, BunkerForegroundService::class.java))
        }

        fun stopTemporary(context: Context) {
            temporaryUntilMs = 0
            if (!context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("enabled", false)) {
                context.stopService(Intent(context, BunkerForegroundService::class.java))
            }
        }

        fun stop(context: Context) {
            temporaryUntilMs = 0
            lastHeartbeatMs = -1
            pageAlive = false
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putBoolean("enabled", false).apply()
            BunkerFallbackJobService.cancel(context)
            unlockAlerted.set(false)
            standbyShown.set(false)
            (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTIF_UNLOCK_ID)
            context.stopService(Intent(context, BunkerForegroundService::class.java))
        }

        fun heartbeat(context: Context, pubkeys: String, relay: String) {
            lastHeartbeatMs = SystemClock.elapsedRealtime()
            pageAlive = true
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
            refreshLiveService()
        }

        private fun isPersistent(context: Context): Boolean =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("enabled", false)

        private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

        /** Whether anything depends on this phone. Absent (upgrade, nothing stored yet) means yes. */
        internal fun isDependenceNeeded(context: Context): Boolean = prefs(context).getBoolean(KEY_NEEDED, true)

        private fun dependTitle(context: Context): String =
            prefs(context).getString(KEY_TITLE, null)?.takeIf { it.isNotBlank() } ?: DEFAULT_TITLE

        private fun dependText(context: Context): String =
            prefs(context).getString(KEY_TEXT, null)?.takeIf { it.isNotBlank() } ?: DEFAULT_TEXT

        /**
         * The page tells the service whether anything depends on this phone and
         * what to say if it stops. Absent means needed.
         */
        @JvmStatic fun setDependence(context: Context, needed: Boolean, title: String, text: String) {
            prefs(context).edit()
                .putBoolean(KEY_NEEDED, needed)
                .putString(KEY_TITLE, title)
                .putString(KEY_TEXT, text)
                .apply()
            // The call only comes from a running page.
            pageAlive = true
            if (!isPersistent(context)) return
            if (!needed) {
                val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                nm.cancel(NOTIF_UNLOCK_ID)
                BunkerFallbackJobService.cancel(context)
                unlockAlerted.set(false)
            }
            refreshLiveService()
        }

        /**
         * Stop without a word. `enabled` stays set: Always on is still the user's
         * choice and the page re-arms it on the next unlock.
         */
        private fun quietStopState(context: Context) {
            lastHeartbeatMs = -1
            temporaryUntilMs = 0
            unlockAlerted.set(false)
            standbyShown.set(false)
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.cancel(NOTIF_UNLOCK_ID)
            nm.cancel(NOTIF_FGS_ID)
            BunkerFallbackJobService.cancel(context)
        }

        private fun heartbeatRemainingMs(): Long {
            val at = lastHeartbeatMs
            if (at < 0) return 0
            return (HEARTBEAT_STALE_MS - (SystemClock.elapsedRealtime() - at)).coerceIn(0, HEARTBEAT_STALE_MS)
        }

        private fun heartbeatFresh(): Boolean = heartbeatRemainingMs() > 0

        /** The persistent always-on setting is on. */
        @JvmStatic fun isAlwaysOn(context: Context): Boolean = isPersistent(context)

        /**
         * The serving page has gone (app swiped away). Nothing signs until
         * the app is opened and unlocked again; say so straight away.
         */
        @JvmStatic fun pageClosed(context: Context) {
            lastHeartbeatMs = -1
            temporaryUntilMs = 0
            pageAlive = false
            if (isPersistent(context)) {
                if (!isDependenceNeeded(context)) {
                    // Nothing depends on this phone: close without a notification.
                    // No refreshLiveService() here: it would queue a refresh on the
                    // service being stopped, which would post the ongoing one again.
                    quietStopState(context)
                    context.stopService(Intent(context, BunkerForegroundService::class.java))
                    return
                }
                standbyShown.set(false)
                unlockAlerted.set(true)
                val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                // The ongoing notification belongs to a running service. After a quiet stop
                // `enabled` is still set with none behind it, and nothing would clear this.
                if (liveService != null) nm.notify(NOTIF_FGS_ID, fgsNotification(context, FgsState.NOT_SIGNING))
                postUnlockAlert(context)
            }
            refreshLiveService()
        }

        @JvmStatic fun isServingPersistently(context: Context): Boolean = isPersistent(context) && heartbeatFresh()

        /** Ongoing notification + unlock alert for the current state. */
        private fun showServingState(context: Context, serving: Boolean) {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.notify(NOTIF_FGS_ID, fgsNotification(context, if (serving) FgsState.SERVING else FgsState.NOT_SIGNING))
            if (serving) nm.cancel(NOTIF_UNLOCK_ID) else postUnlockAlert(context)
        }

        private enum class FgsState { SERVING, NOT_SIGNING, STANDBY }

        /** The ongoing notification's state for the persistent/heartbeat/dependence combination. */
        private fun currentFgsState(context: Context): FgsState = when {
            !isPersistent(context) || heartbeatFresh() -> FgsState.SERVING
            isDependenceNeeded(context) -> FgsState.NOT_SIGNING
            else -> FgsState.STANDBY
        }

        private fun launchIntent(context: Context): PendingIntent = PendingIntent.getActivity(
            context, 0,
            context.packageManager.getLaunchIntentForPackage(context.packageName),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        /** Notification channels exist from Android 8 (API 26); minSdk is 24, where only the channel id is ignored. */
        private fun ensureChannel(
            nm: NotificationManager, id: String, name: String, importance: Int, description: String,
            privateOnLockscreen: Boolean,
        ) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            nm.createNotificationChannel(
                NotificationChannel(id, name, importance).apply {
                    this.description = description
                    if (privateOnLockscreen) lockscreenVisibility = Notification.VISIBILITY_PRIVATE
                }
            )
        }

        private fun ensureAlertsChannel(nm: NotificationManager) = ensureChannel(
            nm, CHANNEL_ALERTS, "Signing requests", NotificationManager.IMPORTANCE_HIGH,
            "A child or connected app is waiting for your approval", privateOnLockscreen = true,
        )

        private fun fgsNotification(context: Context, state: FgsState): Notification {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            ensureChannel(nm, CHANNEL_FGS, "Bunker serving", NotificationManager.IMPORTANCE_LOW,
                "Keeps the Signet bunker reachable while the screen is off", privateOnLockscreen = false)
            val builder = NotificationCompat.Builder(context, CHANNEL_FGS)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setSmallIcon(R.drawable.ic_stat_signet)
                .setContentIntent(launchIntent(context))
                .setOngoing(true)
            when (state) {
                FgsState.SERVING -> builder.setContentTitle("Signet bunker is serving")
                    .setContentText("Signing requests are handled while Signet is closed")
                FgsState.NOT_SIGNING -> builder.setContentTitle("Signet isn't signing right now")
                    .setContentText(dependText(context))
                FgsState.STANDBY -> builder.setContentTitle("Signet is on standby")
                    .setContentText("Nothing needs it right now")
            }
            return builder.build()
        }

        private fun postUnlockAlert(
            context: Context,
            title: String = dependTitle(context),
            text: String = dependText(context),
        ) {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            ensureAlertsChannel(nm)
            nm.notify(
                NOTIF_UNLOCK_ID,
                NotificationCompat.Builder(context, CHANNEL_ALERTS)
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setContentTitle(title)
                    .setContentText(text)
                    .setSmallIcon(R.drawable.ic_stat_signet)
                    .setContentIntent(launchIntent(context))
                    .setAutoCancel(true)
                    .build()
            )
        }

        internal fun postRequestNotification(context: Context) {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            ensureAlertsChannel(nm)
            val tap = PendingIntent.getActivity(
                context, 0,
                context.packageManager.getLaunchIntentForPackage(context.packageName),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )
            nm.notify(
                NOTIF_REQUEST_ID,
                NotificationCompat.Builder(context, CHANNEL_ALERTS)
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setContentTitle("Signing request waiting")
                    .setContentText("Open Signet to review")
                    .setSmallIcon(R.drawable.ic_stat_signet)
                    .setContentIntent(tap)
                    .setAutoCancel(true)
                    .build()
            )
        }
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private lateinit var wakeLock: PowerManager.WakeLock
    private val leaseExpired = Runnable { refreshPowerState() }

    /** Main-thread only: every acquisition has a deadline, renewed by JS liveness. */
    private fun refreshPowerState() {
        mainHandler.removeCallbacks(leaseExpired)
        val persistent = isPersistent(this)
        val remaining = if (persistent) heartbeatRemainingMs()
            else (temporaryUntilMs - SystemClock.elapsedRealtime()).coerceAtLeast(0)
        if (remaining > 0) {
            wakeLock.acquire(remaining)
            mainHandler.postDelayed(leaseExpired, remaining)
            BunkerFallbackJobService.cancel(this)
            if (persistent) {
                val wasAlerted = unlockAlerted.compareAndSet(true, false)
                val wasStandby = standbyShown.compareAndSet(true, false)
                if (wasAlerted || wasStandby) showServingState(this, serving = true)
            }
        } else {
            if (wakeLock.isHeld) wakeLock.release()
            if (persistent) {
                val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                if (isDependenceNeeded(this)) {
                    standbyShown.set(false)
                    if (unlockAlerted.compareAndSet(false, true)) showServingState(this, serving = false)
                    else nm.notify(NOTIF_FGS_ID, fgsNotification(this, FgsState.NOT_SIGNING))
                    BunkerFallbackJobService.schedule(this)
                } else if (pageAlive) {
                    // Page running but locked or its socket down, and nothing needs it:
                    // no alert and no fallback checks; the page heartbeats again on its own.
                    unlockAlerted.set(false)
                    nm.cancel(NOTIF_UNLOCK_ID)
                    BunkerFallbackJobService.cancel(this)
                    standbyShown.set(true)
                    nm.notify(NOTIF_FGS_ID, fgsNotification(this, FgsState.STANDBY))
                } else {
                    // Sticky restart or boot with nothing depending on this phone.
                    quietStopState(this)
                    stopSelf()
                }
            } else {
                BunkerFallbackJobService.cancel(this)
                stopSelf()
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        startForeground(NOTIF_FGS_ID, fgsNotification(this, currentFgsState(this)))
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "signet:bunker").apply {
            // Heartbeats extend one lease; they must not accumulate acquisitions.
            setReferenceCounted(false)
        }
        liveService = this
        refreshPowerState()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Also handles re-arming an existing, sleeping service after unlock.
        refreshPowerState()
        return if (isPersistent(this)) START_STICKY else START_NOT_STICKY
    }

    override fun onDestroy() {
        if (liveService === this) liveService = null
        mainHandler.removeCallbacksAndMessages(null)
        if (wakeLock.isHeld) wakeLock.release()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
