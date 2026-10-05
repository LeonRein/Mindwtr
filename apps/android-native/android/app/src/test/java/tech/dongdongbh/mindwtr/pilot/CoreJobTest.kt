package tech.dongdongbh.mindwtr.pilot

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

/** One CoreWork run: the host's boot first (the app's boot order), then the one named job, then the widgets' refresh. */
class CoreJobTest {
    private val events = mutableListOf<String>()
    private var drained = true
    private var recovered = true
    private var notification: JSONObject? = JSONObject().put("title", "@home next action")
    private var bootFailure: Throwable? = null
    private var jobFailure: Throwable? = null
    private var contextFailure: Throwable? = null
    private var syncFailure: Throwable? = null
    private var syncWanted = true
    private var appActive = false

    private val calls = object : CoreJob.Calls {
        override fun recover(): Boolean {
            events += "recover"
            return recovered
        }
        override fun drain(): Boolean {
            events += "drain"
            jobFailure?.let { throw it }
            return drained
        }
        override fun contextAutomation(json: String): JSONObject {
            JSONObject(json).let { events += "context ${it.getString("action")} ${it.getString("context")}" }
            contextFailure?.let { throw it }
            return JSONObject().put("notification", notification ?: JSONObject.NULL)
        }
        override fun backgroundSync(trigger: String): JSONObject {
            events += "sync $trigger"
            syncFailure?.let { throw it }
            return JSONObject().put("schedule", syncWanted)
        }
        override fun appActive() = appActive
    }

    private fun run(job: String?, input: Map<String, String?> = emptyMap()) = CoreJob.run(job, input,
        boot = { events += "boot"; bootFailure?.let { throw it }; calls },
        post = { events += "post ${it.getString("title")}" },
        refreshWidgets = { events += "widgets" },
        syncAgain = { events += "again" },
        log = { message, fields -> lines += "$message ${fields.optString("job")} ${fields.optString("outcome")} ${fields.optString("error")}".trim() })

    private val lines = mutableListOf<String>()

