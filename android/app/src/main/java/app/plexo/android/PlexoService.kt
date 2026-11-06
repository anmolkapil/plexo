package app.plexo.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Keeps the process (and so the downloads) alive while something is downloading. */
class PlexoService : Service() {
    companion object {
        private const val CHANNEL = "plexo_downloads"
        private const val ID = 1

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, PlexoService::class.java))
        }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var job: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Downloads", NotificationManager.IMPORTANCE_LOW))
        ServiceCompat.startForeground(this, ID, notification("Starting…"), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        if (job == null) {
            val engine = PlexoEngine.get(this)
            job = scope.launch {
                var idle = 0
                while (true) {
                    delay(1000)
                    val active = engine.activeCount.value
                    if (active == 0) {
                        // A few quiet seconds before stopping, so a download that is just starting isn't cut off.
                        if (++idle >= 4) {
                            stopSelf()
                            return@launch
                        }
                    } else {
                        idle = 0
                        val nets = engine.hub.links.value.count { it.enabled.value }
                        nm.notify(ID, notification("$active downloading · ${fmtSpeed(engine.totalSpeed.value)} over $nets network${if (nets == 1) "" else "s"}"))
                    }
                }
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        job = null
        super.onDestroy()
    }

    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle("Plexo")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
            .build()
    }
}
