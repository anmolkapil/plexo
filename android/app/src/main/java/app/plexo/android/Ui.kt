package app.plexo.android

import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle

// Colours follow Plexo desktop's tokens (main.css): teal for Wi-Fi, amber for a phone/mobile link,
// steel for wired.

@Composable
fun PlexoTheme(content: @Composable () -> Unit) {
    val scheme = if (isSystemInDarkTheme()) darkColorScheme(
        background = Color(0xFF1B1E20), surface = Color(0xFF202325), surfaceVariant = Color(0xFF242729),
        onBackground = Color(0xFFEAE7E2), onSurface = Color(0xFFEAE7E2), onSurfaceVariant = Color(0xFFA9ADB2),
        primary = Color(0xFF4EA89A), onPrimary = Color(0xFF10201D), outline = Color(0xFF2B2F33),
        primaryContainer = Color(0xFF22312E), onPrimaryContainer = Color(0xFF7FC9BB),
    ) else lightColorScheme(
        background = Color(0xFFFFFFFF), surface = Color(0xFFFAFAFA), surfaceVariant = Color(0xFFF0F0F0),
        onBackground = Color(0xFF1D1D1F), onSurface = Color(0xFF1D1D1F), onSurfaceVariant = Color(0xFF6E6E73),
        primary = Color(0xFF1F8A70), onPrimary = Color(0xFFFFFFFF), outline = Color(0xFFE0E0E2),
        primaryContainer = Color(0xFFE6F6F2), onPrimaryContainer = Color(0xFF0E6B54),
    )
    MaterialTheme(colorScheme = scheme, content = content)
}

@Composable
private fun kindColor(kind: LinkKind): Color {
    val dark = isSystemInDarkTheme()
    return when (kind) {
        LinkKind.WIFI -> if (dark) Color(0xFF4EA89A) else Color(0xFF1F8A70)
        LinkKind.CELLULAR -> if (dark) Color(0xFFD8A44C) else Color(0xFFD97706)
        LinkKind.ETHERNET -> if (dark) Color(0xFF7F9BC0) else Color(0xFF4F6F94)
    }
}

@Composable
fun PlexoApp(engine: PlexoEngine) {
    val links by engine.hub.links.collectAsStateWithLifecycle()
    val downloads by engine.downloads.collectAsStateWithLifecycle()
    val total by engine.totalSpeed.collectAsStateWithLifecycle()
    var adding by remember { mutableStateOf(false) }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        floatingActionButton = {
            FloatingActionButton(
                onClick = { adding = true },
                containerColor = MaterialTheme.colorScheme.primary,
                contentColor = MaterialTheme.colorScheme.onPrimary,
            ) { Text("+", fontSize = 26.sp) }
        },
    ) { pad ->
        LazyColumn(
            modifier = Modifier.padding(pad).fillMaxSize(),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { Hero(total, links.count { it.enabled.value }) }
            item { NetworksRow(engine.hub, links) }
            if (links.size < 2) item {
                Text(
                    "Only one connection is up. Turn on mobile data while on Wi-Fi (or plug in a USB tether) and Plexo will use both.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp,
                )
            }
            if (downloads.isEmpty()) item {
                Text(
                    "No downloads yet. Tap + and paste a link, or share one to Plexo from your browser.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 14.sp,
                    modifier = Modifier.padding(top = 24.dp),
                )
            } else items(downloads, key = { it.id }) { DownloadCard(it, engine) }
            item { Spacer(Modifier.height(72.dp)) }
        }
    }
    if (adding) AddDialog(onDismiss = { adding = false }, onAdd = { engine.add(it); adding = false })
}

@Composable
private fun Hero(total: Long, networks: Int) {
    Column(Modifier.padding(top = 8.dp)) {
        Text("Plexo", fontSize = 28.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(4.dp))
        Text(
            if (total > 0) "${fmtSpeed(total)} combined" else "Ready",
            color = MaterialTheme.colorScheme.primary, fontSize = 20.sp, fontWeight = FontWeight.Medium,
        )
        Text(
            "$networks network${if (networks == 1) "" else "s"} in use",
            color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp,
        )
    }
}

@Composable
private fun NetworksRow(hub: NetworkHub, links: List<Link>) {
    if (links.isEmpty()) {
        Text("Looking for connections…", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 14.sp)
        return
    }
    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        links.forEach { NetworkChip(hub.nameOf(it), it) }
    }
}

@Composable
private fun NetworkChip(name: String, link: Link) {
    val enabled by link.enabled.collectAsStateWithLifecycle()
    val speed by link.speed.collectAsStateWithLifecycle()
    val color = kindColor(link.kind)
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.surfaceVariant,
        border = BorderStroke(1.dp, if (enabled) color else MaterialTheme.colorScheme.outline),
    ) {
        Row(Modifier.padding(start = 12.dp, top = 8.dp, bottom = 8.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(10.dp).clip(CircleShape).background(if (enabled) color else MaterialTheme.colorScheme.outline))
            Spacer(Modifier.width(10.dp))
            Column {
                Text(name, fontWeight = FontWeight.Medium, fontSize = 14.sp)
                Text(
                    if (enabled) fmtSpeed(speed) else "Off",
                    color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp,
                )
            }
            Spacer(Modifier.width(6.dp))
            Switch(checked = enabled, onCheckedChange = { link.enabled.value = it }, modifier = Modifier.scale(0.8f))
        }
    }
}