    @Test fun theHostBootsBeforeTheJobAndWidgetsRefreshAfterIt() {
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.INGEST))
        assertEquals(listOf("boot", "recover", "drain", "sync capture", "widgets"), events)
    }

    // #1257: what a capture job stored while the app was closed is sent before the job ends (core's capture run), never after.
    @Test fun aCaptureJobSendsWhatItStoredBeforeItEnds() {
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.INGEST))
        assertEquals(listOf("boot", "recover", "drain", "sync capture", "widgets"), events)
        assertEquals(listOf("Native Android core work ingest success"), lines)
    }

    @Test fun aCaptureWhoseSyncFailsIsStillStoredAndLeavesTheRetryToTheSyncJob() {
        // The capture is committed; core recorded the failed upload, and the scheduled job sends it after its cooldown.
        syncFailure = IllegalStateException("Core backgroundSync timed out")
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.INGEST))
        assertEquals(listOf("boot", "recover", "drain", "sync capture", "widgets"), events)
        assertEquals(listOf("Native Android core work ingest success Core backgroundSync timed out"), lines)
    }

    @Test fun theSyncJobRunsCoresScheduledRunThenQueuesItsNext() {
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.SYNC))
        assertEquals(listOf("boot", "recover", "drain", "sync scheduled", "again", "widgets"), events)
    }

    @Test fun theSyncJobQueuesNoNextRunOnceCoreSaysItIsNotWanted() {
        syncWanted = false
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.SYNC))
        assertEquals(listOf("boot", "recover", "drain", "sync scheduled", "widgets"), events)
    }

    @Test fun theSyncJobSkipsWhileTheAppIsInFrontAndQueuesItsNext() {
        // RN's Expo worker runs nothing while the app is in the foreground (its triggers sync) and schedules the next run.
        appActive = true
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.SYNC))
        assertEquals(listOf("boot", "recover", "drain", "again", "widgets"), events)
    }

    @Test fun aSyncJobWhoseRunFailsRetriesAndKeepsItsPlaceInTheChain() {
        syncFailure = IllegalStateException("Core backgroundSync timed out")
        assertEquals(CoreJob.Outcome.Retry, run(CoreJob.SYNC))
        assertEquals(listOf("boot", "recover", "drain", "sync scheduled"), events)
    }

    @Test fun aSyncJobWaitsForRecoveryAndTheDrain() {
        recovered = false
        assertEquals(CoreJob.Outcome.Retry, run(CoreJob.SYNC))
        assertEquals(listOf("boot", "recover"), events)
    }

    @Test fun anOwedJournalThatStillFailsRetriesLaterAndDrainsNothing() {
        recovered = false
        assertEquals(CoreJob.Outcome.Retry, run(CoreJob.INGEST))
        assertEquals(listOf("boot", "recover"), events)
    }

    @Test fun aContextTriggerWaitsForRecoveryAndTheDrain() {
        recovered = false
        assertEquals(CoreJob.Outcome.Retry, run(CoreJob.CONTEXT, mapOf("action" to "activate", "context" to "@home")))
        recovered = true
        drained = false
        assertEquals(CoreJob.Outcome.Retry, run(CoreJob.CONTEXT, mapOf("action" to "activate", "context" to "@home")))
        // Nothing was posted from unfinished state.
        assertEquals(listOf("boot", "recover", "boot", "recover", "drain"), events)
    }

    @Test fun aDrainThatMustWaitRetriesLater() {
        drained = false
        assertEquals(CoreJob.Outcome.Retry, run(CoreJob.INGEST))
        assertEquals(listOf("boot", "recover", "drain"), events)
    }

    @Test fun aFailedDrainRetriesLater() {
        jobFailure = IllegalStateException("Core ingest timed out")
        assertEquals(CoreJob.Outcome.Retry, run(CoreJob.INGEST))
        assertEquals(listOf("boot", "recover", "drain"), events)
    }

    @Test fun eachRunLogsOneLineWithItsJobOutcomeAndOnlyAFailuresCode() {
        run(CoreJob.INGEST)
        jobFailure = IllegalStateException("SAVE_FAILED: Buy milk for Anna")
        run(CoreJob.INGEST)
        run("sync")
        assertEquals(listOf("Native Android core work ingest success", "Native Android core work ingest retry SAVE_FAILED",
            "Native Android core work sync unknown"), lines)
    }

    @Test fun aBootThatFailsRunsNoJob() {
        bootFailure = IllegalStateException("Incomplete tasks load")
        assertEquals(CoreJob.Outcome.Retry, run(CoreJob.INGEST))
        // A trigger whose recovery cannot finish waits for it too.
        assertEquals(CoreJob.Outcome.Retry, run(CoreJob.CONTEXT, mapOf("action" to "activate", "context" to "@home")))
        assertEquals(listOf("boot", "boot"), events)
    }

    @Test fun aContextTriggerPostsCoresNotification() {
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.CONTEXT, mapOf("action" to "activate", "context" to "@home")))
        assertEquals(listOf("boot", "recover", "drain", "context activate @home", "post @home next action", "widgets"), events)
    }

    @Test fun aTriggerCoreAnswersWithNoNotificationPostsNothing() {
        notification = null
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.CONTEXT, mapOf("action" to "deactivate", "context" to "@home")))
        assertEquals(listOf("boot", "recover", "drain", "context deactivate @home", "widgets"), events)
    }

    @Test fun aFailedTriggerIsNotRetried() {
        contextFailure = IllegalStateException("Core contextAutomation timed out")
        // A late notification would describe a moment that has passed: RN's headless task does not retry either.
        assertEquals(CoreJob.Outcome.Failure, run(CoreJob.CONTEXT, mapOf("action" to "activate", "context" to "@home")))
        assertEquals(listOf("boot", "recover", "drain", "context activate @home"), events)
    }

    @Test fun anUnknownJobBootsNothing() {
        assertEquals(CoreJob.Outcome.Failure, run("sync"))
        assertEquals(CoreJob.Outcome.Failure, run(null))
        assertEquals(emptyList<String>(), events)
    }
}
