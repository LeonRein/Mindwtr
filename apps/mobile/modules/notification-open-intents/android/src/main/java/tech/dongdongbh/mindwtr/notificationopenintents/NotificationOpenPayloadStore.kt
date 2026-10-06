package tech.dongdongbh.mindwtr.notificationopenintents

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

object NotificationOpenPayloadStore {
  private const val PREFS_NAME = "mindwtr_notification_open"
  private const val PENDING_COMPLETIONS = "pendingCompletions"
  // A bound on Done taps kept while the app is closed; the oldest go first.
  private const val MAX_PENDING_COMPLETIONS = 50
  private val completionsLock = Any()

  @Volatile
  private var pendingNotificationOpenPayload: LinkedHashMap<String, String>? = null

  @JvmStatic
  fun cache(payload: Map<String, String>) {
    pendingNotificationOpenPayload = LinkedHashMap(payload)
  }

  @JvmStatic
  fun consume(): LinkedHashMap<String, String>? {
    val payload = pendingNotificationOpenPayload ?: return null
    pendingNotificationOpenPayload = null
    return LinkedHashMap(payload)
  }

  /**
   * A Done tap no JS could receive (the app was not running): kept on disk, since the process may
   * die before the app is opened, and applied when the app next starts (consumeCompletions).
   */
  @JvmStatic
  fun persistCompletion(context: Context, payload: Map<String, String>) {
    synchronized(completionsLock) {
      val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      val stored = runCatching { JSONArray(prefs.getString(PENDING_COMPLETIONS, "[]")) }.getOrDefault(JSONArray())
      val queue = JSONArray()
      for (index in maxOf(0, stored.length() - MAX_PENDING_COMPLETIONS + 1) until stored.length()) {
        stored.optJSONObject(index)?.let(queue::put)
      }
      queue.put(JSONObject(payload as Map<*, *>))
      prefs.edit().putString(PENDING_COMPLETIONS, queue.toString()).commit()
    }
  }

  /** Every Done tap kept by persistCompletion, oldest first, and forgets them. */
  @JvmStatic
  fun consumeCompletions(context: Context): List<Map<String, String>> = synchronized(completionsLock) {
    val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    val raw = prefs.getString(PENDING_COMPLETIONS, null) ?: return@synchronized emptyList()
    prefs.edit().remove(PENDING_COMPLETIONS).commit()
    val queue = runCatching { JSONArray(raw) }.getOrNull() ?: return@synchronized emptyList()
    (0 until queue.length()).mapNotNull { index ->
      queue.optJSONObject(index)?.let { item -> item.keys().asSequence().associateWith { key -> item.optString(key) } }
    }
  }
}
