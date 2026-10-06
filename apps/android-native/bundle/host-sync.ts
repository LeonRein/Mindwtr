/**
 * Sync on the Android host: core's mobile sync service, its automatic triggers and Settings › Sync's device, bound to this
 * host's ports as React Native's lib/sync-service.ts, the root layout's sync effects and the Sync screen bind them. Every rule
 * is core's (mobile-sync-service.ts, mobile-sync-triggers.ts, native-host-contract-settings-sync.ts); this file only binds:
 *
 * - RN's device keys in RN's AsyncStorage (RKStorage, in place) and RN's secret store (expo-secure-store's format);
 * - the fetch bridge, the device's network state, the app log;
 * - the local snapshot (the boot's validated SQLite adapter).
 *
 * - the attachment passes and the editor's attachment IO (host-attachments.ts), on the host's app-private files.
 *
 * - sync encryption: core's cipher on the host's crypto calls (HostCrypto.kt: Argon2id and AES-GCM off the engine thread),
 *   and core's encryption transitions (sync-encryption-service.ts) as RN's lib/sync-encryption-service.ts binds them, with
 *   RN's WebDAV XML parser (@xmldom/xmldom).
 *
 * Not on this host yet, and refused the way core refuses an unbound port: Dropbox (S4), File Sync's folder (S5) and the
 * background job (S4). The fence owner stays `mindwtr-mobile` and the device keys keep RN's names,
 * so an upgraded RN user's configuration and deviceId carry over.
 */
import { DOMParser } from '@xmldom/xmldom';
import { createNativeAttachments, nativeFileChannels } from './host-attachments';
import {
    SETTINGS_SYNC_BADGE_COLORS,
    SYNC_BACKEND_KEY,
    SyncCryptoAuthError,
    buildDiagnosticsErrorEntry,
    buildDiagnosticsLogEntry,
    classifySyncFailure,
    coerceSupportedBackend,
    createMobileSyncService,
    createMobileSyncTriggers,
    createSecureSyncConfigStore,
    createSyncEncryptionService,
    createSyncEncryptionStateStore,
    createSyncSecretVault,
    createWebdavCapabilityProofStore,
    flushPendingSave,
    generateUUID,
    getInMemorySyncChangeFingerprint,
    getMobileWebDavRequestOptions,
    isLikelyOfflineSyncError,
    loadWebDavSyncConfig,
    nameNotifyListener,
    normalizeExternalCalendarColor,
    readSyncLocationScope,
    resolveBackend,
    resolveSyncBadgeState,
    sanitizeLogMessage,
    useTaskStore,
    type AppData,
    type DiagnosticsLogEntry,
    type MobileSyncNetworkState,
    type MobileSyncTriggers,
    type NativeSyncSettingsHost,
    type SyncBadgeState,
    type SyncCryptoPrimitives,
    type SyncSecretStoragePort,
    type SyncSecretAccessibility,
} from '@mindwtr/core';

/** host-entry.ts's AsyncStorage over RnKeyValue.kt. */
export type HostKeyValue = {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
    multiGet(keys: readonly string[]): Promise<[string, string | null][]>;
    multiSet(pairs: readonly (readonly [string, string])[]): Promise<void>;
};

export type NativeSyncBindings = {
    keyValue: HostKeyValue;
    /** host-polyfills.js's secret calls (SecretStore.kt, expo-secure-store's format). */
    secrets: { getSecret(key: string): Promise<string | null>; setSecret(key: string, value: string, accessibility?: SyncSecretAccessibility): Promise<void>; deleteSecret(key: string): Promise<void> };
    /** The boot's validated SQLite adapter: the local snapshot a cycle reads and saves. */
    localData: () => { getData(): Promise<AppData>; saveData(data: AppData): Promise<void> };
    /** The device's network state now (HostNetwork.kt), as expo-network reads it. */
    networkState: () => MobileSyncNetworkState;
    /** RN's diagnostics log line (app-log.ts appendLogLine): the file's path once written. */
    appendLog: (entry: DiagnosticsLogEntry, force?: boolean) => Promise<string | null>;
    /** Core's words in the language core chose. */
    translate: (key: string) => string;
    /** An event for Kotlin (CoreHost's hostEvent): never a secret, a URL or task text. */
    emit: (event: Record<string, unknown>) => void;
    /** A logcat line (the device checks read the badge's changes there). */
    trace: (line: string) => void;
};

