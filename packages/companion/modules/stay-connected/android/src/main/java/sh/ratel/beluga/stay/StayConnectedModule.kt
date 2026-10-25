package sh.ratel.beluga.stay

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** The app's handle on StayConnectedService: start (or update its line), stop, and the battery exemption. */
class StayConnectedModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("No React context")

  @SuppressLint("BatteryLife")
  override fun definition() = ModuleDefinition {
    Name("StayConnected")

    /** Start it (only from the front: Android refuses a foreground service started in the background), or just change its line. */
    Function("start") { text: String ->
      if (StayConnectedService.running) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
        nm.notify(StayConnectedService.ID, StayConnectedService.notification(context, text))
        return@Function
      }
      val intent = Intent(context, StayConnectedService::class.java).putExtra(StayConnectedService.EXTRA_TEXT, text)
      try {
        ContextCompat.startForegroundService(context, intent)
      } catch (e: Exception) {
        // In the background (ForegroundServiceStartNotAllowedException): it starts next time the app is in front.
      }
    }

    Function("stop") {
      context.stopService(Intent(context, StayConnectedService::class.java))
    }

    /** Whether Android's battery optimisation leaves the app alone (else Doze may still cut it off). */
    Function("unrestricted") {
      val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
      pm.isIgnoringBatteryOptimizations(context.packageName)
    }

    /** Android's own "Let Beluga run in the background?" prompt. */
    Function("askUnrestricted") {
      val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
    }
  }
}
