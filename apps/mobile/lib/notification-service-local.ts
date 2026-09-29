import {
  areDueDateRemindersEnabled,
  areStartDateRemindersEnabled,
  areTaskRemindersEnabled,
  getSystemDefaultLanguage,
  getTranslations,
  hasActiveMobileNotificationFeature,
  isWeeklyReviewReminderEnabled,
  loadStoredLanguage,
  nameNotifyListener,
  type Language,
  useTaskStore,
} from '@mindwtr/core';
import {
  buildImmediateNotificationDetails,
  buildPomodoroAlarmDetails,
  cancelReminderAlarm,
  cancelUnrequestedReminderAlarms,
  countReminderAlarmCancelReasons,
  getReminderAlarmCancelReason,
  getMaxPendingOneShotReminderAlarms,
  isExplicitPomodoroAlarmCancellation,
  isPomodoroAlarmDue,
  isPomodoroAlarmImmediate,
  isPomodoroAlarmScheduleSuperseded,
  isPomodoroAlarmUnchanged,
  isPomodoroNativeAlarm,
  planReminderAlarms,
  POMODORO_ALARM_STORAGE_KEY,
  readPomodoroAlarmEntry,
  readReminderAlarmMap,
  REMINDER_ALARM_MAP_STORAGE_KEY,
  REMINDER_NOTIFICATION_CHANNEL,
  REMINDER_NOTIFICATION_CHANNEL_NAME,
  REMINDER_NOTIFICATION_EVENT_RESCHEDULE_DELAY_MS,
  REMINDER_STORE_RESCHEDULE_DELAY_MS,
  scheduleReminderAlarms,
  shouldRemoveFiredPomodoroAlarm,
  shouldRescheduleReminderAlarms,
  writeReminderAlarmMap,
  type PomodoroAlarmCancellation,
  type PomodoroAlarmEntry,
  type ReminderAlarmEntry,
  type ReminderAlarmPlan,
  type ReminderAlarmPort,
} from '@mindwtr/core/mobile-reminder-alarms';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeEventEmitter, NativeModules, PermissionsAndroid, Platform } from 'react-native';

import { isLoggingEnabled, logInfo, logWarn } from './app-log';
import { ensureReminderNotificationChannel, restorePersistentCaptureNotification } from '@/modules/notification-open-intents';

type NotificationOpenPayload = {
  notificationId?: string;
  actionIdentifier?: string;
  taskId?: string;
  projectId?: string;
  context?: string;
  kind?: string;
};

type NotificationOpenHandler = (payload: NotificationOpenPayload) => void;

type NotificationPermissionResult = {
  granted: boolean;
  canAskAgain: boolean;
};

type AlarmId = number;

type AlarmScheduleResult = {
  id?: number | string;
};

type AlarmNotificationsApi = {
  parseDate: (date: Date) => string;
  scheduleAlarm: (details: Record<string, unknown>) => Promise<AlarmScheduleResult>;
  sendNotification?: (details: Record<string, unknown>) => void;
  deleteAlarm: (id: AlarmId) => void;
  deleteRepeatingAlarm: (id: AlarmId) => void;
  removeFiredNotification: (id: AlarmId) => void;
  removeAllFiredNotifications: () => void;
  getScheduledAlarms?: () => Promise<unknown>;
  requestPermissions?: (permissions: { alert: boolean; badge: boolean; sound: boolean }) => Promise<unknown>;
};

type PomodoroAlarmLoadResult = {
  entry: PomodoroAlarmEntry | null;
  failed: boolean;
};

type NativeEmitterSubscription = {
  remove: () => void;
};

// Which alarms to hold, their signatures, caps, retries and delays are core's
// (mobile-reminder-alarms.ts); this file binds them to the alarm library.
const POMODORO_ALERT_DELIVERY_RELEASE_CHECK = 'v1.3.0/pomodoro-alert-delivery';
const DAILY_DIGEST_INDEPENDENT_RELEASE_CHECK = 'v1.3.1/daily-digest-independent';
const REMINDER_CANCEL_RELEASE_CHECK = 'v1.3.4/reminder-withdrawn-clears-tray';
const DENIED_RESUME_CLEANUP_RELEASE_CHECK = 'v1.3.4/denied-resume-cleanup';
const SERIALIZED_RESCHEDULE_RELEASE_CHECK = 'v1.3.4/serialized-reminder-cycles';

let started = false;
let alarmApi: AlarmNotificationsApi | null = null;
let notificationOpenHandler: NotificationOpenHandler | null = null;
let storeSubscription: (() => void) | null = null;
let openSubscription: NativeEmitterSubscription | null = null;
let dismissSubscription: NativeEmitterSubscription | null = null;
let rescheduleTimer: ReturnType<typeof setTimeout> | null = null;
let oneShotTopUpTimer: ReturnType<typeof setTimeout> | null = null;
let notificationEventRescheduleTimer: ReturnType<typeof setTimeout> | null = null;
let rescheduleQueue: Promise<void> = Promise.resolve();
let pomodoroAlarmQueue: Promise<void> = Promise.resolve();
let pomodoroRequestOrder = 0;
let latestPomodoroCancellationRequest: PomodoroAlarmCancellation | null = null;
let alarmMap = new Map<string, ReminderAlarmEntry>();
let loadedAlarmMap = false;
let alarmMapLoadPromise: Promise<void> | null = null;
// Last payload `saveAlarmMap` actually wrote; null means "unknown, write it".
let lastSavedAlarmMapJson: string | null = null;