/** host-polyfills.js's sync crypto call (HostCrypto.kt); absent where the host has no crypto (the gates' stand-in). */
type HostCryptoCall = (request: Record<string, unknown>) => Promise<Uint8Array>;

const unavailableCipher = (): never => {
    throw new Error('Sync encryption is not available on this build yet');
};

/**
 * Core's SyncCryptoPrimitives on the host's crypto calls, as RN's sync-crypto-native.ts gives them: Argon2id and AES-GCM off the
 * engine thread, a tag or AAD mismatch as core's own SyncCryptoAuthError (core tells it apart with instanceof), and random bytes
 * from the host's SecureRandom. Without the calls, every primitive refuses: a device whose state says `enabled` then fails
 * closed and never writes plaintext beside ciphertext.
 */
export const createHostSyncCrypto = (call: HostCryptoCall | undefined): SyncCryptoPrimitives => {
    if (!call) {
        return { argon2id: async () => unavailableCipher(), aesGcmSeal: async () => unavailableCipher(), aesGcmOpen: async () => unavailableCipher(), randomBytes: () => unavailableCipher() };
    }
    return {
        argon2id: (pass, salt, params, dkLen) => call({ op: 'argon2id', pass, salt, m: params.mKib, t: params.t, p: params.p, dkLen }),
        aesGcmSeal: (key, nonce, plaintext, aad) => call({ op: 'aesGcmSeal', key, nonce, data: plaintext, aad }),
        aesGcmOpen: async (key, nonce, ctAndTag, aad) => {
            try {
                return await call({ op: 'aesGcmOpen', key, nonce, data: ctAndTag, aad });
            } catch (error) {
                if ((error as { code?: unknown } | null)?.code === 'auth') throw new SyncCryptoAuthError();
                throw error;
            }
        },
        randomBytes: (n) => {
            const bytes = new Uint8Array(n);
            globalThis.crypto.getRandomValues(bytes);
            return bytes;
        },
    };
};

/** RN's key for the device's calendar feeds (lib/external-calendar.ts EXTERNAL_CALENDARS_KEY). */
const EXTERNAL_CALENDARS_KEY = 'mindwtr-external-calendars';

type ExternalCalendar = NonNullable<AppData['settings']['externalCalendars']>[number];

const unavailable = (what: string) => async (): Promise<never> => {
    throw new Error(`${what} is not available on this build yet`);
};

