package com.lanchat.core

import android.content.Context
import android.net.wifi.WifiManager
import kotlinx.coroutines.*
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress

const val DISCOVERY_PORT = 47110
private const val BROADCAST_ADDR = "255.255.255.255"
private const val ANNOUNCE_INTERVAL_MS = 3000L
private const val PEER_TIMEOUT_MS = 10000L
private const val SWEEP_INTERVAL_MS = 2000L

data class SelfInfo(val deviceId: String, val name: String, val chatPort: Int, val transferPort: Int)

data class PeerInfo(
    val deviceId: String,
    val name: String,
    val kind: String, // "android" | "desktop"
    val ip: String,
    val chatPort: Int,
    val transferPort: Int,
    var lastSeen: Long,
)

/**
 * Counterpart to desktop/src/core/discovery.js. Same JSON shape on the wire,
 * same broadcast/sweep intervals — a desktop Discovery instance and this one
 * will see each other with zero special-casing.
 */
class Discovery(private val context: Context, private val self: SelfInfo) {
    private var socket: DatagramSocket? = null
    private var multicastLock: WifiManager.MulticastLock? = null
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val _peers = mutableMapOf<String, PeerInfo>()
    val peers: Map<String, PeerInfo> get() = _peers

    var onPeerChanged: (() -> Unit)? = null

    fun start() {
        val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        multicastLock = wifi.createMulticastLock("lanchat-discovery").apply {
            setReferenceCounted(true)
            acquire()
        }

        socket = DatagramSocket(null).apply {
            reuseAddress = true
            bind(java.net.InetSocketAddress(DISCOVERY_PORT))
            broadcast = true
        }

        scope.launch { announceLoop() }
        scope.launch { listenLoop() }
        scope.launch { sweepLoop() }
    }

    private suspend fun announceLoop() {
        while (isActive) {
            announceOnce()
            delay(ANNOUNCE_INTERVAL_MS)
        }
    }

    private fun announceOnce() {
        val payload = JSONObject().apply {
            put("type", "presence")
            put("deviceId", self.deviceId)
            put("name", self.name)
            put("kind", "android")
            put("chatPort", self.chatPort)
            put("transferPort", self.transferPort)
            put("version", 1)
            put("ts", System.currentTimeMillis())
        }.toString().toByteArray()

        val packet = DatagramPacket(payload, payload.size, InetAddress.getByName(BROADCAST_ADDR), DISCOVERY_PORT)
        try { socket?.send(packet) } catch (_: Exception) { /* transient network hiccup, next tick retries */ }
    }

    private suspend fun listenLoop() {
        val buf = ByteArray(2048)
        while (isActive) {
            try {
                val packet = DatagramPacket(buf, buf.size)
                socket?.receive(packet)
                val json = JSONObject(String(packet.data, 0, packet.length))
                if (json.optString("type") != "presence") continue
                val deviceId = json.getString("deviceId")
                if (deviceId == self.deviceId) continue

                _peers[deviceId] = PeerInfo(
                    deviceId = deviceId,
                    name = json.getString("name"),
                    kind = json.getString("kind"),
                    ip = packet.address.hostAddress ?: continue,
                    chatPort = json.getInt("chatPort"),
                    transferPort = json.getInt("transferPort"),
                    lastSeen = System.currentTimeMillis(),
                )
                withContext(Dispatchers.Main) { onPeerChanged?.invoke() }
            } catch (_: Exception) {
                if (!isActive) break
            }
        }
    }

    private suspend fun sweepLoop() {
        while (isActive) {
            delay(SWEEP_INTERVAL_MS)
            val now = System.currentTimeMillis()
            val before = _peers.size
            _peers.entries.removeAll { now - it.value.lastSeen > PEER_TIMEOUT_MS }
            if (_peers.size != before) withContext(Dispatchers.Main) { onPeerChanged?.invoke() }
        }
    }

    fun stop() {
        scope.cancel()
        socket?.close()
        multicastLock?.let { if (it.isHeld) it.release() }
    }
}