const logNotificationError = (message: string, error?: unknown) => {
  const extra = error ? { error: error instanceof Error ? error.message : String(error) } : undefined;
  void logWarn(`[Local Notifications] ${message}`, { scope: 'notifications', extra });
};

const logNotificationInfo = (message: string, extra?: Record<string, unknown>) => {
  void logInfo(`[Local Notifications] ${message}`, { scope: 'notifications', extra });
};

const logNotificationWarn = (message: string, extra?: Record<string, unknown>) => {
  void logWarn(`[Local Notifications] ${message}`, { scope: 'notifications', extra });
};

async function loadPomodoroAlarmEntry(): Promise<PomodoroAlarmLoadResult> {
  try {
    const raw = await AsyncStorage.getItem(POMODORO_ALARM_STORAGE_KEY);
    return { entry: readPomodoroAlarmEntry(raw), failed: false };
  } catch (error) {
    logNotificationError('Failed to load pomodoro alarm', error);
    return { entry: null, failed: true };
  }
}

async function savePomodoroAlarmEntry(entry: PomodoroAlarmEntry): Promise<boolean> {
  try {
    await AsyncStorage.setItem(POMODORO_ALARM_STORAGE_KEY, JSON.stringify(entry));
    return true;
  } catch (error) {
    logNotificationError('Failed to persist pomodoro alarm', error);
    return false;
  }
}

async function clearPomodoroAlarmEntry(): Promise<boolean> {
  try {
    await AsyncStorage.removeItem(POMODORO_ALARM_STORAGE_KEY);
    return true;
  } catch (error) {
    logNotificationError('Failed to clear pomodoro alarm', error);
    return false;
  }
}

function enqueuePomodoroAlarmOperation(label: string, operation: () => Promise<void>): Promise<void> {
  const current = pomodoroAlarmQueue
    .catch(() => undefined)
    .then(operation);
  pomodoroAlarmQueue = current.catch((error) => {
    logNotificationError(`Failed to ${label} pomodoro alarm`, error);
  });
  return current.catch(() => undefined);
}

function resetRuntimeState(): void {
  lastSavedAlarmMapJson = null;
  rescheduleQueue = Promise.resolve();
  notificationOpenHandler = null;
  alarmMapLoadPromise = null;
  clearOneShotTopUpTimer();
  clearNotificationEventRescheduleTimer();
}

function clearRescheduleTimer(): void {
  if (!rescheduleTimer) return;
  clearTimeout(rescheduleTimer);
  rescheduleTimer = null;
}

function clearOneShotTopUpTimer(): void {
  if (!oneShotTopUpTimer) return;
  clearTimeout(oneShotTopUpTimer);
  oneShotTopUpTimer = null;
}

function clearNotificationEventRescheduleTimer(): void {
  if (!notificationEventRescheduleTimer) return;
  clearTimeout(notificationEventRescheduleTimer);
  notificationEventRescheduleTimer = null;
}

async function getAndroidNotificationPermissionStatus(): Promise<NotificationPermissionResult> {
  if (Number(Platform.Version) < 33) {
    return { granted: true, canAskAgain: true };
  }

  try {
    const granted = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    return { granted, canAskAgain: !granted };
  } catch (error) {
    logNotificationError('Failed to read Android notification permission', error);
    return { granted: false, canAskAgain: false };
  }
}

async function ensureLocalReminderNotificationChannel(): Promise<void> {
  try {
    await ensureReminderNotificationChannel(REMINDER_NOTIFICATION_CHANNEL, REMINDER_NOTIFICATION_CHANNEL_NAME);
    logNotificationInfo('Android reminder notification channel ensured', {
      channel: REMINDER_NOTIFICATION_CHANNEL,
    });
  } catch (error) {
    logNotificationError('Failed to ensure local notification channel', error);
  }
}

async function loadAlarmApi(): Promise<AlarmNotificationsApi | null> {
  if (alarmApi) return alarmApi;
  try {
    const mod = await import('react-native-alarm-notification');
    const api = mod?.default as AlarmNotificationsApi | undefined;
    if (!api || typeof api.scheduleAlarm !== 'function') {
      logNotificationError('react-native-alarm-notification API unavailable');
      return null;
    }
    alarmApi = api;
    return api;
  } catch (error) {
    logNotificationError('Failed to load react-native-alarm-notification', error);
    return null;
  }
}

async function clearScheduledAlarms(
  api: AlarmNotificationsApi | null,
  options: { cancelPomodoro: boolean },
): Promise<void> {
  await loadAlarmMapIfNeeded();
  if (options.cancelPomodoro) {
    await cancelLocalPomodoroCompletionNotification(api, {
      removeFired: true,
      reason: 'notification-permission-denied',
    });
  }
  const scheduledAlarmCount = alarmMap.size;

  if (api) {
    // Every held alarm is withdrawn. Core cancels each on its own: what it
    // delivered goes first, and a failed removal never stops its deletes.
    const port = toReminderAlarmPort(api);
    for (const key of Array.from(alarmMap.keys())) {
      await cancelReminderAlarm(alarmMap, key, port, 'withdrawn');
    }

    // Only with the Pomodoro alert cancelled too (notifications denied): turning
    // reminders off must not clear a delivered Pomodoro alert.
    if (options.cancelPomodoro) {
      try {
        api.removeAllFiredNotifications();
      } catch {
        // no-op
      }

      // removeAllFiredNotifications() is NotificationManager.cancelAll(): it also
      // wipes the pinned quick-capture notification (#819). Re-assert it from its
      // native mirror; a no-op when the capture toggle is off.
      try {
        restorePersistentCaptureNotification();
      } catch {
        // no-op
      }
    }
  }

  alarmMap.clear();
  await saveAlarmMap();
  loadedAlarmMap = false;
  logNotificationInfo('Scheduled alarms cleared', { scheduledAlarmCount });
}

