package sh.ratel.beluga.update

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import androidx.core.app.NotificationCompat

/**
 * What Android's installer says about an update (AppUpdateModule.install). When it wants the user
 * to confirm, its own page comes up if Beluga is in front, else a notification carries it (an app
 * in the background can't open a page). A success is rarely heard here: the new version replaces
 * this process, and ReplacedReceiver speaks for it.
 */
class UpdateReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
      PackageInstaller.STATUS_PENDING_USER_ACTION -> {
        val confirm = (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java) else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_INTENT)) ?: return
        confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.getSharedPreferences(AppUpdateModule.PREFS, Context.MODE_PRIVATE).edit().putBoolean(AppUpdateModule.QUIET, false).apply()
        val shown = AppUpdateModule.front && runCatching { context.startActivity(confirm) }.isSuccess
        if (!shown) notify(context, "A Beluga update is ready", "Tap to install it", PendingIntent.getActivity(context, 0, confirm, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        AppUpdateModule.emit("confirm")
      }
      PackageInstaller.STATUS_SUCCESS -> AppUpdateModule.emit("done")
      PackageInstaller.STATUS_FAILURE_ABORTED -> AppUpdateModule.emit("aborted")
      else -> AppUpdateModule.emit("failed", intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "Android said no ($status)")
    }
  }

  companion object {
    const val CHANNEL = "updates"
    const val ID = 4261

    fun notify(context: Context, title: String, text: String, tap: PendingIntent?) {
      val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (nm.getNotificationChannel(CHANNEL) == null) {
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Updates", NotificationManager.IMPORTANCE_DEFAULT).apply {
          description = "When a new version of Beluga is ready or installed"
          setShowBadge(false)
        })
      }
      val icon = context.resources.getIdentifier("notification_icon", "drawable", context.packageName).takeIf { it != 0 } ?: context.applicationInfo.icon
      val n = NotificationCompat.Builder(context, CHANNEL)
        .setContentTitle(title)
        .setContentText(text)
        .setSmallIcon(icon)
        .setAutoCancel(true)
        .setContentIntent(tap)
        .build()
      runCatching { nm.notify(ID, n) }
    }
  }
}

/** The new version is in. When it went in with the app away, a notification says so (tap: open Beluga). */
class ReplacedReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
    val prefs = context.getSharedPreferences(AppUpdateModule.PREFS, Context.MODE_PRIVATE)
    if (!prefs.getBoolean(AppUpdateModule.QUIET, false)) return
    prefs.edit().putBoolean(AppUpdateModule.QUIET, false).apply()
    val version = AppUpdateModule.installed(context).versionName ?: ""
    val open = context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
      PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
    UpdateReceiver.notify(context, "Beluga updated to $version", "Tap to open it and link to your Mac again", open)
  }
}
