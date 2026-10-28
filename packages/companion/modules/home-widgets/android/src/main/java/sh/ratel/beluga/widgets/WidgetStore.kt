package sh.ratel.beluga.widgets

import android.content.Context
import android.content.SharedPreferences
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import org.json.JSONObject
import java.io.File

/** A board tile as the widget draws it: the `widgets` view's WidgetTileView (src/companion/protocol.ts), in words. */
data class WTile(
  val id: String,
  val dashboard: String,
  val tile: String,
  val board: String,
  val title: String,
  val kind: String,
  val value: String?,
  val change: String?,
  val tone: String,
  val vs: String?,
  val points: DoubleArray,
  val from: String?,
  val to: String?,
  val text: String?,
  val note: String?,
  val project: String?,
  val icon: String?,
  val tint: String?,
  val at: Long?,
)

/** What the phone last got from the Mac: every tile, and when it came. */
data class Snapshot(val tiles: List<WTile>, val got: Long)

/**
 * What the widgets read (BLG-361): the app hands over the Mac's `widgets` view whenever it comes
 * (lib/widgets.ts), kept here so the widgets draw with the app closed; which tile each widget
 * shows; the projects' icons as files. Only tiles' words: never a source, a query or a key.
 */
object WidgetStore {
  private const val PREFS = "beluga_widgets"
  private val SUM = Regex("^[0-9a-f]{16,64}$")

  private fun prefs(c: Context): SharedPreferences = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  fun save(c: Context, json: String) {
    prefs(c).edit().putString("snapshot", json).apply()
    cached = null
  }

  @Volatile private var cached: Pair<String, Snapshot>? = null

  fun snapshot(c: Context): Snapshot? {
    val json = prefs(c).getString("snapshot", null) ?: return null
    cached?.let { if (it.first == json) return it.second }
    val snap = try { parse(JSONObject(json)) } catch (_: Exception) { null } ?: return null
    cached = json to snap
    return snap
  }

  fun tileOf(c: Context, widgetId: Int): String? = prefs(c).getString("w:$widgetId", null)

  fun setTile(c: Context, widgetId: Int, tileId: String) {
    prefs(c).edit().putString("w:$widgetId", tileId).apply()
  }

  fun forget(c: Context, widgetIds: IntArray) {
    val e = prefs(c).edit()
    for (id in widgetIds) e.remove("w:$id")
    e.apply()
  }

  /** A tile the app asked to put on the Home screen, for a launcher that opens the picker on a pin anyway. */
  fun setPending(c: Context, tileId: String) {
    prefs(c).edit().putString("pending", tileId).putLong("pendingAt", System.currentTimeMillis()).apply()
  }

  fun takePending(c: Context): String? {
    val p = prefs(c)
    val tile = p.getString("pending", null) ?: return null
    val fresh = System.currentTimeMillis() - p.getLong("pendingAt", 0) < 60_000
    p.edit().remove("pending").remove("pendingAt").apply()
    return if (fresh) tile else null
  }

  // ---- the projects' icons, by checksum

  private fun iconFile(c: Context, sum: String): File? = if (SUM.matches(sum)) File(File(c.filesDir, "widgets/icons"), sum) else null

  fun hasIcon(c: Context, sum: String): Boolean = iconFile(c, sum)?.exists() == true

  fun saveIcon(c: Context, sum: String, b64: String): Boolean {
    val f = iconFile(c, sum) ?: return false
    val bytes = try { Base64.decode(b64, Base64.DEFAULT) } catch (_: IllegalArgumentException) { return false }
    // Only a small picture is kept.
    val probe = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, probe)
    if (probe.outWidth <= 0 || probe.outWidth > 1024 || probe.outHeight > 1024) return false
    f.parentFile?.mkdirs()
    val tmp = File(f.parentFile, "$sum.tmp")
    tmp.writeBytes(bytes)
    return tmp.renameTo(f)
  }

  fun icon(c: Context, sum: String?): Bitmap? {
    val f = sum?.let { iconFile(c, it) } ?: return null
    return if (f.exists()) BitmapFactory.decodeFile(f.path) else null
  }

  // ---- reading the view

  private fun parse(o: JSONObject): Snapshot {
    val arr = o.optJSONArray("tiles")
    val tiles = ArrayList<WTile>()
    if (arr != null) for (i in 0 until arr.length()) {
      val t = arr.optJSONObject(i) ?: continue
      val id = t.optString("id")
      if (id.isEmpty()) continue
      val pts = t.optJSONArray("points")
      tiles.add(
        WTile(
          id = id,
          dashboard = t.optString("dashboard"),
          tile = t.optString("tile"),
          board = t.optString("board"),
          title = t.optString("title"),
          kind = t.optString("kind", "text"),
          value = t.str("value"),
          change = t.str("change"),
          tone = t.optString("tone", "none"),
          vs = t.str("vs"),
          points = if (pts == null) DoubleArray(0) else DoubleArray(pts.length()) { pts.optDouble(it, 0.0) },
          from = t.str("from"),
          to = t.str("to"),
          text = t.str("text"),
          note = t.str("note"),
          project = t.str("project"),
          icon = t.str("icon"),
          tint = t.str("tint"),
          at = if (t.has("at")) t.optLong("at") else null,
        ),
      )
    }
    return Snapshot(tiles, o.optLong("got", 0))
  }

  private fun JSONObject.str(key: String): String? = if (has(key) && !isNull(key)) optString(key).takeIf { it.isNotEmpty() } else null
}
