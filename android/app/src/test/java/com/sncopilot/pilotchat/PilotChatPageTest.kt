package com.sncopilot.pilotchat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PilotChatPageTest {
  private fun stroke(vararg ys: Float) = PageStroke(ys.map { PagePoint(10f, it) })

  @Test
  fun `an empty page invites writing at the top margin`() {
    val page = PilotChatPage()
    assertEquals(PilotChatPage.TOP_MARGIN, page.nextTop)
    assertEquals(0f, page.contentBottom)
    assertNull(page.takeQuestion())
  }

  @Test
  fun `strokes since the last question become the next question`() {
    val page = PilotChatPage()
    page.addStroke(stroke(100f, 140f))
    page.addStroke(stroke(120f, 180f))
    val question = page.takeQuestion()!!
    assertEquals(2, question.strokes.size)
    assertEquals(100f, question.top)
    assertEquals(180f, question.bottom)
    assertTrue(page.unasked.isEmpty())
    assertNull(page.takeQuestion())
  }

  @Test
  fun `an answer goes under its question`() {
    val page = PilotChatPage()
    page.addStroke(stroke(100f, 180f))
    page.takeQuestion()
    val answer = page.addAnswer("A qubit is…", 200f)
    assertEquals(180f + PilotChatPage.BLOCK_GAP, answer.top)
    assertEquals(answer.top + 200f, answer.bottom)
    assertEquals(answer.bottom + PilotChatPage.BLOCK_GAP, page.nextTop)
  }

  @Test
  fun `an answer never lands on ink written while it was on its way`() {
    val page = PilotChatPage()
    page.addStroke(stroke(100f, 180f))
    page.takeQuestion()
    page.addStroke(stroke(300f, 360f)) // the next question, started early
    val answer = page.addAnswer("…", 50f)
    assertEquals(360f + PilotChatPage.BLOCK_GAP, answer.top)
  }

  @Test
  fun `an empty stroke is ignored`() {
    val page = PilotChatPage()
    page.addStroke(PageStroke(emptyList()))
    assertNull(page.takeQuestion())
  }

  @Test
  fun `settled blocks keep the order they were written in`() {
    val page = PilotChatPage()
    page.addStroke(stroke(100f, 180f))
    page.takeQuestion()
    page.addAnswer("one", 40f)
    page.addStroke(stroke(400f, 450f))
    page.takeQuestion()
    val kinds = page.settled.map { it::class.simpleName }
    assertEquals(listOf("Question", "Answer", "Question"), kinds)
  }

  private fun strokeAt(vararg xy: Float) = PageStroke(xy.toList().chunked(2).map { (x, y) -> PagePoint(x, y) })

  @Test
  fun `a question's crop covers its own strokes, padded`() {
    val question = PilotChatPage.Question(listOf(strokeAt(100f, 200f, 300f, 260f), strokeAt(150f, 240f, 400f, 300f)))
    val crop = question.crop(pad = 20f, maxSide = 4000)
    assertEquals(PilotChatPage.Crop(left = 80f, top = 180f, width = 340, height = 140, scale = 1f), crop)
  }

  @Test
  fun `a crop never starts above or left of the page`() {
    val crop = PilotChatPage.Question(listOf(strokeAt(5f, 8f, 60f, 40f))).crop(pad = 20f, maxSide = 4000)
    assertEquals(0f, crop.left)
    assertEquals(0f, crop.top)
    assertEquals(80, crop.width)
    assertEquals(60, crop.height)
  }

  @Test
  fun `a long question is scaled so its longer side fits`() {
    val crop = PilotChatPage.Question(listOf(strokeAt(0f, 0f, 3200f, 400f))).crop(pad = 0f, maxSide = 1600)
    assertEquals(0.5f, crop.scale)
    assertEquals(1600, crop.width)
    assertEquals(200, crop.height)
  }

  @Test
  fun `a single dot still yields a drawable crop`() {
    val crop = PilotChatPage.Question(listOf(strokeAt(50f, 50f))).crop(pad = 0f, maxSide = 1600)
    assertEquals(1, crop.width)
    assertEquals(1, crop.height)
  }

  @Test
  fun `export is the user's writing and the answers, in page order, without the PilotChat's notes`() {
    val page = PilotChatPage()
    page.addStroke(stroke(100f, 180f))
    page.takeQuestion()
    page.addAnswer("first answer", 40f)
    page.addStroke(stroke(400f, 450f))
    page.takeQuestion()
    page.addAnswer("(Provider request failed.)", 40f, isNote = true)
    page.addStroke(stroke(700f, 750f)) // written, never asked
    val export = page.exportable()
    assertEquals(
        listOf("Writing", "Text", "Writing", "Writing"),
        export.map { it::class.simpleName },
    )
    assertEquals("first answer", (export[1] as PilotChatPage.Export.Text).text)
  }

  @Test
  fun `an empty page exports nothing`() {
    assertTrue(PilotChatPage().exportable().isEmpty())
  }
}
