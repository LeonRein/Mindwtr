# Mindwtr Dev test build: one notification per task

`mindwtr-dev-1.3.3-reminder-replace-arm64.apk` is built from branch `claude/keen-bell-2l93tt` (commit 7576e14).

Each task now keeps a single notification: its start reminder, due reminder and every
repeat (e.g. every 10 minutes) replace it and alert again, instead of adding another one.

- App name **Mindwtr Dev**, app ID `tech.dongdongbh.mindwtr.dev`. It installs next to your
  normal Mindwtr and has its own, empty data.
- Release build with the JavaScript bundled (no dev server needed), arm64 only, signed with a debug key.
- SHA-256: `27742d4d5a1613584770a667fbd9a767e80cf660d7900480ee22733c3cffdb69`

## Install
1. On the phone, tap the APK file above, then **View raw** or **Download**.
2. Open the downloaded file and allow installing from this source if Android asks.
3. In Mindwtr Dev, allow notifications (and "Alarms & reminders" if prompted).

This branch only carries the test build; delete it when you are done.
