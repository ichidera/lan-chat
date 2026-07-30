package com.lanchat.core

import kotlinx.coroutines.*
import org.json.JSONObject
import java.io.DataInputStream
import java.io.DataOutputStream
import java.net.ServerSocket
import java.net.Socket

/**
 * Counterpart to desktop/src/core/pairing.js — the "Connect" flow. See that
 * file's header comment for the full Bluetooth-style request/accept
 * explanation and threat-model note. Same wire format: one connection,
 * length-prefixed JSON, connect_request -> connect_accept|connect_reject.
 */
const val DEFAULT_CONNECT_PORT = 47120
private const val CONNECT_TIMEOUT_MS = 20000L

private fun writeFrame(out: DataOutputStream, obj: JSONObject) {
    val payload = obj.toString().toByteArray(Charsets.UTF_8)
    out.writeInt(payload.size)
    out.write(payload)
}

data class ConnectResult(val status: String, val code: String) // status: "accepted" | "rejected" | "timeout"

data class IncomingConnectRequest(
    val deviceId: String,
    val name: String,
    val code: String,
    val respond: (accept: Boolean) -> Unit,
)

/** Runs always-on: listens for incoming connect requests. */
class ConnectServer(private val identity: Identity, private val trustStore: TrustStore, private val port: Int = DEFAULT_CONNECT_PORT) {
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var server: ServerSocket? = null

    var onIncoming: ((IncomingConnectRequest) -> Unit)? = null

    fun start() {
        server = ServerSocket(port)
        scope.launch {
            while (isActive) {
                val socket = try { server?.accept() } catch (_: Exception) { null } ?: break
                scope.launch { handle(socket) }
            }
        }
    }

    private fun handle(socket: Socket) {
        val input = DataInputStream(socket.getInputStream())
        val output = DataOutputStream(socket.getOutputStream())
        val len = input.readInt()
        val bytes = ByteArray(len).also { input.readFully(it) }
        val msg = JSONObject(String(bytes, Charsets.UTF_8))
        if (msg.optString("type") != "connect_request") { socket.close(); return }

        val theirPublicKeyHex = msg.getString("publicKeyRaw")
        val code = CryptoUtil.verificationCode(identity.publicKeyHex, theirPublicKeyHex)

        val respond: (Boolean) -> Unit = { accept ->
            if (accept) {
                val sessionKey = CryptoUtil.deriveConnectSessionKey(identity.privateKey, hexToBytes(theirPublicKeyHex))
                trustStore.addPaired(msg.getString("deviceId"), msg.getString("name"), sessionKey)
                writeFrame(output, JSONObject().apply {
                    put("type", "connect_accept")
                    put("deviceId", identity.deviceId)
                    put("name", identity.name)
                    put("publicKeyRaw", identity.publicKeyHex)
                })
            } else {
                writeFrame(output, JSONObject().put("type", "connect_reject"))
            }
            socket.close()
        }

        onIncoming?.invoke(IncomingConnectRequest(msg.getString("deviceId"), msg.getString("name"), code, respond))
    }

    fun stop() {
        scope.cancel()
        server?.close()
    }

    private fun hexToBytes(hex: String) = ByteArray(hex.length / 2) { i -> hex.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
}

/** The initiating side of a Connect action. */
class ConnectClient(private val identity: Identity, private val trustStore: TrustStore) {

    /**
     * @param peer from Discovery.peers, must have publicKeyRaw
     * @param onWaiting fired immediately with the verification code, before the other side has responded
     */
    suspend fun connect(peer: PeerInfo, onWaiting: (String) -> Unit): ConnectResult = withContext(Dispatchers.IO) {
        val theirPublicKeyHex = peer.publicKeyRaw
            ?: throw IllegalStateException(
                "${peer.name} hasn't broadcast a public key yet — this usually means their app just started. " +
                "Wait a few seconds for it to reappear in Nearby Devices and try again."
            )
        val code = CryptoUtil.verificationCode(identity.publicKeyHex, theirPublicKeyHex)

        val socket = Socket()
        try {
            socket.connect(java.net.InetSocketAddress(peer.ip, peer.connectPort), CONNECT_TIMEOUT_MS.toInt())
            val output = DataOutputStream(socket.getOutputStream())
            val input = DataInputStream(socket.getInputStream())

            writeFrame(output, JSONObject().apply {
                put("type", "connect_request")
                put("deviceId", identity.deviceId)
                put("name", identity.name)
                put("publicKeyRaw", identity.publicKeyHex)
            })
            withContext(Dispatchers.Main) { onWaiting(code) }

            socket.soTimeout = CONNECT_TIMEOUT_MS.toInt()
            val len = input.readInt()
            val bytes = ByteArray(len).also { input.readFully(it) }
            val msg = JSONObject(String(bytes, Charsets.UTF_8))

            when (msg.getString("type")) {
                "connect_accept" -> {
                    val sessionKey = CryptoUtil.deriveConnectSessionKey(identity.privateKey, hexToBytes(msg.getString("publicKeyRaw")))
                    trustStore.addPaired(msg.getString("deviceId"), msg.getString("name"), sessionKey)
                    ConnectResult("accepted", code)
                }
                "connect_reject" -> ConnectResult("rejected", code)
                else -> ConnectResult("timeout", code)
            }
        } catch (_: java.net.SocketTimeoutException) {
            ConnectResult("timeout", code)
        } finally {
            socket.close()
        }
    }

    private fun hexToBytes(hex: String) = ByteArray(hex.length / 2) { i -> hex.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
}
