package app.mysignet

import android.app.Application
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.content.Context
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
}
