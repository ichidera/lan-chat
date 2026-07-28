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

/**
 * Deliberately simple, single-Activity UI: a device list, and a chat screen.
 * All the interesting logic lives in core/*.kt and LanChatForegroundService;
 * this file just wires taps to those calls. A production app would likely
 * split this into Fragments + a proper adapter, but this keeps the protocol
 * layer fully decoupled from any UI framework choice.
 */
class MainActivity : AppCompatActivity() {

    private var service: LanChatForegroundService? = null
    private var activePeer: PeerInfo? = null

    private lateinit var peerListView: ListView
    private lateinit var chatContainer: LinearLayout
    private lateinit var peerContainer: LinearLayout
    private lateinit var chatTitle: TextView
    private lateinit var messagesView: ListView
    private lateinit var messageInput: EditText
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
            service?.transferServer?.onOffer = { transferId, from, files ->
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
                    // Auto-offer install if any received file looks like an APK.
                    paths.firstOrNull { it.endsWith(".apk") }?.let { ApkShare.installReceivedApk(this@MainActivity, File(it)) }
                }
            }
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
        messagesAdapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, messages)
        messagesView.adapter = messagesAdapter

        findViewById<Button>(R.id.pairButton).setOnClickListener { showPairingDialog() }
        findViewById<Button>(R.id.backButton).setOnClickListener { showPeerList() }
        findViewById<Button>(R.id.sendButton).setOnClickListener { sendMessage() }
        findViewById<Button>(R.id.attachButton).setOnClickListener { showAttachDialog() }

        startForegroundService(Intent(this, LanChatForegroundService::class.java))
        bindService(Intent(this, LanChatForegroundService::class.java), connection, Context.BIND_AUTO_CREATE)
    }

    private fun refreshPeerList() {
        val peers = service?.discovery?.peers?.values?.toList().orEmpty()
        val trustStore = TrustStore(this)
        val labels = peers.map { p ->
            val kind = if (p.kind == "desktop") "\uD83D\uDCBB" else "\uD83D\uDCF1"
            "$kind ${p.name}" + if (!trustStore.isPaired(p.deviceId)) " (not paired)" else ""
        }
        runOnUiThread {
            peerListView.adapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, labels)
            peerListView.setOnItemClickListener { _, _, position, _ ->
                val peer = peers[position]
                if (!trustStore.isPaired(peer.deviceId)) {
                    Toast.makeText(this, "Pair with this device first", Toast.LENGTH_SHORT).show()
                } else {
                    openChat(peer)
                }
            }
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

    /** Lets the user pick: send an installed app (the "Xender" capability), or a generic file. */
    private fun showAttachDialog() {
        val peer = activePeer ?: return
        val apps = ApkShare.listUserInstalledApps(this)
        val options = arrayOf("Send an installed app") + apps.take(0).map { it.label } // app list shown in sub-dialog below
        AlertDialog.Builder(this)
            .setTitle("Send to ${peer.name}")
            .setItems(arrayOf("Send an installed app…")) { _, _ -> showAppPickerDialog(peer, apps) }
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

    private fun showPairingDialog() {
        val identity = IdentityStore.loadOrCreate(this)
        val offer = Pairing.startPairing(identity)
        val view = layoutInflater.inflate(R.layout.dialog_pairing, null)
        view.findViewById<TextView>(R.id.pairingPin).text = offer.pin
        val theirCodeInput = view.findViewById<EditText>(R.id.theirCodeInput)

        AlertDialog.Builder(this)
            .setTitle("Pair this device")
            .setView(view)
            .setPositiveButton("Complete pairing") { _, _ ->
                try {
                    val theirOffer = Pairing.Offer.fromJson(theirCodeInput.text.toString())
                    Pairing.completePairing(theirOffer, identity, TrustStore(this))
                    Toast.makeText(this, "Paired with ${theirOffer.name}", Toast.LENGTH_SHORT).show()
                    refreshPeerList()
                } catch (e: Exception) {
                    Toast.makeText(this, "Could not parse pairing code: ${e.message}", Toast.LENGTH_LONG).show()
                }
            }
            .setNegativeButton("Close", null)
            .show()
    }

    override fun onDestroy() {
        unbindService(connection)
        super.onDestroy()
    }
}
