package com.lanchat.core

import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.*
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

const val PARALLEL_STREAMS = 4

data class FileMeta(
    val name: String,
    val size: Long,
    val mime: String,
    val sha256: String,
    val isApp: Boolean = false,
    val appLabel: String? = null,
    val appPackage: String? = null,
)

data class FileToSend(val path: String, val name: String, val mime: String, val isApp: Boolean = false, val appLabel: String? = null, val appPackage: String? = null)

private fun byteRanges(size: Long, n: Int): List<LongArray> {
    val base = size / n
    var start = 0L
    val ranges = mutableListOf<LongArray>()
    for (i in 0 until n) {
        val len = if (i == n - 1) size - start else base
        ranges.add(longArrayOf(start, start + len - 1)) // inclusive
        start += len
    }
    return ranges
}

private fun sha256Of(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
        val buf = ByteArray(64 * 1024)
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            digest.update(buf, 0, n)
        }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
}

private fun uuidToBytes(uuid: String): ByteArray {
    val hex = uuid.replace("-", "")
    return ByteArray(16) { i -> hex.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
}
private fun bytesToUuid(b: ByteArray): String {
    val h = b.joinToString("") { "%02x".format(it) }
    return "${h.substring(0,8)}-${h.substring(8,12)}-${h.substring(12,16)}-${h.substring(16,20)}-${h.substring(20)}"
}

/** Receiving side: accepts offers, and on acceptance receives the parallel data streams. */
class TransferServer(
    private val self: SelfInfo,
    private val trustStore: TrustStore,
    private val receivedDir: File,
) {
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var controlServer: ServerSocket? = null
    private val dataServers = mutableListOf<ServerSocket>()

    private data class ActiveTransfer(
        val files: List<FileMeta>,
        val destFiles: List<File>,
        val sessionKey: ByteArray,
        val controlOut: DataOutputStream,
        val randomAccessFiles: List<RandomAccessFile>,
        val streamsDoneByFile: IntArray,
        var filesDone: Int = 0,
    )
    private val transfers = ConcurrentHashMap<String, ActiveTransfer>()

    var onOffer: ((transferId: String, from: String, files: List<FileMeta>) -> Unit)? = null
    var onComplete: ((transferId: String, status: String, destPaths: List<String>) -> Unit)? = null

    fun start() {
        receivedDir.mkdirs()
        controlServer = ServerSocket(self.transferPort)
        scope.launch { acceptLoop(controlServer!!) { handleControl(it) } }
        for (i in 1..PARALLEL_STREAMS) {
            val srv = ServerSocket(self.transferPort + i)
            dataServers.add(srv)
            scope.launch { acceptLoop(srv) { handleData(it, i - 1) } }
        }
    }

    private suspend fun acceptLoop(server: ServerSocket, handler: suspend (Socket) -> Unit) {
        while (currentCoroutineContext().isActive) {
            val socket = try { server.accept() } catch (_: Exception) { null } ?: break
            scope.launch { handler(socket) }
        }
    }

    private fun handleControl(socket: Socket) {
        val input = DataInputStream(socket.getInputStream())
        val output = DataOutputStream(socket.getOutputStream())

        val helloLen = input.readInt()
        val helloBytes = ByteArray(helloLen).also { input.readFully(it) }
        val hello = JSONObject(String(helloBytes))
        val peerDeviceId = hello.getString("deviceId")
        val sessionKey = trustStore.sessionKeyFor(peerDeviceId) ?: run { socket.close(); return }

        try {
            while (true) {
                val len = input.readInt()
                val frame = ByteArray(len).also { input.readFully(it) }
                val plaintext = CryptoUtil.decrypt(sessionKey, frame)
                val msg = JSONObject(String(plaintext))
                if (msg.getString("type") == "offer") {
                    val transferId = msg.getString("transferId")
                    val filesJson = msg.getJSONArray("files")
                    val files = (0 until filesJson.length()).map { i ->
                        val f = filesJson.getJSONObject(i)
                        FileMeta(
                            f.getString("name"), f.getLong("size"), f.getString("mime"), f.getString("sha256"),
                            f.optBoolean("isApp", false), f.optString("appLabel", null), f.optString("appPackage", null),
                        )
                    }
                    val destFiles = files.map { File(receivedDir, it.name) }
                    val rafs = destFiles.map { RandomAccessFile(it, "rw").apply { setLength(0) } }
                    transfers[transferId] = ActiveTransfer(files, destFiles, sessionKey, output, rafs, IntArray(files.size))
                    onOffer?.invoke(transferId, peerDeviceId, files)
                }
            }
        } catch (_: Exception) {
            // control channel closed after transfer completes — expected
        }
    }

    /** Call from UI once user taps Accept. */
    fun acceptTransfer(transferId: String) {
        val t = transfers[transferId] ?: return
        val plaintext = JSONObject().put("type", "accept").put("transferId", transferId).toString().toByteArray()
        val frame = CryptoUtil.encrypt(t.sessionKey, plaintext)
        synchronized(t.controlOut) {
            t.controlOut.writeInt(frame.size)
            t.controlOut.write(frame)
        }
    }

    private fun handleData(socket: Socket, expectedStreamIndex: Int) {
        val input = DataInputStream(socket.getInputStream())
        val header = ByteArray(20)
        input.readFully(header)
        val transferId = bytesToUuid(header.copyOfRange(0, 16))
        val fileIndex = ((header[16].toInt() and 0xFF) shl 8) or (header[17].toInt() and 0xFF)
        val streamIndex = ((header[18].toInt() and 0xFF) shl 8) or (header[19].toInt() and 0xFF)

        val t = transfers[transferId] ?: run { socket.close(); return }
        val range = byteRanges(t.files[fileIndex].size, PARALLEL_STREAMS)[streamIndex]
        val raf = t.randomAccessFiles[fileIndex]
        var pos = range[0]

        val buf = ByteArray(64 * 1024)
        try {
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                synchronized(raf) {
                    raf.seek(pos)
                    raf.write(buf, 0, n)
                }
                pos += n
            }
        } catch (_: Exception) { /* stream ended */ }

        val done = synchronized(t) {
            t.streamsDoneByFile[fileIndex] += 1
            t.streamsDoneByFile[fileIndex] == PARALLEL_STREAMS
        }
        if (done) {
            raf.close()
            checkFileAndMaybeFinish(transferId, fileIndex)
        }
    }

    private fun checkFileAndMaybeFinish(transferId: String, fileIndex: Int) {
        val t = transfers[transferId] ?: return
        val ok = sha256Of(t.destFiles[fileIndex]) == t.files[fileIndex].sha256
        val allDone = synchronized(t) {
            t.filesDone += 1
            t.filesDone == t.files.size
        }
        if (allDone) {
            val status = if (ok) "ok" else "checksum_failed"
            val plaintext = JSONObject().put("type", "complete").put("transferId", transferId).put("status", status).toString().toByteArray()
            val frame = CryptoUtil.encrypt(t.sessionKey, plaintext)
            synchronized(t.controlOut) {
                t.controlOut.writeInt(frame.size)
                t.controlOut.write(frame)
            }
            onComplete?.invoke(transferId, status, t.destFiles.map { it.absolutePath })
            transfers.remove(transferId)
        }
    }

    fun stop() {
        scope.cancel()
        controlServer?.close()
        dataServers.forEach { it.close() }
    }
}

