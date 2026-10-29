package sh.ratel.beluga.control.link

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.provider.Settings
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/** What both the app and Beluga Link do the same way: facts about the phone, opening things, a screenshot's JPEG. */
object Phone {
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

  /** Open an app by package, a link in whatever app handles it, or one of the phone's settings screens. */
  fun openOnPhone(context: Context, args: JSONObject) {
    val pkg = args.optString("package", "")
    val url = args.optString("url", "")
    val settings = args.optString("settings", "")
    val intent = when {
      settings == "developer" -> Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS)
      settings == "about" -> Intent(Settings.ACTION_DEVICE_INFO_SETTINGS)
      url.isNotEmpty() -> Intent(Intent.ACTION_VIEW, Uri.parse(url))
      pkg.isNotEmpty() -> context.packageManager.getLaunchIntentForPackage(pkg) ?: throw IllegalArgumentException("No app called $pkg")
      else -> throw IllegalArgumentException("Give a package or a url")
    }.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    context.startActivity(intent)
  }
}
