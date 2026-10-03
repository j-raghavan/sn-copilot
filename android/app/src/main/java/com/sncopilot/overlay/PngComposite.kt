package com.sncopilot.overlay

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect

/**
 * Draws one PNG over another, in place. Used to lay a PDF/EPUB page's
 * handwriting (its mark layer, rendered by generateMarkThumbnails as
 * ink on a transparent background) over the page render, so the
 * provider sees the page as the reader does.
 *
 * Hermes has no canvas or image decoder, so this has to run natively.
 *
 * The result is encoded to memory before the base file is touched: a
 * decode or encode failure leaves the base render exactly as it was,
 * and the caller can still send it.
 */
internal object PngComposite {

  /** Outcome as a CopilotOverlay result code plus a log-friendly message. */
  data class Outcome(val code: String, val message: String) {
    val success: Boolean get() = code == "OK"
  }

  fun overlayInPlace(basePath: String, overlayPath: String): Outcome {
    val mutable = BitmapFactory.Options().apply { inMutable = true }
    val base = BitmapFactory.decodeFile(basePath, mutable)
        ?: return Outcome("DECODE_FAILED", "Could not decode base PNG")
    val overlay = BitmapFactory.decodeFile(overlayPath)
    if (overlay == null) {
      base.recycle()
      return Outcome("DECODE_FAILED", "Could not decode overlay PNG")
    }
    try {
      val canvas = Canvas(base)
      if (overlay.width == base.width && overlay.height == base.height) {
        canvas.drawBitmap(overlay, 0f, 0f, null)
      } else {
        // Both are rendered at the same requested size; scaling only
        // guards against a firmware that rounds one of them differently.
        val dst = Rect(0, 0, base.width, base.height)
        canvas.drawBitmap(overlay, null, dst, Paint(Paint.FILTER_BITMAP_FLAG))
      }
      val encoded = java.io.ByteArrayOutputStream()
      if (!base.compress(Bitmap.CompressFormat.PNG, 100, encoded)) {
        return Outcome("COMPOSITE_FAILED", "PNG encode returned false")
      }
      java.io.FileOutputStream(basePath).use { encoded.writeTo(it) }
      return Outcome("OK", "Composited ${overlay.width}x${overlay.height} over ${base.width}x${base.height}")
    } finally {
      overlay.recycle()
      base.recycle()
    }
  }
}