/** Sending side: offers files (or an installed app's APK), then streams them once accepted. */
class TransferClient(private val self: SelfInfo, private val trustStore: TrustStore) {

    suspend fun sendFiles(peer: PeerInfo, files: List<FileToSend>): String = withContext(Dispatchers.IO) {
        val sessionKey = trustStore.sessionKeyFor(peer.deviceId)
            ?: throw IllegalStateException("Cannot send: peer is not paired yet")

        val transferId = UUID.randomUUID().toString()
        val metas = files.map {
            FileMeta(it.name, File(it.path).length(), it.mime, sha256Of(File(it.path)), it.isApp, it.appLabel, it.appPackage)
        }

        val controlSocket = Socket(peer.ip, peer.transferPort)
        val controlOut = DataOutputStream(controlSocket.getOutputStream())
        val controlIn = DataInputStream(controlSocket.getInputStream())

        val hello = JSONObject().put("type", "hello").put("deviceId", self.deviceId).toString().toByteArray()
        controlOut.writeInt(hello.size); controlOut.write(hello)

        val filesJson = JSONArray()
        metas.forEach { m ->
            filesJson.put(JSONObject().apply {
                put("name", m.name); put("size", m.size); put("mime", m.mime); put("sha256", m.sha256)
                put("isApp", m.isApp); m.appLabel?.let { put("appLabel", it) }; m.appPackage?.let { put("appPackage", it) }
            })
        }
        val offerPlain = JSONObject().put("type", "offer").put("transferId", transferId).put("files", filesJson).toString().toByteArray()
        val offerFrame = CryptoUtil.encrypt(sessionKey, offerPlain)
        controlOut.writeInt(offerFrame.size); controlOut.write(offerFrame)

        // Wait for accept, then stream, then wait for complete.
        var status = "unknown"
        while (true) {
            val len = controlIn.readInt()
            val frame = ByteArray(len).also { controlIn.readFully(it) }
            val msg = JSONObject(String(CryptoUtil.decrypt(sessionKey, frame)))
            when (msg.getString("type")) {
                "accept" -> streamAllFiles(peer, transferId, files, metas)
                "complete" -> { status = msg.getString("status"); controlSocket.close(); break }
            }
        }
        status
    }

    private suspend fun streamAllFiles(peer: PeerInfo, transferId: String, files: List<FileToSend>, metas: List<FileMeta>) = coroutineScope {
        for (fileIndex in files.indices) {
            val ranges = byteRanges(metas[fileIndex].size, PARALLEL_STREAMS)
            ranges.forEachIndexed { streamIndex, range ->
                launch(Dispatchers.IO) {
                    val socket = Socket(peer.ip, peer.transferPort + streamIndex + 1)
                    val out = socket.getOutputStream()
                    val header = ByteArray(20)
                    uuidToBytes(transferId).copyInto(header, 0)
                    header[16] = ((fileIndex shr 8) and 0xFF).toByte(); header[17] = (fileIndex and 0xFF).toByte()
                    header[18] = ((streamIndex shr 8) and 0xFF).toByte(); header[19] = (streamIndex and 0xFF).toByte()
                    out.write(header)

                    RandomAccessFile(files[fileIndex].path, "r").use { raf ->
                        raf.seek(range[0])
                        var remaining = range[1] - range[0] + 1
                        val buf = ByteArray(64 * 1024)
                        while (remaining > 0) {
                            val n = raf.read(buf, 0, minOf(buf.size.toLong(), remaining).toInt())
                            if (n < 0) break
                            out.write(buf, 0, n)
                            remaining -= n
                        }
                    }
                    socket.close()
                }
            }
        }
    }
}
