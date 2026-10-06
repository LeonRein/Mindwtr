# Mindwtr Dev test build: reminder notifications and buttons

`mindwtr-dev-1.3.3-reminders-buttons-arm64.apk` is built from branch `claude/keen-bell-2l93tt` (commit 36bbd46).

What changed:
- **One notification per task.** A task's start reminder, due reminder and every repeat (e.g. every
  10 minutes) replace its notification and alert again, instead of adding another one.
- **Snooze** always snoozes (it used to just close the notification once the app had run since the
  reminder fired).
- **Done** cancels the task's remaining repeats straight away, even with the app in the background,
  and is remembered if the app was closed, then applied the next time you open the app.
- **Dismiss** and swiping away remove only the current notification; the next repeat still comes.

Install:
- App name **Mindwtr Dev**, app ID `tech.dongdongbh.mindwtr.dev`, installs next to your normal Mindwtr.
- Same signing key as the previous test build, so it installs over it and keeps its data.
- Release build with the JavaScript bundled, arm64 only, signed with a debug key.
- SHA-256: `a5a962a1964a9e463052ebadeb9d81e053a8e56ed3c033b257f0609ac36ee0ac`

1. On the phone, tap the APK file above, then **Download** (or **View raw**).
2. Open the downloaded file; allow installing from this source if Android asks.

This branch only carries the test build; delete it when you are done.
