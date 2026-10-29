package sh.ratel.beluga.control

import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import sh.ratel.beluga.control.link.ControlLink
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicInteger

/**
 * The app's line to Beluga Phone Control (BLG-377), the small add-on app that holds the
 * Accessibility service. It binds the add-on's ControlService when the add-on is installed and
 * signed with our key, keeps whether its Accessibility is on, and sends it the Mac's ops.
 */
object AddonClient {
  /** The add-on's Accessibility service is on and connected to us. */
  @Volatile var on = false
    private set

  /** Called (on the main thread) when `on` may have changed, or the screen changed. */
  @Volatile var onChange: (() -> Unit)? = null

  @Volatile private var service: Messenger? = null
  private var bound = false
  private val ids = AtomicInteger()
  private val pending = ConcurrentHashMap<Int, CompletableFuture<String>>()

  private val replies = Messenger(object : Handler(Looper.getMainLooper()) {
    override fun handleMessage(msg: Message) {
      when (msg.what) {
        ControlLink.STATE -> {
          on = msg.data.getBoolean(ControlLink.K_ON)
          onChange?.invoke()
        }
        ControlLink.RESULT -> {
          val future = pending.remove(msg.data.getInt(ControlLink.K_ID)) ?: return
          val error = msg.data.getString(ControlLink.K_ERROR)
          if (error != null) future.completeExceptionally(IllegalStateException(error))
          else future.complete(msg.data.getByteArray(ControlLink.K_OUT)?.toString(Charsets.UTF_8) ?: "{}")
        }
      }
    }
  })

  private val connection = object : ServiceConnection {
    override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
      val messenger = Messenger(binder ?: return)
      service = messenger
      runCatching { messenger.send(Message.obtain(null, ControlLink.HELLO).apply { replyTo = replies }) }
    }

    override fun onServiceDisconnected(name: ComponentName?) = lost()

    override fun onBindingDied(name: ComponentName?) {
      lost()
      // Reinstalled or updated: bind again next time someone asks.
      synchronized(this@AddonClient) { bound = false }
    }
  }

  private fun lost() {
    service = null
    on = false
    for (f in pending.values) f.completeExceptionally(IllegalStateException("Beluga Phone Control stopped"))
    pending.clear()
    onChange?.invoke()
  }

  fun installed(context: Context): Boolean = try {
    context.packageManager.getPackageInfo(ControlLink.ADDON_PACKAGE, 0)
    true
  } catch (e: PackageManager.NameNotFoundException) {
    false
  }

  /** Bind the add-on if it's here and ours (cheap when already bound). */
  @Synchronized fun connect(context: Context) {
    if (bound) return
    val pm = context.packageManager
    if (!installed(context) || pm.checkSignatures(context.packageName, ControlLink.ADDON_PACKAGE) != PackageManager.SIGNATURE_MATCH) return
    val intent = Intent().setClassName(ControlLink.ADDON_PACKAGE, ControlLink.ADDON_SERVICE)
    bound = runCatching { context.applicationContext.bindService(intent, connection, Context.BIND_AUTO_CREATE) }.getOrDefault(false)
  }

  /** Run one op in the add-on's Accessibility service (blocks; throws with its message on failure). */
  fun perform(op: String, args: String): String {
    val to = service ?: throw IllegalStateException(MISSING)
    val id = ids.incrementAndGet()
    val future = CompletableFuture<String>()
    pending[id] = future
    val msg = Message.obtain(null, ControlLink.PERFORM).apply {
      data = Bundle().apply {
        putInt(ControlLink.K_ID, id)
        putString(ControlLink.K_OP, op)
        putString(ControlLink.K_ARGS, args)
      }
      replyTo = replies
    }
    return try {
      to.send(msg)
      future.get(30, TimeUnit.SECONDS)
    } catch (e: ExecutionException) {
      throw e.cause ?: e
    } catch (e: TimeoutException) {
      throw IllegalStateException("Beluga Phone Control didn’t answer")
    } finally {
      pending.remove(id)
    }
  }

  /** Open one of our screens from the background through the add-on (it may; we may not). False when it isn't there. */
  fun launch(intent: PendingIntent): Boolean {
    val to = service ?: return false
    if (!on) return false
    return runCatching {
      to.send(Message.obtain(null, ControlLink.LAUNCH).apply { data = Bundle().apply { putParcelable(ControlLink.K_INTENT, intent) } })
    }.isSuccess
  }

  const val MISSING = "Install Beluga Phone Control on the phone and turn on its Accessibility"
}
