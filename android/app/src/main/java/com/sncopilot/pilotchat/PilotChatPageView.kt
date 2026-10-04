package com.sncopilot.pilotchat

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Typeface
import android.os.SystemClock
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.util.Base64
import android.util.Log
import android.view.MotionEvent
import android.view.View
import kotlin.math.sign

/**
 * The PilotChat page on screen. The pen writes; touch never moves the page,
 * which scrolls only by [scrollPage] (the header's buttons) and to show a new
 * answer, so a resting palm can't jump it about. After the pen
 * rests for [QUESTION_PAUSE_MS] (or on [ask]) the strokes written since the
 * last question are handed to JS as a question: its strokes in screen pixels,
 * and a PNG of just those strokes. JS asks the provider and answers through
 * [appendAnswer], which lays the answer out under the question. The user's
 * ink never moves.
 *
 * The pen is claimed while the page shows and handed back to the note the
 * moment it doesn't, as sn-canvas's CanvasView does: closing the plugin hides
 * the view before the note takes the pen back.
 */
internal class PilotChatPageView(
    context: Context,
    private val events: Events,
) : View(context) {
  interface Events {
    /**
     * A question was written: its strokes, each a list of points in screen
     * pixels, and a base64 PNG of those strokes alone (null if it could not be
     * drawn).
     */
    fun onQuestion(view: PilotChatPageView, strokes: List<List<PagePoint>>, imagePng: String?)

    /** The page's content for the notebook, as [exportForNote] measured it. */
    fun onExport(view: PilotChatPageView, export: NoteExport)
  }

  /**
   * The page's content for the notebook, top to bottom: the user's writing in
   * page pixels, and each answer paragraph with its height at the notebook's
   * font size and text width.
   */
  data class NoteExport(val pageWidth: Int, val items: List<Item>) {
    sealed interface Item {
      data class Writing(val strokes: List<PageStroke>) : Item

      data class Paragraph(val text: String, val height: Int) : Item
    }
  }

  private var page = PilotChatPage()
  private val ink = PilotChatInk(this)
  private val layouts = HashMap<PilotChatPage.Answer, StaticLayout>()

  // How far the page is scrolled down, in pixels.
  private var scroll = 0f

  // The stroke being written, in page pixels; null while the pen is up.
  private var live: MutableList<PagePoint>? = null

  // A question was handed to JS and its answer has not come back yet.
  private var awaiting = false

  // When the pen last lifted, for drawing strokes that may not have been inked (see penLifted).
  private var lastPenUpAt = 0L

  // A hand touched the screen mid-stroke: redraw as the stroke ends (see onHand).
  private var redrawAtPenUp = false

  // When a hand last touched the screen (see onHand).
  private var lastHandAt = 0L

  // Claims the pen again after a hand touch, ahead of the note's pen change (see onHand);
  // never mid-stroke, where a pen change is what loses ink: then as the pen lifts.
  private var reclaimAtPenUp = false
  private val reclaim = Runnable { if (live == null) ink.reassert() else reclaimAtPenUp = true }

  private val askAfterPause = Runnable { ask() }

  // If no answer or note ever comes back, the pen must not stay paused.
  private val answerTimedOut = Runnable { endAwaiting() }

  private val strokePaint =
      Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.BLACK
        style = Paint.Style.STROKE
        strokeWidth = STROKE_WIDTH_PX
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
      }

  private val answerPaint =
      TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.BLACK
        textSize = ANSWER_TEXT_PX
        typeface = Typeface.SERIF
      }

  init {
    setBackgroundColor(Color.WHITE)
  }

  /** The pen the note writes with, set back as the page gives the pen back; null when unknown. */
  fun setNotePen(pen: FirmwarePen?) {
    ink.notePen = pen
  }

  /** Hands the strokes written since the last question to JS now, without waiting for the pen to rest. */
  fun ask() {
    removeCallbacks(askAfterPause)
    // One question at a time: writing done meanwhile is asked once the answer is in.
    if (awaiting) return
    // Tapping Ask with the pen inks a mark on the header; the writing is redrawn by the view.
    ink.clearMarks()
    val question = page.takeQuestion() ?: return
    awaiting = true
    // The page is about to change under the pen: hold it until the answer is written.
    ink.pause()
    postDelayed(answerTimedOut, ANSWER_TIMEOUT_MS)
    val origin = IntArray(2).also(::getLocationOnScreen)
    val onScreen =
        question.strokes.map { stroke ->
          stroke.points.map { PagePoint(it.x + origin[0], it.y - scroll + origin[1]) }
        }
    events.onQuestion(this, onScreen, imageOf(question))
    invalidate()
  }

  /** The question's own strokes, cropped to them and drawn black on white, as a base64 PNG. */
  private fun imageOf(question: PilotChatPage.Question): String? =
      try {
        val crop = question.crop(IMAGE_PAD_PX, IMAGE_MAX_SIDE_PX)
        val bitmap = Bitmap.createBitmap(crop.width, crop.height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.drawColor(Color.WHITE)
        canvas.scale(crop.scale, crop.scale)
        canvas.translate(-crop.left, -crop.top)
        question.strokes.forEach { drawStroke(canvas, it.points) }
        val png = java.io.ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, png)
        bitmap.recycle()
        Base64.encodeToString(png.toByteArray(), Base64.NO_WRAP)
      } catch (e: Throwable) {
        Log.w(TAG, "question image failed: ${e.javaClass.simpleName}: ${e.message}")
        null
      }

  /** Ink off while something covers the page (the insert prompt), so taps on it leave nothing. */
  fun setInkEnabled(enabled: Boolean) {
    ink.blocked = !enabled
  }

  /** Starts a new, empty page: everything written and answered goes, and the pen writes again. */
  fun clearPage() {
    removeCallbacks(askAfterPause)
    removeCallbacks(answerTimedOut)
    page = PilotChatPage()
    layouts.clear()
    live = null
    scroll = 0f
    awaiting = false
    ink.reset()
  }

  /** Writes an answer under the page's content and scrolls so it can be read. */
  fun appendAnswer(text: String) = append(text, isNote = false)

  /** Writes a note from the PilotChat itself (a failure, a setup hint): shown, never put in the notebook. */
  fun appendNote(text: String) = append(text, isNote = true)

  /**
   * Measures the page's content for the notebook and hands it to JS: each
   * answer is split into paragraphs, measured at [fontSizePx] across
   * [textWidthPx] in the notebook's sans-serif, so they can be placed and
   * paginated there. A paragraph taller than [maxHeightPx], a notebook
   * page's room for text, is cut at line ends into pieces that each fit one.
   */
  fun exportForNote(fontSizePx: Float, textWidthPx: Int, maxHeightPx: Int) {
    val paint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
      textSize = fontSizePx
      typeface = Typeface.DEFAULT
    }
    val items = mutableListOf<NoteExport.Item>()
    for (export in page.exportable()) {
      when (export) {
        is PilotChatPage.Export.Writing -> items += NoteExport.Item.Writing(export.strokes)
        is PilotChatPage.Export.Text -> paragraphsOf(export.text).forEach { paragraph ->
          val layout = staticLayout(paragraph, paint, textWidthPx, 1f)
          piecesOf(paragraph, layout, maxHeightPx).forEach { (text, height) ->
            items += NoteExport.Item.Paragraph(text, height)
          }
        }
      }
    }
    val pageWidth = if (width > 0) width else resources.displayMetrics.widthPixels
    events.onExport(this, NoteExport(pageWidth, items))
  }

  private fun append(text: String, isNote: Boolean) {
    val layout = layoutOf(text)
    val answer = page.addAnswer(text, layout.height.toFloat(), isNote)
    layouts[answer] = layout
    // Show the answer from its top, with room under it for the next question when it fits.
    val wantBottomAt = height * ANSWER_BOTTOM_FRACTION
    val target = minOf(answer.bottom - wantBottomAt, answer.top - PilotChatPage.BLOCK_GAP)
    scrollTo(maxOf(scroll, target))
    ink.wipe()
    endAwaiting()
  }

  private fun endAwaiting() {
    removeCallbacks(answerTimedOut)
    awaiting = false
    ink.resume()
    invalidate()
  }

  private fun layoutOf(text: String): StaticLayout {
    val width = (if (width > 0) width else resources.displayMetrics.widthPixels) - 2 * SIDE_MARGIN_PX
    return staticLayout(text, answerPaint, width.toInt(), ANSWER_LINE_SPACING)
  }

  private fun staticLayout(text: String, paint: TextPaint, width: Int, spacing: Float): StaticLayout =
      StaticLayout.Builder.obtain(text, 0, text.length, paint, maxOf(1, width))
          .setAlignment(Layout.Alignment.ALIGN_NORMAL)
          .setLineSpacing(0f, spacing)
          .build()

  // [text] laid out as [layout], cut at line ends into pieces no taller than
  // [maxHeight] each, with their heights; one piece when it already fits.
  private fun piecesOf(text: String, layout: StaticLayout, maxHeight: Int): List<Pair<String, Int>> {
    if (layout.height <= maxHeight) return listOf(text to layout.height)
    val pieces = mutableListOf<Pair<String, Int>>()
    var first = 0
    while (first < layout.lineCount) {
      var last = first
      while (last + 1 < layout.lineCount &&
          layout.getLineBottom(last + 1) - layout.getLineTop(first) <= maxHeight) {
        last++
      }
      val piece = text.substring(layout.getLineStart(first), layout.getLineEnd(last)).trim()
      if (piece.isNotEmpty()) {
        pieces += piece to (layout.getLineBottom(last) - layout.getLineTop(first))
      }
      first = last + 1
    }
    return pieces
  }

  // Blank lines separate paragraphs; each goes into the notebook as its own text box.
  private fun paragraphsOf(text: String): List<String> =
      text.split(Regex("\\n\\s*\\n")).map { it.trim() }.filter { it.isNotEmpty() }

  private fun scrollTo(target: Float) {
    val maxScroll = maxOf(0f, page.contentBottom - height * MIN_VISIBLE_FRACTION)
    scroll = target.coerceIn(0f, maxScroll)
  }

  override fun onTouchEvent(event: MotionEvent): Boolean {
    val tool = event.getToolType(event.actionIndex)
    if (tool == MotionEvent.TOOL_TYPE_FINGER) return onHand(event)
    return when {
      // The pen is paused while the PilotChat writes back; a stroke already under way finishes.
      ink.isPaused && live == null && tool == MotionEvent.TOOL_TYPE_STYLUS -> true
      tool == MotionEvent.TOOL_TYPE_STYLUS || live != null -> onPen(event)
      // The eraser end has nothing to erase yet.
      tool == MotionEvent.TOOL_TYPE_ERASER -> true
      // Anything else (a mouse, say) does nothing on the page.
      else -> true
    }
  }

  /**
   * A finger, or the hand resting on the screen while writing. Two things
   * follow one on device:
   * - the device's ink service resets its ink layer to what is drawn on
   *   screen at the next pen touch (drawAPP "sync background"), so strokes
   *   the view has not drawn yet are drawn now, or as the stroke under way
   *   ends;
   * - 0.1 to 1.5 s later the note under the PilotChat sends its own pen
   *   (HandWriteClient sendPenInfo), and the next stroke is then not inked
   *   at all (drawAPP pushes it with a negative width). The pen is claimed
   *   again on a schedule that covers that window, so the next stroke starts
   *   under the PilotChat's pen; a stroke that still slips through is drawn as
   *   the pen lifts (see penLifted).
   * It never scrolls the page: telling a resting palm from a deliberate drag
   * by timing was not reliable on device, and a page that moves under the pen
   * loses the writer's place.
   */
  private fun onHand(event: MotionEvent): Boolean {
    if (live == null) redrawNow() else redrawAtPenUp = true
    lastHandAt = SystemClock.uptimeMillis()
    if (event.actionMasked == MotionEvent.ACTION_DOWN) {
      Log.i(TAG, "hand touch: redraw ${if (live == null) "now" else "at pen up"}, reclaim scheduled")
      removeCallbacks(reclaim)
      RECLAIM_AFTER_HAND_MS.forEach { postDelayed(reclaim, it) }
    }
    return true
  }

  private fun redrawNow() {
    redrawAtPenUp = false
    invalidate()
  }

  private fun onPen(event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        removeCallbacks(askAfterPause)
        // The note may have taken the pen back since the last stroke.
        ink.reassert()
        ink.penDown()
        live = mutableListOf(pointAt(event.x, event.y))
      }
      MotionEvent.ACTION_MOVE -> {
        val stroke = live ?: return true
        for (h in 0 until event.historySize) {
          stroke += pointAt(event.getHistoricalX(h), event.getHistoricalY(h))
        }
        stroke += pointAt(event.x, event.y)
        if (ink.drawsLiveStroke) invalidate()
      }
      MotionEvent.ACTION_UP -> {
        val stroke = live ?: return true
        stroke += pointAt(event.x, event.y)
        live = null
        ink.keepInk { page.addStroke(PageStroke(stroke)) }
        penLifted()
        postDelayed(askAfterPause, QUESTION_PAUSE_MS)
      }
      MotionEvent.ACTION_CANCEL -> {
        // A stroke cut short is still writing: keep what was drawn.
        live?.let { stroke -> ink.keepInk { page.addStroke(PageStroke(stroke)) } }
        live = null
        penLifted()
      }
    }
    return true
  }

  private fun penLifted() {
    lastPenUpAt = SystemClock.uptimeMillis()
    if (reclaimAtPenUp) {
      reclaimAtPenUp = false
      ink.reassert()
    }
    // Soon after a hand touch the stroke may not have been inked (see onHand): draw it now.
    if (redrawAtPenUp || lastPenUpAt - lastHandAt < HAND_RISK_MS) redrawNow()
  }

  /** Scrolls the page by most of a screen: down for a positive [direction], up for a negative one. */
  fun scrollPage(direction: Int) {
    if (direction == 0 || live != null) return
    val before = scroll
    scrollTo(scroll + direction.sign * height * SCROLL_STEP_FRACTION)
    if (scroll != before) {
      // The firmware ink is fixed to the screen; once the page moves under it, it is wrong.
      ink.wipe()
      invalidate()
    }
  }

  private fun pointAt(x: Float, y: Float) = PagePoint(x, y + scroll)

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    canvas.save()
    // React Native's parents don't clip their children on Android, so writing
    // scrolled above the page would otherwise be painted over the header.
    canvas.clipRect(0f, 0f, width.toFloat(), height.toFloat())
    canvas.translate(0f, -scroll)
    for (block in page.settled) {
      when (block) {
        is PilotChatPage.Question -> block.strokes.forEach { drawStroke(canvas, it.points) }
        is PilotChatPage.Answer -> layouts[block]?.let { layout ->
          canvas.save()
          canvas.translate(SIDE_MARGIN_PX, block.top)
          layout.draw(canvas)
          canvas.restore()
        }
      }
    }
    page.unasked.forEach { drawStroke(canvas, it.points) }
    if (ink.drawsLiveStroke) live?.let { drawStroke(canvas, it) }
    if (awaiting) canvas.drawText(THINKING_MARK, SIDE_MARGIN_PX, page.nextTop + ANSWER_TEXT_PX, answerPaint)
    canvas.restore()
  }

  private fun drawStroke(canvas: Canvas, points: List<PagePoint>) {
    if (points.isEmpty()) return
    val path = Path().apply {
      moveTo(points[0].x, points[0].y)
      // A single sample (a dot) still needs a segment for the round cap to draw.
      if (points.size == 1) lineTo(points[0].x + DOT_NUDGE_PX, points[0].y)
      for (i in 1 until points.size) lineTo(points[i].x, points[i].y)
    }
    canvas.drawPath(path, strokePaint)
  }

  // Closing the plugin hides the page before the note takes the pen back, so the pen is released right then.
  override fun onVisibilityChanged(changedView: View, visibility: Int) {
    super.onVisibilityChanged(changedView, visibility)
    syncPen()
  }

  override fun onWindowVisibilityChanged(visibility: Int) {
    super.onWindowVisibilityChanged(visibility)
    syncPen()
  }

  // The firmware drops the pen whenever another window takes focus, so it is claimed again on every return.
  override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
    super.onWindowFocusChanged(hasWindowFocus)
    if (hasWindowFocus) syncPen()
  }

  private fun syncPen() {
    if (isShown && windowVisibility == VISIBLE) ink.claim() else ink.release()
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    removeCallbacks(askAfterPause)
    removeCallbacks(answerTimedOut)
    removeCallbacks(reclaim)
    ink.release()
  }

  private companion object {
    const val TAG = "SnCopilotPilotChat"

    // The question image: a margin around the strokes, and a cap on its longer side.
    const val IMAGE_PAD_PX = 24f
    const val IMAGE_MAX_SIDE_PX = 1600

    // How long the pen rests before what was written is taken as a question: longer than a pause between words.
    const val QUESTION_PAUSE_MS = 4000L

    // How far one press of a scroll button moves the page.
    const val SCROLL_STEP_FRACTION = 0.66f

    // The note sends its own pen 0.1 to 1.5 s after a hand touch (measured on device); claims
    // spread over that window make sure one lands after it, before the next stroke.
    val RECLAIM_AFTER_HAND_MS = longArrayOf(150L, 500L, 1000L, 1600L, 2400L)

    // Strokes ending this soon after a hand touch may not have been inked, so they are drawn at once.
    const val HAND_RISK_MS = 3000L

    // Longer than JS waits for a reply (REPLY_TIMEOUT_MS, 120 s), so the pen comes back even if nothing does.
    const val ANSWER_TIMEOUT_MS = 150_000L

    // The firmware needle's nib on screen (measured by sn-canvas on device), so the view's strokes match its ink.
    const val STROKE_WIDTH_PX = 9f
    const val DOT_NUDGE_PX = 0.1f

    const val ANSWER_TEXT_PX = 36f
    const val ANSWER_LINE_SPACING = 1.25f
    const val SIDE_MARGIN_PX = 64f
    const val THINKING_MARK = "✦ …"

    // After an answer arrives its bottom sits this far down the screen, leaving the rest for the next question.
    const val ANSWER_BOTTOM_FRACTION = 0.6f

    // The page scrolls no further than to leave this much of its content on screen.
    const val MIN_VISIBLE_FRACTION = 0.3f
  }
}
