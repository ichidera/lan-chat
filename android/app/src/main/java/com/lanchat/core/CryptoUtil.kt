package com.lanchat.core

import com.google.crypto.tink.subtle.ChaCha20Poly1305
import com.google.crypto.tink.subtle.Hkdf
import com.google.crypto.tink.subtle.X25519
import java.security.SecureRandom

/**
 * Counterpart to desktop/src/core/crypto.js. Same algorithms (X25519 ECDH,
 * HKDF-SHA256, ChaCha20-Poly1305), same wire format, produced by Tink instead
 * of Node's built-in crypto module. The frame layout Tink emits by default —
 * nonce(12) || ciphertext || tag(16) — is exactly what desktop now produces,
 * so no translation layer is needed on either side.
 */
object CryptoUtil {

    fun deriveSessionKey(myPrivateKey: ByteArray, theirPublicKey: ByteArray, pin: String): ByteArray {
        val shared = X25519.computeSharedSecret(myPrivateKey, theirPublicKey)
        // salt = pin (matches crypto.hkdfSync('sha256', shared, salt, info, 32) on desktop)
        return Hkdf.computeHkdf(
            "HmacSha256",
            shared,
            pin.toByteArray(Charsets.UTF_8),
            "lan-chat-v1".toByteArray(Charsets.UTF_8),
            32,
        )
    }

    fun encrypt(sessionKey: ByteArray, plaintext: ByteArray): ByteArray {
        val aead = ChaCha20Poly1305(sessionKey)
        return aead.encrypt(plaintext, ByteArray(0)) // Tink prepends its own random nonce
    }

    fun decrypt(sessionKey: ByteArray, frame: ByteArray): ByteArray {
        val aead = ChaCha20Poly1305(sessionKey)
        return aead.decrypt(frame, ByteArray(0))
    }

    fun randomPin(): String {
        val n = 100000 + SecureRandom().nextInt(900000)
        return n.toString()
    }
}
