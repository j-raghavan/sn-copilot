package com.sncopilot.overlay

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Point
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.TextView
import com.facebook.react.ReactInstanceManager
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactRootView
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.bridge.UiThreadUtil
import com.ratta.supernote.pluginlib.modules.PluginModule

/**
 * CopilotOverlayModule — Phase 1 Path B native overlay skeleton.
 *
 * History
 * -------
 *
 * 2026-05-08 (logcat.txt:1554, kbpguk1qf26zp9ui): the first iteration
 * tried only Activity-attached window types (TYPE_APPLICATION_PANEL
 * etc.) and bailed on `getCurrentActivity() returned null` because
 * `showType: 0` runs the JS bundle headless inside the plugin host
 * process, with no foreground Activity in our process. So `addView`
 * was never even attempted — the popup never opened.
 *
 * What the same logcat proved positively
 * --------------------------------------
 *
 * After the button tap (13:03:07.x), zero `RattaSnNoteLib:
 * HandWriteClient: sendFullScreenDisableArea` lines were emitted —
 * compare ~16 such lines per plugin open in the previous showType:1
 * run. So `showType: 0` is honoured: the firmware does NOT lock the
 * page when our button fires. That validates the headless approach.
 *
 * Current strategy (this iteration)
 * ---------------------------------
 *
 * Without an Activity, we have to use a SYSTEM-level window type and
 * the Application context's WindowManager. That requires
 * SYSTEM_ALERT_WINDOW permission on Android 8+. The plugin host
 * (com.ratta.supernote.pluginhost) may or may not have declared SAW;
 * we check `Settings.canDrawOverlays()` at runtime and log the
 * result, then attempt the system window types in this order:
 *
 *   1. TYPE_APPLICATION_OVERLAY (2038)  — sanctioned post-Android 8.
 *   2. TYPE_PHONE (2002)                — pre-Oreo path; deprecated
 *      but still permitted on some firmware builds.
 *   3. TYPE_SYSTEM_ALERT (2003)         — same vintage as TYPE_PHONE.
 *   4. TYPE_TOAST (2005)                — historically permission-
 *      free, restricted on newer Android, kept as last-resort
 *      diagnostic.
 *
 * If `currentActivity` IS available (some future flow may foreground
 * one), we still prefer Activity-attached sub-window types first —
 * those don't need SAW.
 *
 * Each attempt is logged; the Promise resolves with a structured
 * `{success, code, message}` result so the JS side can branch
 * deterministically and so a logcat dump tells the full story
 * without needing the JS log.
 */
class CopilotOverlayModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  companion object {
    private const val TAG = "CopilotOverlay"
    private const val MODULE_NAME = "CopilotOverlay"

    // Sub-window types (need an Activity token).
    private const val FIRST_SUB_WINDOW = 1000
    private const val TYPE_APPLICATION_PANEL = FIRST_SUB_WINDOW + 2
    private const val TYPE_APPLICATION_ATTACHED_DIALOG = FIRST_SUB_WINDOW + 4

    // System-level window types (need SAW permission on Android 8+).
    // Surfaced as constants so the Kotlin compiler is happy without
    // pulling in the framework's @hide flags.
    private const val TYPE_PHONE = 2002
    private const val TYPE_SYSTEM_ALERT = 2003
    private const val TYPE_TOAST = 2005
    private const val TYPE_APPLICATION_OVERLAY = 2038

    // Visual chrome — kept in pixels (not dp) because the e-ink panel
    // pixel density is fixed per device and the overlay is sized in
    // raw pixels via WindowManager.LayoutParams (no Configuration
    // scaling). Tuned for visibility on the Carta-class panels every
    // Supernote uses.
    private const val BORDER_WIDTH_PX = 4
    private const val CORNER_RADIUS_PX = 12f
    private const val INNER_PADDING_PX = 24

    // JS-side AppRegistry key for the React component mounted inside
    // the overlay. Registered in index.js via
    // AppRegistry.registerComponent("SnCopilotPanel", () => …).
    // Keep this string in sync with the JS registration.
    private const val REACT_OVERLAY_COMPONENT = "SnCopilotPanel"

