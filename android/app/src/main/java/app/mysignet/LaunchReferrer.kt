package app.mysignet

import android.net.Uri

/**
 * Which app opened this one through a link, and with which URL. Written by
 * MainActivity on every launch or re-delivery that carries link data, read by
 * SignetNativePlugin.getLaunchReferrer. The package is a HINT for display
 * only: any app can claim any referrer, so it is never a trust input.
 */
object LaunchReferrer {
    @Volatile var pkg: String? = null
    @Volatile var url: String? = null

    /** Called with the activity's referrer (may be null) and the link data. */
    @JvmStatic
    fun capture(referrer: Uri?, dataString: String?) {
        if (dataString == null) return
        pkg = if (referrer?.scheme == "android-app") referrer.host else null
        url = dataString
    }
}
