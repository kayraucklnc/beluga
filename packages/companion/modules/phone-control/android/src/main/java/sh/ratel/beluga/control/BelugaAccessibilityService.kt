package sh.ratel.beluga.control

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/**
 * Beluga's Accessibility service (BLG-150): the one piece that can read another app's screen and
 * act on it. The Mac asks (a `req` frame), the app's JS calls PhoneControlModule.perform, and that
 * runs here. The user turns this on themselves (Settings › Accessibility › Beluga); Android only
 * binds it then, and a notification shows while the Mac is using the phone.
 *
 * Password fields are never read. Everything is best-effort and bounded: a screen read gives at
 * most a few hundred nodes, a gesture waits a short time, and failures come back as a message.
 */
class BelugaAccessibilityService : AccessibilityService() {
  /** The last screen we described, by generation, so the Mac can tap "node #3" instead of pixels. */
  private var gen = 0
  private var lastNodes: List<AccessibilityNodeInfo> = emptyList()

  override fun onServiceConnected() {
    instance = this
    PhoneControlModule.onAccessibilityChanged()
  }

  override fun onUnbind(intent: android.content.Intent?): Boolean {
    instance = null
    PhoneControlModule.onAccessibilityChanged()
    return super.onUnbind(intent)
  }

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {
    // The screen changed: the Mac re-reads it when it next looks (we don't push).
    if (event?.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) PhoneControlModule.onAccessibilityChanged()
  }

  override fun onInterrupt() {}

  // ---- the operations (one entry point, dispatched by name)

  /** Run an op and return its result as a JSON string (throws with a message on failure). */
  fun perform(op: String, args: JSONObject): String {
    return when (op) {
      "screen" -> screen().toString()
      "screenshot" -> screenshot(args.optInt("max", 1280), args.optInt("quality", 70)).toString()
      "tap" -> { tap(args); "{}" }
      "long_press" -> { longPress(args); "{}" }
      "swipe" -> { swipe(args); "{}" }
      "type" -> { type(args); "{}" }
      "key" -> { key(args.getString("key")); "{}" }
      "scroll" -> { scroll(args); "{}" }
      "open" -> { PhoneControlModule.openOnPhone(this, args); "{}" }
      "apps" -> PhoneControlModule.apps(this).toString()
      "info" -> PhoneControlModule.deviceInfoJson(this).toString()
      else -> throw IllegalArgumentException("Can't do \"$op\" through the Accessibility service")
    }
  }

  // ---- reading the screen

  private fun screen(): JSONObject {
    val root = rootInActiveWindow ?: throw IllegalStateException("Nothing on screen to read yet")
    val nodes = ArrayList<AccessibilityNodeInfo>()
    val out = JSONArray()
    collect(root, 0, nodes, out)
    gen += 1
    lastNodes = nodes
    val bounds = Rect().also { root.getBoundsInScreen(it) }
    val keyboard = windows?.any { it.type == android.view.accessibility.AccessibilityWindowInfo.TYPE_INPUT_METHOD } ?: false
    return JSONObject()
      .put("gen", gen)
      .put("app", root.packageName ?: "")
      .put("w", if (bounds.width() > 0) bounds.width() else resources.displayMetrics.widthPixels)
      .put("h", if (bounds.height() > 0) bounds.height() else resources.displayMetrics.heightPixels)
      .put("keyboard", keyboard)
      .put("nodes", out)
  }

