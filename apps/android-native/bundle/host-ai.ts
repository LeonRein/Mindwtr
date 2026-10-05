import { logInfo, logWarn, type NativeAIHost } from '@mindwtr/core';

/** RN's AsyncStorage in place (host-entry.ts keyValue, over RnKeyValue.kt): a write is on disk when it resolves. */
type KeyValue = {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
};

/** host-polyfills.js's secret calls (SecretStore.kt: RN's SecureStore items in the Keystore). */
type Secrets = {
    getSecret(key: string): Promise<string | null>;
    setSecret(key: string, value: string): Promise<void>;
    deleteSecret(key: string): Promise<void>;
};

/**
 * Core's AI device (createNativeHostContract's `ai`, native-host-contract-ai.ts) on an Android host with RN's stores: the
 * consent record (`mindwtr-ai-provider-consent-v1`) and a legacy plain key in RN's AsyncStorage, the keys in RN's SecureStore
 * under `mindwtr-ai-key_<provider>` (core's createAIKeyStore names them), so an upgrade from RN and the RN recovery build see
 * the same ones. The providers use the polyfill's fetch, which logs no URL (Gemini's model list puts the key in the query).
 * Core passes no key to the log. No offline Whisper model files until the Whisper pass (D4).
 */
export const createNativeAI = (keyValue: KeyValue, secrets: () => Secrets, isFossBuild: boolean): NativeAIHost => ({
    // The build's flavor (D8): a FOSS build defaults speech to offline Whisper and refuses cloud speech, as RN's.
    platform: { isFossBuild },
    storage: {
        getItem: (key) => keyValue.get(key),
        setItem: (key, value) => keyValue.set(key, value),
        removeItem: (key) => keyValue.remove(key),
    },
    secrets: {
        get: (key) => secrets().getSecret(key),
        set: (key, value) => secrets().setSecret(key, value),
        delete: (key) => secrets().deleteSecret(key),
    },
    log: {
        warn: (message) => { try { logWarn(message, { scope: 'ai' }); } catch { /* a diagnostic line must never fail its caller */ } },
        info: (message, context) => { try { logInfo(message, { scope: context.scope, context: context.extra }); } catch { /* as above */ } },
    },
});
