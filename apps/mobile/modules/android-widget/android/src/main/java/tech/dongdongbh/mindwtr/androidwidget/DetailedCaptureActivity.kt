package tech.dongdongbh.mindwtr.androidwidget

import android.app.Activity
import android.os.Bundle

/** Isolates the static shortcut's CLEAR_TASK flag from the app's active draft. */
class DetailedCaptureActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    try {
      // Fresh explicit intent: never forward launcher flags, extras, or incoming data.
      startActivity(WidgetRenderer.appIntent(this, "mindwtr:///capture-quick?mode=text&entry=details"))
    } finally {
      finish()
    }
  }
}
