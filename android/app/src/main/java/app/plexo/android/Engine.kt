package app.plexo.android

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.URLDecoder
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicIntegerArray
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicLongArray
import kotlin.math.max
import kotlin.math.min

enum class Status { PROBING, RUNNING, PAUSED, DONE, FAILED }

data class DownloadItem(
    val id: String,
    val url: String,
    val name: String,
    val total: Long,
    val downloaded: Long,
    val status: Status,
    val speed: Long,
    val byKind: Map<LinkKind, Long>,
    val note: String?,
    val uri: String?,
    val createdAt: Long,
)

private const val MIB = 1024L * 1024L
private const val STREAMS_PER_LINK = 6
private const val UA = "Mozilla/5.0 (Linux; Android 15) Plexo/0.1"

/** What the server told us about the file. */
private class Probe(val finalUrl: String, val name: String, val total: Long, val splittable: Boolean)

/**
 * A download cut into blocks. Streams on every network pull blocks from one shared pool, so a fast
 * network ends up taking more of them; when no block is left, idle streams race the slowest
 * in-flight block (same idea as Plexo desktop's scheduler).
 */
private class Task(
    val id: String,
    val url: String,
    var name: String,
    var total: Long,
    val splittable: Boolean,
    val blockSize: Long,
    var uri: String?,
    val createdAt: Long,
    savedCommitted: LongArray? = null,
) {
    val blockCount: Int = if (splittable && total > 0) ((total + blockSize - 1) / blockSize).toInt() else 1

    fun blockStart(i: Int): Long = if (splittable) i * blockSize else 0L
    fun blockEnd(i: Int): Long = when {
        splittable -> min((i + 1) * blockSize, total) - 1
        total > 0 -> total - 1
        else -> Long.MAX_VALUE - 1
    }

    /** Absolute offset up to which each block is on disk. */
    val committed = AtomicLongArray(blockCount)

    /** 0 free, 1 being fetched, 2 being raced, 3 done. */
    val state = AtomicIntegerArray(blockCount)
    val byKind = ConcurrentHashMap<LinkKind, AtomicLong>()
    val calls: MutableSet<Call> = ConcurrentHashMap.newKeySet()

    @Volatile var status = Status.PAUSED
    @Volatile var note: String? = null
    @Volatile var eof = false
    @Volatile var speed = 0L
    @Volatile var job: Job? = null

    init {
        for (i in 0 until blockCount) {
            val saved = savedCommitted?.getOrNull(i)
            committed.set(i, if (saved != null && saved >= blockStart(i)) saved else blockStart(i))
            if (splittable && committed.get(i) > blockEnd(i)) state.set(i, 3)
        }
    }

    fun received(kind: LinkKind): AtomicLong = byKind.getOrPut(kind) { AtomicLong() }
    fun receivedTotal(): Long = byKind.values.sumOf { it.get() }

    fun downloaded(): Long {
        var sum = 0L
        for (i in 0 until blockCount) sum += max(0L, min(committed.get(i), blockEnd(i) + 1) - blockStart(i))
        return sum
    }

    fun complete(): Boolean {
        if (eof) return true
        if (!splittable || total <= 0) return false
        for (i in 0 until blockCount) if (committed.get(i) <= blockEnd(i)) return false
        return true
    }

    fun toItem(): DownloadItem = DownloadItem(
        id, url, name, total, downloaded(), status,
        if (status == Status.RUNNING) speed else 0L,
        byKind.mapValues { it.value.get() }, note, uri, createdAt,
    )

    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id); put("url", url); put("name", name); put("total", total)
        put("splittable", splittable); put("blockSize", blockSize); put("uri", uri)
        put("createdAt", createdAt)
        put("status", status.name)
        put("committed", JSONArray().also { a -> for (i in 0 until blockCount) a.put(committed.get(i)) })
        put("byKind", JSONObject().also { o -> byKind.forEach { (k, v) -> o.put(k.name, v.get()) } })
    }

    companion object {
        fun fromJson(o: JSONObject): Task {
            val arr = o.getJSONArray("committed")
            val t = Task(
                o.getString("id"), o.getString("url"), o.getString("name"), o.getLong("total"),
                o.getBoolean("splittable"), o.getLong("blockSize"),
                if (o.isNull("uri")) null else o.getString("uri"),
                o.optLong("createdAt", System.currentTimeMillis()),
                LongArray(arr.length()) { arr.getLong(it) },
            )
            val saved = Status.valueOf(o.getString("status"))
            t.status = if (saved == Status.DONE) Status.DONE else if (saved == Status.FAILED) Status.FAILED else Status.PAUSED
            o.optJSONObject("byKind")?.let { b ->
                b.keys().forEach { k -> runCatching { t.received(LinkKind.valueOf(k)).set(b.getLong(k)) } }
            }
            if (t.status == Status.DONE) t.eof = true
            return t
        }
    }
}

