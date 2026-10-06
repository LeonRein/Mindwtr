// The mobile apps' background sync run: which backends run from the platform's background
// job, the 4-minute deadline, the failure back-off, the capture import before the sync and
// the storage quiesce after it. It moved here from React Native's
// `apps/mobile/lib/background-sync-task.ts` so the native app's WorkManager job runs the same
// policy. The host keeps its scheduler (expo-background-task, WorkManager) and binds this to
// its sync service, storage, log and app lifecycle.
//
// Light on purpose: React Native's tests reload this module for every case.
import { BACKGROUND_SYNC_FAILURE_STATE_KEY, type SyncKeyValueStoragePort } from './sync-storage-keys';

export type MobileBackgroundSyncTrigger = 'scheduled' | 'capture';
export const MOBILE_BACKGROUND_SYNC_MINIMUM_INTERVAL_MINUTES = 15;
export const MOBILE_BACKGROUND_SYNC_INTERVAL = '15m' as const;
// JobScheduler stops a WorkManager job that is still running after its
// allowance (10 minutes normally, 20 in the ACTIVE standby bucket), counts a
// "timeout" against the app, and defers the next run by about 40 minutes. On
// device the job held a wakelock for the whole allowance whenever the sync did
// not settle (#1001). The run is abandoned well inside that allowance instead,
// so the job always returns and the wakelock is released.
//
// Android pauses JavaScript timers while the app is not in the foreground, so
// the setTimeout race below only fires when the app is visible. The deadline
// that holds in the background is the request deadline handed to the sync's
// fetch, which refuses to start a request past it and caps each request at it.
export const MOBILE_BACKGROUND_SYNC_DEADLINE_MS = 4 * 60 * 1000;
export const MOBILE_BACKGROUND_SYNC_QUIESCE_DEADLINE_MS = 20 * 1000;
/** A run past this is written to the log even with debug logging off: a job
 *  that lives this long is what drained batteries in #1001, and the log a
 *  user shares is the only view into a background run. */
export const MOBILE_BACKGROUND_SYNC_SLOW_RUN_MS = 60 * 1000;
/** Ceiling for the failure cooldown below: eight scheduled intervals, i.e. two
 *  hours. The foreground controller's ceiling (10 minutes) cannot be reused —
 *  it is shorter than this task's own 15-minute interval, so it would never
 *  skip a run. */
export const MOBILE_BACKGROUND_SYNC_MAX_FAILURE_COOLDOWN_MS =
  8 * MOBILE_BACKGROUND_SYNC_MINIMUM_INTERVAL_MINUTES * 60 * 1000;

/** WebDAV, self-hosted cloud and Dropbox (`cloud`), and CloudKit run from the background job.
 *  File Sync does not: its folder lock and document access need the visible app. */
export const supportsMobileScheduledBackgroundSync = (backend: string): boolean => (
  backend === 'webdav' || backend === 'cloud' || backend === 'cloudkit'
);

/** Whether the platform's periodic background job should be scheduled at all. */
export const shouldScheduleMobileBackgroundSync = (input: {
  schedulerAvailable: boolean;
  configured: boolean;
  backend: string;
}): boolean => (
  input.schedulerAvailable
  && input.configured
  && supportsMobileScheduledBackgroundSync(input.backend)
);

export type MobileBackgroundSyncOutcome = 'success' | 'failed';

type LogContext = { scope: string; extra?: Record<string, string>; force?: boolean };

