package com.lanchat.core

import android.content.Context
import org.json.JSONObject

/** Counterpart to desktop/src/core/trustStore.js — same shape, SharedPreferences instead of a JSON file. */
class TrustStore(context: Context) {
    private val prefs = context.getSharedPreferences("lanchat_trust", Context.MODE_PRIVATE)

    data class Peer(val deviceId: String, val name: String, val sessionKey: ByteArray)

    fun addPaired(deviceId: String, name: String, sessionKey: ByteArray) {
        val obj = JSONObject().apply {
            put("name", name)
            put("sessionKey", bytesToHex(sessionKey))
            put("pairedAt", System.currentTimeMillis())
        }
        prefs.edit().putString("peer:$deviceId", obj.toString()).apply()
    }

    fun isPaired(deviceId: String): Boolean = prefs.contains("peer:$deviceId")

    fun sessionKeyFor(deviceId: String): ByteArray? {
        val raw = prefs.getString("peer:$deviceId", null) ?: return null
        return hexToBytes(JSONObject(raw).getString("sessionKey"))
    }

    fun list(): List<Peer> =
        prefs.all.entries
            .filter { it.key.startsWith("peer:") }
            .map { (key, value) ->
                val obj = JSONObject(value as String)
                Peer(
                    deviceId = key.removePrefix("peer:"),
                    name = obj.getString("name"),
                    sessionKey = hexToBytes(obj.getString("sessionKey")),
                )
            }

    private fun bytesToHex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }
    private fun hexToBytes(hex: String) = ByteArray(hex.length / 2) { i -> hex.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
}
