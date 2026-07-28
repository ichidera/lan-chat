package com.lanchat.core

import kotlinx.coroutines.*
import org.json.JSONObject
import java.io.DataInputStream
import java.io.DataOutputStream
import java.net.ServerSocket
import java.net.Socket
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

data class ChatMessage(val id: String, val from: String, val to: String, val body: String, val ts: Long)

/**
 * Counterpart to desktop/src/core/chat.js. Same framing:
 * [4-byte big-endian length][frame], first frame plaintext {"type":"hello",...},
 * every frame after that is ChaCha20-Poly1305 ciphertext keyed by the
 * TrustStore session key for that peer.
 */
class ChatNode(
    private val self: SelfInfo,
    private val trustStore: TrustStore,
) {
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var server: ServerSocket? = null
    private val connections = ConcurrentHashMap<String, Socket>()

    var onMessage: ((from: String, msg: ChatMessage) -> Unit)? = null

    fun start() {
        server = ServerSocket(self.chatPort)
        scope.launch {
            while (isActive) {
                val socket = try { server?.accept() } catch (_: Exception) { null } ?: break
                scope.launch { handleIncoming(socket) }
            }
        }
    }

    private suspend fun handleIncoming(socket: Socket) {
        val input = DataInputStream(socket.getInputStream())
        var peerDeviceId: String? = null
        try {
            while (true) {
                val len = input.readInt()
                val frame = ByteArray(len)
                input.readFully(frame)

                if (peerDeviceId == null) {
                    val hello = JSONObject(String(frame))
                    peerDeviceId = hello.getString("deviceId")
                    connections[peerDeviceId] = socket
                    continue
                }
                val sessionKey = trustStore.sessionKeyFor(peerDeviceId) ?: break
                val plaintext = CryptoUtil.decrypt(sessionKey, frame)
                val obj = JSONObject(String(plaintext))
                val msg = ChatMessage(obj.getString("id"), obj.getString("from"), obj.getString("to"), obj.getString("body"), obj.getLong("ts"))
                withContext(Dispatchers.Main) { onMessage?.invoke(peerDeviceId!!, msg) }
            }
        } catch (_: Exception) {
            // connection closed or peer went away — normal on a LAN with roaming devices
        } finally {
            peerDeviceId?.let { connections.remove(it) }
        }
    }

    suspend fun send(peer: PeerInfo, body: String): ChatMessage = withContext(Dispatchers.IO) {
        val sessionKey = trustStore.sessionKeyFor(peer.deviceId)
            ?: throw IllegalStateException("Cannot send: peer is not paired yet")

        var socket = connections[peer.deviceId]
        if (socket == null || socket.isClosed) {
            socket = Socket(peer.ip, peer.chatPort)
            val out = DataOutputStream(socket.getOutputStream())
            val hello = JSONObject().put("type", "hello").put("deviceId", self.deviceId).toString().toByteArray()
            out.writeInt(hello.size)
            out.write(hello)
            connections[peer.deviceId] = socket
        }

        val msg = ChatMessage(UUID.randomUUID().toString(), self.deviceId, peer.deviceId, body, System.currentTimeMillis())
        val plaintext = JSONObject().apply {
            put("type", "msg"); put("id", msg.id); put("from", msg.from); put("to", msg.to); put("body", msg.body); put("ts", msg.ts)
        }.toString().toByteArray()
        val frame = CryptoUtil.encrypt(sessionKey, plaintext)

        val out = DataOutputStream(socket.getOutputStream())
        out.writeInt(frame.size)
        out.write(frame)
        msg
    }

    fun stop() {
        scope.cancel()
        connections.values.forEach { it.close() }
        server?.close()
    }
}
