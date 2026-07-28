package com.lanchat.core

import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import androidx.core.content.FileProvider
import java.io.File

data class InstalledAppEntry(val label: String, val packageName: String, val apkPath: String)

/**
 * The Android-specific half of "Xender capability" (see PROTOCOL.md §8):
 * reading an installed app's own APK to send it, and installing one that
 * arrives from a peer.
 */
object ApkShare {

    /** Apps the user could choose to send — excludes system apps by default (usually not useful to share). */
    fun listUserInstalledApps(context: Context): List<InstalledAppEntry> {
        val pm = context.packageManager
        return pm.getInstalledApplications(PackageManager.GET_META_DATA)
            .filter { it.flags and ApplicationInfo.FLAG_SYSTEM == 0 }
            .mapNotNull { appInfo ->
                val sourceDir = appInfo.sourceDir ?: return@mapNotNull null
                InstalledAppEntry(
                    label = pm.getApplicationLabel(appInfo).toString(),
                    packageName = appInfo.packageName,
                    apkPath = sourceDir,
                )
            }
            .sortedBy { it.label.lowercase() }
    }

    fun toFileToSend(entry: InstalledAppEntry, tempCopyDir: File): FileToSend {
        // Copy out of the app's private APK location into our own cache so the
        // transfer client can open it as a normal file with a friendly name.
        val dest = File(tempCopyDir, "${entry.packageName}.apk")
        File(entry.apkPath).copyTo(dest, overwrite = true)
        return FileToSend(
            path = dest.absolutePath,
            name = "${entry.label}.apk",
            mime = "application/vnd.android.package-archive",
            isApp = true,
            appLabel = entry.label,
            appPackage = entry.packageName,
        )
    }

    /** Fires the system install prompt for a received APK. Requires REQUEST_INSTALL_PACKAGES (declared in manifest). */
    fun installReceivedApk(context: Context, apkFile: File) {
        val uri = FileProvider.getUriForFile(context, "com.lanchat.fileprovider", apkFile)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
    }
}
