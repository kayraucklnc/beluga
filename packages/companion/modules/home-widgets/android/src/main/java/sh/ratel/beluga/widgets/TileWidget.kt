package sh.ratel.beluga.widgets

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle

/**
 * The "Board tile" widget (BLG-361). It draws what the app last handed over (WidgetStore); it can't
 * reach the Mac itself, so it redraws when the app gets a new `widgets` view (while Beluga is open,
 * or Stay connected keeps the link), when it's resized, and hourly for its "as of".
 */
class TileWidget : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    for (id in ids) draw(context, manager, id)
  }

  override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) {
    draw(context, manager, id)
  }

  override fun onDeleted(context: Context, ids: IntArray) {
    WidgetStore.forget(context, ids)
  }

  companion object {
    fun ids(c: Context): IntArray = AppWidgetManager.getInstance(c).getAppWidgetIds(ComponentName(c, TileWidget::class.java))

    fun draw(c: Context, manager: AppWidgetManager, id: Int) {
      try {
        manager.updateAppWidget(id, TileRender.views(c, manager, id))
      } catch (_: Exception) {
        // A launcher that refuses a drawing keeps the last one.
      }
    }

    fun drawAll(c: Context) {
      val m = AppWidgetManager.getInstance(c)
      for (id in ids(c)) draw(c, m, id)
    }
  }
}

/** Android placed a widget the app asked for (a tile's ••• › Add to Home screen): it shows that tile. */
class PinnedReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
    val tile = intent.getStringExtra(EXTRA_TILE) ?: return
    if (id == AppWidgetManager.INVALID_APPWIDGET_ID) return
    WidgetStore.setTile(context, id, tile)
    WidgetStore.takePending(context)
    TileWidget.draw(context, AppWidgetManager.getInstance(context), id)
  }

  companion object {
    const val EXTRA_TILE = "sh.ratel.beluga.widgets.TILE"
  }
}
