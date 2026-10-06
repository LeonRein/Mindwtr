package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The widget publication a resume holds until the screen's first content (ProcessCoreHost.appState), or its fallback. */
class HeldPublicationTest {
    private val held = HeldPublication<String>()

    @Test fun firstContentTakesTheHeldPublicationOnce() {
        held.hold("runtime")
        assertEquals("runtime", held.take())
        assertNull(held.take())
    }

    @Test fun aFallbackPublishesItsOwnHoldWhenNoContentCame() {
        val resume = held.hold("runtime")
        assertEquals("runtime", held.takeIf(resume))
        assertNull(held.take())
    }

    @Test fun aStaleFallbackLeavesALaterResumesHoldForItsFirstContent() {
        // Resume A holds and schedules its fallback; a pause clears; resume B holds before A's fallback runs.
        val resumeA = held.hold("runtime")
        held.clear()
        held.hold("runtime")
        assertNull(held.takeIf(resumeA))
        // B's first content still publishes, after it drew.
        assertEquals("runtime", held.take())
    }

    @Test fun aFallbackAfterFirstContentPublishesNothing() {
        val resume = held.hold("runtime")
        assertEquals("runtime", held.take())
        assertNull(held.takeIf(resume))
    }
}