class PlexoEngine private constructor(private val app: Context) {
    companion object {
        @Volatile private var instance: PlexoEngine? = null
        fun get(context: Context): PlexoEngine = instance ?: synchronized(this) {
            instance ?: PlexoEngine(context.applicationContext).also { instance = it }
        }
    }

    val hub = NetworkHub(app)
    val downloads = MutableStateFlow<List<DownloadItem>>(emptyList())
    val totalSpeed = MutableStateFlow(0L)
    val activeCount = MutableStateFlow(0)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val tasks = ConcurrentHashMap<String, Task>()
    private val probing = ConcurrentHashMap<String, DownloadItem>()
    private val dir = File(app.filesDir, "downloads").apply { mkdirs() }

    init {
        hub.start()
        dir.listFiles { f -> f.extension == "json" }?.forEach { f ->
            runCatching { Task.fromJson(JSONObject(f.readText())) }.getOrNull()?.let { tasks[it.id] = it }
        }
        publish()
        scope.launch { ticker() }
    }

    // ---- public actions -------------------------------------------------------------------

    fun add(rawUrl: String) {
        val url = rawUrl.trim()
        val id = UUID.randomUUID().toString()
        val now = System.currentTimeMillis()
        probing[id] = DownloadItem(id, url, url, 0, 0, Status.PROBING, 0, emptyMap(), null, null, now)
        publish()
        scope.launch {
            try {
                val p = probe(url)
                val nets = max(2, hub.links.value.size)
                val target = nets.toLong() * STREAMS_PER_LINK * 2
                val block = if (p.splittable) ((p.total + target - 1) / target).coerceIn(MIB, 8 * MIB) else 1L
                val t = Task(id, p.finalUrl, p.name, p.total, p.splittable, block, null, now)
                tasks[id] = t
                probing.remove(id)
                start(t)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                probing[id]?.let { probing[id] = it.copy(status = Status.FAILED, note = e.message ?: "Couldn't reach the link") }
            }
            publish()
        }
    }

    fun pause(id: String) {
        val t = tasks[id] ?: return
        if (t.status != Status.RUNNING) return
        t.status = Status.PAUSED
        t.calls.forEach { it.cancel() }
        t.job?.cancel()
        save(t)
        publish()
    }

    fun resume(id: String) {
        val t = tasks[id]
        if (t != null) {
            if (t.status == Status.PAUSED || t.status == Status.FAILED) start(t)
            return
        }
        probing[id]?.let { probing.remove(id); add(it.url) }
    }

    fun remove(id: String) {
        probing.remove(id)
        tasks.remove(id)?.let { t ->
            val keepFile = t.status == Status.DONE
            t.status = Status.PAUSED
            t.calls.forEach { it.cancel() }
            t.job?.cancel()
            File(dir, "$id.json").delete()
            // A finished file stays in Downloads; a half-written one goes.
            val uri = t.uri
            if (!keepFile && uri != null) runCatching { app.contentResolver.delete(Uri.parse(uri), null, null) }
        }
        publish()
    }

    // ---- running a task -------------------------------------------------------------------

    private fun start(t: Task) {
        if (t.job?.isActive == true) return
        t.status = Status.RUNNING
        t.note = null
        PlexoService.start(app)
        t.job = scope.launch {
            try {
                run(t)
                if (t.complete()) finish(t)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                t.status = Status.FAILED
                t.note = e.message ?: e.javaClass.simpleName
            } finally {
                save(t)
                publish()
            }
        }
        publish()
    }