async function loadAlarmMapIfNeeded(): Promise<void> {
  if (loadedAlarmMap) return;
  if (alarmMapLoadPromise) {
    await alarmMapLoadPromise;
    return;
  }
  alarmMapLoadPromise = (async () => {
    try {
      const raw = await AsyncStorage.getItem(REMINDER_ALARM_MAP_STORAGE_KEY);
      alarmMap = readReminderAlarmMap(raw);
      loadedAlarmMap = true;
    } catch (error) {
      alarmMap = new Map<string, ReminderAlarmEntry>();
      loadedAlarmMap = false;
      logNotificationError('Failed to load alarm map', error);
    }
  })().finally(() => {
    alarmMapLoadPromise = null;
  });
  await alarmMapLoadPromise;
}

async function saveAlarmMap(): Promise<void> {
  // Every reschedule cycle ends here, but a cycle that re-derives the same
  // alarms leaves the map byte-identical — the common case, since most saves
  // touch no reminder-relevant field. Comparing the serialized form catches
  // that regardless of which path mutated the map (schedule, cancel, clear),
  // so a no-op cycle costs no AsyncStorage write (#766).
  const serialized = writeReminderAlarmMap(alarmMap);
  if (serialized === lastSavedAlarmMapJson) return;
  try {
    await AsyncStorage.setItem(REMINDER_ALARM_MAP_STORAGE_KEY, serialized);
    lastSavedAlarmMapJson = serialized;
  } catch (error) {
    lastSavedAlarmMapJson = null;
    logNotificationError('Failed to persist alarm map', error);
  }
}

function toAlarmFireDate(api: AlarmNotificationsApi, date: Date): string {
  const next = new Date(date);
  next.setMilliseconds(0);
  return api.parseDate(next);
}

function parseEventPayload(value: unknown): Record<string, string> | null {
  const raw = typeof value === 'string' ? value : null;
  try {
    const parsed = raw ? JSON.parse(raw) as unknown : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const result: Record<string, string> = {};
    for (const [key, item] of Object.entries(parsed as Record<string, unknown>)) {
      if (key === 'data') {
        const nested = parseEventPayload(item);
        if (nested) {
          for (const [nestedKey, nestedValue] of Object.entries(nested)) {
            result[nestedKey] ??= nestedValue;
          }
        }
      } else if (typeof item === 'string') {
        result[key] = item;
      } else if (item !== undefined && item !== null) {
        result[key] = String(item);
      }
    }
    return result;
  } catch {
    return null;
  }
}

function attachNativeEventListeners(): void {
  const nativeModule = (NativeModules as Record<string, unknown>).RNAlarmNotification;
  if (!nativeModule) return;

  const emitter = new NativeEventEmitter(nativeModule as any);

  openSubscription?.remove();
  openSubscription = emitter.addListener('OnNotificationOpened', (payload: unknown) => {
    const data = parseEventPayload(payload);
    if (!data) {
      logNotificationWarn('Notification event payload was unreadable');
      return;
    }
    // Receipt evidence for #1028: every tap that reaches JS is logged, so a
    // dead action button with no line here means the tap died in the native
    // layer (receiver never ran, or the alarm row it looks up is gone).
    logNotificationInfo('Notification opened event', {
      action: data.actionIdentifier || 'open',
      alarmKey: data.alarmKey || data.id || '',
      taskId: data.taskId || '',
      handlerAttached: String(Boolean(notificationOpenHandler)),
    });
    if (data.kind === 'pomodoro') {
      // Presentation evidence for #888: a tap proves iOS actually showed it.
      logNotificationInfo('Pomodoro notification opened', { id: data.alarmKey || data.id || '' });
    }
    if (alarmApi && (data.taskId || data.projectId)) {
      enqueueNotificationEventReschedule(alarmApi);
    }
    if (!notificationOpenHandler) return;
    try {
      notificationOpenHandler({
        notificationId: data.alarmKey || data.id,
        actionIdentifier: data.actionIdentifier || 'open',
        taskId: data.taskId,
        projectId: data.projectId,
        context: data.context,
        kind: data.kind,
      });
    } catch (error) {
      logNotificationError('Failed to handle notification open event', error);
    }
  });

  dismissSubscription?.remove();
  dismissSubscription = emitter.addListener('OnNotificationDismissed', (payload: unknown) => {
    const data = parseEventPayload(payload);
    logNotificationInfo('Notification dismissed event', {
      alarmKey: data?.alarmKey || data?.id || '',
      taskId: data?.taskId || '',
    });
    if (data?.kind === 'pomodoro') {
      logNotificationInfo('Pomodoro notification dismissed', { id: data.alarmKey || data.id || '' });
    }
    if (alarmApi && data && (data.taskId || data.projectId)) {
      enqueueNotificationEventReschedule(alarmApi);
    }
  });
}

