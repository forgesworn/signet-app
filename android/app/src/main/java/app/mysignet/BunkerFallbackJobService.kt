package app.mysignet

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.os.Handler
import android.os.Looper
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

/** Blind request alerts while locked. Android holds a wake lock only during each job. */
class BunkerFallbackJobService : JobService() {
    companion object {
        internal const val JOB_ID = 2003
        private const val POLL_INTERVAL_MS = 15 * 60_000L
        private const val POLL_LOOKBACK_S = 48 * 3600L
        private val http = OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(8, TimeUnit.SECONDS)
            .build()

        fun schedule(context: Context) {
            val scheduler = context.getSystemService(JobScheduler::class.java)
            // Do not reset the next check every time the service is started.
            if (scheduler.getPendingJob(JOB_ID) != null) return
            scheduler.schedule(JobInfo.Builder(JOB_ID, ComponentName(context, BunkerFallbackJobService::class.java))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPeriodic(POLL_INTERVAL_MS)
                .setBackoffCriteria(POLL_INTERVAL_MS, JobInfo.BACKOFF_POLICY_EXPONENTIAL)
                .build())
        }

        fun cancel(context: Context) {
            context.getSystemService(JobScheduler::class.java).cancel(JOB_ID)
        }
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private var work: Poll? = null

    override fun onStartJob(params: JobParameters): Boolean {
        if (!BunkerForegroundService.isAlwaysOn(this) || BunkerForegroundService.isServingPersistently(this)) return false
        val prefs = getSharedPreferences(BunkerForegroundService.PREFS, Context.MODE_PRIVATE)
        val pubkeys = prefs.getString("pubkeysCsv", "") ?: ""
        val relay = prefs.getString("relayUrl", "") ?: ""
        if (pubkeys.isEmpty() || !relay.startsWith("wss://")) return false
        val poll = Poll(params, pubkeys, relay)
        work = poll
        poll.thread.start()
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean {
        work?.cancel()
        work = null
        return BunkerForegroundService.isAlwaysOn(this) && !BunkerForegroundService.isServingPersistently(this)
    }

    override fun onDestroy() {
        work?.cancel()
        work = null
        mainHandler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    private inner class Poll(val params: JobParameters, val pubkeys: String, val relay: String) {
        val cancelled = AtomicBoolean(false)
        val done = CountDownLatch(1)
        @Volatile var socket: WebSocket? = null
        val thread = Thread({ run() }, "signet-bunker-poll")

        fun cancel() {
            cancelled.set(true)
            socket?.cancel()
            done.countDown()
            thread.interrupt()
        }

        fun run() {
            val sawEvent = AtomicBoolean(false)
            val completed = AtomicBoolean(false)
            val now = System.currentTimeMillis() / 1000
            try {
                val prefs = getSharedPreferences(BunkerForegroundService.PREFS, Context.MODE_PRIVATE)
                val cursor = prefs.getLong("cursor", 0).coerceAtLeast(now - POLL_LOOKBACK_S)
                val filter = JSONObject()
                    .put("kinds", JSONArray().put(24133))
                    .put("#p", JSONArray().apply { pubkeys.split(',').filter { it.isNotEmpty() }.forEach { put(it) } })
                    .put("since", cursor)
                val req = JSONArray().put("REQ").put("fb").put(filter).toString()
                if (cancelled.get()) return
                socket = http.newWebSocket(Request.Builder().url(relay).build(), object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) { webSocket.send(req) }
                    override fun onMessage(webSocket: WebSocket, text: String) {
                        try {
                            when (JSONArray(text).optString(0)) {
                                "EVENT" -> sawEvent.set(true)
                                "EOSE" -> { completed.set(true); done.countDown() }
                            }
                        } catch (_: Exception) { /* ignore malformed relay messages */ }
                    }
                    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { done.countDown() }
                    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { done.countDown() }
                })
                if (!cancelled.get()) done.await(8, TimeUnit.SECONDS)
            } catch (_: Exception) {
                // JobScheduler backs off failures and waits for a usable network.
            } finally {
                socket?.cancel()
                mainHandler.post {
                    if (work === this && !cancelled.get()) {
                        work = null
                        val waiting = BunkerForegroundService.isAlwaysOn(this@BunkerFallbackJobService) &&
                            !BunkerForegroundService.isServingPersistently(this@BunkerFallbackJobService)
                        if (waiting && sawEvent.get()) {
                            if (completed.get()) getSharedPreferences(BunkerForegroundService.PREFS, Context.MODE_PRIVATE)
                                .edit().putLong("cursor", now).apply()
                            BunkerForegroundService.postRequestNotification(this@BunkerFallbackJobService)
                        }
                        jobFinished(params, waiting && !completed.get())
                    }
                }
            }
        }
    }
}
