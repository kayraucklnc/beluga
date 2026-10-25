package sh.ratel.beluga.control

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/**
 * The app's handle on phone control (BLG-150): it runs the Mac's ops through the Accessibility
 * service, says what this phone can do, finds its own Wireless-debugging port over mDNS, and shows
 * the "Your Mac is using this phone" notification. The heavy work (reading and acting on the
 * screen) is in BelugaAccessibilityService.
 */
class PhoneControlModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("No React context")

  private var nsd: NsdManager? = null
  private var adbListener: NsdManager.DiscoveryListener? = null
  private var pairListener: NsdManager.DiscoveryListener? = null

  override fun definition() = ModuleDefinition {
    Name("PhoneControl")
    Events("adb", "accessibility", "stopped", "mirror", "mirrorEnd")
    current = this@PhoneControlModule

    AsyncFunction("perform") { op: String, args: String ->
      // Live video is Android's screen capture, not the Accessibility service's (it only lends its
      // right to open the "Start now" sheet from the background).
      if (op == "mirror") return@AsyncFunction MirrorService.control(BelugaAccessibilityService.instance ?: context, if (args.isBlank()) JSONObject() else JSONObject(args))
      val service = BelugaAccessibilityService.instance ?: throw IllegalStateException("Turn on Accessibility for Beluga on the phone")
      service.perform(op, if (args.isBlank()) JSONObject() else JSONObject(args))
    }

    Function("accessibilityEnabled") { BelugaAccessibilityService.instance != null }
    Function("canScreenshot") { Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && BelugaAccessibilityService.instance != null }
    Function("deviceInfo") { deviceInfoJson(context).toString() }
    Function("canMirror") { MirrorService.supported }
    Function("mirrorAck") { seq: Int -> MirrorService.ack(seq) }

    Function("openAccessibilitySettings") {
      context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    Function("startControlNote") { text: String -> showNote(context, text) }
    Function("stopControlNote") { (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTE_ID) }

    Function("startAdbDiscovery") { startDiscovery() }
    Function("stopAdbDiscovery") { stopDiscovery() }

    OnDestroy { stopDiscovery(); if (current === this@PhoneControlModule) current = null }
  }

  // ---- Wireless debugging discovery (mDNS)

  private fun startDiscovery() {
    val manager = nsd ?: (context.getSystemService(Context.NSD_SERVICE) as NsdManager).also { nsd = it }
    if (adbListener == null) adbListener = resolveListener("_adb-tls-connect._tcp", isPairing = false).also { manager.discoverServices("_adb-tls-connect._tcp", NsdManager.PROTOCOL_DNS_SD, it) }
    if (pairListener == null) pairListener = resolveListener("_adb-tls-pairing._tcp", isPairing = true).also { manager.discoverServices("_adb-tls-pairing._tcp", NsdManager.PROTOCOL_DNS_SD, it) }
  }

  private fun stopDiscovery() {
    adbListener?.let { runCatching { nsd?.stopServiceDiscovery(it) } }
    pairListener?.let { runCatching { nsd?.stopServiceDiscovery(it) } }
    adbListener = null
    pairListener = null
    adbPort = null
    pairPort = null
  }

  private fun resolveListener(type: String, isPairing: Boolean): NsdManager.DiscoveryListener = object : NsdManager.DiscoveryListener {
    override fun onServiceFound(info: NsdServiceInfo) {
      val cb = object : NsdManager.ResolveListener {
        override fun onServiceResolved(resolved: NsdServiceInfo) {
          // Only this phone's own adbd is on the loopback/local address; the port is what we need.
          if (isPairing) pairPort = resolved.port else adbPort = resolved.port
          emitPorts()
        }
        override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) {}
      }
      runCatching { nsd?.resolveService(info, cb) }
    }
    override fun onServiceLost(info: NsdServiceInfo) {
      if (isPairing) pairPort = null else adbPort = null
      emitPorts()
    }
    override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {}
    override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
    override fun onDiscoveryStarted(serviceType: String) {}
    override fun onDiscoveryStopped(serviceType: String) {}
  }

  private fun emitPorts() {
    val payload = JSONObject()
    adbPort?.let { payload.put("port", it) }
    pairPort?.let { payload.put("pairing", it) }
    sendEvent("adb", mapOf("port" to adbPort, "pairing" to pairPort))
  }

  companion object {
    const val NOTE_ID = 4208
    const val CHANNEL = "mac-using-phone"
    @Volatile private var current: PhoneControlModule? = null
    @Volatile private var adbPort: Int? = null
    @Volatile private var pairPort: Int? = null

    /** The service connected or went away: tell the JS so it re-reports control to the Mac. */
    fun onAccessibilityChanged() {
      current?.sendEvent("accessibility", mapOf("on" to (BelugaAccessibilityService.instance != null)))
    }

    /** A piece of the screen's video for the Mac (MirrorService), as the `vid` frame carries it. */
    fun emitMirror(seq: Int, b64: String, key: Boolean, ts: Long, w: Int, h: Int, sw: Int, sh: Int) {
      current?.sendEvent("mirror", mapOf("seq" to seq, "b64" to b64, "key" to key, "ts" to ts.toDouble(), "w" to w, "h" to h, "sw" to sw, "sh" to sh))
    }

    /** The video stopped (the user said no or pressed Stop, or Android ended it). */
    fun emitMirrorEnd(reason: String?) {
      current?.sendEvent("mirrorEnd", mapOf("reason" to reason))
    }

    /** The Stop button on the "Your Mac is using this phone" notification: the JS turns control off. */
    fun onStopRequested(context: Context) {
      (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTE_ID)
      current?.sendEvent("stopped", mapOf<String, Any?>())
    }

    /** A screenshot's bitmap as the protocol's ShotView (JPEG, longest side `max`). */
    fun encode(bitmap: Bitmap, max: Int, quality: Int): JSONObject {
      val scale = minOf(1f, max.toFloat() / maxOf(bitmap.width, bitmap.height))
      val scaled = if (scale < 1f) Bitmap.createScaledBitmap(bitmap, (bitmap.width * scale).toInt(), (bitmap.height * scale).toInt(), true) else bitmap
      val out = ByteArrayOutputStream()
      scaled.compress(Bitmap.CompressFormat.JPEG, quality.coerceIn(30, 95), out)
      val b64 = android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP)
      return JSONObject()
        .put("mime", "image/jpeg")
        .put("b64", b64)
        .put("w", bitmap.width)
        .put("h", bitmap.height)
        .put("iw", scaled.width)
        .put("ih", scaled.height)
    }

    /** This phone in a few facts, plus its Wi-Fi IPv4 (so the Mac's adb can reach it on the same network). */
    fun deviceInfoJson(context: Context): JSONObject {
      val dm = context.resources.displayMetrics
      val json = JSONObject()
        .put("model", Build.MODEL ?: "Android")
        .put("manufacturer", Build.MANUFACTURER ?: "")
        .put("android", Build.VERSION.RELEASE ?: "")
        .put("sdk", Build.VERSION.SDK_INT)
        .put("w", dm.widthPixels)
        .put("h", dm.heightPixels)
      wifiIp(context)?.let { json.put("wifiIp", it) }
      return json
    }

    private fun wifiIp(context: Context): String? {
      return try {
        val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        @Suppress("DEPRECATION") val ip = wifi.connectionInfo?.ipAddress ?: 0
        if (ip == 0) null else "%d.%d.%d.%d".format(ip and 0xff, ip shr 8 and 0xff, ip shr 16 and 0xff, ip shr 24 and 0xff)
      } catch (e: Exception) {
        null
      }
    }

    /** The apps the user can open, by package and label. */
    fun apps(context: Context): JSONObject {
      val pm = context.packageManager
      val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
      val out = JSONArray()
      for (ri in pm.queryIntentActivities(intent, 0).take(1000)) {
        out.put(JSONObject().put("pkg", ri.activityInfo.packageName).put("label", ri.loadLabel(pm).toString()))
      }
      return JSONObject().put("apps", out)
    }

    /** Open an app by package, or a link in whatever app handles it. */
    fun openOnPhone(context: Context, args: JSONObject) {
      val pkg = args.optString("package", "")
      val url = args.optString("url", "")
      val intent = when {
        url.isNotEmpty() -> Intent(Intent.ACTION_VIEW, Uri.parse(url))
        pkg.isNotEmpty() -> context.packageManager.getLaunchIntentForPackage(pkg) ?: throw IllegalArgumentException("No app called $pkg")
        else -> throw IllegalArgumentException("Give a package or a url")
      }.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
    }

    private fun showNote(context: Context, text: String) {
      val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL) == null) {
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Your Mac is using this phone", NotificationManager.IMPORTANCE_LOW).apply {
          description = "Shown while your Mac's Claude is acting on this phone"
        })
      }
      val stop = PendingIntent.getBroadcast(
        context, 0,
        Intent(context, ControlActionReceiver::class.java).setAction(ControlActionReceiver.ACTION_STOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )
      val icon = context.resources.getIdentifier("notification_icon", "drawable", context.packageName).takeIf { it != 0 } ?: context.applicationInfo.icon
      val note: Notification = NotificationCompat.Builder(context, CHANNEL)
        .setContentTitle("Your Mac is using this phone")
        .setContentText(text.ifBlank { "Claude is acting on this phone" })
        .setSmallIcon(icon)
        .setOngoing(true)
        .setCategory(NotificationCompat.CATEGORY_STATUS)
        .addAction(0, "Stop", stop)
        .build()
      nm.notify(NOTE_ID, note)
    }
  }
}
