package com.lanchat.core

import android.content.Context
import android.os.Build
import com.google.crypto.tink.subtle.X25519
import java.util.UUID

/**
 * Mirrors desktop's loadOrCreateIdentity() in main.js: one deviceId + one
 * X25519 keypair, generated once and persisted forever. Same shape, same
 * lifecycle, different storage backend (SharedPreferences vs a JSON file).
 */
data class Identity(
    val deviceId: String,
    val name: String,
    val privateKey: ByteArray,
    val publicKey: ByteArray,
) {
    val publicKeyHex: String get() = publicKey.joinToString("") { "%02x".format(it) }
}

object IdentityStore {
    private const val PREFS = "lanchat_identity"

    fun loadOrCreate(context: Context): Identity {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val existingId = prefs.getString("deviceId", null)
        if (existingId != null) {
            return Identity(
                deviceId = existingId,
                name = prefs.getString("name", Build.MODEL) ?: Build.MODEL,
                privateKey = hexToBytes(prefs.getString("priv", "")!!),
                publicKey = hexToBytes(prefs.getString("pub", "")!!),
            )
        }

        val priv = X25519.generatePrivateKey()
        val pub = X25519.publicFromPrivate(priv)
        val deviceId = UUID.randomUUID().toString()
        val name = Build.MODEL ?: "Android device"

        prefs.edit()
            .putString("deviceId", deviceId)
            .putString("name", name)
            .putString("priv", bytesToHex(priv))
            .putString("pub", bytesToHex(pub))
            .apply()

        return Identity(deviceId, name, priv, pub)
    }

    private fun bytesToHex(bytes: ByteArray): String =
        bytes.joinToString("") { "%02x".format(it) }

    private fun hexToBytes(hex: String): ByteArray =
        ByteArray(hex.length / 2) { i -> hex.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
}
