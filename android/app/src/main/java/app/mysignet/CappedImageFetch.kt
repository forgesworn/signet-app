package app.mysignet

import android.util.Base64
import com.getcapacitor.JSObject
import okhttp3.Call
import okhttp3.CookieJar
import okhttp3.Dns
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.Inet6Address
import java.net.InetAddress
import java.net.UnknownHostException
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * The APK leg of a contact-picture download (src/lib/picture-download.ts):
 * one image GET with a hard byte cap and a hard wall-clock deadline.
 *
 * - https only; no redirects (any 3xx is a failure, a redirect could hop to a
 *   host the JS SSRF guard never saw); no cookies, no cache, no credentials.
 * - IP-literal hosts are checked directly (OkHttp never sends them through Dns).
 * - The DNS answer must be a public address too (loopback, private,
 *   link-local, unique-local, CGNAT and multicast are refused), so a public
 *   name that resolves inward fails as well.
 * - A declared Content-Length over the cap is refused before reading; the
 *   body is read in chunks and abandoned the moment it passes the cap.
 * - connect/read timeouts, an OkHttp call timeout, and a deadline checked in
 *   the read loop. A watchdog answers "timeout" at the deadline (plus a short
 *   grace) even if the worker thread is stuck somewhere no timeout reaches,
 *   such as a DNS lookup, so the JS caller always gets its answer.
 * - At most [LANES] fetches run at once, on their own threads: never the
 *   Capacitor plugin thread, which NIP-55 and biometric calls share.
 */
object CappedImageFetch {
    private const val LANES = 4
    private const val MAX_BYTES_LIMIT = 8 * 1024 * 1024
    private const val MIN_TIMEOUT_MS = 1_000L
    private const val MAX_TIMEOUT_MS = 30_000L
    private const val WATCHDOG_GRACE_MS = 1_000L
    private const val MAX_URL_CHARS = 2048
    private const val CHUNK = 16 * 1024

    sealed class Result {
        class Ok(val status: Int, val bytes: ByteArray) : Result()
        class Failed(val reason: String, val status: Int = 0) : Result()

        fun toJs(): JSObject = when (this) {
            is Ok -> JSObject()
                .put("ok", true)
                .put("status", status)
                .put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
            is Failed -> JSObject()
                .put("ok", false)
                .put("status", status)
                .put("reason", reason)
        }
    }

    private val lanes: ThreadPoolExecutor = (Executors.newFixedThreadPool(LANES) { r ->
        Thread(r, "signet-image-fetch").apply { isDaemon = true }
    } as ThreadPoolExecutor)

