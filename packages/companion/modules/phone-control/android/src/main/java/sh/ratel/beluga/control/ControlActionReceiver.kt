package sh.ratel.beluga.control

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** The Stop button on the "Your Mac is using this phone" notification (BLG-150). */
class ControlActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == ACTION_STOP) PhoneControlModule.onStopRequested(context)
  }

  companion object {
    const val ACTION_STOP = "sh.ratel.beluga.control.STOP"
  }
}
