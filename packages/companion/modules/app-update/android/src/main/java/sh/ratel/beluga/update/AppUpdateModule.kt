package sh.ratel.beluga.update

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * The phone app updating itself (BLG-426): download a release's APK into the cache, check it is
 * Beluga and newer, and hand it to Android's PackageInstaller. From Android 12 an app that installed
 * itself may update itself without a prompt; otherwise Android shows its own confirmation
 * (UpdateReceiver brings it up, or posts it as a notification while the app is away).
 */
class AppUpdateModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("No React context")

  override fun definition() = ModuleDefinition {
    Name("AppUpdate")
    Events("progress", "status")
    current = this@AppUpdateModule
    OnDestroy { if (current === this@AppUpdateModule) current = null }

    /** The installed version: versionName (1.7.0) and versionCode. */
    Function("version") {
      val info = installed(context)
      mapOf("name" to (info.versionName ?: "0"), "code" to code(info).toDouble())
    }

    /** "Install unknown apps" is allowed for Beluga (without it, Android asks the first time). */
    Function("canInstall") { context.packageManager.canRequestPackageInstalls() }

    /** Android's "Install unknown apps" page for Beluga. */
    Function("allowInstalls") {
      val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
    }

    /** An update can install without asking: Android 12+ and installs allowed. */
    Function("quiet") { Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && context.packageManager.canRequestPackageInstalls() }

    /** The network is metered (mobile data): the app downloads 60 MB only when asked. */
    Function("metered") {
      val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      cm.isActiveNetworkMetered
    }

    /** The app is in front (UpdateReceiver shows Android's confirmation) or away (it posts a notification). */
    Function("front") { on: Boolean -> front = on }

    /**
     * Download `url` (`size` bytes, `sha256` when the release gives one) to the cache, with
     * "progress" events, and check it: Beluga's package and newer than what's installed. A file
     * already there and whole is used again. Returns the path.
     */
    AsyncFunction("download") { url: String, size: Double, sha256: String?, name: String ->
      val dir = File(context.cacheDir, "updates").apply { mkdirs() }
      val file = File(dir, name.replace(Regex("[^A-Za-z0-9._-]"), "_"))
      dir.listFiles()?.forEach { if (it != file) it.delete() }
      val want = size.toLong()
      if (!(file.exists() && file.length() == want && check(file, sha256) == null)) {
        file.delete()
        fetch(url, File(dir, "${file.name}.part"), want).renameTo(file)
      }
      check(file, sha256)?.let {
        file.delete()
        throw IllegalStateException(it)
      }
      file.absolutePath
    }

    /** Give the APK at `path` to Android's installer. What happens next comes as "status" events. */
    AsyncFunction("install") { path: String ->
      val file = File(path)
      val installer = context.packageManager.packageInstaller
      val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
        setAppPackageName(context.packageName)
        setSize(file.length())
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
      }
      val id = installer.createSession(params)
      installer.openSession(id).use { session ->
        session.openWrite("base.apk", 0, file.length()).use { out ->
          file.inputStream().use { it.copyTo(out, 1 shl 16) }
          session.fsync(out)
        }
        // Once the new version runs, ReplacedReceiver says so (only when it went in with the app away).
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(QUIET, !front).apply()
        val done = Intent(context, UpdateReceiver::class.java).setPackage(context.packageName)
        val pending = PendingIntent.getBroadcast(context, id, done, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
        session.commit(pending.intentSender)
      }
    }

    /** Forget a downloaded update (after it's installed, or when a newer one replaces it). */
    Function("discard") { File(context.cacheDir, "updates").deleteRecursively() }
  }

  private fun fetch(url: String, part: File, want: Long): File {
    part.delete()
    var next = URL(url)
    // GitHub's release links redirect to its file host: follow them by hand (across hosts).
    var conn: HttpURLConnection
    var hops = 0
    while (true) {
      conn = (next.openConnection() as HttpURLConnection).apply {
        instanceFollowRedirects = false
        connectTimeout = 15_000
        readTimeout = 30_000
        setRequestProperty("Accept", "application/octet-stream")
      }
      val code = conn.responseCode
      if (code in 300..399 && hops++ < 5) {
        next = URL(next, conn.getHeaderField("Location"))
        conn.disconnect()
        continue
      }
      if (code != 200) throw IllegalStateException("The download answered $code")
      break
    }
    val digest = MessageDigest.getInstance("SHA-256")
    var got = 0L
    var told = 0L
    conn.inputStream.use { input ->
      part.outputStream().use { out ->
        val buf = ByteArray(1 shl 16)
        while (true) {
          val n = input.read(buf)
          if (n < 0) break
          out.write(buf, 0, n)
          digest.update(buf, 0, n)
          got += n
          val now = System.currentTimeMillis()
          if (now - told > 250) {
            told = now
            sendEvent("progress", mapOf("got" to got.toDouble(), "size" to want.toDouble()))
          }
        }
      }
    }
    conn.disconnect()
    sendEvent("progress", mapOf("got" to got.toDouble(), "size" to want.toDouble()))
    if (want > 0 && got != want) {
      part.delete()
      throw IllegalStateException("The download stopped short")
    }
    return part
  }

  /** What's wrong with the APK at `file`, or null: the size, sum, package and version all check out. */
  private fun check(file: File, sha256: String?): String? {
    if (sha256 != null && sum(file) != sha256.lowercase()) return "The download doesn’t match the release"
    val pm = context.packageManager
    val archive: PackageInfo = (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) pm.getPackageArchiveInfo(file.path, PackageManager.PackageInfoFlags.of(0)) else @Suppress("DEPRECATION") pm.getPackageArchiveInfo(file.path, 0))
      ?: return "The download isn’t an Android app"
    if (archive.packageName != context.packageName) return "The download isn’t Beluga"
    if (code(archive) <= code(installed(context))) return "This phone already has that version"
    return null
  }

  private fun sum(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buf = ByteArray(1 shl 16)
      while (true) {
        val n = input.read(buf)
        if (n < 0) break
        digest.update(buf, 0, n)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }

  companion object {
    const val PREFS = "beluga-update"
    const val QUIET = "quiet"
    @Volatile var current: AppUpdateModule? = null
    @Volatile var front = true

    fun installed(context: Context): PackageInfo = context.packageManager.getPackageInfo(context.packageName, 0)

    fun code(info: PackageInfo): Long = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()

    fun emit(status: String, message: String? = null) {
      current?.sendEvent("status", mapOf("status" to status, "message" to message))
    }
  }
}