export const createNativeSync = (bindings: NativeSyncBindings) => {
    const { keyValue } = bindings;
    const storage = {
        getItem: (key: string) => keyValue.get(key),
        setItem: (key: string, value: string) => keyValue.set(key, value),
        removeItem: (key: string) => keyValue.remove(key),
    };

    // RN's app-log.ts lines: logInfo, logWarn, logError, logSyncError.
    const logLine = (level: 'info' | 'warn', message: string, context?: { scope?: string; extra?: Record<string, unknown>; force?: boolean }) =>
        bindings.appendLog(buildDiagnosticsLogEntry(level, message, context), context?.force).catch(() => null);
    const logError = (error: unknown, context: { scope: string; url?: string; extra?: Record<string, unknown> }) =>
        bindings.appendLog(buildDiagnosticsErrorEntry(error, context)).catch(() => null);

    // RN's secure-secret-store.ts: expo-secure-store as core's keystore port (Android keeps one accessibility class).
    const secretStorage: SyncSecretStoragePort = {
        isAvailable: async () => true,
        getItem: (key) => bindings.secrets.getSecret(key),
        setItem: (key, value, accessibility) => globalThis.__mindwtrHostPlatform === 'ios'
            ? bindings.secrets.setSecret(key, value, accessibility)
            : bindings.secrets.setSecret(key, value),
        deleteItem: (key) => bindings.secrets.deleteSecret(key),
    };
    const secureConfig = createSecureSyncConfigStore({ storage, secrets: secretStorage, vault: createSyncSecretVault(secretStorage) });
    const encryptionState = createSyncEncryptionStateStore({
        storage,
        secureConfig,
        readActiveScope: () => readSyncLocationScope(storage),
        log: { info: (message, context) => logLine('info', message, context), warn: (message, context) => logLine('warn', message, context) },
    });
    const capabilityProof = createWebdavCapabilityProofStore(storage);

    const crypto = createHostSyncCrypto((globalThis as { __mindwtrCryptoCall?: HostCryptoCall }).__mindwtrCryptoCall);

    // Core's encryption transitions (enable, change, disable, unlock), as RN's lib/sync-encryption-service.ts binds them. They
    // run on core's serialized sync queue, so a transition and a cycle never interleave. Dropbox and File Sync come later.
    const transitions = createSyncEncryptionService<never>({
        storage: { getItem: (key) => keyValue.get(key) },
        state: encryptionState,
        crypto,
        fetch: (input, init) => fetch(input, init),
        parseWebdavXml: (source) => {
            const errors: string[] = [];
            const document = new DOMParser({
                errorHandler: (level, message) => errors.push(`${level}: ${String(message)}`),
            }).parseFromString(source, 'application/xml') as unknown as Document;
            return { document, errors };
        },
        loadWebDavConfig: () => loadWebDavSyncConfig(storage, (key) => secureConfig.getSecureConfigValue(key)),
        webDavRequestOptions: (allowInsecureHttp) => getMobileWebDavRequestOptions(allowInsecureHttp),
        getDropboxClientId: async () => '',
        runDropboxAuthorized: unavailable('Dropbox'),
    });

    const networkListeners = new Set<(state: MobileSyncNetworkState) => void>();

    // Attachments (host-attachments.ts) on the host's files, with sync's own stores, keystore, log and encryption state.
    const channels = nativeFileChannels();
    const attachments = channels ? createNativeAttachments({
        storage,
        getSecureConfigValue: (key) => secureConfig.getSecureConfigValue(key),
        log: {
            info: (message, context) => logLine('info', message, context),
            warn: (message, context) => logLine('warn', message, context),
            sanitize: (message) => sanitizeLogMessage(message),
        },
        crypto,
        encryption: {
            logSyncEncryptionEvent: (event, extra, options) => encryptionState.logSyncEncryptionEvent(event, extra, options),
            getSyncEncryptionMaterial: () => encryptionState.getSyncEncryptionMaterial(),
        },
    }, channels) : null;

    const service = createMobileSyncService<never>({
        storage,
        getSecureConfigValue: (key) => secureConfig.getSecureConfigValue(key),
        platform: { os: () => 'android', isFossBuild: false, dropboxAppKey: () => '' },
        network: {
            getState: async () => bindings.networkState(),
            subscribe: (listener) => {
                networkListeners.add(listener);
                return { remove: () => { networkListeners.delete(listener); } };
            },
        },
        localData: { getData: () => bindings.localData().getData(), saveData: (data) => bindings.localData().saveData(data) },
        log: {
            info: (message, context) => logLine('info', message, context),
            warn: (message, context) => logLine('warn', message, context),
            syncError: (error, context) => logError(error, { scope: 'sync', url: context.url, extra: { backend: context.backend, step: context.step } }),
            sanitize: (message) => sanitizeLogMessage(message),
        },
        // RN's lib/external-calendar.ts getExternalCalendars and saveExternalCalendars, on its key.
        externalCalendars: {
            load: async () => {
                let parsed: ExternalCalendar[] = [];
                try {
                    const raw = await keyValue.get(EXTERNAL_CALENDARS_KEY);
                    parsed = raw ? JSON.parse(raw) as ExternalCalendar[] : [];
                } catch {
                    parsed = [];
                }
                return (Array.isArray(parsed) ? parsed : [])
                    .filter((c) => c && typeof c.url === 'string')
                    .map((c) => ({
                        id: c.id || generateUUID(),
                        name: (c.name || 'Calendar').trim() || 'Calendar',
                        url: c.url.trim(),
                        enabled: c.enabled !== false,
                        color: normalizeExternalCalendarColor(c.color),
                        ...(Array.isArray(c.areaIds) ? { areaIds: c.areaIds } : {}),
                    }))
                    .filter((c) => c.url.length > 0);
            },
            save: async (calendars) => {
                const sanitized = calendars
                    .map((c) => ({
                        id: c.id || generateUUID(),
                        name: (c.name || 'Calendar').trim() || 'Calendar',
                        url: (c.url || '').trim(),
                        enabled: c.enabled !== false,
                        color: normalizeExternalCalendarColor(c.color),
                        ...(Array.isArray(c.areaIds) ? { areaIds: c.areaIds } : {}),
                    }))
                    .filter((c) => c.url.length > 0);
                await keyValue.set(EXTERNAL_CALENDARS_KEY, JSON.stringify(sanitized));
            },
        },
        fetch: (input, init) => fetch(input, init),
        crypto,
        encryption: {
            flushSyncEncryptionLocalState: () => encryptionState.flushSyncEncryptionLocalState(),
            getSyncEncryptionStatus: () => encryptionState.getSyncEncryptionStatus(),
            getSyncEncryptionMaterial: () => encryptionState.getSyncEncryptionMaterial(),
            isSyncEncryptionBlocked: (scope) => encryptionState.isSyncEncryptionBlocked(scope),
            isSyncEncryptionPostureUnestablished: (scope, completed) => encryptionState.isSyncEncryptionPostureUnestablished(scope, completed),
            loadSyncEncryptionLocalState: () => encryptionState.loadSyncEncryptionLocalState(),
            logSyncEncryptionEvent: (event, extra, options) => encryptionState.logSyncEncryptionEvent(event, extra, options),
            syncEncryptionLocalState: encryptionState.syncEncryptionLocalState,
            // A WebDAV attachment pass with no key first asks whether the location holds ciphertext (core's rule).
            probeLocationCiphertext: (target) => transitions.probeSyncLocationCiphertext(target),
        },
        ensureWebdavCapabilityProof: (config, probe, options) => capabilityProof.ensureWebdavCapabilityProof(config, probe, options),
        dropboxAuth: {
            isConnected: async () => false,
            getValidAccessToken: unavailable('Dropbox'),
            forceRefreshAccessToken: unavailable('Dropbox'),
            getValidAccessTokenForTokens: unavailable('Dropbox'),
            forceRefreshAccessTokenForTokens: unavailable('Dropbox'),
        },
        fileSync: {
            readVersioned: unavailable('File sync'),
            write: unavailable('File sync'),
            resolveUri: unavailable('File sync'),
            isBookmarksAvailable: () => false,
            resolveBookmark: async () => null,
            acquireLease: unavailable('File sync'),
            revalidateLease: unavailable('File sync'),
            releaseLease: async () => undefined,
        },
        // Core's attachment passes on the host's files; a host without app files (the gates' stand-in) syncs metadata only.
        attachments: attachments?.syncPort ?? {
            syncWebdav: async () => null,
            syncCloud: async () => null,
            syncDropbox: async () => null,
            syncFile: async () => null,
            cleanupTempFiles: async () => undefined,
            hasCompletedPresenceReconciliation: async () => false,
            hasPendingWork: async () => false,
            runCleanup: async ({ appData }) => ({ appData, shouldInvalidateFastSyncState: false }),
        },
    });

    // ---- What Kotlin draws: the Menu tab's dot and the Settings row's badge, and when a cycle ended ----

    let configured = false;
    let cycles = 0;
    let lastEvent = '';
    const badge = (): SyncBadgeState => {
        const settings = useTaskStore.getState().settings;
        return resolveSyncBadgeState({
            configured,
            activityState: service.getMobileSyncActivityState(),
            pendingRemoteWriteAt: settings.pendingRemoteWriteAt,
            lastSyncStatus: settings.lastSyncStatus,
            lastSyncAt: settings.lastSyncAt,
        });
    };
    const state = () => {
        const current = badge();
        return { type: 'sync', badge: current, color: current === 'hidden' ? null : SETTINGS_SYNC_BADGE_COLORS[current], cycles };
    };
    const emitState = () => {
        const event = state();
        const text = JSON.stringify(event);
        if (text === lastEvent) return;
        lastEvent = text;
        bindings.trace(`Native Android sync state badge=${event.badge} cycles=${event.cycles}`);
        bindings.emit(event);
    };
    /** RN's useMobileSyncBadge reads the configuration again on every screen change and sync status change. */
    const refreshConfigured = async () => {
        try {
            configured = (await service.getMobileSyncConfigurationStatus()).configured;
        } catch {
            configured = false;
        }
        emitState();
    };

    /** Every cycle, automatic or from the Sync screen, goes through here, so Kotlin reads its lists again once one ends. */
    const performSync: NativeSyncSettingsHost['performSync'] = async (syncPathOverride, options) => {
        try {
            return await service.performMobileSync(syncPathOverride, options);
        } finally {
            cycles += 1;
            void refreshConfigured();
        }
    };

    // ---- Settings › Sync's device (native-host-contract-settings-sync.ts) ----

    const settingsHost: NativeSyncSettingsHost = {
        platform: { os: 'android', isFossBuild: false, dropboxAppKey: '' },
        storage: {
            multiGet: (keys) => keyValue.multiGet(keys),
            setItem: (key, value) => keyValue.set(key, value),
            multiSet: (entries) => keyValue.multiSet(entries),
            removeItem: (key) => keyValue.remove(key),
        },
        secrets: {
            get: (key) => secureConfig.getSecureConfigValue(key),
            set: (key, value) => secureConfig.setSecureConfigValue(key, value),
            delete: (key) => secureConfig.deleteSecureConfigValue(key),
        },
        performSync,
        clearSyncConfigCache: () => service.clearMobileSyncConfigCache(),
        // The background job comes with S4; the configuration changed, so the badge reads it again.
        reconcileBackgroundSync: async () => {
            void refreshConfigured();
            return { action: 'unchanged' };
        },
        rememberWebdavCapabilityProof: (config) => capabilityProof.rememberWebdavCapabilityProof(config),
        encryption: {
            getStatus: () => encryptionState.getSyncEncryptionStatus(),
            getIncompleteTransition: () => encryptionState.getIncompleteSyncEncryptionTransition(),
            transitions: {
                enable: (passphrase, options) => transitions.enableSyncEncryption(passphrase, options),
                change: (current, next, options) => transitions.changeSyncEncryptionPassphrase(current, next, options),
                disable: (options) => transitions.disableSyncEncryption(options),
                provide: (passphrase) => transitions.provideSyncEncryptionPassphrase(passphrase),
                decline: () => transitions.declineSyncEncryptionPassphrase(),
                abandon: () => transitions.abandonSyncEncryptionTransition(),
                recheck: () => transitions.recheckPartlyEncryptedLocation(),
                randomBytes: (length) => crypto.randomBytes(length),
            },
            isBackendPending: () => transitions.isSyncEncryptionBackendPending(),
        },
        log: {
            info: (message, context) => logLine('info', message, context),
            error: (error) => { void logError(error, { scope: 'settings' }); },
        },
    };

    // ---- Automatic sync: core's triggers, as RN's use-root-layout-sync-effects.ts binds them ----

    let triggers: MobileSyncTriggers | null = null;
    let online: boolean | null = null;

    /** RN's showSyncIssue: one warning toast for an automatic failure, with Open for Settings › Sync. */
    const showSyncIssue = (classification: string) => {
        const t = bindings.translate;
        const key = ({
            auth: 'settings.syncFailureAuth',
            permission: 'settings.syncFailurePermission',
            rateLimited: 'settings.syncFailureRateLimited',
            misconfigured: 'settings.syncFailureMisconfigured',
            conflict: 'settings.syncFailureConflict',
            encryptionState: 'settings.syncEncryptionStateUnavailable',
            encryption: 'settings.syncFailureEncryption',
            fileLockUnavailable: 'settings.syncFileLockUnavailable',
        } as Record<string, string>)[classification] ?? 'settings.syncFailureGeneric';
        bindings.emit({ type: 'toast', title: t('settings.syncBadgeWarning'), message: t(key), tone: 'warning', durationMs: 5200, action: t('common.open'), open: 'sync' });
    };

    return {
        settingsHost,
        /** The editor's and the project screen's attachment IO (core's NativeAttachmentsHost); null without app files. */
        attachmentsHost: attachments?.contractHost ?? null,
        /** The badge and cycle count now. */
        state,
        /**
         * After the boot's validated load and journal replay: the triggers start, and the app's first sync is asked for
         * (RN's startup requestSync(0)). [appState] is 'active' or 'background'.
         */
        start(appState: string) {
            if (triggers) return state();
            triggers = createMobileSyncTriggers({
                initialAppState: appState,
                performSync: () => {
                    bindings.trace('Native Android sync automatic cycle');
                    return performSync(undefined, {});
                },
                abortSync: () => service.abortMobileSync(),
                flushPendingSave: () => flushPendingSave(),
                reconcileBackgroundSync: () => { void refreshConfigured(); },
                readStoredBackend: () => keyValue.get(SYNC_BACKEND_KEY),
                resolveSupportedBackend: (raw) => coerceSupportedBackend(resolveBackend(raw), false),
                getSyncChangeFingerprint: () => getInMemorySyncChangeFingerprint(),
                isLikelyOfflineSyncError: (error) => isLikelyOfflineSyncError(error),
                classifySyncFailure: (error) => classifySyncFailure(error),
                reportError: (error) => { void logError(error, { scope: 'app' }); },
                logWarn: (message, context) => logLine('warn', message, context),
                showSyncIssue,
            });
            const active = triggers;
            active.start();
            useTaskStore.subscribe(nameNotifyListener('auto-sync-trigger', (current, previous) => {
                active.handleStoreChange(current, previous);
                const settings = current.settings;
                const before = previous.settings;
                if (settings?.lastSyncAt !== before?.lastSyncAt || settings?.lastSyncStatus !== before?.lastSyncStatus
                    || settings?.pendingRemoteWriteAt !== before?.pendingRemoteWriteAt) void refreshConfigured();
            }));
            service.subscribeMobileSyncActivityState(() => emitState());
            active.requestSync(0);
            void refreshConfigured();
            return state();
        },
        /** RN's AppState change ('active', 'background'). */
        appState(next: string) {
            triggers?.handleAppStateChange(next);
            return state();
        },
        /**
         * The device's network changed (expo-network's listener): a running cycle stops when it went offline. Coming back
         * online asks for an automatic sync through core's pacing (RN catches up in its background job, which comes with S4).
         */
        network(next: MobileSyncNetworkState) {
            for (const listener of Array.from(networkListeners)) {
                try { listener(next); } catch (error) { void logError(error, { scope: 'sync' }); }
            }
            const now = next.isConnected !== false && next.isInternetReachable !== false;
            if (online === false && now) triggers?.requestSync();
            online = now;
            return state();
        },
    };
};

export type NativeSync = ReturnType<typeof createNativeSync>;
