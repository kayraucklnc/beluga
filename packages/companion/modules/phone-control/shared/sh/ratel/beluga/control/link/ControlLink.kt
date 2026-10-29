package sh.ratel.beluga.control.link

import android.content.Context
import android.content.pm.PackageManager
import android.os.Process

/**
 * How the Beluga app and Beluga Phone Control talk on the phone (BLG-377). The Accessibility
 * service lives in its own small app, so the main APK installs where Play Protect blocks sideloaded
 * apps that declare one. The app binds the add-on's ControlService and they swap Messenger
 * messages; each side only answers the other if it's signed with the same key.
 */
object ControlLink {
  const val APP_PACKAGE = "sh.ratel.beluga"
  const val ADDON_PACKAGE = "sh.ratel.beluga.control"
  const val ADDON_SERVICE = "sh.ratel.beluga.addon.ControlService"
  const val ADDON_SETUP = "sh.ratel.beluga.addon.SetupActivity"

  /** app → add-on, with replyTo: start sending me STATE (answered with one at once). */
  const val HELLO = 1
  /** app → add-on: run op K_OP with K_ARGS (JSON), answered with RESULT under the same K_ID. */
  const val PERFORM = 2
  /** add-on → app: K_ID, and K_OUT (UTF-8 JSON) or K_ERROR. */
  const val RESULT = 3
  /** add-on → app: K_ON, the Accessibility service is connected (also sent when the screen changes). */
  const val STATE = 4
  /** app → add-on: K_INTENT, a PendingIntent for one of the app's screens, opened from the background. */
  const val LAUNCH = 5

  const val K_ID = "id"
  const val K_OP = "op"
  const val K_ARGS = "args"
  const val K_OUT = "out"
  const val K_ERROR = "error"
  const val K_ON = "on"
  const val K_INTENT = "intent"

  /** The other side is ours: the same signing key as this app. */
  fun sameSigner(context: Context, uid: Int): Boolean =
    uid == Process.myUid() || context.packageManager.checkSignatures(Process.myUid(), uid) == PackageManager.SIGNATURE_MATCH
}
