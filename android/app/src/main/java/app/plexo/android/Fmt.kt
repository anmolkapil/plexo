package app.plexo.android

import java.util.Locale

fun fmtBytes(b: Long): String {
    if (b < 1024) return "$b B"
    val units = arrayOf("KB", "MB", "GB", "TB")
    var v = b.toDouble()
    var i = -1
    while (v >= 1024 && i < units.lastIndex) {
        v /= 1024
        i++
    }
    return String.format(Locale.US, if (v >= 100) "%.0f %s" else "%.1f %s", v, units[i])
}

fun fmtSpeed(bytesPerSecond: Long): String = fmtBytes(bytesPerSecond) + "/s"

fun fmtEta(remainingBytes: Long, speed: Long): String {
    if (speed <= 0 || remainingBytes <= 0) return ""
    val s = remainingBytes / speed
    return when {
        s >= 3600 -> "${s / 3600}h ${(s % 3600) / 60}m left"
        s >= 60 -> "${s / 60}m ${s % 60}s left"
        else -> "${s}s left"
    }
}
