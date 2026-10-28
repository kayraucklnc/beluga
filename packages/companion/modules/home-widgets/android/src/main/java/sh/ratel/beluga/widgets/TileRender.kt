package sh.ratel.beluga.widgets

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import android.net.Uri
import android.os.Build
import android.text.format.DateFormat
import android.text.format.DateUtils
import android.util.SizeF
import android.util.TypedValue
import android.view.View
import android.widget.RemoteViews
import androidx.annotation.RequiresApi
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * How a board tile looks on the Home screen (BLG-361), as the Mac's desktop widget draws it
 * (packages/mac/widgets/BelugaWidgets.swift): the project's logo and the tile's title on top, a
 * wash of the project's tint over the card; a number with its change (mint when good, rose when
 * bad) and its points as a soft area in the tint, beside it when wide; a chart's points with the
 * first and last labels; an output, a table or a headline in words. Paused or gone says so.
 */
object TileRender {
  private enum class Size { SMALL, WIDE, LARGE }

  /** The tint's wash over the card: as quiet as the board's (7%). */
  private const val WASH_ALPHA = 18

  fun views(c: Context, mgr: AppWidgetManager, widgetId: Int): RemoteViews {
    val snap = WidgetStore.snapshot(c)
    val tileId = WidgetStore.tileOf(c, widgetId)
    val tile = tileId?.let { id -> snap?.tiles?.find { it.id == id } }
    val state = when {
      tile != null -> null
      snap == null -> Empty.NO_DATA
      tileId == null -> Empty.UNPICKED
      else -> Empty.GONE
    }
    val click = if (tile != null) openBoard(c, widgetId, tile) else openPicker(c, widgetId)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return sized(c, tile, state, click)
    // Before Android 12: the size the launcher says it has (portrait: its min width and max height).
    val o = mgr.getAppWidgetOptions(widgetId)
    val w = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 150).toFloat()
    val h = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 150).toFloat()
    val size = if (h >= 220 && w >= 220) Size.LARGE else if (w >= 230) Size.WIDE else Size.SMALL
    return one(c, tile, state, size, click, w, h)
  }

  @RequiresApi(Build.VERSION_CODES.S)
  private fun sized(c: Context, tile: WTile?, state: Empty?, click: PendingIntent): RemoteViews =
    RemoteViews(
      mapOf(
        SizeF(100f, 90f) to one(c, tile, state, Size.SMALL, click, 160f, 160f),
        SizeF(230f, 90f) to one(c, tile, state, Size.WIDE, click, 320f, 150f),
        SizeF(220f, 220f) to one(c, tile, state, Size.LARGE, click, 320f, 320f),
      ),
    )

  private enum class Empty { NO_DATA, UNPICKED, GONE }

  private fun one(c: Context, tile: WTile?, state: Empty?, size: Size, click: PendingIntent, wDp: Float, hDp: Float): RemoteViews {
    if (tile == null) return empty(c, state ?: Empty.NO_DATA, click)
    val pts = tile.points
    val chartable = tile.kind != "text" && pts.size > 1
    val wide = size == Size.WIDE && chartable
    val v = RemoteViews(c.packageName, if (wide) R.layout.beluga_tile_row else R.layout.beluga_tile_column)
    v.setOnClickPendingIntent(R.id.beluga_body, click)
    v.setOnClickPendingIntent(android.R.id.background, click)
    val tint = parseTint(tile.tint) ?: c.getColor(R.color.beluga_widget_sky)
    v.setViewVisibility(R.id.beluga_wash, View.VISIBLE)
    v.setInt(R.id.beluga_wash, "setColorFilter", tint)
    v.setInt(R.id.beluga_wash, "setImageAlpha", WASH_ALPHA)
    head(c, v, tile, tint)
    v.setTextViewText(R.id.beluga_at, asOf(c, tile.at))
    v.setViewVisibility(R.id.beluga_at, if (tile.at != null && (size != Size.SMALL || !chartable)) View.VISIBLE else View.GONE)

    if (tile.kind == "text") {
      v.setViewVisibility(R.id.beluga_value, if (tile.value != null) View.VISIBLE else View.GONE)
      tile.value?.let {
        v.setTextViewText(R.id.beluga_value, it)
        v.setTextViewTextSize(R.id.beluga_value, TypedValue.COMPLEX_UNIT_SP, 12f)
        ink(c, v, R.id.beluga_value, R.color.beluga_widget_text2)
      }
      v.setViewVisibility(R.id.beluga_changes, View.GONE)
      v.setViewVisibility(R.id.beluga_space, View.GONE)
      v.setViewVisibility(R.id.beluga_text, View.VISIBLE)
      v.setTextViewText(R.id.beluga_text, tile.text ?: "Nothing yet: it shows after its sentinel runs.")
      if (tile.text == null) ink(c, v, R.id.beluga_text, R.color.beluga_widget_text2)
      v.setInt(R.id.beluga_text, "setMaxLines", when (size) { Size.SMALL -> 5; Size.WIDE -> 4; Size.LARGE -> 16 })
      return v
    }

    // A number or a chart.
    val value = tile.value ?: "—"
    v.setTextViewText(R.id.beluga_value, value)
    v.setTextViewTextSize(R.id.beluga_value, TypedValue.COMPLEX_UNIT_SP, valueSize(value, size, wide))
    changes(v, tile, size, wide)
    v.setViewVisibility(R.id.beluga_text, View.GONE)
    if (chartable) {
      val (cw, ch) = when {
        wide -> (wDp - 28) * 0.56f - 12 to hDp - 60
        size == Size.LARGE -> wDp - 28 to hDp - 150
        else -> wDp - 28 to hDp - 110
      }
      v.setViewVisibility(R.id.beluga_chart, View.VISIBLE)
      v.setImageViewBitmap(R.id.beluga_chart, area(c, pts, tint, cw, ch))
      v.setViewVisibility(R.id.beluga_space, View.GONE)
      val range = (size == Size.LARGE || wide || tile.kind == "chart") && tile.from != null && tile.to != null
      v.setViewVisibility(R.id.beluga_range, if (range) View.VISIBLE else View.GONE)
      if (range) {
        v.setTextViewText(R.id.beluga_from, tile.from)
        v.setTextViewText(R.id.beluga_to, tile.to)
      }
    } else {
      v.setViewVisibility(R.id.beluga_chart, View.GONE)
      v.setViewVisibility(R.id.beluga_range, View.GONE)
      v.setViewVisibility(R.id.beluga_space, View.VISIBLE)
    }
    return v
  }

  /** The project's logo (its icon, or its first letter on its tint) and the tile's title, its note beside. */
  private fun head(c: Context, v: RemoteViews, tile: WTile, tint: Int) {
    v.setTextViewText(R.id.beluga_title, tile.title.ifEmpty { tile.board })
    val icon = WidgetStore.icon(c, tile.icon)
    when {
      icon != null -> v.setImageViewBitmap(R.id.beluga_mark, rounded(c, icon))
      tile.project != null -> v.setImageViewBitmap(R.id.beluga_mark, letter(c, tile.project, tint))
      else -> v.setImageViewResource(R.id.beluga_mark, R.drawable.beluga_ic_laptop)
    }
    v.setViewVisibility(R.id.beluga_note, if (tile.note != null) View.VISIBLE else View.GONE)
    tile.note?.let { v.setTextViewText(R.id.beluga_note, it) }
  }

  private fun changes(v: RemoteViews, tile: WTile, size: Size, wide: Boolean) {
    val change = tile.change
    val pill = when {
      change == null -> 0
      tile.tone == "good" -> R.id.beluga_change_good
      tile.tone == "bad" -> R.id.beluga_change_bad
      else -> R.id.beluga_change_none
    }
    for (id in intArrayOf(R.id.beluga_change_good, R.id.beluga_change_bad, R.id.beluga_change_none)) {
      v.setViewVisibility(id, if (id == pill) View.VISIBLE else View.GONE)
    }
    if (pill != 0) v.setTextViewText(pill, change)
    // "vs last week" when there's room for it (the Mac's small widget leaves it out too).
    val vs = tile.vs?.takeIf { size != Size.SMALL || wide }
    v.setViewVisibility(R.id.beluga_vs, if (vs != null) View.VISIBLE else View.GONE)
    vs?.let { v.setTextViewText(R.id.beluga_vs, it) }
    v.setViewVisibility(R.id.beluga_changes, if (pill != 0 || vs != null) View.VISIBLE else View.GONE)
  }

  private fun valueSize(value: String, size: Size, wide: Boolean): Float {
    val n = value.length
    val big = if (size == Size.LARGE && !wide) 44f else 30f
    return when {
      n <= 6 -> big
      n <= 9 -> big * 0.82f
      else -> big * 0.66f
    }
  }

  /** Nothing to draw yet: say what to do, in a word or two. Tapping it picks a tile (or opens Beluga). */
  private fun empty(c: Context, state: Empty, click: PendingIntent): RemoteViews {
    val v = RemoteViews(c.packageName, R.layout.beluga_tile_column)
    v.setOnClickPendingIntent(R.id.beluga_body, click)
    v.setOnClickPendingIntent(android.R.id.background, click)
    v.setImageViewResource(R.id.beluga_mark, R.drawable.beluga_ic_dashboard)
    v.setTextViewText(R.id.beluga_title, if (state == Empty.GONE) "Tile gone" else "Board tile")
    v.setViewVisibility(R.id.beluga_value, View.GONE)
    v.setViewVisibility(R.id.beluga_changes, View.GONE)
    v.setViewVisibility(R.id.beluga_at, View.GONE)
    v.setViewVisibility(R.id.beluga_space, View.GONE)
    v.setViewVisibility(R.id.beluga_text, View.VISIBLE)
    ink(c, v, R.id.beluga_text, R.color.beluga_widget_text2)
    v.setTextViewText(
      R.id.beluga_text,
      when (state) {
        Empty.NO_DATA -> "Open Beluga while your Mac is awake, then tap here to pick a tile."
        Empty.UNPICKED -> "Tap to pick one of your boards' tiles."
        Empty.GONE -> "It's no longer on your board. Tap to pick another."
      },
    )
    return v
  }

  /** A text colour that follows the phone's light or dark (Android 12+ resolves it where it's drawn). */
  private fun ink(c: Context, v: RemoteViews, id: Int, color: Int) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) v.setColorStateList(id, "setTextColor", color)
    else v.setTextColor(id, c.getColor(color))
  }

  // ---- where a tap goes

  private fun openBoard(c: Context, widgetId: Int, tile: WTile): PendingIntent {
    val uri = Uri.parse("beluga://dashboard/${Uri.encode(tile.dashboard)}?tile=${Uri.encode(tile.tile)}")
    val i = Intent(Intent.ACTION_VIEW, uri).setPackage(c.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    return PendingIntent.getActivity(c, widgetId, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  private fun openPicker(c: Context, widgetId: Int): PendingIntent {
    val i = Intent(c, TilePickerActivity::class.java)
      .setAction(TilePickerActivity.ACTION_PICK)
      .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
    return PendingIntent.getActivity(c, widgetId + 1_000_000, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  // ---- words

  /** "as of 14:05" today, "as of Oct 27" before. */
  fun asOf(c: Context, at: Long?): String {
    if (at == null) return ""
    val d = Date(at)
    return if (DateUtils.isToday(at)) "as of ${DateFormat.getTimeFormat(c).format(d)}" else "as of ${SimpleDateFormat("MMM d", Locale.getDefault()).format(d)}"
  }

  fun parseTint(hex: String?): Int? = try { if (hex != null && hex.length == 7 && hex[0] == '#') Color.parseColor(hex) else null } catch (_: IllegalArgumentException) { null }

  // ---- pictures

  private fun scale(c: Context): Float = c.resources.displayMetrics.density.coerceAtMost(2.75f)

  /** The points as a soft area under their line, in the tint, with the last one marked (no axes: the room is small). */
  fun area(c: Context, points: DoubleArray, tint: Int, wDp: Float, hDp: Float): Bitmap {
    val s = scale(c)
    val w = (wDp.coerceIn(40f, 420f) * s).toInt()
    val h = (hDp.coerceIn(24f, 260f) * s).toInt()
    val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    val cv = Canvas(bmp)
    val lo = points.min()
    val hi = points.max()
    val pad = maxOf((hi - lo) * 0.12, 0.0001)
    val bottom = lo - pad
    val top = hi + pad
    val stroke = 1.8f * s
    val dot = 2.6f * s
    val inset = dot + stroke
    val x = { i: Int -> inset + i * (w - 2 * inset) / (points.size - 1) }
    val y = { v: Double -> (inset + (1 - (v - bottom) / (top - bottom)) * (h - 2 * inset)).toFloat() }
    val line = Path()
    line.moveTo(x(0), y(points[0]))
    for (i in 1 until points.size) {
      // A smooth curve that never overshoots a point (each bend's handles are level with its ends).
      val mx = (x(i - 1) + x(i)) / 2
      line.cubicTo(mx, y(points[i - 1]), mx, y(points[i]), x(i), y(points[i]))
    }
    val fill = Path(line)
    fill.lineTo(x(points.size - 1), h.toFloat())
    fill.lineTo(x(0), h.toFloat())
    fill.close()
    val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      shader = LinearGradient(0f, 0f, 0f, h.toFloat(), withAlpha(tint, 0.24f), withAlpha(tint, 0.03f), Shader.TileMode.CLAMP)
    }
    cv.drawPath(fill, fillPaint)
    val linePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      style = Paint.Style.STROKE
      strokeWidth = stroke
      strokeCap = Paint.Cap.ROUND
      strokeJoin = Paint.Join.ROUND
      color = tint
    }
    cv.drawPath(line, linePaint)
    cv.drawCircle(x(points.size - 1), y(points.last()), dot, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = tint })
    return bmp
  }

  private fun withAlpha(color: Int, a: Float): Int = Color.argb((a * 255).toInt(), Color.red(color), Color.green(color), Color.blue(color))

  /** A project's icon with the board's rounded corners. */
  fun rounded(c: Context, src: Bitmap, dp: Float = 16f): Bitmap {
    val px = (dp * scale(c)).toInt().coerceAtLeast(8)
    val out = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888)
    val cv = Canvas(out)
    val r = px * 0.24f
    val p = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    cv.drawRoundRect(RectF(0f, 0f, px.toFloat(), px.toFloat()), r, r, p)
    p.xfermode = android.graphics.PorterDuffXfermode(android.graphics.PorterDuff.Mode.SRC_IN)
    cv.drawBitmap(src, null, RectF(0f, 0f, px.toFloat(), px.toFloat()), p)
    return out
  }

  /** A project without an icon: its first letter in its tint, on the tint softly. */
  fun letter(c: Context, name: String, tint: Int, dp: Float = 16f): Bitmap {
    val px = (dp * scale(c)).toInt().coerceAtLeast(8)
    val out = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888)
    val cv = Canvas(out)
    val r = px * 0.24f
    cv.drawRoundRect(RectF(0f, 0f, px.toFloat(), px.toFloat()), r, r, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = withAlpha(tint, 0.18f) })
    val ch = name.trim().firstOrNull()?.uppercase() ?: "?"
    val tp = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = tint
      textSize = px * 0.6f
      textAlign = Paint.Align.CENTER
      typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL)
    }
    val base = px / 2f - (tp.descent() + tp.ascent()) / 2
    cv.drawText(ch, px / 2f, base, tp)
    return out
  }
}