function toReminderAlarmPort(api: AlarmNotificationsApi): ReminderAlarmPort {
  return {
    parseDate: (date) => api.parseDate(date),
    scheduleAlarm: (details) => api.scheduleAlarm(details),
    deleteAlarm: (id) => api.deleteAlarm(id),
    deleteRepeatingAlarm: (id) => api.deleteRepeatingAlarm(id),
    removeFiredNotification: (id) => api.removeFiredNotification(id),
    logInfo: logNotificationInfo,
    logError: logNotificationError,
  };
}

// Pending requests the OS actually holds, for the cycle-complete log only —
// never used to drive cancellation. A count above `alarmMap.size` is the
// signature of #1020 (a cancel that silently removed nothing), and it is the
// one number that separates "still leaking" from "orphans from before the fix
// firing one last time" without another week of counting notifications by
// hand. Returns null when the module cannot enumerate.
//
// Diagnostics-only, so it is gated on logging: the enumeration is a native
// round-trip that a reschedule cycle otherwise pays on every store change even
// though nothing reads the result with logging off (#766).
async function countPendingNativeAlarms(api: AlarmNotificationsApi): Promise<number | null> {
  if (!isLoggingEnabled()) return null;
  if (typeof api.getScheduledAlarms !== 'function') return null;
  try {
    const pending = await api.getScheduledAlarms();
    return Array.isArray(pending) ? pending.length : null;
  } catch (error) {
    logNotificationError('Failed to read pending native alarms', error);
    return null;
  }
}

// Tester proof of the withdrawn-or-expired rule: a withdrawn alarm's delivered
// notification was removed, an expired one's was kept.
function logCancelReasons(plan: ReminderAlarmPlan): void {
  const counts = countReminderAlarmCancelReasons(plan);
  for (const reason of ['withdrawn', 'expired'] as const) {
    if (counts[reason] === 0) continue;
    logNotificationInfo('Reminder alarms cancelled', {
      releaseCheck: REMINDER_CANCEL_RELEASE_CHECK,
      reason,
      count: counts[reason],
    });
  }
}

function scheduleOneShotTopUp(api: AlarmNotificationsApi, delayMs: number | null): void {
  clearOneShotTopUpTimer();
  if (delayMs === null) return;
  oneShotTopUpTimer = setTimeout(() => {
    oneShotTopUpTimer = null;
    enqueueReschedule(api);
  }, delayMs);
}

async function loadReminderTranslations(activeFeature: boolean): Promise<Record<string, string>> {
  if (!activeFeature) return {};
  const language: Language = await loadStoredLanguage(AsyncStorage, getSystemDefaultLanguage()).catch(() => getSystemDefaultLanguage());
  return getTranslations(language);
}

async function runRescheduleCycle(api: AlarmNotificationsApi): Promise<void> {
  const cycleStartedAtMs = Date.now();
  await loadAlarmMapIfNeeded();

  const { settings, tasks, projects } = useTaskStore.getState();
  const taskRemindersEnabled = areTaskRemindersEnabled(settings);
  const includeStartTime = areStartDateRemindersEnabled(settings);
  const includeDueDate = areDueDateRemindersEnabled(settings);
  const weeklyReviewEnabled = isWeeklyReviewReminderEnabled(settings);
  const activeFeature = hasActiveMobileNotificationFeature(settings);

  logNotificationInfo('Reschedule cycle started', {
    taskCount: tasks.length,
    projectCount: projects.length,
    existingAlarmCount: alarmMap.size,
    activeFeature,
    taskRemindersEnabled,
    includeStartTime,
    includeDueDate,
    includeReviewAt: taskRemindersEnabled && settings.reviewAtNotificationsEnabled !== false,
    weeklyReviewEnabled,
  });

  const port = toReminderAlarmPort(api);
  const translations = await loadReminderTranslations(activeFeature);
  const now = new Date();

  // Derivation and the diff live in core (`planReminderAlarms` over `buildReminderSchedule`):
  // digests, weekly review, every task's next reminder plus its due-time repeats, and project
  // reviews, already sorted and capped. This effect layer binds the plan to the alarm library.
  const plan = planReminderAlarms({
    settings,
    tasks,
    projects,
    now,
    translations,
    maxOneShotReminders: getMaxPendingOneShotReminderAlarms(Platform.OS),
    alarms: alarmMap,
  });

  if (plan.mode !== 'active') {
    clearOneShotTopUpTimer();
    await cancelUnrequestedReminderAlarms(plan, alarmMap, port);
    await saveAlarmMap();
    logCancelReasons(plan);
    logNotificationInfo('Reschedule cycle complete', {
      activeFeature,
      scheduledAlarmCount: alarmMap.size,
      oneShotReminderCount: 0,
      scheduledOneShotReminderCount: 0,
      durationMs: Date.now() - cycleStartedAtMs,
    });
    return;
  }

  const { diagnostics, recurring: recurringRequests, oneShot: oneShotRequests } = plan;

  // A rejected scheduleAlarm (revoked exact-alarm permission, the per-app pending
  // alarm cap) aborts the cycle. Whatever was created before that point is live in
  // AlarmManager, so the map has to reach storage anyway or a restart can never
  // cancel those alarms. saveAlarmMap no-ops on an unchanged map and swallows its
  // own storage errors, so the extra call is free and cannot mask the original.
  try {
    await scheduleReminderAlarms(plan, alarmMap, port);
    scheduleOneShotTopUp(api, plan.topUpDelayMs);

    await cancelUnrequestedReminderAlarms(plan, alarmMap, port);
  } finally {
    await saveAlarmMap();
  }
  if (!taskRemindersEnabled) {
    const morningDigestEnabled = recurringRequests.some((request) => request.key === 'digest:morning');
    const eveningDigestEnabled = recurringRequests.some((request) => request.key === 'digest:evening');
    const requestedDailyDigestAlarmCount = Number(morningDigestEnabled) + Number(eveningDigestEnabled);
    const dailyDigestAlarmCount = Number(morningDigestEnabled && alarmMap.has('digest:morning'))
      + Number(eveningDigestEnabled && alarmMap.has('digest:evening'));
    if (dailyDigestAlarmCount > 0 && dailyDigestAlarmCount === requestedDailyDigestAlarmCount) {
      logNotificationInfo('Independent daily digest alarms reconciled', {
        releaseCheck: DAILY_DIGEST_INDEPENDENT_RELEASE_CHECK,
        taskRemindersEnabled,
        morningDigestEnabled,
        eveningDigestEnabled,
        count: dailyDigestAlarmCount,
        outcome: 'reconciled',
      });
    }
  }
  logCancelReasons(plan);
  logNotificationInfo('Reschedule cycle complete', {
    activeFeature,
    scheduledAlarmCount: alarmMap.size,
    pendingNativeAlarmCount: await countPendingNativeAlarms(api),
    oneShotReminderCount: diagnostics.oneShotReminderCount,
    scheduledOneShotReminderCount: oneShotRequests.length,
    maxPendingOneShotReminderAlarms: getMaxPendingOneShotReminderAlarms(Platform.OS),
    nextOneShotFireAt: oneShotRequests[0]?.config.fireAt.toISOString() ?? '',
    taskReminderCount: diagnostics.taskReminderCount,
    taskReviewReminderCount: diagnostics.taskReviewReminderCount,
    projectReviewReminderCount: diagnostics.projectReviewReminderCount,
    dateOnlyDueDateCount: diagnostics.dateOnlyDueDateCount,
    futureDueDateReminderCount: diagnostics.futureDueDateReminderCount,
    pastDueDateReminderCount: diagnostics.pastDueDateReminderCount,
    dateOnlyStartTimeCount: diagnostics.dateOnlyStartTimeCount,
    futureStartTimeReminderCount: diagnostics.futureStartTimeReminderCount,
    pastStartTimeReminderCount: diagnostics.pastStartTimeReminderCount,
    futureTaskReviewReminderCount: diagnostics.futureTaskReviewReminderCount,
    pastTaskReviewReminderCount: diagnostics.pastTaskReviewReminderCount,
    suppressedTaskReminderCount: diagnostics.suppressedTaskReminderCount,
    durationMs: Date.now() - cycleStartedAtMs,
  });
}

