package com.lanchat.core

import android.content.Context
import android.net.wifi.WifiManager
import kotlinx.coroutines.*
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.MulticastSocket
import java.net.NetworkInterface

const val DISCOVERY_PORT = 47110
private const val GLOBAL_BROADCAST_ADDR = "255.255.255.255"
private const val MULTICAST_ADDR = "239.255.255.250"
private const val ANNOUNCE_INTERVAL_MS = 3000L
private const val PEER_TIMEOUT_MS = 12000L // 4x announce interval, same reasoning as desktop
private const val SWEEP_INTERVAL_MS = 2000L

data class SelfInfo(val deviceId: String, val name: String, val chatPort: Int, val transferPort: Int, val connectPort: Int, val publicKeyRaw: String)

data class PeerInfo(
    val deviceId: String,
    val name: String,
    val kind: String, // "android" | "desktop"
    val ip: String,
    val chatPort: Int,
    val transferPort: Int,
    val connectPort: Int,
    val publicKeyRaw: String?,
    var lastSeen: Long,
)

/**
 * Counterpart to desktop/src/core/discovery.js. Same JSON shape, same
 * multi-layer broadcast strategy, and the same reply-on-new-peer unicast
 * handshake (fixes asymmetric broadcast reachability — see that file's
 * header comment for the full reasoning).
 */
class Discovery(private val context: Context, private val self: SelfInfo) {
    private var socket: MulticastSocket? = null
    private var multicastLock: WifiManager.MulticastLock? = null
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val _peers = mutableMapOf<String, PeerInfo>()
    val peers: Map<String, PeerInfo> get() = _peers

    var onPeerChanged: (() -> Unit)? = null

    private fun interfaceBroadcastAddresses(): List<String> {
        val addrs = mutableListOf<String>()
        try {
            for (iface in NetworkInterface.getNetworkInterfaces()) {
                if (!iface.isUp || iface.isLoopback) continue
                for (ifAddr in iface.interfaceAddresses) {
                    val broadcast = ifAddr.broadcast ?: continue
                    addrs.add(broadcast.hostAddress ?: continue)
                }
            }
        } catch (_: Exception) {
            // interface enumeration can fail transiently (e.g. Wi-Fi toggling) — other layers still work
        }
        return addrs.distinct()
    }

    fun start() {
        val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        multicastLock = wifi.createMulticastLock("lanchat-discovery").apply {
            setReferenceCounted(true)
            acquire()
        }

        socket = MulticastSocket(null).apply {
            reuseAddress = true
            bind(InetSocketAddress(DISCOVERY_PORT))
            broadcast = true
        }
        try {
            socket?.joinGroup(InetSocketAddress(InetAddress.getByName(MULTICAST_ADDR), DISCOVERY_PORT), null)
        } catch (_: Exception) {
            // multicast join can fail on some networks — broadcast layers still cover discovery
        }

        scope.launch { announceLoop() }
        scope.launch { listenLoop() }
        scope.launch { sweepLoop() }
    }

    private suspend fun announceLoop() {
        while (currentCoroutineContext().isActive) {
            announceOnce()
            delay(ANNOUNCE_INTERVAL_MS)
        }
    }

    private fun presencePayload(): ByteArray = JSONObject().apply {
        put("type", "presence")
        put("deviceId", self.deviceId)
        put("name", self.name)
        put("kind", "android")
        put("chatPort", self.chatPort)
        put("transferPort", self.transferPort)
        put("connectPort", self.connectPort)
        put("publicKeyRaw", self.publicKeyRaw)
        put("version", 1)
        put("ts", System.currentTimeMillis())
    }.toString().toByteArray()

    private fun sendTo(addr: String, port: Int = DISCOVERY_PORT) {
        try {
            val payload = presencePayload()
            socket?.send(DatagramPacket(payload, payload.size, InetAddress.getByName(addr), port))
        } catch (_: Exception) {
            // one target failing (interface just went down, etc.) is expected occasionally — other layers cover it
        }
    }

    private fun announceOnce() {
        val targets = (listOf(GLOBAL_BROADCAST_ADDR, MULTICAST_ADDR) + interfaceBroadcastAddresses()).distinct()
        for (addr in targets) sendTo(addr)
    }

    /**
     * Manual fallback for "Connect by IP": sends one unicast presence packet
     * directly to a specific address, bypassing broadcast/multicast. If it
     * arrives, the reply-on-new-peer behavior below means the target will
     * unicast its own presence straight back.
     */
    fun probe(ip: String) {
        sendTo(ip, DISCOVERY_PORT)
    }

    private suspend fun listenLoop() {
        val buf = ByteArray(2048)
        while (currentCoroutineContext().isActive) {
            try {
                val packet = DatagramPacket(buf, buf.size)
                socket?.receive(packet)
                val json = JSONObject(String(packet.data, 0, packet.length))
                if (json.optString("type") != "presence") continue
                val deviceId = json.getString("deviceId")
                if (deviceId == self.deviceId) continue

                val isNew = !_peers.containsKey(deviceId)
                _peers[deviceId] = PeerInfo(
                    deviceId = deviceId,
                    name = json.getString("name"),
                    kind = json.getString("kind"),
                    ip = packet.address.hostAddress ?: continue,
                    chatPort = json.getInt("chatPort"),
                    transferPort = json.getInt("transferPort"),
                    connectPort = json.optInt("connectPort", 47120),
                    publicKeyRaw = json.optString("publicKeyRaw", null),
                    lastSeen = System.currentTimeMillis(),
                )
                withContext(Dispatchers.Main) { onPeerChanged?.invoke() }

                // First contact from this peer: reply directly to their
                // address immediately, instead of waiting for our own next
                // broadcast cycle. Fixes asymmetric broadcast reachability.
                if (isNew) sendTo(packet.address.hostAddress ?: continue, packet.port)
            } catch (_: Exception) {
                if (!currentCoroutineContext().isActive) break
            }
        }
    }

    private suspend fun sweepLoop() {
        while (currentCoroutineContext().isActive) {
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