    private suspend fun run(t: Task) = coroutineScope {
        val fd = openFile(t)
        val out = FileOutputStream(fd.fileDescriptor).channel
        val running = HashMap<String, List<Job>>()
        try {
            while (isActive && !t.complete()) {
                val links = hub.links.value
                for (link in links) {
                    if (!link.enabled.value || !link.alive) continue
                    if (running[link.id]?.any { it.isActive } == true) continue
                    val streams = when {
                        t.splittable -> {
                            var left = 0
                            for (i in 0 until t.blockCount) if (t.state.get(i) != 3) left++
                            max(1, min(STREAMS_PER_LINK, left))
                        }
                        running.values.flatten().none { it.isActive } -> 1
                        else -> 0
                    }
                    running[link.id] = (0 until streams).map { launch(Dispatchers.IO) { worker(link, t, out) } }
                }
                t.note = if (links.none { it.enabled.value }) "Waiting for a network…" else null
                delay(400)
            }
        } finally {
            withContext(NonCancellable) {
                running.values.flatten().forEach { it.cancel() }
                t.calls.forEach { it.cancel() }
                runCatching { out.close() }
                runCatching { fd.close() }
            }
        }
    }

    private suspend fun worker(link: Link, t: Task, out: FileChannel) {
        var fails = 0
        while (currentCoroutineContext().isActive && link.alive && link.enabled.value && !t.complete()) {
            val b = claim(t) ?: return
            try {
                fetch(link, t, b, out)
                fails = 0
            } catch (e: CancellationException) {
                release(t, b)
                throw e
            } catch (e: IOException) {
                release(t, b)
                fails++
                delay(min(4000L, 300L shl min(fails, 5)))
            }
        }
    }

    private fun claim(t: Task): Int? {
        for (i in 0 until t.blockCount) {
            if (t.state.get(i) == 0 && t.state.compareAndSet(i, 0, 1)) {
                if (t.splittable && t.committed.get(i) > t.blockEnd(i)) {
                    t.state.set(i, 3)
                    continue
                }
                return i
            }
        }
        if (!t.splittable) return null
        // Nothing free: race the in-flight block with the most left, if it's worth a second request.
        var best = -1
        var most = 0L
        for (i in 0 until t.blockCount) {
            if (t.state.get(i) == 1) {
                val left = t.blockEnd(i) + 1 - t.committed.get(i)
                if (left > most) { most = left; best = i }
            }
        }
        if (best >= 0 && most > 512 * 1024 && t.state.compareAndSet(best, 1, 2)) return best
        return null
    }

    private fun release(t: Task, b: Int) {
        if (!t.state.compareAndSet(b, 2, 1)) t.state.compareAndSet(b, 1, 0)
    }

    private fun fetch(link: Link, t: Task, b: Int, out: FileChannel) {
        val begin = if (t.splittable) max(t.committed.get(b), t.blockStart(b)) else 0L
        val end = t.blockEnd(b)
        val rb = Request.Builder().url(t.url)
            .header("User-Agent", UA)
            // Byte ranges refer to the stored bytes, so never let anything compress them.
            .header("Accept-Encoding", "identity")
        if (t.splittable) rb.header("Range", "bytes=$begin-$end")
        val call = link.client.newCall(rb.build())
        t.calls.add(call)
        try {
            call.execute().use { resp ->
                if (t.splittable && resp.code != 206) throw IOException("Server answered ${resp.code} to a range request")
                if (!resp.isSuccessful) throw IOException("HTTP ${resp.code}")
                val input = resp.body!!.byteStream()
                val buf = ByteArray(64 * 1024)
                var pos = begin
                if (!t.splittable) t.committed.set(0, 0)
                while (true) {
                    if (t.status != Status.RUNNING || !link.enabled.value || !link.alive) break
                    val limit = if (t.splittable) min(buf.size.toLong(), end + 1 - pos).toInt() else buf.size
                    if (limit <= 0) break
                    val n = input.read(buf, 0, limit)
                    if (n < 0) {
                        if (!t.splittable) { t.total = pos; t.eof = true }
                        break
                    }
                    val bb = ByteBuffer.wrap(buf, 0, n)
                    var p = pos
                    while (bb.hasRemaining()) p += out.write(bb, p)
                    pos += n
                    t.committed.accumulateAndGet(b, pos) { a, v -> max(a, v) }
                    t.received(link.kind).addAndGet(n.toLong())
                    link.bytes.addAndGet(n.toLong())
                }
            }
        } finally {
            t.calls.remove(call)
        }
        if ((t.splittable && t.committed.get(b) > end) || t.eof) t.state.set(b, 3) else release(t, b)
    }

