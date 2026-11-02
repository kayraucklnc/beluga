package sh.ratel.beluga.control

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.SystemClock
import android.util.Base64
import android.util.DisplayMetrics
import android.view.Display
import android.view.Surface
import androidx.core.app.NotificationCompat
import org.json.JSONObject

/**
 * The Mac's mirror as live video (BLG-184). Android's screen capture (MediaProjection, which the
 * user allows with "Start now") draws the screen into the hardware H.264 encoder; each piece it
 * makes goes to the app's JS as a "mirror" event, and on to the Mac as a `vid` frame. Smooth over
 * sharp: the longest side `max` (1280 by default), up to 30 fps, a few Mbit/s.
 *
 * Pacing: the Mac acks every piece. With too many unanswered (a slow link), pieces are skipped up to
 * the next key frame, asked for once the link catches up, so the picture never falls behind. When
 * the Mac stops watching, the encoder stops and the capture is kept a while (opening the mirror
 * again doesn't ask again), then let go. A notification with Stop shows the whole time.
 */
class MirrorService : Service() {
  private data class Params(val max: Int = 1280, val fps: Int = 30, val kbps: Int = 2500)
  private data class Px(val w: Int, val h: Int)

  private val thread = HandlerThread("beluga-mirror").apply { start() }
  private val handler = Handler(thread.looper)
  private var projection: MediaProjection? = null
  private var display: VirtualDisplay? = null
  private var codec: MediaCodec? = null
  private var input: Surface? = null
  private var drain: Thread? = null
  @Volatile private var draining = false
  private var params = Params()
  @Volatile private var screen = Px(0, 0)
  private var ended = false

  // Pacing, by the Mac's acks.
  @Volatile private var seq = 0
  @Volatile private var acked = -1
  @Volatile private var lastAckAt = 0L
  @Volatile private var skipping = false
  @Volatile private var keyAsked = false
  @Volatile private var pausing = false
  private var config: ByteArray? = null

  private val releaseLater = Runnable { end(null, notify = false) }

  private val displays = object : DisplayManager.DisplayListener {
    override fun onDisplayAdded(id: Int) {}
    override fun onDisplayRemoved(id: Int) {}
    override fun onDisplayChanged(id: Int) {
      // Turned sideways (or the resolution changed): a new encoder of the new shape.
      if (id == Display.DEFAULT_DISPLAY && codec != null && realSize() != screen) startEncoder()
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> handler.post { end("Stopped on the phone") }
      ACTION_BEGIN -> {
        // Android 14: the foreground service (type mediaProjection) runs first, then the capture starts.
        goForeground()
        val code = intent.getIntExtra(EXTRA_CODE, 0)
        val data: Intent? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) intent.getParcelableExtra(EXTRA_DATA, Intent::class.java) else @Suppress("DEPRECATION") intent.getParcelableExtra(EXTRA_DATA)
        handler.post { if (data != null) begin(code, data) else end("Android didn’t start the screen capture") }
      }
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    handler.post { end(null, notify = false) }
    thread.quitSafely()
    super.onDestroy()
  }

  // ---- on the mirror thread

  private fun begin(code: Int, data: Intent) {
    ended = false
    try {
      val manager = getSystemService(MediaProjectionManager::class.java)
      val p = manager.getMediaProjection(code, data) ?: throw IllegalStateException("Android didn’t start the screen capture")
      p.registerCallback(object : MediaProjection.Callback() {
        override fun onStop() {
          handler.post { end("The phone stopped sharing its screen") }
        }
      }, handler)
      projection = p
      instance = this
      params = wanted
      getSystemService(DisplayManager::class.java).registerDisplayListener(displays, handler)
      startEncoder()
    } catch (e: Throwable) {
      end(e.message ?: "The screen capture didn’t start")
    }
  }

  /** The Mac asked again (maybe with another size): play, from a key frame. */
  private fun play(p: Params) {
    handler.removeCallbacks(releaseLater)
    if (codec == null || p != params) {
      params = p
      startEncoder()
    } else {
      acked = seq - 1
      lastAckAt = SystemClock.uptimeMillis()
      skipping = false
      requestKey()
    }
  }

  /** The Mac stopped watching: no more encoding, and let the capture go if it doesn't come back. */
  private fun pause() {
    stopEncoder()
    handler.removeCallbacks(releaseLater)
    handler.postDelayed(releaseLater, KEEP_MS)
  }