// Every reschedule cycle must run through this one queue. Two cycles in flight
// at once both see a key that still needs arming (the first has not stored its
// alarm id yet) and each create a native alarm, so the reminder fires twice.
// On Android that overlap is routine: coming back to the foreground fires the
// overdue one-shot top-up timer and the AppState start request together.
// The returned promise rejects with the cycle's error; the queue itself never does.
function queueRescheduleCycle(api: AlarmNotificationsApi): Promise<void> {
  const cycle = rescheduleQueue
    .catch(() => undefined)
    .then(() => runRescheduleCycle(api));
  rescheduleQueue = cycle.catch(() => undefined);
  return cycle;
}

function enqueueReschedule(api: AlarmNotificationsApi): void {
  queueRescheduleCycle(api).catch((error) => logNotificationError('Failed to reschedule local notifications', error));
}

function enqueueNotificationEventReschedule(api: AlarmNotificationsApi): void {
  clearNotificationEventRescheduleTimer();
  notificationEventRescheduleTimer = setTimeout(() => {
    notificationEventRescheduleTimer = null;
    enqueueReschedule(api);
  }, REMINDER_NOTIFICATION_EVENT_RESCHEDULE_DELAY_MS);
}

export function setLocalNotificationOpenHandler(handler: NotificationOpenHandler | null): void {
  notificationOpenHandler = handler;
  if (handler) {
    attachNativeEventListeners();
  }
}

export async function requestLocalNotificationPermission(): Promise<NotificationPermissionResult> {
  if (Platform.OS === 'android') {
    const currentStatus = await getAndroidNotificationPermissionStatus();
    logNotificationInfo('Android notification permission checked', currentStatus);
    if (currentStatus.granted) {
      await ensureLocalReminderNotificationChannel();
      return currentStatus;
    }

    try {
      const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      logNotificationInfo('Android notification permission requested', { result });
      if (result === PermissionsAndroid.RESULTS.GRANTED) {
        await ensureLocalReminderNotificationChannel();
        return { granted: true, canAskAgain: true };
      }
      if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
        return { granted: false, canAskAgain: false };
      }
      return { granted: false, canAskAgain: true };
    } catch (error) {
      logNotificationError('Failed to request Android notification permission', error);
      return { granted: false, canAskAgain: false };
    }
  }

  const api = await loadAlarmApi();
  if (!api || typeof api.requestPermissions !== 'function') {
    return { granted: false, canAskAgain: false };
  }

  try {
    const result = await api.requestPermissions({ alert: true, badge: true, sound: true });
    const granted = Boolean((result as { alert?: boolean } | undefined)?.alert);
    return { granted, canAskAgain: !granted };
  } catch (error) {
    logNotificationError('Failed to request iOS notification permission', error);
    return { granted: false, canAskAgain: false };
  }
}

