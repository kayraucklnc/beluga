package sh.ratel.beluga.widgets

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The app's handle on its Home-screen widgets (BLG-361): it hands over the Mac's `widgets` view and
 * the projects' icons as they come, says whether any widget is placed, and asks Android to put a
 * tile on the Home screen (the phone shows its own "Add to Home screen" sheet).
 */
class HomeWidgetsModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("No React context")

  override fun definition() = ModuleDefinition {
    Name("HomeWidgets")

    Function("set") { json: String ->
      WidgetStore.save(context, json)
      TileWidget.drawAll(context)
    }

    Function("hasIcon") { sum: String -> WidgetStore.hasIcon(context, sum) }

    Function("saveIcon") { sum: String, b64: String ->
      val saved = WidgetStore.saveIcon(context, sum, b64)
      if (saved) TileWidget.drawAll(context)
      saved
    }

    Function("placed") { TileWidget.ids(context).size }

    Function("canPin") { AppWidgetManager.getInstance(context).isRequestPinAppWidgetSupported }

    Function("pin") { tileId: String ->
      val c = context
      val m = AppWidgetManager.getInstance(c)
      if (!m.isRequestPinAppWidgetSupported) return@Function false
      WidgetStore.setPending(c, tileId)
      // Mutable: Android adds the new widget's id to it.
      val back = PendingIntent.getBroadcast(
        c,
        tileId.hashCode(),
        Intent(c, PinnedReceiver::class.java).putExtra(PinnedReceiver.EXTRA_TILE, tileId),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
      )
      m.requestPinAppWidget(ComponentName(c, TileWidget::class.java), null, back)
    }
  }
}
