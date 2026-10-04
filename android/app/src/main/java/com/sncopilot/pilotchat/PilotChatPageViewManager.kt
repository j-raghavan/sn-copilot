package com.sncopilot.pilotchat

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.annotations.ReactProp
import com.facebook.react.uimanager.events.Event

/**
 * Exposes [PilotChatPageView] to React Native as `<PilotChatPageView>` (see
 * src/native/PilotChatPageView.ts). Thin, in sn-canvas's CanvasViewManager
 * pattern: the `notePen` and `inkEnabled` props; the `ask`, `appendAnswer`, `appendNote`,
 * `exportForNote`, `clearPage` and `scrollPage` commands; and the `onQuestion` and
 * `onExport` events.
 *
 * Commands arrive through both [receiveCommand] overloads; which one the
 * runtime calls depends on whether the view's tag is a Paper or a Fabric tag at
 * the interop boundary, so both are handled.
 */
internal class PilotChatPageViewManager : SimpleViewManager<PilotChatPageView>() {
  override fun getName(): String = NAME

  override fun createViewInstance(reactContext: ThemedReactContext): PilotChatPageView =
      PilotChatPageView(
          reactContext,
          object : PilotChatPageView.Events {
            override fun onQuestion(view: PilotChatPageView, strokes: List<List<PagePoint>>, imagePng: String?) =
                dispatch(reactContext, view, EVENT_QUESTION, questionPayload(strokes, imagePng))

            override fun onExport(view: PilotChatPageView, export: PilotChatPageView.NoteExport) =
                dispatch(reactContext, view, EVENT_EXPORT, exportPayload(export))
          },
      )

  /** The note's pen as the SDK's getPenInfo reports it ({type, width, color}), to set back on close. */
  @ReactProp(name = "notePen")
  fun setNotePen(view: PilotChatPageView, pen: ReadableMap?) {
    val type = pen?.takeIf { it.hasKey("type") }?.getInt("type")
    val width = pen?.takeIf { it.hasKey("width") }?.getInt("width") ?: 0
    val color = pen?.takeIf { it.hasKey("color") }?.getInt("color") ?: 0
    view.setNotePen(type?.let { FirmwarePen.ofNotePen(it, width, color) })
  }

  /** Ink on the page; false while the insert prompt covers it. */
  @ReactProp(name = "inkEnabled", defaultBoolean = true)
  fun setInkEnabled(view: PilotChatPageView, enabled: Boolean) = view.setInkEnabled(enabled)

  override fun getCommandsMap(): MutableMap<String, Int> = COMMAND_IDS.toMutableMap()

  // Deprecated upstream in favor of the String overload below, but still the one a Paper tag calls (see class doc).
  @Suppress("OVERRIDE_DEPRECATION")
  override fun receiveCommand(root: PilotChatPageView, commandId: Int, args: ReadableArray?) {
    val command = COMMAND_IDS.entries.firstOrNull { it.value == commandId } ?: return
    runCommand(root, command.key, args)
  }

  override fun receiveCommand(root: PilotChatPageView, commandId: String, args: ReadableArray?) =
      runCommand(root, commandId, args)

  override fun getExportedCustomDirectEventTypeConstants(): MutableMap<String, Any> =
      mutableMapOf(
          EVENT_QUESTION to mapOf("registrationName" to "onQuestion"),
          EVENT_EXPORT to mapOf("registrationName" to "onExport"),
      )

  private fun runCommand(root: PilotChatPageView, command: String, args: ReadableArray?) {
    when (command) {
      COMMAND_ASK -> root.ask()
      COMMAND_APPEND_ANSWER ->
          args?.takeIf { it.size() > 0 }?.getString(0)?.let(root::appendAnswer)
      COMMAND_APPEND_NOTE ->
          args?.takeIf { it.size() > 0 }?.getString(0)?.let(root::appendNote)
      COMMAND_CLEAR_PAGE -> root.clearPage()
      COMMAND_SCROLL_PAGE ->
          if (args != null && args.size() > 0) root.scrollPage(args.getDouble(0).toInt())
      COMMAND_EXPORT_FOR_NOTE ->
          if (args != null && args.size() >= 2) {
            val maxHeight = if (args.size() >= 3) args.getDouble(2).toInt() else Int.MAX_VALUE
            root.exportForNote(args.getDouble(0).toFloat(), args.getDouble(1).toInt(), maxHeight)
          }
    }
  }

