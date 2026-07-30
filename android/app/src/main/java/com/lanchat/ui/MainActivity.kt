package com.lanchat.ui

import android.app.AlertDialog
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Bundle
import android.os.IBinder
import android.widget.*
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.lanchat.R
import com.lanchat.core.*
import kotlinx.coroutines.launch
import java.io.File
import java.net.NetworkInterface

/**
 * Deliberately simple, single-Activity UI: a device list, and a chat screen.
 * All the interesting logic lives in the core/ package's .kt files and LanChatForegroundService;
 * this file just wires taps to those calls.
 *
 * Tapping a device in the list is the single entry point (mirrors the
 * desktop renderer): if it's not paired yet, this opens the pairing dialog
 * for that specific device; if it is paired, tapping toggles its chat screen
 * open/closed.

 */
class MainActivity : AppCompatActivity() {

    private var service: LanChatForegroundService? = null
    private var activePeer: PeerInfo? = null
    private var peersSnapshot: List<PeerInfo> = emptyList()

    private lateinit var peerListView: ListView
    private lateinit var chatContainer: LinearLayout
    private lateinit var peerContainer: LinearLayout
    private lateinit var chatTitle: TextView
    private lateinit var messagesView: ListView
    private lateinit var messageInput: EditText
    private lateinit var selfIpText: TextView
    private val messages = mutableListOf<String>()
    private lateinit var messagesAdapter: ArrayAdapter<String>

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            service = (binder as LanChatForegroundService.LocalBinder).getService()
            service?.discovery?.onPeerChanged = { refreshPeerList() }
            service?.chatNode?.onMessage = { from, msg ->
                if (activePeer?.deviceId == from) {
                    messages.add("them: ${msg.body}")
                    messagesAdapter.notifyDataSetChanged()
                }
            }
            service?.transferServer?.onOffer = { transferId, _, files ->
                runOnUiThread {
                    AlertDialog.Builder(this@MainActivity)
                        .setTitle("Incoming files")
                        .setMessage("From a paired device: ${files.joinToString { it.name }}")
                        .setPositiveButton("Accept") { _, _ -> service?.transferServer?.acceptTransfer(transferId) }
                        .setNegativeButton("Decline", null)
                        .show()
                }
            }
            service?.transferServer?.onComplete = { _, status, paths ->
                runOnUiThread {
                    Toast.makeText(this@MainActivity, "Received ($status): $paths", Toast.LENGTH_LONG).show()
                    paths.firstOrNull { it.endsWith(".apk") }?.let { ApkShare.installReceivedApk(this@MainActivity, File(it)) }
                }
            }
            service?.connectServer?.onIncoming = { req -> runOnUiThread { showIncomingConnectDialog(req) } }
            refreshPeerList()
        }
        override fun onServiceDisconnected(name: ComponentName?) { service = null }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        peerContainer = findViewById(R.id.peerContainer)
        chatContainer = findViewById(R.id.chatContainer)
        peerListView = findViewById(R.id.peerListView)
        chatTitle = findViewById(R.id.chatTitle)
        messagesView = findViewById(R.id.messagesView)
        messageInput = findViewById(R.id.messageInput)
        selfIpText = findViewById(R.id.selfIpText)
        messagesAdapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, messages)
        messagesView.adapter = messagesAdapter

        findViewById<Button>(R.id.backButton).setOnClickListener { showPeerList() }
        findViewById<Button>(R.id.sendButton).setOnClickListener { sendMessage() }
        findViewById<Button>(R.id.attachButton).setOnClickListener { showAttachDialog() }
        findViewById<Button>(R.id.manualIpButton).setOnClickListener { probeManualIp() }

        selfIpText.text = "Your IP: ${localIpAddresses().joinToString(", ")}"

        startForegroundService(Intent(this, LanChatForegroundService::class.java))
        bindService(Intent(this, LanChatForegroundService::class.java), connection, Context.BIND_AUTO_CREATE)
    }

    private fun localIpAddresses(): List<String> {
        val addrs = mutableListOf<String>()
        try {
            for (iface in NetworkInterface.getNetworkInterfaces()) {
                if (!iface.isUp || iface.isLoopback) continue
                for (addr in iface.inetAddresses) {
                    val host = addr.hostAddress ?: continue
                    if (host.contains(':')) continue // skip IPv6 for a simpler display
                    addrs.add(host)
                }
            }
        } catch (_: Exception) { /* best effort */ }
        return addrs
    }

    private fun refreshPeerList() {
        val peers = service?.discovery?.peers?.values?.toList().orEmpty()
        peersSnapshot = peers
        val trustStore = TrustStore(this)
        val labels = peers.map { p ->
            val kind = if (p.kind == "desktop") "\uD83D\uDCBB" else "\uD83D\uDCF1"
            val trusted = trustStore.isPaired(p.deviceId)
            "$kind ${p.name}" + when {
                !trusted -> " — tap to pair"

                activePeer?.deviceId == p.deviceId -> " (open)"
                else -> ""
            }
        }
        runOnUiThread {
            peerListView.adapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, labels)
            peerListView.setOnItemClickListener { _, _, position, _ ->
                val peer = peers[position]
                togglePeer(peer, trustStore)
            }
        }
    }

    /** Single entry point for tapping a device: pair if needed, otherwise toggle its chat open/closed. */
    private fun togglePeer(peer: PeerInfo, trustStore: TrustStore) {
        if (!trustStore.isPaired(peer.deviceId)) {
            showPairingDialog(peer)
            return
        }
        if (activePeer?.deviceId == peer.deviceId) {
            showPeerList() // tapping the already-open conversation again closes it

        } else {
            openChat(peer)
        }
    }

    private fun openChat(peer: PeerInfo) {
        activePeer = peer
        messages.clear()
        messagesAdapter.notifyDataSetChanged()
        chatTitle.text = "Chat with ${peer.name}"
        peerContainer.visibility = android.view.View.GONE
        chatContainer.visibility = android.view.View.VISIBLE
    }

    private fun showPeerList() {
        activePeer = null
        peerContainer.visibility = android.view.View.VISIBLE
        chatContainer.visibility = android.view.View.GONE
        refreshPeerList()
    }

    private fun sendMessage() {
        val peer = activePeer ?: return
        val text = messageInput.text.toString().trim()
        if (text.isEmpty()) return
        lifecycleScope.launch {
            service?.chatNode?.send(peer, text)
            messages.add("me: $text")
            messagesAdapter.notifyDataSetChanged()
            messageInput.setText("")
        }
    }

    private fun showAttachDialog() {
        val peer = activePeer ?: return
        AlertDialog.Builder(this)
            .setTitle("Send to ${peer.name}")
            .setItems(arrayOf("Send an installed app…")) { _, _ -> showAppPickerDialog(peer, ApkShare.listUserInstalledApps(this)) }
            .show()
    }

    private fun showAppPickerDialog(peer: PeerInfo, apps: List<InstalledAppEntry>) {
        val labels = apps.map { it.label }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle("Choose an app to send")
            .setItems(labels) { _, index ->
                val entry = apps[index]
                lifecycleScope.launch {
                    val tempDir = File(cacheDir, "outgoing").apply { mkdirs() }
                    val fileToSend = ApkShare.toFileToSend(entry, tempDir)
                    val status = service?.transferClient?.sendFiles(peer, listOf(fileToSend))
                    Toast.makeText(this@MainActivity, "Sent ${entry.label}: $status", Toast.LENGTH_SHORT).show()
                }
            }
            .show()
    }

    /**
     * Pairing dialog, tied to one specific peer. Only a PIN needs to be
     * agreed on — see Pairing.kt / PROTOCOL.md §4 for why nothing else does.
     */
    private fun showPairingDialog(peer: PeerInfo) {
        val identity = IdentityStore.loadOrCreate(this)
        val generatedPin = Pairing.generatePin()

        val view = layoutInflater.inflate(R.layout.dialog_pairing, null)
        view.findViewById<TextView>(R.id.pairingPin).text = generatedPin
        val pinInput = view.findViewById<EditText>(R.id.theirCodeInput).apply {
            hint = "Or enter the PIN they gave you"
        }

        AlertDialog.Builder(this)
            .setTitle("Pair with ${'$'}{peer.name}")
            .setMessage("Tell them this PIN, or enter the one they told you, then tap Pair.")
            .setView(view)
            .setPositiveButton("Pair") { _, _ ->
                val typedPin = pinInput.text.toString().trim()
                val pin = if (typedPin.isNotEmpty()) typedPin else generatedPin
                // Re-read the live peer so we have its freshest publicKeyRaw.
                val livePeer = peersSnapshot.find { it.deviceId == peer.deviceId } ?: peer
                try {
                    Pairing.pairWithPeer(identity, livePeer, pin, TrustStore(this))
                    Toast.makeText(this, "Paired with ${'$'}{livePeer.name}", Toast.LENGTH_SHORT).show()
                    openChat(livePeer)
                } catch (e: Exception) {
                    AlertDialog.Builder(this)
                        .setTitle("Couldn't pair")
                        .setMessage(e.message)
                        .setPositiveButton("OK", null)
                        .show()
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    override fun onDestroy() {
        unbindService(connection)
        super.onDestroy()
    }
}
