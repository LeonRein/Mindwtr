package tech.dongdongbh.mindwtr.pilot

import org.json.JSONObject

/**
 * One CoreWork run (CoreWork.kt), apart from Android: [boot] hands over this process's host (ProcessCoreHost.get, whose boot
 * is the app's own: validated load, journal replay, queue drain), then recovery in the same order (an owed journal replay,
 * then the drain it held back), then the one named job runs on it, then the widgets refresh.
 * JVM-tested (CoreJobTest).
 */
internal object CoreJob {
    /**
     * Drain the pending-captures queue (the capture intent's items, the capture window's, widget check-offs), then send what it
     * stored (core's capture run, #1257) before the job ends.
     */
    const val INGEST = "ingest"
    /** An automation trigger's notification (the ACTIVATE_CONTEXT and DEACTIVATE_CONTEXT broadcasts): `action` and `context`. */
    const val CONTEXT = "context"
    /**
     * Core's reminder plan applied again: `mode` "cycle", "rebuild" to remake every alarm (Reminders.kt's reschedule receiver), or
     * "fired" with `key`, a daily or weekly alarm that fired, which core makes again at its next time.
     */
    const val REMINDERS = "reminders"
    /** A reminder's Done: `requestId` (made when the notification was posted) and `taskId`; then the plan again. */
    const val REMINDER_DONE = "reminderDone"
    /** A reminder's Snooze: `requestId`, `requestedAt` (the tap's time, ms) and `details` (the fired alarm's). */
    const val REMINDER_SNOOZE = "reminderSnooze"
    /** RN's scheduled background sync (expo-background-task's worker): core's scheduled run, then the next run queued. */
    const val SYNC = "backgroundSync"
    private val JOBS = setOf(INGEST, CONTEXT, REMINDERS, REMINDER_DONE, REMINDER_SNOOZE, SYNC)

    enum class Outcome { Success, Retry, Failure }

    const val LINE = "Native Android core work"

    /** The host calls a job makes. */
    interface Calls {
        /** ProcessCoreHost.recover on this host: an owed journal replay sent again; false while anything stays owed. */
        fun recover(): Boolean
        /** ProcessCoreHost.recovered on this host (the drain, then sync); false while the queue must wait or the drain failed. */
        fun drain(): Boolean
        /** Core's runContextAutomation with [json] (`{ action, context }`): `{ notification }`, null for none. */
        fun contextAutomation(json: String): JSONObject
        /** Core's reminder plan applied now ([mode] "cycle", "rebuild", or "fired" with [key]). */
        fun reminders(mode: String, key: String): JSONObject = throw UnsupportedOperationException("reminders")
        /** Core's completeReminderTask, journaled under [requestId]. */
        fun reminderDone(requestId: String, taskId: String): JSONObject = throw UnsupportedOperationException("reminderDone")
        /** Core's snoozeReminder with [json] (`{ requestId, requestedAt, details }`), journaled; the engine makes its alarm once. */
        fun reminderSnooze(json: String): JSONObject = throw UnsupportedOperationException("reminderSnooze")
        /**
         * Core's background run ([trigger] "capture" or "scheduled"; CoreHost.backgroundSync), awaited: it settles with the sync
         * (sent, failed and recorded, skipped by core's cooldown, or abandoned at core's 4 min deadline). `{ schedule }`.
         */
        fun backgroundSync(trigger: String): JSONObject = throw UnsupportedOperationException("backgroundSync")
        /** Whether the app is in front (MainActivity resumed): its own triggers sync then. */
        fun appActive(): Boolean = false
    }

    /**
     * Runs job [name] with [input]. Every job waits for recovery and the drain: while either cannot finish, the job retries
     * later (the files stay queued, and a trigger posts nothing from unfinished state). A trigger that core then fails never
     * retries: a late notification would describe a moment that has passed, and RN's headless task does not retry either.
     * A reminder's Done and Snooze are journaled core commands whose request UUID makes every try the same request, so they retry
     * until core answers, unless core refuses the input itself (INVALID_INPUT). Snooze's alarm is made in the engine against core's
     * native state, once per request however many tries; Done plans the alarms again, as the store changed.
     * A capture job (INGEST) then sends what the drains stored and waits for that sync: a failed upload is core's recorded failure,
     * which the sync job retries, so the job still succeeds (the capture is stored). The sync job (SYNC) runs core's scheduled run,
     * none while the app is in front (as RN's Expo worker), then [syncAgain] queues its next run unless core says sync is no longer
     * wanted; a run that failed outright retries in place, so the chain never breaks.
     * [log] gets one line per run, its fields apart (the job, its outcome, a failure's code: never a task's words).
     */
    fun run(name: String?, input: Map<String, String?>, boot: () -> Calls, post: (JSONObject) -> Unit, refreshWidgets: () -> Unit,
            log: (String, JSONObject) -> Unit, syncAgain: () -> Unit = {}): Outcome {
        val line = JSONObject().put("job", name ?: JSONObject.NULL)
        if (name !in JOBS) {
            log(LINE, line.put("outcome", "unknown"))
            return Outcome.Failure
        }
        var recovered = false
        val outcome = try {
            val host = boot()
            if (!host.recover() || !host.drain()) Outcome.Retry
            else when (name) {
                INGEST -> {
                    runCatching { host.backgroundSync("capture") }
                        .onFailure { line.put("error", (it.message ?: it.javaClass.simpleName).substringBefore(':')) }
                    Outcome.Success
                }
                SYNC -> {
                    val again = if (host.appActive()) {
                        line.put("skipped", "foreground")
                        true
                    } else host.backgroundSync("scheduled").optBoolean("schedule")
                    if (again) syncAgain()
                    Outcome.Success
                }
                REMINDERS -> {
                    host.reminders(input["mode"] ?: "cycle", input["key"].orEmpty())
                    Outcome.Success
                }
                REMINDER_DONE -> {
                    host.reminderDone(input["requestId"].orEmpty(), input["taskId"].orEmpty())
                    host.reminders("cycle", "")
                    Outcome.Success
                }
                REMINDER_SNOOZE -> {
                    val request = JSONObject().put("requestId", input["requestId"].orEmpty())
                        .put("requestedAt", input["requestedAt"]?.toLongOrNull() ?: JSONObject.NULL)
                        .put("details", input["details"]?.let(::JSONObject) ?: JSONObject.NULL)
                    host.reminderSnooze(request.toString())
                    Outcome.Success
                }
                else -> {
                    recovered = true
                    val trigger = JSONObject().put("action", input["action"] ?: JSONObject.NULL).put("context", input["context"] ?: JSONObject.NULL)
                    host.contextAutomation(trigger.toString()).optJSONObject("notification")?.let(post)
                    Outcome.Success
                }
            }
        } catch (failure: Throwable) {
            line.put("error", (failure.message ?: failure.javaClass.simpleName).substringBefore(':'))
            val refused = failure.message?.startsWith("INVALID_INPUT") == true
            if (recovered || refused) Outcome.Failure else Outcome.Retry
        }
        log(LINE, line.put("outcome", outcome.name.lowercase()))
        if (outcome == Outcome.Success) refreshWidgets()
        return outcome
    }
}
