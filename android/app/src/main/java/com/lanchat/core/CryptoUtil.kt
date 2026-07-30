package com.lanchat.core

import com.google.crypto.tink.subtle.AesGcmJce
import com.google.crypto.tink.subtle.Hkdf
import com.google.crypto.tink.subtle.X25519
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * Counterpart to desktop/src/core/crypto.js. Same algorithms (X25519 ECDH,
 * HKDF-SHA256, AES-256-GCM), same wire format, produced by Tink instead of
 * Node's built-in crypto module. The frame layout Tink emits by default —
 * nonce(12) || ciphertext || tag(16) — is exactly what desktop produces, so
 * no translation layer is needed on either side.
 *
 * NOTE ON CIPHER CHOICE: this used to use ChaCha20-Poly1305, matching an
 * earlier version of the desktop client. That was switched to AES-256-GCM
 * after discovering some Windows Electron builds' bundled OpenSSL doesn't
 * expose ChaCha20-Poly1305 ("Unknown cipher"). AES-GCM is the safer,
 * universally-available choice on both platforms.
 */
object CryptoUtil {

    /** Legacy PIN-salted derivation — no longer used by the main Connect flow, kept for reference. */
    fun deriveSessionKey(myPrivateKey: ByteArray, theirPublicKey: ByteArray, pin: String): ByteArray {
        val shared = X25519.computeSharedSecret(myPrivateKey, theirPublicKey)
        return Hkdf.computeHkdf("HmacSha256", shared, pin.toByteArray(Charsets.UTF_8), "lan-chat-v1".toByteArray(Charsets.UTF_8), 32)
    }

    /** Used by the interactive Connect flow (see Pairing.kt): pure ECDH, no PIN. */
    fun deriveConnectSessionKey(myPrivateKey: ByteArray, theirPublicKey: ByteArray): ByteArray {
        val shared = X25519.computeSharedSecret(myPrivateKey, theirPublicKey)
        return Hkdf.computeHkdf("HmacSha256", shared, ByteArray(0), "lan-chat-connect-v1".toByteArray(Charsets.UTF_8), 32)
    }

    /** Same order-independent 6-digit code as desktop's verificationCode() in crypto.js. */
    fun verificationCode(pubKeyHexA: String, pubKeyHexB: String): String {
        val (a, b) = listOf(pubKeyHexA, pubKeyHexB).sorted()
        val digest = MessageDigest.getInstance("SHA-256").digest((a + b).toByteArray(Charsets.UTF_8))
        val num = (
            ((digest[0].toInt() and 0xFF) shl 24) or
            ((digest[1].toInt() and 0xFF) shl 16) or
            ((digest[2].toInt() and 0xFF) shl 8) or
            (digest[3].toInt() and 0xFF)
        ).toLong() and 0xFFFFFFFFL
        return (num % 1000000).toString().padStart(6, '0')
    }

    fun encrypt(sessionKey: ByteArray, plaintext: ByteArray): ByteArray {
        val aead = AesGcmJce(sessionKey)
        return aead.encrypt(plaintext, ByteArray(0)) // Tink prepends its own random nonce
    }

    fun decrypt(sessionKey: ByteArray, frame: ByteArray): ByteArray {
        val aead = AesGcmJce(sessionKey)
        return aead.decrypt(frame, ByteArray(0))
    }

    fun randomPin(): String {
        val n = 100000 + SecureRandom().nextInt(900000)
        return n.toString()
    }
}