  private fun startEncoder() {
    val p = projection ?: return
    stopEncoder()
    try {
      val real = realSize()
      screen = real
      val scale = minOf(1f, params.max.toFloat() / maxOf(real.w, real.h))
      val w = even(real.w * scale)
      val h = even(real.h * scale)
      val c = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
      try {
        c.configure(format(w, h, tuned = true), null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
      } catch (e: Exception) {
        // An encoder that dislikes a tuning key: the plain format.
        c.reset()
        c.configure(format(w, h, tuned = false), null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
      }
      val surface = c.createInputSurface()
      c.start()
      codec = c
      input = surface
      val dpi = resources.displayMetrics.densityDpi
      val d = display
      if (d == null) {
        // Once per capture (Android 14): later encoders reuse it through setSurface.
        display = p.createVirtualDisplay("Beluga mirror", w, h, dpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, surface, null, null)
      } else {
        d.resize(w, h, dpi)
        d.surface = surface
      }
      acked = seq - 1
      lastAckAt = SystemClock.uptimeMillis()
      skipping = false
      keyAsked = false
      pausing = false
      config = null
      draining = true
      drain = Thread({ drainLoop(c, w, h) }, "beluga-mirror-out").apply { start() }
    } catch (e: Throwable) {
      end(e.message ?: "The phone’s video encoder didn’t start")
    }
  }

  private fun stopEncoder() {
    draining = false
    drain?.let { if (it !== Thread.currentThread()) it.join(600) }
    drain = null
    display?.surface = null
    codec?.let {
      runCatching { it.stop() }
      runCatching { it.release() }
    }
    codec = null
    input?.release()
    input = null
  }

  private fun end(reason: String?, notify: Boolean = true) {
    if (ended) return
    ended = true
    handler.removeCallbacks(releaseLater)
    stopEncoder()
    runCatching { display?.release() }
    display = null
    runCatching { projection?.stop() }
    projection = null
    runCatching { getSystemService(DisplayManager::class.java).unregisterDisplayListener(displays) }
    if (instance === this) instance = null
    if (notify) PhoneControlModule.emitMirrorEnd(reason)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE) else @Suppress("DEPRECATION") stopForeground(true)
    stopSelf()
  }

  // ---- the encoder's output, on its own thread

  private fun drainLoop(c: MediaCodec, w: Int, h: Int) {
    val info = MediaCodec.BufferInfo()
    while (draining) {
      val i = try {
        c.dequeueOutputBuffer(info, 100_000)
      } catch (e: IllegalStateException) {
        break
      }
      if (i < 0) {
        watchdog()
        continue
      }
      val bytes = ByteArray(info.size)
      c.getOutputBuffer(i)?.let { buf ->
        buf.position(info.offset)
        buf.limit(info.offset + info.size)
        buf.get(bytes)
      }
      c.releaseOutputBuffer(i, false)
      if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
        config = bytes
        continue
      }
      if (bytes.isEmpty()) continue
      val key = info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0
      val sps = config
      send(if (key && sps != null) sps + bytes else bytes, key, info.presentationTimeUs, w, h)
      watchdog()
    }
  }

  private fun send(bytes: ByteArray, key: Boolean, ts: Long, w: Int, h: Int) {
    val behind = seq - 1 - acked
    if (behind > WINDOW || bytes.size > VID_MAX) {
      skipping = true
      return
    }
    if (skipping && !key) return
    skipping = false
    keyAsked = false
    val n = seq++
    PhoneControlModule.emitMirror(n, Base64.encodeToString(bytes, Base64.NO_WRAP), key, ts, w, h, screen.w, screen.h)
  }

  /** No word from the Mac for a while (the link dropped, the Mac slept): stop encoding. */
  private fun watchdog() {
    if (pausing || seq == 0 || seq - 1 <= acked) return
    if (SystemClock.uptimeMillis() - lastAckAt < SILENT_MS) return
    pausing = true
    handler.post { pause() }
  }

  private fun ack(n: Int) {
    if (n > acked) acked = n
    lastAckAt = SystemClock.uptimeMillis()
    // Caught up after skipping: a key frame to start clean from.
    if (skipping && !keyAsked && seq - 1 - acked <= WINDOW / 2) {
      keyAsked = true
      requestKey()
    }
  }

