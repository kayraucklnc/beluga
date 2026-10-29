package sh.ratel.beluga.addon

import android.app.ActivityOptions
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.RemoteException
import org.json.JSONObject
import sh.ratel.beluga.control.link.ControlLink
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors

/**
 * Beluga Link's door for the Beluga app (BLG-377): the app binds this, says HELLO, and
 * sends the Mac's ops (PERFORM); they run in BelugaAccessibilityService and come back as RESULT.
 * Only an app signed with the same key gets an answer.
 */
class ControlService : Service() {
  private val work = Executors.newCachedThreadPool()
  private lateinit var messenger: Messenger

  override fun onCreate() {
    super.onCreate()
    messenger = Messenger(Incoming(Looper.getMainLooper()))
  }

  override fun onBind(intent: Intent?): IBinder = messenger.binder

  override fun onDestroy() {
    clients.clear()
    work.shutdown()
    super.onDestroy()
  }

  private inner class Incoming(looper: Looper) : Handler(looper) {
    override fun handleMessage(msg: Message) {
      if (!ControlLink.sameSigner(this@ControlService, msg.sendingUid)) return
      val reply = msg.replyTo
      when (msg.what) {
        ControlLink.HELLO -> if (reply != null) {
          if (clients.none { it.binder == reply.binder }) clients.add(reply)
          send(reply, state())
        }
        ControlLink.PERFORM -> if (reply != null) {
          val data = Bundle(msg.data)
          work.execute { send(reply, perform(data)) }
        }
        ControlLink.LAUNCH -> launch(msg.data)
      }
    }
  }

  private fun perform(data: Bundle): Message {
    val out = Message.obtain(null, ControlLink.RESULT)
    val bundle = Bundle().apply { putInt(ControlLink.K_ID, data.getInt(ControlLink.K_ID)) }
    try {
      val service = BelugaAccessibilityService.instance ?: throw IllegalStateException("Turn on Accessibility for Beluga Link on the phone")
      val args = data.getString(ControlLink.K_ARGS).orEmpty()
      val json = service.perform(data.getString(ControlLink.K_OP).orEmpty(), if (args.isBlank()) JSONObject() else JSONObject(args))
      // Bytes, not a String: a screen or a screenshot is half the size in a Binder parcel this way.
      bundle.putByteArray(ControlLink.K_OUT, json.toByteArray(Charsets.UTF_8))
    } catch (e: Throwable) {
      bundle.putString(ControlLink.K_ERROR, e.message ?: e.javaClass.simpleName)
    }
    out.data = bundle
    return out
  }

  /** Open one of the app's screens (the mirror's "Start now"): a bound Accessibility service may start activities from the background. */
  private fun launch(data: Bundle) {
    @Suppress("DEPRECATION") val intent = data.getParcelable<PendingIntent>(ControlLink.K_INTENT) ?: return
    val options = if (Build.VERSION.SDK_INT >= 34) {
      ActivityOptions.makeBasic().setPendingIntentBackgroundActivityStartMode(ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED).toBundle()
    } else null
    runCatching { intent.send(this, 0, null, null, null, null, options) }
  }

  companion object {
    private val clients = CopyOnWriteArrayList<Messenger>()

    private fun state(): Message = Message.obtain(null, ControlLink.STATE).apply {
      data = Bundle().apply { putBoolean(ControlLink.K_ON, BelugaAccessibilityService.instance != null) }
    }

    private fun send(to: Messenger, msg: Message) {
      try {
        to.send(msg)
      } catch (e: RemoteException) {
        clients.remove(to) // the app went away
      }
    }

    /** The service connected or went away, or the screen changed: tell the app so it re-reports control to the Mac. */
    fun onAccessibilityChanged() {
      for (c in clients) send(c, state())
    }
  }
}
