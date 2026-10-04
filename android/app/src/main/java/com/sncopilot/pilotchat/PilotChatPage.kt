package com.sncopilot.pilotchat

/** A point on the PilotChat page, in page pixels: x across, y down from the top of the page. */
data class PagePoint(val x: Float, val y: Float)

/** One pen stroke on the page, in the order the pen drew it. */
data class PageStroke(val points: List<PagePoint>) {
  val top: Float get() = points.minOf { it.y }
  val bottom: Float get() = points.maxOf { it.y }
}

/**
 * The PilotChat page, top to bottom: the user's handwritten questions and the
 * answers written back under them. The user's ink stays where it was written;
 * each answer goes under the question it answers, and writing carries on
 * under the last answer.
 *
 * Pure Kotlin (no Android types) so the layout rules are unit-testable;
 * [PilotChatPageView] measures answer text and draws the page.
 */
class PilotChatPage {
  sealed interface Block {
    val bottom: Float
  }

  data class Question(val strokes: List<PageStroke>) : Block {
    val top: Float get() = strokes.minOf { it.top }
    override val bottom: Float get() = strokes.maxOf { it.bottom }
    val left: Float get() = strokes.minOf { s -> s.points.minOf { it.x } }
    val right: Float get() = strokes.maxOf { s -> s.points.maxOf { it.x } }

    /**
     * The area of the page an image of this question covers: its own strokes'
     * bounds and nothing else on the page, padded by [pad] and kept off the
     * page's top-left edge, at [scale] so its longer side is at most [maxSide].
     */
    fun crop(pad: Float, maxSide: Int): Crop {
      val left = maxOf(0f, left - pad)
      val top = maxOf(0f, top - pad)
      val width = right + pad - left
      val height = bottom + pad - top
      val scale = minOf(1f, maxSide / maxOf(width, height))
      return Crop(left, top, maxOf(1, (width * scale).toInt()), maxOf(1, (height * scale).toInt()), scale)
    }
  }

  /** A page area to render: from ([left], [top]) in page pixels, [scale]d into a [width] x [height] image. */
  data class Crop(val left: Float, val top: Float, val width: Int, val height: Int, val scale: Float)

  /**
   * Text laid out from [top], [height] pixels tall as the view measured it:
   * an answer, or (when [isNote]) a note from the PilotChat itself, such as a
   * failure, which is shown but never written into the user's notebook.
   */
  data class Answer(val text: String, val top: Float, val height: Float, val isNote: Boolean = false) : Block {
    override val bottom: Float get() = top + height
  }

  private val blocks = mutableListOf<Block>()
  private val pending = mutableListOf<PageStroke>()

  /** Everything asked and answered so far, oldest first. */
  val settled: List<Block> get() = blocks

  /** Strokes written since the last question was taken. */
  val unasked: List<PageStroke> get() = pending

  /** Where an answer goes, or new writing is invited: under everything on the page. */
  val nextTop: Float get() = lowest()?.plus(BLOCK_GAP) ?: TOP_MARGIN

  /** The lowest point anything on the page reaches; 0 on an empty page. */
  val contentBottom: Float get() = lowest() ?: 0f

  private fun lowest(): Float? = (blocks.map { it.bottom } + pending.map { it.bottom }).maxOrNull()

  fun addStroke(stroke: PageStroke) {
    if (stroke.points.isNotEmpty()) pending += stroke
  }

  /** Turns the strokes written since the last question into a question; null when nothing was written. */
  fun takeQuestion(): Question? {
    if (pending.isEmpty()) return null
    val question = Question(pending.toList())
    pending.clear()
    blocks += question
    return question
  }

  /**
   * Writes [text], [height] pixels tall, under everything on the page,
   * including strokes the user started while the answer was on its way: ink
   * never moves, so the answer goes below it rather than over it.
   */
  fun addAnswer(text: String, height: Float, isNote: Boolean = false): Answer {
    val answer = Answer(text, nextTop, height, isNote)
    blocks += answer
    return answer
  }

  /** Something to write into the user's notebook, in page order. */
  sealed interface Export {
    data class Writing(val strokes: List<PageStroke>) : Export

    data class Text(val text: String) : Export
  }

  /**
   * What belongs in the user's notebook, top to bottom: every question's
   * strokes (including any not asked yet) and every answer; never the
   * PilotChat's own notes.
   */
  fun exportable(): List<Export> {
    val out = mutableListOf<Export>()
    for (block in blocks) {
      when (block) {
        is Question -> out += Export.Writing(block.strokes)
        is Answer -> if (!block.isNote) out += Export.Text(block.text)
      }
    }
    if (pending.isNotEmpty()) out += Export.Writing(pending.toList())
    return out
  }

  companion object {
    /** Space between a question and its answer, and between an answer and the next writing. */
    const val BLOCK_GAP = 48f

    /** Where the first answer would sit on an empty page. */
    const val TOP_MARGIN = 48f
  }
}
