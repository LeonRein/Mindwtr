package tech.dongdongbh.mindwtr.pilot

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.media.AudioAttributes
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject
import java.util.UUID

/**
 * A notification as RN shows one (react-native-alarm-notification's sendNotification, patched), from core's details
 * (buildImmediateNotificationDetails, or a reminder alarm's buildReminderAlarmDetails; host-entry adds the channel's name). Kotlin
 * reads the details; it decides none.
 */
internal object CoreNotifications {
    /** Core's REMINDER_NOTIFICATION_CHANNEL. */
    const val REMINDER_CHANNEL = "mindwtr_reminders_v2"
    /** A tap's payload for MainActivity: the notification's data as JSON, which core routes (EntryPoints.kt, routeNotificationOpen). */
    const val EXTRA_OPEN = "tech.dongdongbh.mindwtr.notificationOpen"

    /** Posts [details] now; false when Android drops it (no notification permission, Android 13+). */
    fun post(context: Context, details: JSONObject): Boolean {
        // RN's notification ID: the send time in seconds.
        val id = (System.currentTimeMillis() / 1000).toInt()
        val builder = builder(context, id, details, details.getString("channelName")) ?: return false
        context.getSystemService(NotificationManager::class.java).notify(id, builder.build())
        return NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    /**
     * A fired reminder alarm (core's NativeReminderAlarm with the channel's name) under the alarm's id, as RN's AlarmReceiver posts
     * it: with buttons, Complete (a task reminder only), Snooze and Dismiss, with RN's labels and icons. Done and Snooze each carry a
     * request UUID made now, so every tap on this notification is the same request.
     */
    fun postReminder(context: Context, alarm: JSONObject) {
        val id = alarm.getInt("id")
        val details = alarm.getJSONObject("details")
        val builder = builder(context, id, details, alarm.optString("channelName")) ?: return
        if (details.optBoolean("has_button")) {
            val data = details.optJSONObject("data") ?: JSONObject()
            fun action(name: String) = Intent(context, ReminderActionReceiver::class.java).setAction(name).putExtra(ReminderActionReceiver.EXTRA_ID, id)
            fun broadcast(intent: Intent) = PendingIntent.getBroadcast(context, id, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            if (data.optString("notificationActionComplete") == "true") {
                builder.addAction(android.R.drawable.checkbox_on_background, "COMPLETE", broadcast(action(ReminderActionReceiver.COMPLETE)
                    .putExtra(ReminderActionReceiver.EXTRA_REQUEST, UUID.randomUUID().toString()).putExtra(ReminderActionReceiver.EXTRA_TASK, data.optString("taskId"))))
            }
            builder.addAction(R.drawable.ic_snooze, "SNOOZE", broadcast(action(ReminderActionReceiver.SNOOZE)
                .putExtra(ReminderActionReceiver.EXTRA_REQUEST, UUID.randomUUID().toString()).putExtra(ReminderAlarms.EXTRA_ALARM, alarm.toString())))
            builder.addAction(android.R.drawable.ic_lock_idle_alarm, "DISMISS", broadcast(action(ReminderActionReceiver.DISMISS)))
        }
        context.getSystemService(NotificationManager::class.java).notify(id, builder.build())
    }

    /**
     * RN's notification for [details] under [id]: RN's title (the app's name when empty) and text (none: nothing is posted), icon,
     * color, sound, and a tap that opens the app with the notification's data for core to route. Null when RN would post nothing.
     */
    private fun builder(context: Context, id: Int, details: JSONObject, channelName: String): NotificationCompat.Builder? {
        val channel = details.optString("channel").ifEmpty { return null }
        val message = details.optString("message").ifEmpty { return null }
        val title = details.optString("title").ifEmpty { context.applicationInfo.loadLabel(context.packageManager).toString() }
        val color = details.optString("color").takeIf { it.isNotEmpty() }?.let(Color::parseColor)
        ensureChannel(context, channel, channelName.ifEmpty { channel }, color)
        val sound = if (details.optBoolean("play_sound", true)) Settings.System.DEFAULT_NOTIFICATION_URI else null
        val open = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_OPEN, (details.optJSONObject("data") ?: JSONObject()).toString())
        return NotificationCompat.Builder(context, channel)
            .setSmallIcon(context.resources.getIdentifier(details.optString("small_icon", "ic_launcher"), "mipmap", context.packageName))
            .setContentTitle(title)
            .setContentText(message)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(details.optBoolean("auto_cancel", true))
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setSound(sound)
            .setContentIntent(PendingIntent.getActivity(context, id, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
            .apply {
                color?.let(::setColor)
                if (details.optBoolean("use_big_text")) setStyle(NotificationCompat.BigTextStyle().bigText(message))
            }
    }

    /** RN's reminder channel as RN makes it at start (NotificationOpenIntentsModule.ensureReminderChannel), once; its light in core's color. */
    private fun ensureChannel(context: Context, id: String, name: String, color: Int?) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(id) != null) return
        manager.createNotificationChannel(NotificationChannel(id, name, NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = name
            enableLights(true)
            color?.let { lightColor = it }
            enableVibration(false)
            setSound(Settings.System.DEFAULT_NOTIFICATION_URI, AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build())
        })
    }
}
