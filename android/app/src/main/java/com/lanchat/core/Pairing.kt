package com.lanchat.core

/**
 * Counterpart to desktop/src/core/pairing.js — see that file's header for the
 * full explanation of why this is PIN-only now (public keys already travel
 * in every presence broadcast, see Discovery.kt) and the threat-model note.
 */
object Pairing {

    fun generatePin(): String = CryptoUtil.randomPin()

    /**
     * @param identity this device's identity (private key + id)
     * @param peer a peer from Discovery.peers — MUST have publicKeyRaw (i.e. we've heard at least one presence packet from it)
     * @param pin the 6-digit PIN both humans agreed to use
     * @param trustStore where the derived session key gets stored
     */
    fun pairWithPeer(identity: Identity, peer: PeerInfo, pin: String, trustStore: TrustStore) {
        val theirPublicKeyHex = peer.publicKeyRaw
            ?: throw IllegalStateException(
                "${peer.name} hasn't broadcast a public key yet — this usually means their app just started. " +
                "Wait a few seconds for it to reappear in Nearby Devices and try again."
            )
        if (!Regex("^\\d{6}$").matches(pin)) {
            throw IllegalArgumentException("PIN must be exactly 6 digits.")
        }
        val theirPublicKey = hexToBytes(theirPublicKeyHex)
        val sessionKey = CryptoUtil.deriveSessionKey(identity.privateKey, theirPublicKey, pin)
        trustStore.addPaired(peer.deviceId, peer.name, sessionKey)
    }

    private fun hexToBytes(hex: String) = ByteArray(hex.length / 2) { i -> hex.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
}