export async function sendLocalMobileNotification(
  title: string,
  message?: string,
  data?: Record<string, string>
): Promise<void> {
  const trimmedTitle = String(title || '').trim();
  if (!trimmedTitle) return;

  const api = await loadAlarmApi();
  if (!api) return;

  const permission = await requestLocalNotificationPermission();
  if (!permission.granted) return;

  await sendLocalMobileNotificationWithApi(api, trimmedTitle, message, data);
}

async function sendLocalMobileNotificationWithApi(
  api: AlarmNotificationsApi,
  title: string,
  message?: string,
  data?: Record<string, string>,
): Promise<boolean> {
  const trimmedTitle = String(title || '').trim();
  if (!trimmedTitle) return false;

  try {
    const details = buildImmediateNotificationDetails(trimmedTitle, message, data);

    if (typeof api.sendNotification === 'function') {
      api.sendNotification(details);
      return true;
    }

    await api.scheduleAlarm({
      ...details,
      fire_date: api.parseDate(new Date(Date.now() + 2000)),
      schedule_type: 'once',
    });
    return true;
  } catch (error) {
    logNotificationError('Failed to send local mobile notification', error);
    return false;
  }
}

async function loadNativePomodoroAlarmIds(api: AlarmNotificationsApi): Promise<Set<AlarmId> | null> {
  if (typeof api.getScheduledAlarms !== 'function') {
    logNotificationWarn('Pomodoro native alarm inventory unavailable');
    return null;
  }
  try {
    const alarms = await api.getScheduledAlarms();
    if (!Array.isArray(alarms)) {
      logNotificationWarn('Pomodoro native alarm inventory unreadable');
      return null;
    }
    const ids = new Set<AlarmId>();
    for (const alarm of alarms) {
      if (!alarm || typeof alarm !== 'object' || !isPomodoroNativeAlarm(alarm)) continue;
      const id = Number((alarm as Record<string, unknown>).id);
      if (Number.isFinite(id)) ids.add(Math.floor(id));
    }
    return ids;
  } catch (error) {
    logNotificationError('Failed to read pomodoro native alarm inventory', error);
    return null;
  }
}

function cancelPomodoroAlarmId(
  api: AlarmNotificationsApi,
  id: AlarmId,
  removeFired: boolean,
): boolean {
  try {
    // Android resolves the delivered notification id from its alarm row, so
    // remove the tray item before deleteAlarm removes that row.
    if (removeFired) api.removeFiredNotification(id);
    api.deleteAlarm(id);
    api.deleteRepeatingAlarm(id);
    return true;
  } catch (error) {
    logNotificationError('Failed to cancel pomodoro alarm', error);
    return false;
  }
}

function logPreservedDuePomodoroAlarm(reason: string, count = 1): void {
  logNotificationInfo('Pomodoro due alarm preserved', {
    reason,
    outcome: 'preserved',
    count,
    releaseCheck: POMODORO_ALERT_DELIVERY_RELEASE_CHECK,
  });
}

function isPomodoroScheduleSuperseded(
  scheduleOrder: number,
  fireAtMs: number,
): boolean {
  return isPomodoroAlarmScheduleSuperseded(latestPomodoroCancellationRequest, scheduleOrder, fireAtMs);
}

async function cancelLocalPomodoroCompletionNotificationUnlocked(
  api: AlarmNotificationsApi | null,
  options: { removeFired?: boolean; reason?: string },
  requestedAtMs: number,
): Promise<void> {
  const loaded = await loadPomodoroAlarmEntry();
  const reason = options.reason ?? 'unspecified';
  const explicitCancellation = isExplicitPomodoroAlarmCancellation(reason);
  if (loaded.failed && !explicitCancellation) return;
  const entry = loaded.entry;
  const preserveDue = !explicitCancellation && isPomodoroAlarmDue(entry, requestedAtMs);

  if (preserveDue) {
    if (entry?.id !== undefined) {
      logPreservedDuePomodoroAlarm(reason);
    }
    return;
  }

  if (!api) {
    if (entry) {
      logNotificationWarn('Pomodoro alarm cancellation deferred; alarm module unavailable', { reason });
    }
    return;
  }

  const ids = new Set<AlarmId>();
  if (entry?.id !== undefined) ids.add(entry.id);
  let inventoryComplete = true;
  if (explicitCancellation) {
    const nativeIds = await loadNativePomodoroAlarmIds(api);
    inventoryComplete = nativeIds !== null;
    for (const id of nativeIds ?? []) ids.add(id);
  }

  let cancellationComplete = true;
  for (const id of ids) {
    const shouldRemoveFired = shouldRemoveFiredPomodoroAlarm({ removeFired: options.removeFired, reason, entry, id, requestedAtMs });
    cancellationComplete = cancelPomodoroAlarmId(api, id, shouldRemoveFired) && cancellationComplete;
  }

  if (entry || ids.size > 0) {
    logNotificationInfo('Pomodoro alarm cancelled', {
      reason,
      outcome: cancellationComplete && inventoryComplete ? 'cancelled' : 'incomplete',
      count: ids.size,
    });
  }
  if (cancellationComplete && inventoryComplete) {
    await clearPomodoroAlarmEntry();
  }
}

