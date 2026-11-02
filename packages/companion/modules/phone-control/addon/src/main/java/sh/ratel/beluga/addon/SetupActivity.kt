package sh.ratel.beluga.addon

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.provider.Settings

/** Opening Beluga Link takes you to Android's Accessibility settings, where you turn it on. It has no screen of its own. */
class SetupActivity : Activity() {
  override fun onCreate(saved: Bundle?) {
    super.onCreate(saved)
    runCatching { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
    finish()
  }
}