  /**
   * {pageWidth, items: [{kind: 'writing', strokes: [[x0, y0, …], …]} |
   * {kind: 'paragraph', text, height}]}, strokes in PilotChat page pixels.
   */
  private fun exportPayload(export: PilotChatPageView.NoteExport): WritableMap {
    val items = Arguments.createArray()
    for (item in export.items) {
      val map = Arguments.createMap()
      when (item) {
        is PilotChatPageView.NoteExport.Item.Writing -> {
          map.putString("kind", "writing")
          map.putArray("strokes", flatStrokes(item.strokes.map { it.points }))
        }
        is PilotChatPageView.NoteExport.Item.Paragraph -> {
          map.putString("kind", "paragraph")
          map.putString("text", item.text)
          map.putInt("height", item.height)
        }
      }
      items.pushMap(map)
    }
    return Arguments.createMap().apply {
      putInt("pageWidth", export.pageWidth)
      putArray("items", items)
    }
  }

  /**
   * {strokes: [[x0, y0, x1, y1, …], …], image?: base64 PNG}: flat per stroke,
   * so a question crosses the bridge as a few arrays.
   */
  private fun questionPayload(strokes: List<List<PagePoint>>, imagePng: String?): WritableMap =
      Arguments.createMap().apply {
        putArray("strokes", flatStrokes(strokes))
        imagePng?.let { putString("image", it) }
      }

  /** Each stroke as one flat array [x0, y0, x1, y1, …]. */
  private fun flatStrokes(strokes: List<List<PagePoint>>): WritableArray {
    val all = Arguments.createArray()
    for (stroke in strokes) {
      val flat = Arguments.createArray()
      for (point in stroke) {
        flat.pushDouble(point.x.toDouble())
        flat.pushDouble(point.y.toDouble())
      }
      all.pushArray(flat)
    }
    return all
  }

  private fun dispatch(
      context: ThemedReactContext,
      view: PilotChatPageView,
      eventName: String,
      payload: WritableMap,
  ) {
    val dispatcher = UIManagerHelper.getEventDispatcherForReactTag(context, view.id) ?: return
    dispatcher.dispatchEvent(PilotChatEvent(UIManagerHelper.getSurfaceId(view), view.id, eventName, payload))
  }

  private class PilotChatEvent(
      surfaceId: Int,
      viewTag: Int,
      private val name: String,
      private val payload: WritableMap,
  ) : Event<PilotChatEvent>(surfaceId, viewTag) {
    override fun getEventName(): String = name

    override fun getEventData(): WritableMap = payload
  }

  companion object {
    const val NAME = "PilotChatPageView"
    private const val EVENT_QUESTION = "topQuestion"
    private const val EVENT_EXPORT = "topExport"
    private const val COMMAND_ASK = "ask"
    private const val COMMAND_APPEND_ANSWER = "appendAnswer"
    private const val COMMAND_APPEND_NOTE = "appendNote"
    private const val COMMAND_EXPORT_FOR_NOTE = "exportForNote"
    private const val COMMAND_CLEAR_PAGE = "clearPage"
    private const val COMMAND_SCROLL_PAGE = "scrollPage"
    private val COMMAND_IDS =
        mapOf(
            COMMAND_ASK to 1,
            COMMAND_APPEND_ANSWER to 2,
            COMMAND_APPEND_NOTE to 3,
            COMMAND_EXPORT_FOR_NOTE to 4,
            COMMAND_CLEAR_PAGE to 5,
            COMMAND_SCROLL_PAGE to 6,
        )
  }
}