export async function cancelLocalPomodoroCompletionNotification(
  loadedApi?: AlarmNotificationsApi | null,
  options: { removeFired?: boolean; reason?: string } = {},
): Promise<void> {
  const requestedAtMs = Date.now();
  const order = ++pomodoroRequestOrder;
  latestPomodoroCancellationRequest = {
    order,
    requestedAtMs,
    reason: options.reason ?? 'unspecified',
  };
  return enqueuePomodoroAlarmOperation('cancel', async () => {
    const api = loadedApi ?? await loadAlarmApi();
    await cancelLocalPomodoroCompletionNotificationUnlocked(api, options, requestedAtMs);
  });
}

export async function scheduleLocalPomodoroCompletionNotification(
  title: string,
  message: string,
  fireAt: Date,
  data?: Record<string, string>,
): Promise<void> {
  const requestedAtMs = Date.now();
  const order = ++pomodoroRequestOrder;
  const trimmedTitle = String(title || '').trim();
  const fireAtMs = fireAt.getTime();
  const fireAtValid = Number.isFinite(fireAtMs);

  // The very first statement, before every gate: a diagnostic log with no
  // "requested" line now proves the panel never asked for an alert at all —
  // an empty log used to be ambiguous (#888).
  logNotificationInfo('Pomodoro alarm requested', {
    fireAt: fireAtValid ? new Date(fireAtMs).toISOString() : 'invalid',
    inMs: fireAtValid ? String(fireAtMs - requestedAtMs) : 'invalid',
    phase: data?.phase ?? '',
    hasTitle: String(Boolean(trimmedTitle)),
  });

  if (!trimmedTitle) {
    logNotificationWarn('Pomodoro alarm skipped; empty title');
    return;
  }
  if (!fireAtValid) {
    logNotificationWarn('Pomodoro alarm skipped; invalid fire date');
    return;
  }

  return enqueuePomodoroAlarmOperation('schedule', async () => {
    const api = await loadAlarmApi();
    if (!api) {
      logNotificationWarn('Pomodoro alarm skipped; alarm module unavailable');
      return;
    }

    const permission = await requestLocalNotificationPermission();
    if (!permission.granted) {
      logNotificationWarn('Pomodoro alarm skipped; notification permission not granted');
      await cancelLocalPomodoroCompletionNotificationUnlocked(
        api,
        { removeFired: true, reason: 'notification-permission-denied' },
        requestedAtMs,
      );
      return;
    }

    if (isPomodoroScheduleSuperseded(order, fireAtMs)) return;

    const loaded = await loadPomodoroAlarmEntry();
    if (loaded.failed) return;
    if (isPomodoroScheduleSuperseded(order, fireAtMs)) return;
    const previousEntry = loaded.entry;
    const phase = data?.phase ?? '';
    if (isPomodoroAlarmUnchanged(previousEntry, fireAtMs, phase)) {
      logNotificationInfo('Pomodoro alarm already matches requested phase');
      return;
    }

    if (isPomodoroAlarmImmediate(fireAtMs, Date.now())) {
      logNotificationInfo('Pomodoro completion already due; notifying immediately');
      const delivered = await sendLocalMobileNotificationWithApi(api, trimmedTitle, message, data);
      if (!delivered) return;
      const saved = await savePomodoroAlarmEntry({
        fireAtMs,
        ...(phase ? { phase } : {}),
        notifiedImmediately: true,
      });
      if (!saved) return;
      if (previousEntry?.id !== undefined && previousEntry.id !== 0) {
        if (isPomodoroAlarmDue(previousEntry, requestedAtMs)) {
          logPreservedDuePomodoroAlarm('phase-replaced');
        } else {
          cancelPomodoroAlarmId(api, previousEntry.id, true);
        }
      }
      return;
    }

    try {
      const result = await api.scheduleAlarm({
        ...buildPomodoroAlarmDetails(trimmedTitle, message, data),
        fire_date: toAlarmFireDate(api, fireAt),
      });
      const id = Number(result?.id);
      if (!Number.isFinite(id)) {
        logNotificationError('Pomodoro alarm returned invalid id');
        return;
      }
      const scheduledId = Math.floor(id);
      const saved = await savePomodoroAlarmEntry({
        id: scheduledId,
        fireAtMs,
        ...(phase ? { phase } : {}),
      });
      if (!saved) {
        if (previousEntry?.id !== scheduledId) {
          cancelPomodoroAlarmId(api, scheduledId, true);
        }
        return;
      }
      logNotificationInfo('Pomodoro alarm scheduled', {
        alarmId: scheduledId,
        fireAt: new Date(fireAtMs).toISOString(),
      });
      // Skip when the ids match: the iOS module keys requests by creation second,
      // so deleting the shared id would remove the replacement alarm (#888).
      if (previousEntry?.id !== undefined && previousEntry.id !== scheduledId) {
        if (isPomodoroAlarmDue(previousEntry, requestedAtMs)) {
          logPreservedDuePomodoroAlarm('phase-replaced');
        } else {
          cancelPomodoroAlarmId(api, previousEntry.id, true);
        }
      }
    } catch (error) {
      logNotificationError('Failed to schedule pomodoro alarm', error);
    }
  });
}