    // sn-plugin-lib registers PluginModule under this name (defined as
    // NativePluginManagerSpec.NAME in the SDK's codegen at
    // build/generated/.../NativePluginManagerSpec.java:27). We use it
    // for the string-based getNativeModule lookup in step 1 of the
    // reflection chain — class-based lookup throws because the SDK
    // doesn't carry a @ReactModule annotation on PluginModule.
    private const val MODULE_NAME_NATIVE_PLUGIN_MANAGER = "NativePluginManager"
  }

  private var overlayView: View? = null
  private var layoutParams: WindowManager.LayoutParams? = null
  private var hostWindowManager: WindowManager? = null

  override fun getName(): String = MODULE_NAME

  @ReactMethod
  fun open(width: Double, height: Double, x: Double, y: Double, promise: Promise) {
    Log.i(TAG, "[COPILOT_OVERLAY] open requested width=$width height=$height x=$x y=$y")
    // open() is invoked on the React Native bridge thread
    // (mqt_native_modules), not the UI thread. Everything below
    // creates/touches Android Views and calls WindowManager.addView,
    // both of which must run on the main thread — otherwise the
    // resulting ViewRootImpl claims the bridge thread as the
    // "owning" thread and the next time RN's UIManager (on main
    // thread) tries to populate our ReactRootView's children it
    // throws CalledFromWrongThreadException. The 2026-05-08 16:42
    // device run hit exactly that exception (logcat ViewRootImpl
    // checkThread → ViewGroup.addView → ReactViewGroupManager).
    //
    // UiThreadUtil.runOnUiThread posts to the main looper if not
    // already on it, so reflection helpers below run on the main
    // thread for the rest of the open() flow.
    UiThreadUtil.runOnUiThread { openOnUiThread(width, height, x, y, promise) }
  }

  private fun openOnUiThread(
      width: Double,
      height: Double,
      x: Double,
      y: Double,
      promise: Promise,
  ) {
    val appContext = reactApplicationContext.applicationContext
    val canDrawOverlays = canDrawOverlays(appContext)
    Log.i(TAG, "[COPILOT_OVERLAY] open: canDrawOverlays=$canDrawOverlays " +
        "sdkInt=${Build.VERSION.SDK_INT}")

    if (overlayView != null) {
      Log.w(TAG, "[COPILOT_OVERLAY] open: overlay already exists; closing first")
      removeOverlay()
    }

    val activity = currentActivity
    val attempts = mutableListOf<AttemptResult>()

    // 1. Activity-attached sub-windows — preferred when available
    //    because they don't need SAW.
    if (activity != null) {
      Log.i(TAG, "[COPILOT_OVERLAY] open: foreground activity=" +
          "${activity.javaClass.name}; trying sub-window types first")
      val subWindowTypes = listOf(
          "TYPE_APPLICATION_PANEL" to TYPE_APPLICATION_PANEL,
          "TYPE_APPLICATION_ATTACHED_DIALOG" to TYPE_APPLICATION_ATTACHED_DIALOG,
      )
      for ((typeName, typeValue) in subWindowTypes) {
        val r = tryAddView(
            label = typeName,
            type = typeValue,
            wm = activity.windowManager,
            context = activity,
            width = width, height = height, x = x, y = y,
            tokenSource = activity,
        )
        attempts.add(r)
        if (r.success) {
          succeed(promise, attempts, r)
          return
        }
      }
    } else {
      Log.w(TAG, "[COPILOT_OVERLAY] open: getCurrentActivity() returned null; " +
          "skipping sub-window types and falling through to system windows")
    }

    // 2. System window types — work without an Activity, but most
    //    require SAW permission on Android 8+.
    val systemWindowTypes = mutableListOf<Pair<String, Int>>()
    systemWindowTypes.add("TYPE_APPLICATION_OVERLAY" to TYPE_APPLICATION_OVERLAY)
    systemWindowTypes.add("TYPE_PHONE" to TYPE_PHONE)
    systemWindowTypes.add("TYPE_SYSTEM_ALERT" to TYPE_SYSTEM_ALERT)
    systemWindowTypes.add("TYPE_TOAST" to TYPE_TOAST)

    val systemWm = appContext.getSystemService(Context.WINDOW_SERVICE) as? WindowManager
    if (systemWm == null) {
      val msg = "Application context has no WINDOW_SERVICE — cannot fall back."
      Log.e(TAG, "[COPILOT_OVERLAY] open: $msg")
      attempts.add(AttemptResult("APP_CONTEXT_WM", false, msg))
      fail(promise, attempts, "NO_WINDOW_MANAGER", msg, canDrawOverlays)
      return
    }

    for ((typeName, typeValue) in systemWindowTypes) {
      val r = tryAddView(
          label = typeName,
          type = typeValue,
          wm = systemWm,
          context = appContext,
          width = width, height = height, x = x, y = y,
          tokenSource = null,
      )
      attempts.add(r)
      if (r.success) {
        succeed(promise, attempts, r)
        return
      }
    }

    Log.e(TAG, "[COPILOT_OVERLAY] open: ALL window types failed")
    fail(
        promise = promise,
        attempts = attempts,
        code = if (canDrawOverlays) "ADD_VIEW_FAILED" else "NO_OVERLAY_PERMISSION",
        message = "addView failed for every window type. canDrawOverlays=" +
            "$canDrawOverlays. " +
            (if (!canDrawOverlays)
              "The plugin host process does not hold SYSTEM_ALERT_WINDOW; " +
              "system window types require it on Android 8+. " +
              "Resolution requires either: (a) the firmware vendor adds " +
              "SAW to com.ratta.supernote.pluginhost's manifest, or (b) " +
              "the plugin framework exposes a sanctioned overlay API. " +
              "See playbook/log/2026-05-08-phase1-derisk-popup.md."
            else
              "SAW is granted but every type still failed; check the " +
              "per-type messages in the attempts list."),
        canDrawOverlays = canDrawOverlays,
    )
  }

  /**
   * Copy plain text to the Android system clipboard via
   * ClipboardManager.setPrimaryClip(...).
   *
   * Note: this puts text on the OS clipboard so it can be pasted in
   * other Android apps (browser, email, etc.). It does NOT populate
   * the firmware's element clipboard that the Supernote lasso-Paste
   * menu reads from — Dunn confirmed in the 2026-05-01 message that
   * `pushElementsToClipboard` is planned for the next SDK version
   * but not yet exposed (requirements §3.3 / §10.6). When the SDK
   * gains it, we'll wire a separate "insert as page element" path.
   */
  @ReactMethod
  fun copyToClipboard(text: String, label: String?, promise: Promise) {
    Log.i(TAG,
        "[COPILOT_OVERLAY] copyToClipboard requested " +
        "label=${label ?: "(default)"} length=${text.length}")
    UiThreadUtil.runOnUiThread { copyToClipboardOnUiThread(text, label, promise) }
  }

  private fun copyToClipboardOnUiThread(
      text: String,
      label: String?,
      promise: Promise,
  ) {
    val ctx = reactApplicationContext.applicationContext
    val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
    if (cm == null) {
      Log.e(TAG, "[COPILOT_OVERLAY] copyToClipboard: CLIPBOARD_SERVICE unavailable")
      promise.resolve(buildResult(success = false, code = "NO_CLIPBOARD_SERVICE",
          message = "Application context has no CLIPBOARD_SERVICE"))
      return
    }
    try {
      val clip = ClipData.newPlainText(label ?: "Copilot", text)
      cm.setPrimaryClip(clip)
      Log.i(TAG, "[COPILOT_OVERLAY] copyToClipboard: SUCCESS")
      promise.resolve(buildResult(success = true, code = "OK",
          message = "Copied ${text.length} chars to system clipboard"))
    } catch (e: Throwable) {
      val msg = "${e.javaClass.simpleName}: ${e.message}"
      Log.e(TAG, "[COPILOT_OVERLAY] copyToClipboard threw: $msg", e)
      promise.resolve(buildResult(success = false, code = "CLIPBOARD_THREW",
          message = msg))
    }
  }

  /**
   * Returns the actual screen dimensions of the underlying Android
   * Display via `Display.getRealSize()` — this is the panel's real
   * pixel size for whatever device we're on, in the current
   * orientation, regardless of system bars.
   *
   * Works on every Supernote device the SDK supports (A5, A6, A6X,
   * A5X, A6X2/Nomad, A5X2/Manta) without us having to ship a
   * device-type → dimensions table. Same callsite handles 7.8" and
   * 10.3" panels and portrait/landscape rotations.
   *
   * Returns `{success, width, height, message}` — same convention as
   * the other methods, so the JS side branches on `success`.
   */
  @ReactMethod
  fun getScreenSize(promise: Promise) {
    val ctx = reactApplicationContext.applicationContext
    val wm = ctx.getSystemService(Context.WINDOW_SERVICE) as? WindowManager
    if (wm == null) {
      Log.w(TAG, "[COPILOT_OVERLAY] getScreenSize: WINDOW_SERVICE unavailable")
      promise.resolve(buildScreenSizeResult(false, 0, 0,
          "WINDOW_SERVICE unavailable on application context"))
      return
    }
    return try {
      val display = wm.defaultDisplay
      val size = Point()
      display.getRealSize(size)
      Log.i(TAG, "[COPILOT_OVERLAY] getScreenSize: width=${size.x} height=${size.y}")
      promise.resolve(buildScreenSizeResult(true, size.x, size.y, "OK"))
    } catch (e: Throwable) {
      val msg = "${e.javaClass.simpleName}: ${e.message}"
      Log.e(TAG, "[COPILOT_OVERLAY] getScreenSize: $msg", e)
      promise.resolve(buildScreenSizeResult(false, 0, 0, msg))
    }
  }

  @ReactMethod
  fun move(x: Double, y: Double, promise: Promise) {
    Log.i(TAG, "[COPILOT_OVERLAY] move requested x=$x y=$y")
    // Same UI-thread requirement as open() — wm.updateViewLayout
    // touches the view hierarchy and must run on the thread that
    // owns the ViewRootImpl (which is the main thread because we
    // open() on the main thread).
    UiThreadUtil.runOnUiThread { moveOnUiThread(x, y, promise) }
  }

  private fun moveOnUiThread(x: Double, y: Double, promise: Promise) {
    val view = overlayView
    val viewParams = layoutParams
    val wm = hostWindowManager
    if (view == null || viewParams == null || wm == null) {
      Log.w(TAG, "[COPILOT_OVERLAY] move: no overlay open")
      promise.resolve(buildResult(success = false, code = "NOT_OPEN",
          message = "move() called before open()"))
      return
    }
    viewParams.x = x.toInt()
    viewParams.y = y.toInt()
    try {
      wm.updateViewLayout(view, viewParams)
      Log.i(TAG, "[COPILOT_OVERLAY] move: SUCCESS x=${viewParams.x} y=${viewParams.y}")
      promise.resolve(buildResult(success = true, code = "OK",
          message = "Overlay moved to x=${viewParams.x} y=${viewParams.y}"))
    } catch (e: Throwable) {
      val msg = "${e.javaClass.simpleName}: ${e.message}"
      Log.e(TAG, "[COPILOT_OVERLAY] move: $msg", e)
      promise.resolve(buildResult(success = false, code = "UPDATE_FAILED",
          message = msg))
    }
  }

  /**
   * Force a re-composite of the overlay window. Phase-1 experiment for
   * the "writing under the overlay is mangled" issue: the firmware's
   * pen fast-path renders strokes directly to the e-ink panel, and we
   * don't yet know whether those strokes go into the same framebuffer
   * as our overlay (in which case `invalidate()` + `updateViewLayout()`
   * will overwrite them) or into a separate composited layer (in
   * which case nothing we do at the Android-compositor level can
   * clear them, and the only fix is the SDK addition we're asking
   * Dunn for in playbook/log/2026-05-08-dunn-disable-area-ask.md).
   *
   * The wiring on the JS side is to call this from a PEN_UP listener
   * — fires once per stroke end, which is the right cadence for e-ink
   * (much more frequent would just stress the panel).
   */
  @ReactMethod
  fun redraw(promise: Promise) {
    Log.i(TAG, "[COPILOT_OVERLAY] redraw requested")
    // Same UI-thread requirement — invalidate() + updateViewLayout()
    // both touch the view hierarchy.
    UiThreadUtil.runOnUiThread { redrawOnUiThread(promise) }
  }

  private fun redrawOnUiThread(promise: Promise) {
    val view = overlayView
    val viewParams = layoutParams
    val wm = hostWindowManager
    if (view == null || viewParams == null || wm == null) {
      Log.w(TAG, "[COPILOT_OVERLAY] redraw: no overlay open")
      promise.resolve(buildResult(success = false, code = "NOT_OPEN",
          message = "redraw() called before open()"))
      return
    }
    try {
      view.invalidate()
      // updateViewLayout with the same params forces a window-manager
      // re-composite — same primitive `move` uses for drag. On
      // Scenario A firmware, this overwrites stroke pixels in the
      // overlay region; on Scenario B firmware, this is a no-op for
      // the visible result.
      wm.updateViewLayout(view, viewParams)
      Log.i(TAG, "[COPILOT_OVERLAY] redraw: SUCCESS")
      promise.resolve(buildResult(success = true, code = "OK",
          message = "Overlay re-composited"))
    } catch (e: Throwable) {
      val msg = "${e.javaClass.simpleName}: ${e.message}"
      Log.e(TAG, "[COPILOT_OVERLAY] redraw: $msg", e)
      promise.resolve(buildResult(success = false, code = "UPDATE_FAILED",
          message = msg))
    }
  }

  @ReactMethod
  fun close(promise: Promise) {
    Log.i(TAG, "[COPILOT_OVERLAY] close requested")
    // wm.removeView() and ReactRootView.unmountReactApplication()
    // both touch the view hierarchy and must run on the main thread.
    UiThreadUtil.runOnUiThread { closeOnUiThread(promise) }
  }

  /**
   * Write `base64Content` (a standard base64 string) to `path` as raw
   * bytes. Used by the encrypted-vault store: sn-plugin-lib's
   * NativeFileUtils only exposes copy/rename/delete/list — there's no
   * `writeFile`. Reading is handled by `fetch('file://…')` already.
   *
   * Intent-private write semantics:
   *  - Caller passes the FINAL destination path. Atomicity (write-tmp,
   *    rename) is the caller's responsibility via FileUtils.renameToFile;
   *    this method is the one-shot "put bytes at path" primitive.
   *  - Parent directory must already exist; FileUtils.makeDir is the
   *    other primitive callers use to set that up.
   */
  @ReactMethod
  fun writeFileBase64(path: String, base64Content: String, promise: Promise) {
    Log.i(TAG, "[COPILOT_OVERLAY] writeFileBase64 path=$path bytes(b64)=${base64Content.length}")
    try {
      val bytes = android.util.Base64.decode(base64Content, android.util.Base64.DEFAULT)
      val target = java.io.File(path)
      val parent = target.parentFile
      if (parent != null && !parent.exists()) {
        promise.resolve(buildResult(success = false, code = "PARENT_MISSING",
            message = "Parent directory does not exist: ${parent.absolutePath}"))
        return
      }
      java.io.FileOutputStream(target).use { it.write(bytes) }
      Log.i(TAG, "[COPILOT_OVERLAY] writeFileBase64: SUCCESS bytes=${bytes.size}")
      promise.resolve(buildResult(success = true, code = "OK",
          message = "Wrote ${bytes.size} bytes to $path"))
    } catch (e: IllegalArgumentException) {
      val msg = "Invalid base64 input: ${e.message}"
      Log.e(TAG, "[COPILOT_OVERLAY] writeFileBase64: $msg", e)
      promise.resolve(buildResult(success = false, code = "BAD_BASE64", message = msg))
    } catch (e: Throwable) {
      val msg = "${e.javaClass.simpleName}: ${e.message}"
      Log.e(TAG, "[COPILOT_OVERLAY] writeFileBase64: $msg", e)
      promise.resolve(buildResult(success = false, code = "WRITE_FAILED", message = msg))
    }
  }

  private fun closeOnUiThread(promise: Promise) {
    val removed = removeOverlay()
    if (removed) {
      Log.i(TAG, "[COPILOT_OVERLAY] close: SUCCESS")
      promise.resolve(buildResult(success = true, code = "OK",
          message = "Overlay removed"))
    } else {
      Log.w(TAG, "[COPILOT_OVERLAY] close: nothing to remove")
      promise.resolve(buildResult(success = false, code = "NOT_OPEN",
          message = "close() called with no overlay open"))
    }
  }

  // -------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------

  private data class AttemptResult(
      val label: String,
      val success: Boolean,
      val message: String,
  )

  private fun tryAddView(
      label: String,
      type: Int,
      wm: WindowManager,
      context: Context,
      width: Double,
      height: Double,
      x: Double,
      y: Double,
      tokenSource: Activity?,
  ): AttemptResult {
    val params = buildLayoutParams(width, height, x, y, type, tokenSource)
    val view = buildOverlayView(context)
    return try {
      Log.i(TAG, "[COPILOT_OVERLAY] open: trying $label ($type)")
      wm.addView(view, params)
      overlayView = view
      layoutParams = params
      hostWindowManager = wm
      val msg = "Overlay added with $label at " +
          "x=${params.x} y=${params.y} w=${params.width} h=${params.height}"
      Log.i(TAG, "[COPILOT_OVERLAY] open: SUCCESS using $label")
      AttemptResult(label, true, msg)
    } catch (e: Throwable) {
      val msg = "$label failed: ${e.javaClass.simpleName}: ${e.message}"
      Log.w(TAG, "[COPILOT_OVERLAY] open: $msg")
      AttemptResult(label, false, msg)
    }
  }

  private fun removeOverlay(): Boolean {
    val view = overlayView ?: return false
    val wm = hostWindowManager
    overlayView = null
    layoutParams = null
    hostWindowManager = null

    // If a ReactRootView is mounted inside the overlay, unmount it so
    // the per-plugin React instance doesn't leak the previous root.
    // Without this, a second open() would re-mount on top of a stale
    // tree and the bridge would log "ReactRootView was unmounted but
    // not yet attached" warnings.
    if (view is ViewGroup) {
      detachReactRootViews(view)
    }

    if (wm == null) {
      Log.w(TAG, "[COPILOT_OVERLAY] removeOverlay: no WindowManager available")
      return false
    }
    return try {
      wm.removeView(view)
      true
    } catch (e: Throwable) {
      Log.w(TAG, "[COPILOT_OVERLAY] removeOverlay: " +
          "${e.javaClass.simpleName}: ${e.message}", e)
      false
    }
  }

  private fun detachReactRootViews(parent: ViewGroup) {
    for (i in 0 until parent.childCount) {
      val child = parent.getChildAt(i)
      if (child is ReactRootView) {
        try {
          child.unmountReactApplication()
          Log.i(TAG, "[COPILOT_OVERLAY] React root unmounted")
        } catch (e: Throwable) {
          Log.w(TAG,
              "[COPILOT_OVERLAY] unmountReactApplication failed: " +
              "${e.javaClass.simpleName}: ${e.message}", e)
        }
      } else if (child is ViewGroup) {
        detachReactRootViews(child)
      }
    }
  }

  private fun canDrawOverlays(context: Context): Boolean {
    // Pre-Marshmallow had no runtime gate; treat as granted.
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true
    return try {
      Settings.canDrawOverlays(context)
    } catch (e: Throwable) {
      Log.w(TAG, "[COPILOT_OVERLAY] canDrawOverlays threw: ${e.message}")
      false
    }
  }

  private fun buildOverlayView(context: Context): View {
    // Visible border: white fill + 4-px black stroke, slight rounded
    // corners. Without the stroke the overlay reads as a faint
    // rectangle on e-ink — adding a real border makes it obviously a
    // popup rather than a piece of the page (confirmed in the
    // 2026-05-08 device run).
    val borderDrawable = GradientDrawable().apply {
      shape = GradientDrawable.RECTANGLE
      setColor(Color.WHITE)
      setStroke(BORDER_WIDTH_PX, Color.BLACK)
      cornerRadius = CORNER_RADIUS_PX
    }

    val frame = FrameLayout(context).apply {
      background = borderDrawable
      // Inset content from the border so the children don't touch
      // the black stroke.
      setPadding(
          BORDER_WIDTH_PX + INNER_PADDING_PX,
          BORDER_WIDTH_PX + INNER_PADDING_PX,
          BORDER_WIDTH_PX + INNER_PADDING_PX,
          BORDER_WIDTH_PX + INNER_PADDING_PX,
      )
    }

    // Try to mount the React tree via the reflection chain
    // documented in playbook/log/2026-05-08-react-mount-reflection-plan.md.
    // If any step fails, fall back to a native diagnostic TextView so
    // the device shows something AND the logcat tells us which step
    // broke.
    val reactRootView = tryMountReactRootView(context)
    if (reactRootView != null) {
      val lp = FrameLayout.LayoutParams(
          ViewGroup.LayoutParams.MATCH_PARENT,
          ViewGroup.LayoutParams.MATCH_PARENT,
      )
      frame.addView(reactRootView, lp)
      Log.i(TAG, "[COPILOT_OVERLAY] React root mounted inside overlay")
    } else {
      val body = TextView(context).apply {
        text =
            "Copilot overlay\n\n" +
            "React mount failed — see logcat [COPILOT_OVERLAY] " +
            "for the per-step diagnostic. Tap to close."
        textSize = 16f
        setTextColor(Color.BLACK)
      }
      frame.addView(body)
      Log.w(TAG, "[COPILOT_OVERLAY] React root NOT mounted; using native fallback")
    }

    frame.setOnTouchListener(TapToCloseListener())
    return frame
  }

  /**
   * Reflection chain to mount the per-plugin React tree inside our
   * overlay window. See playbook/log/2026-05-08-react-mount-reflection-plan.md.
   *
   * Step 1: get PluginModule via the public TurboModule API.
   * Step 2: read PluginModule.pluginApp (package-private) via reflection.
   * Step 3: invoke getReactInstanceManager() on the runtime concrete
   *         PluginApp via javaClass.getMethod(...).
   * Step 4: ReactRootView.startReactApplication with the per-plugin RIM.
   *
   * Each step logs precisely on failure so a single device run tells us
   * which symbol changed (and we can adapt by reading the SDK source
   * for the new field/method name).
   */
  private fun tryMountReactRootView(context: Context): ReactRootView? {
    val pluginModule = step1GetPluginModule() ?: return null
    val pluginApp = step2ReadPluginAppField(pluginModule) ?: return null
    val rim = step3InvokeGetReactInstanceManager(pluginApp) ?: return null
    return step4StartReactApplication(rim)
  }

  private fun step1GetPluginModule(): PluginModule? {
    // We deliberately use the string-based lookup with the registered
    // module name ("NativePluginManager"). The class-based overload
    // `getNativeModule(Class)` requires the target class to carry a
    // `@ReactModule(name=...)` annotation — sn-plugin-lib's
    // PluginModule does NOT, and the class-based call throws
    // `IllegalArgumentException: Could not find @ReactModule
    // annotation in com.ratta.supernote.pluginlib.modules.PluginModule`
    // (verified on device, logcat 2026-05-08 16:34 PID 17098).
    //
    // The string-based lookup goes through the same TurboModule /
    // legacy registry but doesn't require the annotation. The
    // "NativePluginManager" name is exposed as
    // NativePluginManagerSpec.NAME in the SDK codegen (sn-plugin-lib
    // 0.1.34 / build/generated/.../NativePluginManagerSpec.java:27)
    // and matches the JS-side getEnforcing<Spec>('NativePluginManager').
    return try {
      val module = reactApplicationContext.getNativeModule(MODULE_NAME_NATIVE_PLUGIN_MANAGER)
      if (module == null) {
        Log.w(TAG,
            "[COPILOT_OVERLAY] reflect step1: native module " +
            "'$MODULE_NAME_NATIVE_PLUGIN_MANAGER' not registered " +
            "in this React context — bailing.")
        return null
      }
      if (module !is PluginModule) {
        Log.e(TAG,
            "[COPILOT_OVERLAY] reflect step1: native module " +
            "'$MODULE_NAME_NATIVE_PLUGIN_MANAGER' is " +
            "${module.javaClass.name}, expected PluginModule. " +
            "SDK packaging changed — bailing.")
        return null
      }
      Log.i(TAG, "[COPILOT_OVERLAY] reflect step1: PluginModule=$module")
      module
    } catch (e: Throwable) {
      Log.e(TAG,
          "[COPILOT_OVERLAY] reflect step1 threw: " +
          "${e.javaClass.simpleName}: ${e.message}", e)
      null
    }
  }

  private fun step2ReadPluginAppField(pluginModule: PluginModule): Any? {
    return try {
      val field = PluginModule::class.java.getDeclaredField("pluginApp")
      field.isAccessible = true
      val value = field.get(pluginModule)
      if (value == null) {
        Log.w(TAG,
            "[COPILOT_OVERLAY] reflect step2: PluginModule.pluginApp is null. " +
            "Host did not inject pluginApp — bailing.")
      } else {
        Log.i(TAG,
            "[COPILOT_OVERLAY] reflect step2: pluginApp=$value " +
            "(runtime class=${value.javaClass.name})")
      }
      value
    } catch (e: NoSuchFieldException) {
      Log.e(TAG,
          "[COPILOT_OVERLAY] reflect step2: PluginModule.pluginApp field " +
          "not found — SDK rename? Declared fields: " +
          PluginModule::class.java.declaredFields.joinToString { it.name })
      null
    } catch (e: Throwable) {
      Log.e(TAG,
          "[COPILOT_OVERLAY] reflect step2 threw: " +
          "${e.javaClass.simpleName}: ${e.message}", e)
      null
    }
  }

  private fun step3InvokeGetReactInstanceManager(pluginApp: Any): ReactInstanceManager? {
    // The 2026-05-08 16:38 PID 17098 device run dumped all available
    // methods on com.ratta.supernote.pluginhost.plugin.PluginApp and
    // confirmed: there is NO `getReactInstanceManager()` method
    // (the SDK's commented-out FileSelector reference at
    // FileSelector.java:44 was for an older shape). The current
    // method is `getReactNativeHost()` which returns a standard
    // ReactNativeHost; we then call `.getReactInstanceManager()` on
    // it (a public method on RN's own class, no reflection).
    //
    // ReactNativeHost is per-plugin in this firmware — confirmed by
    // the earlier logcat hint `PluginManager: getReactNativeHost
    // StubActivity:com.ratta.supernote.pluginhost.StubActivity@…` —
    // so the RIM we get from it is the per-plugin one our index.js
    // bundle was loaded into. That is what the original Phase 2
    // crash (Invariant Violation: SnCopilotPanel has not been
    // registered) needed.
    return try {
      val method = pluginApp.javaClass.getMethod("getReactNativeHost")
      val hostRaw = method.invoke(pluginApp)
      if (hostRaw == null) {
        Log.w(TAG,
            "[COPILOT_OVERLAY] reflect step3: getReactNativeHost() " +
            "returned null — host not yet attached? Bailing.")
        return null
      }
      if (hostRaw !is ReactNativeHost) {
        Log.e(TAG,
            "[COPILOT_OVERLAY] reflect step3: getReactNativeHost() " +
            "returned ${hostRaw.javaClass.name}, expected " +
            "com.facebook.react.ReactNativeHost. SDK shape changed — bailing.")
        return null
      }
      Log.i(TAG,
          "[COPILOT_OVERLAY] reflect step3a: ReactNativeHost=$hostRaw")

      val rim = hostRaw.reactInstanceManager
      if (rim == null) {
        Log.w(TAG,
            "[COPILOT_OVERLAY] reflect step3b: " +
            "ReactNativeHost.reactInstanceManager is null — bailing.")
        return null
      }
      Log.i(TAG,
          "[COPILOT_OVERLAY] reflect step3b: ReactInstanceManager=$rim")
      rim
    } catch (e: NoSuchMethodException) {
      val methods = pluginApp.javaClass.methods
          .map { it.name }
          .distinct()
          .sorted()
          .joinToString()
      Log.e(TAG,
          "[COPILOT_OVERLAY] reflect step3: getReactNativeHost() " +
          "method not found on ${pluginApp.javaClass.name}. " +
          "Available methods: $methods")
      null
    } catch (e: Throwable) {
      Log.e(TAG,
          "[COPILOT_OVERLAY] reflect step3 threw: " +
          "${e.javaClass.simpleName}: ${e.message}", e)
      null
    }
  }

  private fun step4StartReactApplication(rim: ReactInstanceManager): ReactRootView? {
    return try {
      val rootView = ReactRootView(reactApplicationContext)
      val initialProps = Bundle()
      // Reserved for Phase 2 — handlers will pass scope info here so
      // the panel knows which entry point fired (sidebar / lasso /
      // doc-select). Empty for the de-risk-mount step.
      rootView.startReactApplication(rim, REACT_OVERLAY_COMPONENT, initialProps)
      Log.i(TAG,
          "[COPILOT_OVERLAY] reflect step4: startReactApplication " +
          "(\"$REACT_OVERLAY_COMPONENT\") succeeded")
      rootView
    } catch (e: Throwable) {
      Log.e(TAG,
          "[COPILOT_OVERLAY] reflect step4: startReactApplication threw: " +
          "${e.javaClass.simpleName}: ${e.message}", e)
      null
    }
  }

  private fun buildLayoutParams(
      width: Double,
      height: Double,
      x: Double,
      y: Double,
      type: Int,
      tokenSource: Activity?,
  ): WindowManager.LayoutParams {
    // Window flag rationale:
    //
    //  FLAG_NOT_TOUCH_MODAL — touches OUTSIDE our overlay still go
    //  to the underlying note canvas (so the user can keep writing
    //  on the page). This is the load-bearing flag for the page-
    //  stays-editable behaviour proven in the 2026-05-08 device
    //  run.
    //
    //  FLAG_LAYOUT_NO_LIMITS — overlay can extend outside the
    //  screen bounds (kept for safety; harmless when we right-dock
    //  on-screen).
    //
    //  We do NOT set FLAG_NOT_FOCUSABLE. With that flag set, the
    //  Supernote handwriting / keyboard IME never appears when the
    //  TextInput in ChatView gains focus — taps on the input field
    //  go through but no input mechanism shows. Dropping the flag
    //  makes the overlay focusable, so the IME pops up on TextInput
    //  focus. Touches outside the overlay still pass through
    //  because of FLAG_NOT_TOUCH_MODAL.
    val flags = (
        WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
        or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
    )
    val params = WindowManager.LayoutParams(
        width.toInt(),
        height.toInt(),
        type,
        flags,
        PixelFormat.TRANSLUCENT,
    )
    params.gravity = Gravity.TOP or Gravity.START
    params.x = x.toInt()
    params.y = y.toInt()
    // Sub-window types need an attached token; system types don't.
    if (tokenSource != null) {
      params.token = tokenSource.window.decorView.windowToken
    }
    return params
  }

  private fun buildResult(success: Boolean, code: String, message: String): WritableMap {
    val map = Arguments.createMap()
    map.putBoolean("success", success)
    map.putString("code", code)
    map.putString("message", message)
    return map
  }

  private fun buildScreenSizeResult(
      success: Boolean,
      width: Int,
      height: Int,
      message: String,
  ): WritableMap {
    val map = Arguments.createMap()
    map.putBoolean("success", success)
    map.putInt("width", width)
    map.putInt("height", height)
    map.putString("message", message)
    return map
  }


  private fun succeed(promise: Promise, attempts: List<AttemptResult>, winning: AttemptResult) {
    val msg = winning.message + " (attempted " + attempts.size + " type(s))"
    promise.resolve(buildResult(success = true, code = "OK", message = msg))
  }

  private fun fail(
      promise: Promise,
      attempts: List<AttemptResult>,
      code: String,
      message: String,
      canDrawOverlays: Boolean,
  ) {
    val combined = StringBuilder()
    combined.append(message)
    combined.append(" canDrawOverlays=").append(canDrawOverlays).append(". ")
    combined.append("Attempts: ")
    combined.append(attempts.joinToString("; ") { "${it.label}=${if (it.success) "ok" else "failed"} (${it.message})" })
    promise.resolve(buildResult(success = false, code = code, message = combined.toString()))
  }

  private inner class TapToCloseListener : View.OnTouchListener {
    private var downX = 0f
    private var downY = 0f
    private val tapSlopPx = 12

    override fun onTouch(v: View, event: MotionEvent): Boolean {
      when (event.action) {
        MotionEvent.ACTION_DOWN -> {
          downX = event.rawX
          downY = event.rawY
        }
        MotionEvent.ACTION_UP -> {
          val dx = kotlin.math.abs(event.rawX - downX)
          val dy = kotlin.math.abs(event.rawY - downY)
          if (dx <= tapSlopPx && dy <= tapSlopPx) {
            Log.i(TAG, "[COPILOT_OVERLAY] tap detected — closing overlay")
            removeOverlay()
          }
        }
      }
      return true
    }
  }
}