  private fun collect(node: AccessibilityNodeInfo?, depth: Int, nodes: ArrayList<AccessibilityNodeInfo>, out: JSONArray) {
    if (node == null || out.length() >= 1500) return
    val b = Rect().also { node.getBoundsInScreen(it) }
    val flags = StringBuilder()
    if (node.isClickable) flags.append('c')
    if (node.isLongClickable) flags.append('l')
    if (node.isEditable) flags.append('e')
    if (node.isScrollable) flags.append('s')
    if (node.isCheckable) flags.append('k')
    if (node.isChecked) flags.append('K')
    if (node.isFocused) flags.append('F')
    if (node.isSelected) flags.append('x')
    if (!node.isEnabled) flags.append('d')
    if (node.isPassword) flags.append('p')
    val says = if (node.isPassword) "" else node.text?.toString()
    val desc = node.contentDescription?.toString()
    val hint = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) node.hintText?.toString() else null
    val onScreen = !b.isEmpty && b.right > 0 && b.bottom > 0
    // Keep anything that's actionable, or says something, and is actually on screen.
    if (onScreen && (flags.isNotEmpty() || !says.isNullOrEmpty() || !desc.isNullOrEmpty())) {
      val i = nodes.size
      nodes.add(AccessibilityNodeInfo.obtain(node))
      val o = JSONObject()
        .put("i", i)
        .put("d", depth)
        .put("c", (node.className ?: "").toString().substringAfterLast('.'))
        .put("b", JSONArray(listOf(b.left, b.top, b.right, b.bottom)))
      if (!says.isNullOrEmpty()) o.put("t", says.take(2000))
      if (!hint.isNullOrEmpty()) o.put("h", hint.take(400))
      if (!desc.isNullOrEmpty()) o.put("s", desc.take(2000))
      node.viewIdResourceName?.let { o.put("r", it.substringAfterLast('/')) }
      if (flags.isNotEmpty()) o.put("f", flags.toString())
      out.put(o)
    }
    for (i in 0 until node.childCount) collect(node.getChild(i), depth + 1, nodes, out)
  }

  private fun nodeFor(args: JSONObject): AccessibilityNodeInfo? {
    if (!args.has("node")) return null
    if (args.has("gen") && args.getInt("gen") != gen) return null
    return lastNodes.getOrNull(args.getInt("node"))
  }

  // ---- acting

  private fun tap(args: JSONObject) {
    val node = nodeFor(args)
    if (node != null && node.isClickable) {
      node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
      return
    }
    gestureTap(args.getInt("x").toFloat(), args.getInt("y").toFloat(), 60)
  }

  private fun longPress(args: JSONObject) {
    val node = nodeFor(args)
    if (node != null && node.isLongClickable) {
      node.performAction(AccessibilityNodeInfo.ACTION_LONG_CLICK)
      return
    }
    gestureTap(args.getInt("x").toFloat(), args.getInt("y").toFloat(), args.optInt("ms", 600).toLong())
  }

  private fun gestureTap(x: Float, y: Float, ms: Long) {
    val path = Path().apply { moveTo(x, y) }
    dispatch(GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, ms)).build())
  }

  private fun swipe(args: JSONObject) {
    val path = Path().apply {
      moveTo(args.getInt("x1").toFloat(), args.getInt("y1").toFloat())
      lineTo(args.getInt("x2").toFloat(), args.getInt("y2").toFloat())
    }
    dispatch(GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, args.optInt("ms", 300).toLong())).build())
  }

  private fun scroll(args: JSONObject) {
    val node = nodeFor(args) ?: biggestScrollable(rootInActiveWindow)
    val forward = args.getString("dir").let { it == "down" || it == "right" }
    node?.performAction(if (forward) AccessibilityNodeInfo.ACTION_SCROLL_FORWARD else AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD)
  }

  private fun biggestScrollable(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
    if (node == null) return null
    var best: AccessibilityNodeInfo? = null
    var area = 0
    fun walk(n: AccessibilityNodeInfo?) {
      if (n == null) return
      if (n.isScrollable) {
        val b = Rect().also { n.getBoundsInScreen(it) }
        if (b.width() * b.height() > area) { area = b.width() * b.height(); best = n }
      }
      for (i in 0 until n.childCount) walk(n.getChild(i))
    }
    walk(node)
    return best
  }

  private fun type(args: JSONObject) {
    val field = nodeFor(args) ?: findFocusedEditable(rootInActiveWindow) ?: throw IllegalStateException("No text field has the focus")
    val text = args.getString("text")
    val value = if (args.optBoolean("replace", false)) text else "${field.text ?: ""}$text"
    field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply {
      putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value)
    })
    if (args.optBoolean("enter", false)) field.performAction(imeEnterAction())
  }

  /** The "press the keyboard's action" action (API 30+); a click elsewhere. */
  private fun imeEnterAction(): Int =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) android.R.id.accessibilityActionImeEnter else AccessibilityNodeInfo.ACTION_CLICK

  private fun findFocusedEditable(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
    if (node == null) return null
    if (node.isEditable && node.isFocused) return node
    for (i in 0 until node.childCount) findFocusedEditable(node.getChild(i))?.let { return it }
    return null
  }

  private fun key(key: String) {
    val action = when (key) {
      "back" -> GLOBAL_ACTION_BACK
      "home" -> GLOBAL_ACTION_HOME
      "recents" -> GLOBAL_ACTION_RECENTS
      "notifications" -> GLOBAL_ACTION_NOTIFICATIONS
      "quick_settings" -> GLOBAL_ACTION_QUICK_SETTINGS
      "lock" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) GLOBAL_ACTION_LOCK_SCREEN else GLOBAL_ACTION_HOME
      "power_dialog" -> GLOBAL_ACTION_POWER_DIALOG
      "enter" -> { // no global "enter"; press the keyboard's action on the focused field instead
        findFocusedEditable(rootInActiveWindow)?.performAction(imeEnterAction()); return
      }
      else -> throw IllegalArgumentException("No such key: $key")
    }
    performGlobalAction(action)
  }

  // ---- a screenshot without MediaProjection (API 30+)

  private fun screenshot(max: Int, quality: Int): JSONObject {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) throw IllegalStateException("Screenshots need Android 11 or newer (or turn on Wireless debugging)")
    val future = CompletableFuture<JSONObject>()
    takeScreenshot(android.view.Display.DEFAULT_DISPLAY, { it.run() }, object : TakeScreenshotCallback {
      override fun onSuccess(result: ScreenshotResult) {
        try {
          val hardware = result.hardwareBuffer
          val bitmap = android.graphics.Bitmap.wrapHardwareBuffer(hardware, result.colorSpace)
            ?: throw IllegalStateException("Couldn't read the screenshot")
          val software = bitmap.copy(android.graphics.Bitmap.Config.ARGB_8888, false)
          bitmap.recycle()
          hardware.close()
          future.complete(PhoneControlModule.encode(software, max, quality))
        } catch (e: Throwable) {
          future.completeExceptionally(e)
        }
      }
      override fun onFailure(errorCode: Int) {
        future.completeExceptionally(IllegalStateException("The screenshot failed (code $errorCode); the screen may be protected"))
      }
    })
    return future.get(8, TimeUnit.SECONDS)
  }

  private fun dispatch(gesture: GestureDescription) {
    val done = CompletableFuture<Boolean>()
    val ok = dispatchGesture(gesture, object : GestureResultCallback() {
      override fun onCompleted(d: GestureDescription?) { done.complete(true) }
      override fun onCancelled(d: GestureDescription?) { done.complete(false) }
    }, null)
    if (!ok) throw IllegalStateException("The gesture couldn't be sent")
    done.get(5, TimeUnit.SECONDS)
  }

  companion object {
    @Volatile var instance: BelugaAccessibilityService? = null
  }
}