export type MobileBackgroundSyncPorts = {
  /** The device key-value store; holds the failure record. */
  storage: SyncKeyValueStoragePort;
  log: {
    info(message: string, context: LogContext): unknown;
    warn(message: string, context: LogContext): unknown;
  };
  sync: {
    getConfigurationStatus(): Promise<{ backend: string; configured: boolean }>;
    performSync(): Promise<{ success: boolean; error?: string }>;
    /** Aborts the running cycle as a lifecycle abort. */
    abort(): unknown;
    /** The wall-clock time past which the sync's fetch starts no request; null clears it. */
    setRequestDeadline(at: number | null): void;
  };
  flushPendingSave(): Promise<void>;
  /** Imports captures and check-offs queued while the app was closed; resolves to the count. */
  drainPendingCaptures(trigger: MobileBackgroundSyncTrigger): Promise<number>;
  /** Lets deferred storage writes land before the headless process is torn down. */
  quiesceStorage(): Promise<void>;
  /** True while the platform pauses JavaScript timers (diagnostics only). */
  timersPaused(): boolean;
  /** App lifecycle changes ('active' when the app comes to the foreground). */
  onAppStateChange(listener: (state: string) => void): { remove(): void };
  now?: () => number;
  /** The run's deadline when the host shortens it (the native app's debug device check only); else MOBILE_BACKGROUND_SYNC_DEADLINE_MS. */
  deadlineMs?: () => number;
};

const withDeadline = <T>(work: Promise<T>, deadlineMs: number, onDeadline: () => T): Promise<T> => (
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(onDeadline()), deadlineMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  })
);

// A backend that cannot accept this device (a wrong password, a server that is
// gone) otherwise costs a full failing cycle — wakelock, storage flush, network
// — every 15 minutes forever. Each failure in a row doubles the wait from one
// scheduled interval up to the ceiling above; one success clears the record.
type BackgroundSyncFailureState = { lastFailureAt: number; consecutiveFailures: number };

export const backgroundSyncFailureCooldownMs = (consecutiveFailures: number): number => Math.min(
  MOBILE_BACKGROUND_SYNC_MAX_FAILURE_COOLDOWN_MS,
  MOBILE_BACKGROUND_SYNC_MINIMUM_INTERVAL_MINUTES * 60 * 1000 * (2 ** (Math.max(1, consecutiveFailures) - 1)),
);

