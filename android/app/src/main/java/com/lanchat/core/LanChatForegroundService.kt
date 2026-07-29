package com.lanchat.core

import android.app.*
import android.content.Context
import android.content.Intent
import android.os.Binder
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import java.io.File

/**
 * Android kills background sockets aggressively once the app isn't visible.
 * A foreground service with a persistent (low-priority) notification is the
 * standard, expected way to say "this app is intentionally listening on the
 * network right now" — same reason music/VPN/download apps use one.
 */
class LanChatForegroundService : Service() {
    private lateinit var identity: Identity
    private lateinit var trustStore: TrustStore
    lateinit var discovery: Discovery
    lateinit var chatNode: ChatNode
    lateinit var transferServer: TransferServer
    lateinit var transferClient: TransferClient

    private val binder = LocalBinder()
    inner class LocalBinder : Binder() { fun getService(): LanChatForegroundService = this@LanChatForegroundService }
    override fun onBind(intent: Intent?): IBinder = binder

    override fun onCreate() {
        super.onCreate()
        identity = IdentityStore.loadOrCreate(this)
        trustStore = TrustStore(this)
        val self = SelfInfo(identity.deviceId, identity.name, chatPort = 47111, transferPort = 47112, publicKeyRaw = identity.publicKeyHex)

        discovery = Discovery(this, self).also { it.start() }
        chatNode = ChatNode(self, trustStore).also { it.start() }
        transferServer = TransferServer(self, trustStore, File(filesDir, "received")).also { it.start() }
        transferClient = TransferClient(self, trustStore)

        startForeground(NOTIFICATION_ID, buildNotification())
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    private fun buildNotification(): Notification {
        val channelId = "lanchat_service"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(channelId, "LAN Chat running", NotificationManager.IMPORTANCE_MIN)
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(channel)
        }
        return NotificationCompat.Builder(this, channelId)
            .setContentTitle("LAN Chat is active")
            .setContentText("Visible to devices on this network")
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth) // placeholder — swap for a real app icon asset
            .setOngoing(true)
            .build()
    }

    override fun onDestroy() {
        discovery.stop()
        chatNode.stop()
        transferServer.stop()
        super.onDestroy()
    }

    companion object { private const val NOTIFICATION_ID = 1 }
}
