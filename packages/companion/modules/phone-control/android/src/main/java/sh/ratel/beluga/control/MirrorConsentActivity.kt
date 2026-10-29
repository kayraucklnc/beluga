package sh.ratel.beluga.control

import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionConfig
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.core.app.NotificationCompat

/**
 * A see-through screen that only shows Android's "Start now" sheet for the Mac's live mirror
 * (BLG-184), then hands the answer to MirrorService and goes. It runs in its own task, so whatever
 * app the user was in comes back underneath. Opened from the background by Beluga Phone Control
 * (its bound Accessibility service may do that); where Android still says no, a notification opens it instead.
 */
class MirrorConsentActivity : Activity() {
  override fun onCreate(saved: Bundle?) {
    super.onCreate(saved)
    shownAt = SystemClock.uptimeMillis()
    getSystemService(NotificationManager::class.java).cancel(NOTE_ID)
    if (saved != null) return
    val manager = getSystemService(MediaProjectionManager::class.java)
    // The whole screen only (Android 14's "one app" choice would mirror nothing useful).
    val sheet = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) manager.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay()) else manager.createScreenCaptureIntent()
    try {
      @Suppress("DEPRECATION")
      startActivityForResult(sheet, ASK)
    } catch (e: Exception) {
      MirrorService.declined("The phone couldn’t ask to share its screen")
      finish()
    }
  }

  @Deprecated("The platform's own result callback; this screen has nothing else to do")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    @Suppress("DEPRECATION")
    super.onActivityResult(requestCode, resultCode, data)
    if (requestCode == ASK) {
      if (resultCode == RESULT_OK && data != null) MirrorService.begin(this, resultCode, data) else MirrorService.declined()
    }
    finish()
    overridePendingTransition(0, 0)
  }

  companion object {
    private const val ASK = 1
    private const val NOTE_ID = 4210
    private const val CHANNEL = "mac-mirror-ask"
    @Volatile private var shownAt = 0L
    @Volatile private var askedAt = 0L

    /** Show "Start now" (at most once every few seconds, so repeated asks don't stack sheets). */
    fun ask(context: Context) {
      val now = SystemClock.uptimeMillis()
      if (now - askedAt < 5_000) return
      askedAt = now
      val open = Intent(context, MirrorConsentActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION)
      // From the background only Phone Control's bound Accessibility service may open a screen (BLG-377).
      val viaAddon = AddonClient.launch(PendingIntent.getActivity(context, 3, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
      if (!viaAddon) runCatching { context.startActivity(open) }
      // Android kept it from opening: a notification the user taps instead.
      Handler(Looper.getMainLooper()).postDelayed({ if (shownAt < now) notifyToAsk(context) }, 1_500)
    }

    private fun notifyToAsk(context: Context) {
      val nm = context.getSystemService(NotificationManager::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL) == null) {
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Your Mac asks to show this screen", NotificationManager.IMPORTANCE_HIGH).apply {
          description = "When your Mac opens its mirror of this phone"
        })
      }
      val tap = PendingIntent.getActivity(
        context, 2,
        Intent(context, MirrorConsentActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )
      val icon = context.resources.getIdentifier("notification_icon", "drawable", context.packageName).takeIf { it != 0 } ?: context.applicationInfo.icon
      nm.notify(NOTE_ID, NotificationCompat.Builder(context, CHANNEL)
        .setContentTitle("Show this screen on your Mac?")
        .setContentText("Tap for smooth live video in Beluga’s mirror")
        .setSmallIcon(icon)
        .setAutoCancel(true)
        .setContentIntent(tap)
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        .build())
    }
  }
}