export async function startLocalMobileNotifications(): Promise<void> {
  if (started) {
    logNotificationInfo('Start requested while service is already running; rescheduling current reminders', {
      releaseCheck: SERIALIZED_RESCHEDULE_RELEASE_CHECK,
    });
    const api = await loadAlarmApi();
    if (api) {
      await queueRescheduleCycle(api);
    }
    return;
  }
  started = true;
  logNotificationInfo('Start requested', {
    platform: Platform.OS,
    platformVersion: String(Platform.Version),
  });

  const api = await loadAlarmApi();
  if (!api) {
    logNotificationInfo('Start aborted; alarm API unavailable');
    started = false;
    return;
  }

  const permission = await requestLocalNotificationPermission();
  if (!permission.granted) {
    logNotificationInfo('Start aborted; notification permission not granted', permission);
    await clearScheduledAlarms(api, { cancelPomodoro: true });
    started = false;
    return;
  }

  attachNativeEventListeners();
  await queueRescheduleCycle(api);
  logNotificationInfo('Service started');

  storeSubscription?.();
  storeSubscription = useTaskStore.subscribe(nameNotifyListener('notification-reschedule', (state, prevState) => {
    // Reschedule cycles only read tasks, projects, and a handful of settings
    // fields. tasks/projects re-arm on any identity change (cheap reference
    // compare). settings re-arms only when a reminder-relevant field actually
    // moved: an unchanged sync cycle still rewrites lastSyncAt/lastSyncStatus/
    // lastSyncStats into a fresh settings object every time (#766).
    if (!shouldRescheduleReminderAlarms(state, prevState)) {
      return;
    }
    clearRescheduleTimer();
    rescheduleTimer = setTimeout(() => {
      rescheduleTimer = null;
      enqueueReschedule(api);
    }, REMINDER_STORE_RESCHEDULE_DELAY_MS);
  }));
}

// AlarmManager decides exact vs inexact when the alarm is *created*, so alarms
// that were scheduled while "Alarms & reminders" was denied stay inexact after
// the user allows it. The reconciliation skips any key whose config
// signature is unchanged, so a plain reschedule cycle would re-confirm every
// stale alarm instead of re-creating it. Cancel first, then run the one
// existing cycle so it rebuilds them all as exact.
export async function rescheduleLocalAlarmsAsExact(): Promise<void> {
  if (!started) return;
  const api = await loadAlarmApi();
  if (!api) return;
  logNotificationInfo('Rebuilding alarms as exact after exact-alarm permission grant');
  rescheduleQueue = rescheduleQueue
    .catch(() => undefined)
    .then(async () => {
      await loadAlarmMapIfNeeded();
      // Remade at once, so what an alarm delivered stays, unless its reminder was
      // withdrawn since the last cycle. The texts load first; the tasks are read
      // after that await, and every alarm is judged and cancelled in the same turn,
      // so a change that lands meanwhile is never judged from an older state.
      const translations = await loadReminderTranslations(hasActiveMobileNotificationFeature(useTaskStore.getState().settings));
      const { settings, tasks, projects } = useTaskStore.getState();
      const plan = planReminderAlarms({
        settings,
        tasks,
        projects,
        now: new Date(),
        translations,
        maxOneShotReminders: getMaxPendingOneShotReminderAlarms(Platform.OS),
        alarms: alarmMap,
      });
      const port = toReminderAlarmPort(api);
      const keys = Array.from(alarmMap.keys());
      await Promise.all(keys.map((key) => cancelReminderAlarm(alarmMap, key, port, getReminderAlarmCancelReason(plan, key))));
      await runRescheduleCycle(api);
    })
    .catch((error) => logNotificationError('Failed to rebuild alarms as exact', error));
  await rescheduleQueue;
}

// `permissionDenied`: the OS denies notifications, so the cleanup is the one a
// denied start runs (the Pomodoro alarm and the whole tray go too).
export async function stopLocalMobileNotifications(options: { permissionDenied?: boolean } = {}): Promise<void> {
  logNotificationInfo('Stop requested');
  clearRescheduleTimer();
  clearNotificationEventRescheduleTimer();

  storeSubscription?.();
  storeSubscription = null;

  openSubscription?.remove();
  openSubscription = null;

  dismissSubscription?.remove();
  dismissSubscription = null;
  notificationOpenHandler = null;

  const api = await loadAlarmApi();
  await clearScheduledAlarms(api, { cancelPomodoro: options.permissionDenied === true });
  resetRuntimeState();
  started = false;
  logNotificationInfo('Service stopped');
  if (options.permissionDenied) {
    logNotificationInfo('Denied-permission cleanup ran on stop', { releaseCheck: DENIED_RESUME_CLEANUP_RELEASE_CHECK });
  }
}

export async function getLocalNotificationPermissionStatus(): Promise<NotificationPermissionResult> {
  if (Platform.OS === 'android') {
    return getAndroidNotificationPermissionStatus();
  }
  return requestLocalNotificationPermission();
}

export const __localNotificationTestUtils = {
  loadAlarmMapIfNeeded,
  getAlarmMapSnapshot: () => new Map(alarmMap),
  getNotificationOpenHandler: () => notificationOpenHandler,
  isAlarmMapLoaded: () => loadedAlarmMap,
  resetForTests: () => {
    clearRescheduleTimer();
    storeSubscription?.();
    storeSubscription = null;
    openSubscription?.remove();
    openSubscription = null;
    dismissSubscription?.remove();
    dismissSubscription = null;
    started = false;
    alarmApi = null;
    alarmMap = new Map<string, ReminderAlarmEntry>();
    loadedAlarmMap = false;
    resetRuntimeState();
    pomodoroAlarmQueue = Promise.resolve();
    pomodoroRequestOrder = 0;
    latestPomodoroCancellationRequest = null;
  },
};