@Composable
private fun DownloadCard(item: DownloadItem, engine: PlexoEngine) {
    val ctx = LocalContext.current
    Surface(
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(item.name, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(statusLine(item), color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp)
            when {
                item.status == Status.DONE -> Unit
                item.total > 0 -> CombineBar(item)
                item.status == Status.RUNNING || item.status == Status.PROBING ->
                    LinearProgressIndicator(Modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.primary)
            }
            if (item.byKind.isNotEmpty()) Legend(item)
            Row(horizontalArrangement = Arrangement.End, modifier = Modifier.fillMaxWidth()) {
                when (item.status) {
                    Status.RUNNING -> TextButton({ engine.pause(item.id) }) { Text("Pause") }
                    Status.PAUSED, Status.FAILED -> TextButton({ engine.resume(item.id) }) {
                        Text(if (item.status == Status.FAILED) "Retry" else "Resume")
                    }
                    Status.DONE -> TextButton({ openFile(ctx, item) }) { Text("Open") }
                    Status.PROBING -> Unit
                }
                TextButton({ engine.remove(item.id) }) { Text("Remove") }
            }
        }
    }
}

private fun statusLine(i: DownloadItem): String = when (i.status) {
    Status.PROBING -> "Checking the link…"
    Status.RUNNING -> i.note ?: listOf(
        if (i.total > 0) "${fmtBytes(i.downloaded)} of ${fmtBytes(i.total)}" else fmtBytes(i.downloaded),
        fmtSpeed(i.speed),
        if (i.total > 0) fmtEta(i.total - i.downloaded, i.speed) else "",
    ).filter { it.isNotEmpty() }.joinToString(" · ")
    Status.PAUSED -> "Paused · ${fmtBytes(i.downloaded)}" + if (i.total > 0) " of ${fmtBytes(i.total)}" else ""
    Status.DONE -> "Saved to Downloads/Plexo · ${fmtBytes(i.total)}"
    Status.FAILED -> i.note ?: "Failed"
}

/** The progress bar, split by which network brought in each share of it. */
@Composable
private fun CombineBar(item: DownloadItem) {
    val colors = LinkKind.values().associateWith { kindColor(it) }
    val track = MaterialTheme.colorScheme.outline
    val frac = (item.downloaded.toFloat() / item.total).coerceIn(0f, 1f)
    Canvas(Modifier.fillMaxWidth().height(8.dp).clip(RoundedCornerShape(4.dp))) {
        drawRect(track, Offset.Zero, size)
        val sum = item.byKind.values.sum().coerceAtLeast(1L)
        val width = size.width * frac
        var x = 0f
        for (kind in LinkKind.values()) {
            val bytes = item.byKind[kind] ?: continue
            val w = width * bytes / sum
            drawRect(colors.getValue(kind), Offset(x, 0f), Size(w, size.height))
            x += w
        }
    }
}

@Composable
private fun Legend(item: DownloadItem) {
    val sum = item.byKind.values.sum().coerceAtLeast(1L)
    Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        for (kind in LinkKind.values()) {
            val bytes = item.byKind[kind] ?: continue
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(8.dp).clip(CircleShape).background(kindColor(kind)))
                Spacer(Modifier.width(6.dp))
                Text(
                    "${kind.label} ${100 * bytes / sum}%",
                    color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp,
                )
            }
        }
    }
}

private fun openFile(ctx: android.content.Context, item: DownloadItem) {
    val uri = item.uri?.let(Uri::parse) ?: return
    try {
        ctx.startActivity(
            Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, ctx.contentResolver.getType(uri) ?: "*/*")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    } catch (_: Exception) {
        Toast.makeText(ctx, "No app can open this file", Toast.LENGTH_SHORT).show()
    }
}

@Composable
private fun AddDialog(onDismiss: () -> Unit, onAdd: (String) -> Unit) {
    val clipboard = LocalClipboardManager.current
    var text by remember {
        mutableStateOf(clipboard.getText()?.text?.trim()?.takeIf { it.startsWith("http://") || it.startsWith("https://") } ?: "")
    }
    val valid = text.trim().startsWith("http://") || text.trim().startsWith("https://")
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("New download") },
        text = {
            OutlinedTextField(
                value = text, onValueChange = { text = it }, singleLine = true,
                label = { Text("Link") }, modifier = Modifier.fillMaxWidth(),
            )
        },
        confirmButton = { TextButton(onClick = { onAdd(text) }, enabled = valid) { Text("Download") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
