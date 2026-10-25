package sh.ratel.beluga.stay

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat

/**
 * Stay connected (docs/companion.md, "Staying connected", BLG-128): a foreground service, so
 * Android keeps the app's process (and with it the link's worklet) running with the screen off,
 * and a partial wake lock so its heartbeat still beats. Its notification is quiet and ongoing:
 * Android requires one, and it says what's going on. Nothing here talks to the network: the app
 * does, as when it's in front.
 */
class StayConnectedService : Service() {
  private var lock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: "Connected to your Mac"
    val note = notification(this, text)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(ID, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
    } else {
      startForeground(ID, note)
    }
    running = true
    if (lock == null) {
      val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
      lock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "beluga:stay-connected").apply {
        setReferenceCounted(false)
        acquire()
      }
    }
    // Killed with the app: it comes back when the app does (the app starts it again), never alone.
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    running = false
    lock?.let { if (it.isHeld) it.release() }
    lock = null
    super.onDestroy()
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    // Swiped away from recents: the link's gone with the app, so the service goes too.
    stopSelf()
    super.onTaskRemoved(rootIntent)
  }

  companion object {
    const val ID = 4207
    const val CHANNEL = "stay-connected"
    const val EXTRA_TEXT = "text"
    @Volatile var running = false

    fun notification(context: Context, text: String): Notification {
      val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL) == null) {
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Staying connected", NotificationManager.IMPORTANCE_MIN).apply {
          description = "Shown while Beluga stays connected to your Mac in the background"
          setShowBadge(false)
        })
      }
      val open = context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
        PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      }
      val icon = context.resources.getIdentifier("notification_icon", "drawable", context.packageName).takeIf { it != 0 } ?: context.applicationInfo.icon
      return NotificationCompat.Builder(context, CHANNEL)
        .setContentTitle("Beluga")
        .setContentText(text)
        .setSmallIcon(icon)
        .setOngoing(true)
        .setSilent(true)
        .setPriority(NotificationCompat.PRIORITY_MIN)
        .setCategory(NotificationCompat.CATEGORY_SERVICE)
        .setContentIntent(open)
        .build()
    }
  }
}
