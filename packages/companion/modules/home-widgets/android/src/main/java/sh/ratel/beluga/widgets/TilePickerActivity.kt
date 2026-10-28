package sh.ratel.beluga.widgets

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.Intent
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Which tile a widget shows (BLG-361): opened by the launcher when the widget is added, from the
 * widget's Settings later, and by tapping one that has none. Your boards' tiles as the phone last
 * got them, by board, each with its project's logo and what it shows now. One tap picks it.
 */
class TilePickerActivity : Activity() {
  private var widgetId = AppWidgetManager.INVALID_APPWIDGET_ID

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    widgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
    // Backing out leaves the launcher's new widget unplaced.
    setResult(RESULT_CANCELED, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId))
    if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) return finish()
    val snap = WidgetStore.snapshot(this)
    // A tile the app just asked to put here (a launcher that opens the picker on a pin anyway).
    WidgetStore.takePending(this)?.let { pending -> if (snap?.tiles?.any { it.id == pending } == true) return pick(pending) }
    WindowCompat.setDecorFitsSystemWindows(window, false)
    setContentView(page(snap))
  }

  private fun pick(tileId: String) {
    WidgetStore.setTile(this, widgetId, tileId)
    TileWidget.draw(this, AppWidgetManager.getInstance(this), widgetId)
    setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId))
    finish()
  }

  // ---- the page

  private fun dp(v: Float): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics).toInt()

  private fun text(size: Float, color: Int, bold: Boolean = false, value: CharSequence = ""): TextView = TextView(this).apply {
    setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
    setTextColor(getColor(color))
    if (bold) typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
    text = value
  }

  private fun page(snap: Snapshot?): View {
    val col = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(20f), dp(24f), dp(20f), dp(24f))
    }
    col.addView(text(24f, R.color.beluga_widget_text, bold = true, value = "Choose a tile"))
    col.addView(
      text(14f, R.color.beluga_widget_text2, value = "From your boards in Beluga. It shows what your phone last got from your Mac.").apply {
        setPadding(0, dp(6f), 0, dp(8f))
      },
    )
    val tiles = snap?.tiles.orEmpty()
    if (tiles.isEmpty()) col.addView(nothing(snap == null))
    else for ((board, group) in tiles.groupBy { it.board }) {
      col.addView(
        text(12f, R.color.beluga_widget_text3, bold = true, value = board.uppercase()).apply {
          letterSpacing = 0.06f
          setPadding(dp(4f), dp(18f), 0, dp(6f))
        },
      )
      for (t in group) col.addView(row(t))
    }
    val scroll = ScrollView(this).apply {
      isFillViewport = true
      clipToPadding = false
      addView(col, MATCH_PARENT, WRAP_CONTENT)
    }
    ViewCompat.setOnApplyWindowInsetsListener(scroll) { v, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      insets
    }
    return scroll
  }

  private fun row(t: WTile): View {
    val tint = TileRender.parseTint(t.tint) ?: getColor(R.color.beluga_widget_sky)
    val row = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setBackgroundResource(R.drawable.beluga_row)
      setPadding(dp(14f), dp(12f), dp(14f), dp(12f))
      isClickable = true
      contentDescription = listOfNotNull(t.title, t.value, t.change).joinToString(", ")
      setOnClickListener { pick(t.id) }
    }
    val mark = ImageView(this).apply {
      val icon = WidgetStore.icon(this@TilePickerActivity, t.icon)
      when {
        icon != null -> setImageBitmap(TileRender.rounded(this@TilePickerActivity, icon, 30f))
        t.project != null -> setImageBitmap(TileRender.letter(this@TilePickerActivity, t.project, tint, 30f))
        else -> setImageResource(R.drawable.beluga_ic_laptop)
      }
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }
    row.addView(mark, LinearLayout.LayoutParams(dp(30f), dp(30f)))
    val words = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(12f), 0, dp(8f), 0) }
    words.addView(text(15f, R.color.beluga_widget_text, bold = true, value = t.title).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END })
    val sub = when {
      t.note != null -> t.note
      t.kind == "text" -> t.text?.lineSequence()?.firstOrNull { it.isNotBlank() } ?: "Words, after its sentinel runs"
      t.change != null -> listOfNotNull(t.change, t.vs).joinToString(" ")
      t.kind == "chart" -> "Over time"
      else -> t.project ?: "A number"
    }
    words.addView(text(13f, R.color.beluga_widget_text2, value = sub).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END })
    row.addView(words, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
    if (t.kind != "text" && t.value != null) row.addView(text(16f, R.color.beluga_widget_text, bold = true, value = t.value).apply { maxLines = 1 })
    val lp = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(8f) }
    row.layoutParams = lp
    return row
  }

  /** No tiles here yet: what to do, and one way into Beluga. */
  private fun nothing(neverGot: Boolean): View {
    val box = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setBackgroundResource(R.drawable.beluga_row)
      setPadding(dp(18f), dp(18f), dp(18f), dp(18f))
      layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(16f) }
    }
    box.addView(ImageView(this).apply { setImageResource(R.drawable.beluga_ic_dashboard) }, LinearLayout.LayoutParams(dp(26f), dp(26f)))
    box.addView(text(16f, R.color.beluga_widget_text, bold = true, value = "No tiles yet").apply { setPadding(0, dp(12f), 0, dp(4f)) })
    box.addView(
      text(
        14f,
        R.color.beluga_widget_text2,
        value = if (neverGot) "Open Beluga on this phone while your Mac is awake: your boards' tiles come over, then add the widget again."
        else "Put a number on a board in Beluga › Sentinel on your Mac, then add the widget again.",
      ),
    )
    val open = text(15f, R.color.beluga_widget_card, bold = true, value = "Open Beluga").apply {
      gravity = Gravity.CENTER
      setPadding(dp(18f), dp(10f), dp(18f), dp(10f))
      background = GradientDrawable().apply { cornerRadius = dp(20f).toFloat(); setColor(getColor(R.color.beluga_widget_text)) }
      isClickable = true
      setOnClickListener {
        packageManager.getLaunchIntentForPackage(packageName)?.let { startActivity(it) }
        finish()
      }
    }
    box.addView(open, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { topMargin = dp(16f) })
    return box
  }

  companion object {
    /** Tapping a widget that has no tile (or lost it): pick one. */
    const val ACTION_PICK = "sh.ratel.beluga.widgets.PICK"
  }
}