  private fun requestKey() {
    runCatching { codec?.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) }) }
  }

  private fun format(w: Int, h: Int, tuned: Boolean): MediaFormat =
    MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, w, h).apply {
      setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
      setInteger(MediaFormat.KEY_BIT_RATE, params.kbps * 1000)
      setInteger(MediaFormat.KEY_FRAME_RATE, params.fps)
      setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 3)
      // A still screen still sends now and then, so a new viewer gets its key frame.
      setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 250_000)
      if (tuned && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        setFloat(MediaFormat.KEY_MAX_FPS_TO_ENCODER, params.fps.toFloat())
        setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0)
        setInteger(MediaFormat.KEY_PRIORITY, 0)
      }
    }

  @Suppress("DEPRECATION")
  private fun realSize(): Px {
    val metrics = DisplayMetrics()
    getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY)?.getRealMetrics(metrics)
    val w = if (metrics.widthPixels > 0) metrics.widthPixels else resources.displayMetrics.widthPixels
    val h = if (metrics.heightPixels > 0) metrics.heightPixels else resources.displayMetrics.heightPixels
    return Px(w, h)
  }

  private fun goForeground() {
    val nm = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL) == null) {
      nm.createNotificationChannel(NotificationChannel(CHANNEL, "Showing this screen on your Mac", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Shown while your Mac mirrors this phone’s screen"
      })
    }
    val stop = PendingIntent.getService(this, 1, Intent(this, MirrorService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val icon = resources.getIdentifier("notification_icon", "drawable", packageName).takeIf { it != 0 } ?: applicationInfo.icon
    val note: Notification = NotificationCompat.Builder(this, CHANNEL)
      .setContentTitle("Your Mac is showing this screen")
      .setContentText("Live, for the mirror in Beluga on your Mac")
      .setSmallIcon(icon)
      .setOngoing(true)
      .setCategory(NotificationCompat.CATEGORY_STATUS)
      .addAction(0, "Stop", stop)
      .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(NOTE_ID, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
    else startForeground(NOTE_ID, note)
  }

  companion object {
    const val NOTE_ID = 4209
    private const val CHANNEL = "mac-mirror"
    private const val ACTION_BEGIN = "sh.ratel.beluga.control.MIRROR_BEGIN"
    private const val ACTION_STOP = "sh.ratel.beluga.control.MIRROR_STOP"
    private const val EXTRA_CODE = "code"
    private const val EXTRA_DATA = "data"
    /** Pieces in flight before skipping to a key frame (about 0.4 s at 30 fps). */
    private const val WINDOW = 12
    /** The protocol's VID_MAX: a bigger piece is skipped. */
    private const val VID_MAX = 600 * 1024
    /** No ack this long: the Mac is gone, stop encoding. */
    private const val SILENT_MS = 10_000L
    /** The capture is kept this long after the Mac stops watching. */
    private const val KEEP_MS = 90_000L

    @Volatile private var instance: MirrorService? = null
    @Volatile private var wanted = Params()

    /** Live video needs the mediaProjection foreground service type (Android 10). */
    val supported: Boolean get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q

    /** The Mac's `mirror` op: play (asking the user the first time) or pause. Returns its MirrorView. */
    fun control(context: Context, args: JSONObject): String {
      val running = instance
      if (!args.optBoolean("on", false)) {
        running?.handler?.post { running.pause() }
        return JSONObject().put("state", "off").toString()
      }
      if (!supported) throw IllegalStateException("Live video needs Android 10 or newer")
      val p = Params(args.optInt("max", 1280).coerceIn(320, 1920), args.optInt("fps", 30).coerceIn(5, 60), args.optInt("kbps", 2500).coerceIn(200, 12_000))
      wanted = p
      if (running != null) {
        running.handler.post { running.play(p) }
        return JSONObject().put("state", "streaming").toString()
      }
      MirrorConsentActivity.ask(context)
      return JSONObject().put("state", "asking").toString()
    }

    /** The Mac took piece `seq`. */
    fun ack(seq: Int) {
      instance?.ack(seq)
    }

    /** "Start now": run the service with Android's answer. */
    fun begin(context: Context, code: Int, data: Intent) {
      val intent = Intent(context, MirrorService::class.java).setAction(ACTION_BEGIN).putExtra(EXTRA_CODE, code).putExtra(EXTRA_DATA, data)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
    }

    /** The user said no (or the sheet couldn't open). */
    fun declined(reason: String = "Not allowed on the phone") {
      PhoneControlModule.emitMirrorEnd(reason)
    }

    private fun even(v: Float): Int = maxOf(16, (v.toInt() / 8) * 8)
  }
}
