package com.sncopilot.pilotchat

import android.util.Log
import android.view.View

/**
 * How a stroke shows while it is being written on the PilotChat page. Adapted from
 * sn-canvas's LiveInk, which is proven on device, for a page with one tool:
 * the pen always writes.
 *
 * With the firmware pen claimed ([FirmwareInk]), Supernote inks each stroke as
 * fast as its own notes and the view never draws it live. Committing a stroke
 * skips the redraw, which would repaint the panel over the next stroke being
 * written; once the pen rests ([SETTLE_MS]) the view redraws, the firmware ink
 * staying, so its own rendering holds every stroke too. Anything else that
 * changes the page (a scroll, an answer) no longer matches the ink, so the ink
 * is wiped and the view's rendering takes over. Without the firmware service
 * the view draws the live stroke itself.
 */
internal class PilotChatInk(private val view: View) {
  private val firmware = FirmwareInk(view.context, APP_NAME)
  private var claimed = false

  // Firmware ink is on the panel, over what the view draws.
  private var wet = false

  // A stroke the firmware inked is being committed: its ink stays, and the view doesn't redraw.
  private var keeping = false

  private val settle = Runnable { view.invalidate() }

  /** Whether the view must draw the live stroke itself. */
  val drawsLiveStroke: Boolean get() = !claimed

  /** Whether a stroke the firmware inked is being committed; the view skips its redraw meanwhile. */
  val isKeepingInk: Boolean get() = keeping

  /** The pen the note writes with, set back as the page gives the pen back; null while unknown. */
  var notePen: FirmwarePen? = null

  // The pen is paused while the PilotChat writes back (see [pause]).
  private var paused = false

  /**
   * Ink off while something is shown over the page (the insert prompt): its
   * buttons are tapped with the pen, and those taps must leave no marks or
   * strokes. Turning it on clears what the tap that opened it left.
   */
  var blocked = false
    set(value) {
      field = value
      if (claimed) firmware.setWritable(!isPaused)
      if (value) clear()
    }

  /** Whether the pen is off: while the PilotChat writes back, or while the page is [blocked]. */
  val isPaused: Boolean get() = paused || blocked

  /**
   * Claims the pen for the page. The firmware drops the claim whenever another
   * window takes focus, so the view calls this again on every return.
   */
  fun claim() {
    if (!view.isAttachedToWindow) return
    claimed = firmware.setup()
    firmware.setWritable(!isPaused)
    // Whatever the pen inked before the claim goes too.
    clear()
    Log.i(TAG, "pilotchat ink: ${if (claimed) "firmware" else "view"}")
  }

  /**
   * Stops the pen inking while the PilotChat writes back, so nothing is written
   * that the answer could land on or the page could move under; the
   * firmware's own switch, as sn-canvas turns ink off for its other tools.
   */
  fun pause() {
    paused = true
    if (claimed) firmware.setWritable(false)
  }

  /** The answer is on the page: the pen writes again. */
  fun resume() {
    paused = false
    reassert()
  }

  /**
   * Claims the pen again without wiping anything. The note under the PilotChat
   * keeps running, and whenever it lays itself out (the screen waking, say)
   * it sends its own pen and turns ink off over the whole screen, after our
   * claim (seen on device: HandWriteClient sendFullScreenDisableArea). Ink
   * would then stop showing until the view next redrew. Called as the pen
   * lands, so writing always shows.
   */
  fun reassert() {
    if (!claimed || isPaused) return
    firmware.setup()
    firmware.setWritable(true)
  }

  /** The page leaves the screen: the pen goes back to the note, writing again, with its own pen. */
  fun release() {
    if (claimed) {
      firmware.teardown(notePen)
      Log.i(TAG, "firmware ink released: pen back to the note (pen set back: ${notePen ?: "none known"})")
    }
    view.removeCallbacks(settle)
    claimed = false
    wet = false
  }

  /** The pen touches the page: while the firmware inks, whatever it does leaves ink, and no redraw may land on it. */
  fun penDown() {
    view.removeCallbacks(settle)
    if (claimed) wet = true
  }

  /** Runs [commit], which adds the stroke the pen just drew, keeping the firmware's ink and deferring the redraw. */
  fun keepInk(commit: () -> Unit) {
    keeping = true
    try {
      commit()
    } finally {
      keeping = false
    }
    if (claimed) {
      view.removeCallbacks(settle)
      view.postDelayed(settle, SETTLE_MS)
    } else {
      view.invalidate()
    }
  }

  /** The page starts afresh: whatever ink is on the panel goes, and the pen writes again. */
  fun reset() {
    view.removeCallbacks(settle)
    paused = false
    reassert()
    clear()
  }

  /** The page changed some other way: its firmware ink no longer matches, so it goes and the view redraws. */
  fun wipe() {
    if (wet && !keeping) clear()
  }

  /**
   * Clears the ink layer outright, such as the mark a pen tap on the header
   * leaves (ink is on over the whole window); the view redraws the writing.
   */
  fun clearMarks() = clear()

  private fun clear() {
    firmware.clearAll()
    wet = false
    view.invalidate()
  }

  private companion object {
    const val TAG = "SnCopilotPilotChatInk"
    const val APP_NAME = "SnCopilot"

    // How long the pen rests before the view redraws under the firmware ink: longer than the pause between words.
    const val SETTLE_MS = 2000L
  }
}