    private val watchdog: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "signet-image-fetch-watchdog").apply { isDaemon = true }
    }

    internal fun isPublic(address: InetAddress): Boolean {
        if (address.isAnyLocalAddress || address.isLoopbackAddress || address.isLinkLocalAddress ||
            address.isSiteLocalAddress || address.isMulticastAddress) return false
        val b = address.address
        if (b.size == 4) {
            val b0 = b[0].toInt() and 0xff
            val b1 = b[1].toInt() and 0xff
            if (b0 == 0) return false // 0.0.0.0/8
            if (b0 == 100 && b1 in 64..127) return false // 100.64.0.0/10
            return true
        }
        if (b.size != 16 || address !is Inet6Address) return false
        fun zero(from: Int, to: Int) = (from until to).all { b[it].toInt() == 0 }
        fun embedded(at: Int) = isPublic(InetAddress.getByAddress(b.copyOfRange(at, at + 4)))
        val b0 = b[0].toInt() and 0xff
        val b1 = b[1].toInt() and 0xff
        if ((b0 and 0xfe) == 0xfc) return false // fc00::/7 unique-local
        if (b0 == 0xfe && (b1 and 0xc0) == 0xc0) return false // fec0::/10 site-local (deprecated)
        // NAT64: 64:ff9b::/96 and 64:ff9b:1::/48, refused outright.
        if (b0 == 0x00 && b1 == 0x64 && (b[2].toInt() and 0xff) == 0xff && (b[3].toInt() and 0xff) == 0x9b) {
            if (zero(4, 12)) return false
            if (b[4].toInt() == 0 && b[5].toInt() == 1) return false
        }
        if (b0 == 0x20 && b1 == 0x02) return embedded(2) // 6to4: v4 in bits 16-48
        // IPv4-mapped ::ffff:0:0/96 and deprecated IPv4-compatible ::/96.
        if (zero(0, 10) && (b[10].toInt() and 0xff) == 0xff && (b[11].toInt() and 0xff) == 0xff) return embedded(12)
        if (zero(0, 12)) return embedded(12)
        return true
    }

    private val DOTTED_QUAD = Regex("""^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$""")
    // Mirrors OkHttp's own "is this an IP literal" test, which skips the custom Dns.
    private val IP_LITERAL = Regex("""^(?:[0-9a-fA-F]*:[0-9a-fA-F:.]*|[\d.]+)$""")

    /**
     * An IP-literal host never reaches [publicOnlyDns] (OkHttp resolves it with
     * InetAddress.getByName), so classify it here. A numeric-looking host that is
     * not a strict dotted quad is refused rather than left to the resolver.
     */
    internal fun literalHostIsPublic(host: String): Boolean {
        if (!IP_LITERAL.matches(host)) return true // a name: the Dns hook covers it
        if (!host.contains(':')) {
            val m = DOTTED_QUAD.matchEntire(host) ?: return false
            if (m.groupValues.drop(1).any { it.toInt() > 255 }) return false
        }
        return try {
            isPublic(InetAddress.getByName(host)) // a literal: no lookup happens
        } catch (e: UnknownHostException) {
            false
        }
    }

    private val publicOnlyDns = object : Dns {
        override fun lookup(hostname: String): List<InetAddress> {
            val public = Dns.SYSTEM.lookup(hostname).filter { isPublic(it) }
            if (public.isEmpty()) throw UnknownHostException("no public address for host")
            return public
        }
    }

    private val baseClient: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .followRedirects(false)
            .followSslRedirects(false)
            .retryOnConnectionFailure(false)
            .cookieJar(CookieJar.NO_COOKIES)
            .cache(null)
            .dns(publicOnlyDns)
            .build()
    }

    /**
     * Fetch off the caller's thread; [done] is called exactly once, by the
     * deadline plus [WATCHDOG_GRACE_MS] at the latest.
     */
    fun start(url: String, maxBytes: Int, timeoutMs: Int, done: (Result) -> Unit) {
        val timeout = timeoutMs.toLong().coerceIn(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
        val cap = maxBytes.coerceIn(1, MAX_BYTES_LIMIT)
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeout)
        val answered = AtomicBoolean(false)
        val inFlight = AtomicReference<Call?>(null)
        val answer = { result: Result -> if (answered.compareAndSet(false, true)) done(result) }

        val timer = watchdog.schedule({
            inFlight.get()?.cancel()
            answer(Result.Failed("timeout"))
        }, timeout + WATCHDOG_GRACE_MS, TimeUnit.MILLISECONDS)

        try {
            lanes.execute {
                try {
                    // Queued behind other lanes past our own deadline: already answered.
                    if (!answered.get()) answer(fetch(url, cap, deadline, inFlight))
                } catch (t: Throwable) {
                    answer(Result.Failed("error"))
                } finally {
                    timer.cancel(false)
                }
            }
        } catch (t: Throwable) {
            timer.cancel(false)
            answer(Result.Failed("error"))
        }
    }

    private fun remainingMs(deadline: Long): Long =
        TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime())

    private fun fetch(url: String, cap: Int, deadline: Long, inFlight: AtomicReference<Call?>): Result {
        if (url.length > MAX_URL_CHARS) return Result.Failed("bad-url")
        val parsed = url.toHttpUrlOrNull() ?: return Result.Failed("bad-url")
        if (!parsed.isHttps) return Result.Failed("not-https")
        if (parsed.username.isNotEmpty() || parsed.password.isNotEmpty()) return Result.Failed("bad-url")
        if (!literalHostIsPublic(parsed.host)) return Result.Failed("bad-url")
        val remaining = remainingMs(deadline)
        if (remaining <= 0) return Result.Failed("timeout")

        val client = baseClient.newBuilder()
            .connectTimeout(remaining, TimeUnit.MILLISECONDS)
            .readTimeout(remaining, TimeUnit.MILLISECONDS)
            .callTimeout(remaining, TimeUnit.MILLISECONDS)
            .build()
        val request = Request.Builder()
            .url(parsed)
            .get()
            .header("Accept", "image/jpeg,image/png,image/webp,image/*;q=0.8")
            .header("Cache-Control", "no-cache")
            .build()
        val call = client.newCall(request)
        inFlight.set(call)
        try {
            call.execute().use { response ->
                val status = response.code
                // Every 3xx lands here: redirects are never followed.
                if (status !in 200..299) return Result.Failed("status", status)
                val body = response.body ?: return Result.Failed("no-body", status)
                val declared = body.contentLength()
                if (declared > cap) return Result.Failed("too-large", status)
                val out = ByteArrayOutputStream(if (declared in 1..cap.toLong()) declared.toInt() else CHUNK)
                val buf = ByteArray(CHUNK)
                body.byteStream().use { input ->
                    while (true) {
                        if (System.nanoTime() > deadline) return Result.Failed("timeout", status)
                        val n = input.read(buf)
                        if (n < 0) break
                        if (out.size().toLong() + n > cap) return Result.Failed("too-large", status)
                        out.write(buf, 0, n)
                    }
                }
                return Result.Ok(status, out.toByteArray())
            }
        } catch (e: IOException) {
            return Result.Failed(if (call.isCanceled() || System.nanoTime() > deadline) "timeout" else "network")
        } finally {
            inFlight.set(null)
            // Harmless after a normal finish; drops the connection after an early return.
            call.cancel()
        }
    }
}
