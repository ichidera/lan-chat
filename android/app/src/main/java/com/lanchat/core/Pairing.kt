package com.lanchat.core

import org.json.JSONObject

/** Counterpart to desktop/src/core/pairing.js — see that file for the full threat-model note. */
object Pairing {

    data class Offer(val deviceId: String, val name: String, val publicKeyHex: String, val pin: String) {
        fun toJson(): String = JSONObject().apply {
            put("deviceId", deviceId)
            put("name", name)
            put("publicKeyRaw", publicKeyHex)
            put("pin", pin)
        }.toString()

        companion object {
            fun fromJson(json: String): Offer {
                val o = JSONObject(json)
                return Offer(o.getString("deviceId"), o.getString("name"), o.getString("publicKeyRaw"), o.getString("pin"))
            }
        }
    }

    fun startPairing(identity: Identity): Offer =
        Offer(identity.deviceId, identity.name, bytesToHex(identity.publicKey), CryptoUtil.randomPin())

    /** Called on the device that receives someone else's Offer (scanned QR / typed code). */
    fun completePairing(offer: Offer, identity: Identity, trustStore: TrustStore) {
        val theirPublicKey = hexToBytes(offer.publicKeyHex)
        val sessionKey = CryptoUtil.deriveSessionKey(identity.privateKey, theirPublicKey, offer.pin)
        trustStore.addPaired(offer.deviceId, offer.name, sessionKey)
    }

    /** Used by the device that *generated* the offer, once it has the other side's public key back. */
    fun deriveMatchingKey(identity: Identity, theirPublicKeyHex: String, pin: String): ByteArray =
        CryptoUtil.deriveSessionKey(identity.privateKey, hexToBytes(theirPublicKeyHex), pin)

    private fun bytesToHex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }
    private fun hexToBytes(hex: String) = ByteArray(hex.length / 2) { i -> hex.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
}
