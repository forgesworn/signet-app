package app.mysignet

/**
 * NIP-55 on the wire, reduced to plain values so it can be checked on the
 * host JVM. An incoming intent or provider query becomes a [Nip55Incoming]
 * for the web layer; the web layer's answer becomes the extras or cursor
 * the calling app reads. Mirrors Cambium's `Nip55Request`, so an app gets
 * the same shapes from either ForgeSworn signer.
 */
object Nip55Wire {
    const val SCHEME = "nostrsigner"

    /** The calling app's name as the launcher shows it, so the approval screen can say "Amethyst" rather than a package name. */
    fun labelOf(packageManager: android.content.pm.PackageManager, packageName: String?): String? {
        if (packageName.isNullOrEmpty()) return null
        return try {
            packageManager.getApplicationLabel(packageManager.getApplicationInfo(packageName, 0)).toString().takeIf { it.isNotBlank() && it != packageName }
        } catch (e: Exception) { null }
    }
    const val EXTRA_TYPE = "type"
    const val EXTRA_ID = "id"
    const val EXTRA_CURRENT_USER = "current_user"
    const val EXTRA_PUBKEY = "pubkey"
    const val EXTRA_PUBKEY_ALT = "pubKey"
    const val EXTRA_PERMISSIONS = "permissions"
    const val EXTRA_RESULT = "result"
    const val EXTRA_EVENT = "event"
    const val EXTRA_SIGNATURE = "signature"
    const val EXTRA_PACKAGE = "package"
    const val EXTRA_REJECTED = "rejected"

    val METHODS = setOf("get_public_key", "sign_event", "nip44_encrypt", "nip44_decrypt")

    /** The provider authorities this signer answers on, `<package>.<METHOD>`. */
    fun authority(packageName: String, method: String): String = "$packageName.${method.uppercase()}"

    /** The method named by a provider authority, or null. */
    fun methodOf(authority: String, packageName: String): String? {
        val prefix = "$packageName."
        if (!authority.startsWith(prefix)) return null
        val method = authority.removePrefix(prefix).lowercase()
        return if (method == "ping" || method in METHODS) method else null
    }
}

/** One request as it goes to the web layer. */
data class Nip55Incoming(
    val id: String,
    val callerPackage: String?,
    /** The calling app's name as the phone shows it; null when the package cannot be looked up. */
    val callerLabel: String?,
    val type: String?,
    val payload: String?,
    val peerPubkey: String?,
    val currentUser: String?,
    val permissions: String?,
    val viaProvider: Boolean,
) {
    /** The fields as the web layer reads them; null stays null. Serialised by the plugin, which has the JSON library. */
    fun fields(): Map<String, Any?> = mapOf(
        "id" to id, "callerPackage" to callerPackage, "callerLabel" to callerLabel, "type" to type, "payload" to payload,
        "peerPubkey" to peerPubkey, "currentUser" to currentUser, "permissions" to permissions, "viaProvider" to viaProvider,
    )

    companion object {
        /**
         * From an intent: `nostrsigner:<payload>` in the data plus the extras.
         * The payload is the scheme-specific part, kept exactly as sent, because
         * a signed event's JSON must not be reformatted on the way through.
         */
        fun fromIntent(
            id: String, callerPackage: String?, callerLabel: String?, dataString: String?,
            type: String?, currentUser: String?, pubkey: String?, permissions: String?,
        ): Nip55Incoming {
            val payload = dataString?.let { raw ->
                val colon = raw.indexOf(':')
                if (colon < 0 || !raw.substring(0, colon).equals(Nip55Wire.SCHEME, ignoreCase = true)) null
                else raw.substring(colon + 1).takeIf { it.isNotEmpty() }
            }
            return Nip55Incoming(id, callerPackage, callerLabel, type, payload, pubkey, currentUser, permissions, viaProvider = false)
        }

        /**
         * From a provider query: the projection carries the payload, the other
         * party's key and the calling app's chosen identity, in that order, as
         * Amber laid it out and Cambium follows.
         */
        fun fromProvider(id: String, callerPackage: String?, callerLabel: String?, method: String, projection: Array<out String>?): Nip55Incoming {
            val payload = projection?.getOrNull(0)?.takeIf { it.isNotEmpty() }
            val peer = projection?.getOrNull(1)?.takeIf { it.isNotEmpty() }
            val currentUser = projection?.getOrNull(2)?.takeIf { it.isNotEmpty() }
            return Nip55Incoming(id, callerPackage, callerLabel, method, payload, peer, currentUser, null, viaProvider = true)
        }
    }
}

/** What the web layer sent back for one request. */
data class Nip55Answer(val status: String, val result: String?, val event: String?) {
    val ok: Boolean get() = status == "ok"
    val deferred: Boolean get() = status == "deferred"
}
