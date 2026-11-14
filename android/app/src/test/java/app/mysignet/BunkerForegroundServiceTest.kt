package app.mysignet

import android.app.Application
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Looper
import android.os.PowerManager
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ServiceController
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import org.robolectric.shadows.ShadowPowerManager
import org.robolectric.shadow.api.Shadow
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
@LooperMode(LooperMode.Mode.PAUSED)
class BunkerForegroundServiceTest {
    private lateinit var context: Application
    private var controller: ServiceController<BunkerForegroundService>? = null
    private val relay = "wss://relay.example.com"

    @Before fun setUp() {
        context = RuntimeEnvironment.getApplication()
        BunkerForegroundService.stop(context)
        context.getSharedPreferences(BunkerForegroundService.PREFS, Context.MODE_PRIVATE).edit().clear().commit()
    }

    @After fun tearDown() {
        controller?.destroy()
        BunkerForegroundService.stop(context)
        shadowOf(Looper.getMainLooper()).idle()
    }

    private fun createService() {
        controller = Robolectric.buildService(BunkerForegroundService::class.java).create().startCommand(0, 1)
    }

    private fun wakeLock(): PowerManager.WakeLock = ShadowPowerManager.getLatestWakeLock()
    private fun fallback(): JobInfo? = context.getSystemService(JobScheduler::class.java)
        .getPendingJob(BunkerFallbackJobService.JOB_ID)
    private fun advance(ms: Long) = shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(ms))
    private fun notifications() = shadowOf(context.getSystemService(NotificationManager::class.java)).allNotifications
    private fun postedText(n: Notification, key: String): String? = n.extras.getCharSequence(key)?.toString()
    private fun enabled() = context.getSharedPreferences(BunkerForegroundService.PREFS, Context.MODE_PRIVATE).getBoolean("enabled", false)
    private fun beat() {
        BunkerForegroundService.heartbeat(context, "pubkey", relay)
        shadowOf(Looper.getMainLooper()).idle()
    }

    @Test fun `boot stays asleep and schedules a network constrained fallback`() {
        BunkerForegroundService.start(context, "pubkey", relay, fromBoot = true)
        createService()
        assertFalse(wakeLock().isHeld)
        assertFalse(BunkerForegroundService.isServingPersistently(context))
        assertEquals(JobInfo.NETWORK_TYPE_ANY, fallback()!!.networkType)
        assertTrue(fallback()!!.intervalMillis >= 15 * 60_000L)
        assertEquals(JobInfo.BACKOFF_POLICY_EXPONENTIAL, fallback()!!.backoffPolicy)
        // Required for network-constrained jobs when targeting Android 14+.
        assertEquals(PackageManager.PERMISSION_GRANTED,
            context.packageManager.checkPermission(android.Manifest.permission.ACCESS_NETWORK_STATE, context.packageName))
    }

    @Test fun `a sticky process restart cannot borrow a heartbeat from before process death`() {
        context.getSharedPreferences(BunkerForegroundService.PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean("enabled", true).putString("pubkeysCsv", "pubkey").putString("relayUrl", relay).commit()
        createService()
        assertFalse(wakeLock().isHeld)
        assertNotNull(fallback())
    }

    @Test fun `fresh heartbeats keep signing alive and their loss releases the lock`() {
        BunkerForegroundService.start(context, "pubkey", relay)
        createService()
        repeat(6) {
            advance(20_000)
            beat()
            assertTrue(wakeLock().isHeld)
            assertNull(fallback())
        }
        advance(89_999)
        assertTrue(wakeLock().isHeld)
        advance(1)
        assertFalse(wakeLock().isHeld)
        assertFalse(BunkerForegroundService.isServingPersistently(context))
        assertNotNull(fallback())
    }

    @Test fun `page closure releases immediately even after multiple renewals`() {
        BunkerForegroundService.start(context, "pubkey", relay)
        createService()
        repeat(5) { beat() }
        BunkerForegroundService.pageClosed(context)
        shadowOf(Looper.getMainLooper()).idle()
        assertFalse(wakeLock().isHeld)
        assertFalse(BunkerForegroundService.isServingPersistently(context))
        assertNotNull(fallback())
    }

    @Test fun `a recovered heartbeat reacquires the lock and cancels fallback`() {
        BunkerForegroundService.start(context, "pubkey", relay, fromBoot = true)
        createService()
        beat()
        assertTrue(wakeLock().isHeld)
        assertNull(fallback())
        advance(90_000)
        assertFalse(wakeLock().isHeld)
        beat()
        assertTrue(wakeLock().isHeld)
        assertNull(fallback())
    }

    @Test fun `unlock re-arms an existing service without recreating it`() {
        BunkerForegroundService.start(context, "pubkey", relay, fromBoot = true)
        createService()
        BunkerForegroundService.start(context, "pubkey", relay)
        controller!!.startCommand(0, 2)
        assertTrue(wakeLock().isHeld)
        assertNull(fallback())
    }

    @Test fun `temporary serving expires without persistent heartbeats or fallback`() {
        BunkerForegroundService.startTemporary(context, 120_000)
        createService()
        advance(90_000)
        assertTrue(wakeLock().isHeld)
        beat() // A stray heartbeat must not extend the user's deadline.
        advance(30_000)
        assertFalse(wakeLock().isHeld)
        assertTrue(shadowOf(controller!!.get()).isStoppedBySelf)
        assertNull(fallback())
        assertFalse(BunkerForegroundService.isAlwaysOn(context))
    }

    @Test fun `closing a temporary page releases it immediately`() {
        BunkerForegroundService.startTemporary(context, 120_000)
        createService()
        BunkerForegroundService.pageClosed(context)
        shadowOf(Looper.getMainLooper()).idle()
        assertFalse(wakeLock().isHeld)
        assertTrue(shadowOf(controller!!.get()).isStoppedBySelf)
        assertNull(fallback())
    }

    @Test fun `temporary stop does not interrupt persistent serving`() {
        BunkerForegroundService.start(context, "pubkey", relay)
        createService()
        BunkerForegroundService.stopTemporary(context)
        assertTrue(wakeLock().isHeld)
        assertTrue(BunkerForegroundService.isAlwaysOn(context))
    }

    @Test fun `destruction releases the lease and stop cancels pending checks`() {
        BunkerForegroundService.start(context, "pubkey", relay)
        createService()
        val lock = wakeLock()
        controller!!.destroy()
        controller = null
        assertFalse(lock.isHeld)
        BunkerForegroundService.pageClosed(context)
        BunkerFallbackJobService.schedule(context)
        BunkerForegroundService.stop(context)
        assertNull(fallback())
    }

    @Test fun `fallback scheduling is idempotent`() {
        BunkerFallbackJobService.schedule(context)
        val job = fallback()
        BunkerFallbackJobService.schedule(context)
        assertEquals(job, fallback())
    }

    @Test fun `fallback does no network work while disabled or signing live`() {
        val job = Robolectric.buildService(BunkerFallbackJobService::class.java).create()
        val params = Shadow.newInstanceOf(JobParameters::class.java)
        assertFalse(job.get().onStartJob(params))
        BunkerForegroundService.start(context, "pubkey", relay)
        createService()
        assertFalse(job.get().onStartJob(params))
        job.destroy()
    }

    @Test fun `closing the page when nothing needs the phone is quiet and keeps always on chosen`() {
        BunkerForegroundService.start(context, "pubkey", relay)
        BunkerForegroundService.setDependence(context, false, "", "")
        createService()
        beat()
        BunkerForegroundService.pageClosed(context)
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(notifications().isEmpty())
        assertTrue(enabled())
        assertNull(fallback())
        assertNotNull(shadowOf(context).nextStoppedService)
        // Robolectric does not run onDestroy for stopService; the system would.
        controller!!.destroy()
        controller = null
        shadowOf(Looper.getMainLooper()).idle()
        assertFalse(wakeLock().isHeld)
        assertTrue(notifications().isEmpty())
    }

    @Test fun `closing the page when something needs the phone alerts with the stored copy`() {
        BunkerForegroundService.start(context, "pubkey", relay)
        BunkerForegroundService.setDependence(context, true, "Signet stopped signing", "Amethyst can't reach Signet until you open and unlock it.")
        createService()
        beat()
        BunkerForegroundService.pageClosed(context)
        shadowOf(Looper.getMainLooper()).idle()
        val all = notifications()
        val alert = all.single { postedText(it, Notification.EXTRA_TITLE) == "Signet stopped signing" }
        assertEquals("Amethyst can't reach Signet until you open and unlock it.", postedText(alert, Notification.EXTRA_TEXT))
        val ongoing = all.single { postedText(it, Notification.EXTRA_TITLE) == "Signet isn't signing right now" }
        assertEquals("Amethyst can't reach Signet until you open and unlock it.", postedText(ongoing, Notification.EXTRA_TEXT))
        assertTrue(enabled())
        assertNotNull(fallback())
    }

    @Test fun `closing the page with no service running posts the alert but no ongoing notification`() {
        // After a quiet stop `enabled` is still set and no service is behind it.
        BunkerForegroundService.start(context, "pubkey", relay)
        BunkerForegroundService.setDependence(context, true, "Signet stopped signing", "Kid can't reach Signet until you open and unlock it.")
        BunkerForegroundService.pageClosed(context)
        shadowOf(Looper.getMainLooper()).idle()
        val all = notifications()
        assertEquals(1, all.size)
        assertEquals("Signet stopped signing", postedText(all[0], Notification.EXTRA_TITLE))
        assertEquals(0, all[0].flags and Notification.FLAG_ONGOING_EVENT)
    }

    @Test fun `absent dependence prefs behave as needed`() {
        BunkerForegroundService.start(context, "pubkey", relay)
        createService()
        beat()
        BunkerForegroundService.pageClosed(context)
        shadowOf(Looper.getMainLooper()).idle()
        val alert = notifications().single { postedText(it, Notification.EXTRA_TITLE) == "Signet isn't signing" }
        assertEquals("Tap to open and unlock Signet so it can sign again.", postedText(alert, Notification.EXTRA_TEXT))
        assertNotNull(fallback())
    }

    @Test fun `a stale heartbeat with nothing needing the phone posts no alert and schedules no job`() {
        BunkerForegroundService.start(context, "pubkey", relay)
        BunkerForegroundService.setDependence(context, false, "", "")
        createService()
        beat()
        advance(90_000)
        assertFalse(wakeLock().isHeld)
        assertNull(fallback())
        val all = notifications()
        assertEquals(1, all.size)
        assertEquals("Signet is on standby", postedText(all[0], Notification.EXTRA_TITLE))
        assertEquals("Nothing needs it right now", postedText(all[0], Notification.EXTRA_TEXT))
        assertFalse(shadowOf(controller!!.get()).isStoppedBySelf)
        beat()
        assertTrue(wakeLock().isHeld)
        assertEquals("Signet bunker is serving", postedText(notifications().single(), Notification.EXTRA_TITLE))
    }

    @Test fun `a restart with no page and nothing needing the phone stops itself quietly`() {
        context.getSharedPreferences(BunkerForegroundService.PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean("enabled", true).putBoolean("dependNeeded", false)
            .putString("pubkeysCsv", "pubkey").putString("relayUrl", relay).commit()
        createService()
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(shadowOf(controller!!.get()).isStoppedBySelf)
        assertTrue(notifications().isEmpty())
        assertNull(fallback())
        assertTrue(enabled())
    }

    @Test fun `flipping to not needed while the alert is up clears it`() {
        BunkerForegroundService.start(context, "pubkey", relay)
        createService()
        beat()
        BunkerForegroundService.pageClosed(context)
        shadowOf(Looper.getMainLooper()).idle()
        assertNotNull(fallback())
        assertEquals(2, notifications().size)
        BunkerForegroundService.setDependence(context, false, "", "")
        shadowOf(Looper.getMainLooper()).idle()
        assertNull(fallback())
        assertTrue(notifications().none { postedText(it, Notification.EXTRA_TITLE) == "Signet isn't signing" })
    }

    @Test fun `boot starts the service only when something needs the phone`() {
        val prefs = context.getSharedPreferences(BunkerForegroundService.PREFS, Context.MODE_PRIVATE)
        prefs.edit().putBoolean("enabled", true).putString("pubkeysCsv", "pubkey").putString("relayUrl", relay)
            .putBoolean("dependNeeded", false).commit()
        BootReceiver().onReceive(context, Intent(Intent.ACTION_BOOT_COMPLETED))
        assertNull(shadowOf(context).nextStartedService)
        prefs.edit().putBoolean("dependNeeded", true).commit()
        BootReceiver().onReceive(context, Intent(Intent.ACTION_BOOT_COMPLETED))
        assertNotNull(shadowOf(context).nextStartedService)
        prefs.edit().remove("dependNeeded").commit()
        BootReceiver().onReceive(context, Intent(Intent.ACTION_BOOT_COMPLETED))
        assertNotNull(shadowOf(context).nextStartedService)
    }
}