    // ---- files ----------------------------------------------------------------------------

    private fun openFile(t: Task): ParcelFileDescriptor {
        val resolver = app.contentResolver
        if (t.uri == null) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, t.name)
                put(MediaStore.Downloads.MIME_TYPE, mimeFor(t.name))
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Plexo")
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: throw IOException("Couldn't create the file in Downloads")
            t.uri = uri.toString()
        }
        return resolver.openFileDescriptor(Uri.parse(t.uri), "rw")
            ?: throw IOException("Couldn't open the file in Downloads")
    }

    private fun finish(t: Task) {
        if (t.total <= 0) t.total = t.downloaded()
        t.uri?.let {
            val v = ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }
            runCatching { app.contentResolver.update(Uri.parse(it), v, null, null) }
        }
        t.status = Status.DONE
    }

    private fun mimeFor(name: String): String =
        MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase())
            ?: "application/octet-stream"

    private fun save(t: Task) {
        runCatching { File(dir, "${t.id}.json").writeText(t.toJson().toString()) }
    }

    // ---- probing --------------------------------------------------------------------------

    private suspend fun probe(url: String): Probe = withContext(Dispatchers.IO) {
        require(url.startsWith("http://") || url.startsWith("https://")) { "Only http and https links work" }
        val client = hub.links.value.firstOrNull()?.client ?: hub.base
        // A one-byte range request tells us the size and whether ranges work, where HEAD is often refused.
        val req = Request.Builder().url(url).header("User-Agent", UA)
            .header("Accept-Encoding", "identity").header("Range", "bytes=0-0").build()
        client.newCall(req).execute().use { r ->
            if (!r.isSuccessful) throw IOException("The server answered ${r.code}")
            val range = r.header("Content-Range")
            val total = if (r.code == 206 && range != null) range.substringAfter('/').toLongOrNull()
            else r.header("Content-Length")?.toLongOrNull()
            val finalUrl = r.request.url
            Probe(
                finalUrl = finalUrl.toString(),
                name = fileName(r.header("Content-Disposition"), finalUrl.encodedPath),
                total = total ?: 0L,
                splittable = r.code == 206 && total != null && total > 0,
            )
        }
    }

    private fun fileName(disposition: String?, path: String): String {
        val fromHeader = disposition?.let { d ->
            Regex("filename\\*\\s*=\\s*[^']*'[^']*'([^;]+)", RegexOption.IGNORE_CASE).find(d)?.groupValues?.get(1)
                ?.let { runCatching { URLDecoder.decode(it.trim().trim('"'), "UTF-8") }.getOrNull() }
                ?: Regex("filename\\s*=\\s*\"?([^\";]+)\"?", RegexOption.IGNORE_CASE).find(d)?.groupValues?.get(1)
        }
        val raw = fromHeader ?: path.substringAfterLast('/').let { runCatching { URLDecoder.decode(it, "UTF-8") }.getOrDefault(it) }
        val clean = raw.replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), "_").trim().trim('.')
        return clean.ifEmpty { "download" }.take(160)
    }

    // ---- progress -------------------------------------------------------------------------

    private fun publish() {
        downloads.value = (probing.values + tasks.values.map { it.toItem() }).sortedByDescending { it.createdAt }
    }

    private suspend fun ticker() {
        val lastLink = HashMap<String, Long>()
        val lastTask = HashMap<String, Long>()
        var tick = 0
        while (true) {
            delay(500)
            tick++
            for (l in hub.links.value) {
                val now = l.bytes.get()
                val d = now - (lastLink[l.id] ?: now)
                lastLink[l.id] = now
                l.speed.value = ((l.speed.value + d * 2) / 2)
            }
            var total = 0L
            var active = probing.values.count { it.status == Status.PROBING }
            for (t in tasks.values) {
                if (t.status == Status.RUNNING) {
                    active++
                    val n = t.receivedTotal()
                    val d = n - (lastTask[t.id] ?: n)
                    lastTask[t.id] = n
                    t.speed = (t.speed + d * 2) / 2
                    total += t.speed
                    if (tick % 4 == 0) save(t)
                } else {
                    t.speed = 0
                    lastTask.remove(t.id)
                }
            }
            totalSpeed.value = total
            activeCount.value = active
            publish()
        }
    }
}