export const createMobileBackgroundSyncRunner = (ports: MobileBackgroundSyncPorts) => {
  const now = ports.now ?? (() => Date.now());

  const logBackgroundSyncWarning = (message: string, error?: unknown) => {
    const extra = error ? { error: error instanceof Error ? error.message : String(error) } : undefined;
    void ports.log.warn(message, { scope: 'sync', extra });
  };

  const readBackgroundSyncFailureState = async (): Promise<BackgroundSyncFailureState | null> => {
    try {
      const stored = await ports.storage.getItem(BACKGROUND_SYNC_FAILURE_STATE_KEY);
      if (!stored) return null;
      const parsed = JSON.parse(stored) as Partial<BackgroundSyncFailureState> | null;
      const lastFailureAt = Number(parsed?.lastFailureAt);
      const consecutiveFailures = Number(parsed?.consecutiveFailures);
      if (!Number.isFinite(lastFailureAt) || !Number.isFinite(consecutiveFailures) || consecutiveFailures < 1) {
        return null;
      }
      return { lastFailureAt, consecutiveFailures };
    } catch (error) {
      logBackgroundSyncWarning('Failed to read the background sync failure record', error);
      return null;
    }
  };

  const recordBackgroundSyncOutcome = async (
    succeeded: boolean,
    previous: BackgroundSyncFailureState | null,
  ): Promise<void> => {
    try {
      if (succeeded) {
        if (previous) await ports.storage.removeItem(BACKGROUND_SYNC_FAILURE_STATE_KEY);
        return;
      }
      await ports.storage.setItem(BACKGROUND_SYNC_FAILURE_STATE_KEY, JSON.stringify({
        lastFailureAt: now(),
        consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
      } satisfies BackgroundSyncFailureState));
    } catch (error) {
      logBackgroundSyncWarning('Failed to persist the background sync failure record', error);
    }
  };

  /** Same race as withDeadline, but the deadline can also be declared past by an
   *  app lifecycle 'active' event, not only by its own timer. A setTimeout scheduled
   *  before the app was suspended does not fire again until the app resumes —
   *  by then a CloudKit operation may have sat suspended for up to half an hour
   *  (see the module comment above). React Native delivers 'active' the moment JS
   *  resumes, before anything else runs, so a run that is already past its
   *  deadline by then is abandoned immediately instead of waiting for that timer. */
  const withDeadlineAndResumeCheck = <T>(
    work: Promise<T>,
    deadlineAt: number,
    onDeadline: (stage: 'timer' | 'resume') => T,
  ): Promise<T> => (
    new Promise<T>((resolve, reject) => {
      let settled = false;
      let subscription: { remove: () => void } | null = null;
      const cleanup = () => {
        clearTimeout(timer);
        subscription?.remove();
      };
      const settleWithDeadline = (stage: 'timer' | 'resume') => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(onDeadline(stage));
      };
      const timer = setTimeout(() => settleWithDeadline('timer'), Math.max(0, deadlineAt - now()));
      subscription = ports.onAppStateChange((state) => {
        if (state === 'active' && now() >= deadlineAt) settleWithDeadline('resume');
      });
      work.then(
        (value) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      );
    })
  );

  const performBackgroundSyncWork = async (): Promise<MobileBackgroundSyncOutcome> => {
    const { backend, configured } = await ports.sync.getConfigurationStatus();
    if (!configured || !supportsMobileScheduledBackgroundSync(backend)) {
      return 'success';
    }

    await ports.flushPendingSave().catch((error) => {
      logBackgroundSyncWarning('Mobile background sync save flush failed', error);
    });
    const result = await ports.sync.performSync();
    if (result.success) {
      return 'success';
    }

    logBackgroundSyncWarning('Mobile background sync failed', result.error);
    return 'failed';
  };

  const quiesceWithinDeadline = (): Promise<void> => (
    withDeadline(ports.quiesceStorage(), MOBILE_BACKGROUND_SYNC_QUIESCE_DEADLINE_MS, () => {
      logBackgroundSyncWarning('Mobile background sync storage quiesce did not finish before its deadline');
    })
  );

  const runMobileBackgroundSync = async (
    trigger: MobileBackgroundSyncTrigger = 'scheduled',
  ): Promise<MobileBackgroundSyncOutcome> => {
    const startedAt = now();
    // Captures and widget check-offs made while the app was closed only exist as
    // queue files; import them first so this sync has them to send (#1257). It is
    // local work, so it runs even when the network part below is skipped.
    const drained = await ports.drainPendingCaptures(trigger).catch((error) => {
      logBackgroundSyncWarning('Background capture import failed', error);
      return 0;
    });
    // A Save that the visible app already imported has nothing left to send from here.
    if (trigger === 'capture' && drained === 0) return 'success';
    const failureState = await readBackgroundSyncFailureState();
    // The cooldown spares the battery from scheduled retries; a Save is the user acting now.
    if (failureState && trigger === 'scheduled') {
      const cooldownMs = backgroundSyncFailureCooldownMs(failureState.consecutiveFailures);
      const waitedMs = startedAt - failureState.lastFailureAt;
      // A clock that moved backwards reads as a negative wait; run rather than
      // sit out a cooldown that can never expire.
      if (waitedMs >= 0 && waitedMs < cooldownMs) {
        void ports.log.info('Mobile background sync skipped during failure cooldown', {
          scope: 'sync',
          extra: {
            consecutiveFailures: String(failureState.consecutiveFailures),
            cooldownMs: String(cooldownMs),
            waitedMs: String(waitedMs),
          },
        });
        if (drained > 0) await quiesceWithinDeadline();
        return 'success';
      }
    }
    // Kept on an object: the deadline callback below assigns it from a closure,
    // which control-flow narrowing on a plain `let` cannot see.
    const run: { outcome: 'success' | 'failed' | 'abandoned' | 'crashed' } = { outcome: 'crashed' };
    // Counted from here, not from startedAt: the capture drain above does file
    // work and can take a while after a long backlog. Counting from startedAt
    // would hand the sync whatever is left of the four minutes — possibly none
    // of it, abandoning a run that never began and arming the failure cooldown.
    const deadlineMs = ports.deadlineMs?.() ?? MOBILE_BACKGROUND_SYNC_DEADLINE_MS;
    const deadlineAt = now() + deadlineMs;
    ports.sync.setRequestDeadline(deadlineAt);
    // A "started" line without its "finished" line in a shared log is the
    // signature of a run that never settled (#1001).
    void ports.log.info('Mobile background sync started', {
      scope: 'sync',
      extra: { timersPaused: String(ports.timersPaused()) },
    });
    try {
      const result = await withDeadlineAndResumeCheck(
        performBackgroundSyncWork(),
        deadlineAt,
        // Which of the two branches wins is a race the app does not control: on
        // resume, React Native restarts the paused timer at the same moment
        // AppState delivers 'active'. So both carry the proof fields and `stage`
        // says which one it was — otherwise a working build could log a line the
        // tester cannot see and the release check would report a false failure.
        (stage): MobileBackgroundSyncOutcome => {
          ports.sync.abort();
          run.outcome = 'abandoned';
          void ports.log.warn('Mobile background sync did not finish before its deadline and was abandoned', {
            scope: 'sync',
            force: true,
            extra: {
              deadlineMs: String(deadlineMs),
              elapsedMs: String(now() - startedAt),
              stage,
              releaseCheck: 'v1.3.2/background-sync-wallclock-abort',
            },
          });
          return 'failed';
        },
      );
      if (run.outcome !== 'abandoned') {
        run.outcome = result === 'success' ? 'success' : 'failed';
      }
      return result;
    } catch (error) {
      logBackgroundSyncWarning('Mobile background sync crashed', error);
      return 'failed';
    } finally {
      ports.sync.setRequestDeadline(null);
      // This runs in a headless process that is destroyed the moment the task
      // promise settles; deferred storage work must land before that, not after.
      // It gets its own short deadline for the same reason as the sync above.
      await quiesceWithinDeadline();
      // Written here for the same reason as the quiesce above: the headless
      // process is destroyed as soon as this promise settles.
      await recordBackgroundSyncOutcome(run.outcome === 'success', failureState);
      const elapsedMs = now() - startedAt;
      const extra = { outcome: run.outcome, elapsedMs: String(elapsedMs) };
      if (elapsedMs >= MOBILE_BACKGROUND_SYNC_SLOW_RUN_MS) {
        void ports.log.warn('Mobile background sync run took longer than a minute', { scope: 'sync', force: true, extra });
      } else {
        void ports.log.info('Mobile background sync finished', { scope: 'sync', extra });
      }
    }
  };

  // The platform scheduler can deliver every queued event it has accumulated at once (three
  // arrived in the same millisecond on device), and the sync service has no re-entrancy guard
  // of its own. Overlapping runs raced each other's snapshots and widened the teardown window
  // above, so they share one run.
  let inFlightBackgroundSync: Promise<MobileBackgroundSyncOutcome> | null = null;

  const runSharedBackgroundSync = (trigger: MobileBackgroundSyncTrigger): Promise<MobileBackgroundSyncOutcome> => {
    if (!inFlightBackgroundSync) {
      inFlightBackgroundSync = runMobileBackgroundSync(trigger).finally(() => {
        inFlightBackgroundSync = null;
      });
    }
    return inFlightBackgroundSync;
  };

  return {
    /** Runs one background sync, or joins the one already running. */
    run: runSharedBackgroundSync,
    /** A second Save during a run waits for it, then imports and sends its own capture. */
    runCapture: async (): Promise<void> => {
      if (inFlightBackgroundSync) await inFlightBackgroundSync.catch(() => undefined);
      await runSharedBackgroundSync('capture');
    },
    /** The running background sync, so a scheduler change can wait it out. */
    getInFlightRun: (): Promise<MobileBackgroundSyncOutcome> | null => inFlightBackgroundSync,
  };
};

export type MobileBackgroundSyncRunner = ReturnType<typeof createMobileBackgroundSyncRunner>;
