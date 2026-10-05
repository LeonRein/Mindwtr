import { afterEach, describe, expect, it } from 'bun:test';
import {
    BACKGROUND_SYNC_FAILURE_STATE_KEY,
    SYNC_BACKEND_KEY,
    WEBDAV_URL_KEY,
    setLogger,
} from '@mindwtr/core';
import { createDeadlineFetch, createNativeSync } from './host-sync';

// The native app's background sync binding (S4a): core's runner and schedule decision on the host's ports.
const globals = globalThis as unknown as Record<string, unknown>;
const realFetch = globalThis.fetch;

const host = (stored: Record<string, string> = {}, refuseSchedule = false) => {
    const kv = new Map(Object.entries(stored));
    const schedules: boolean[] = [];
    const lines: string[] = [];
    const traces: string[] = [];
    const sync = createNativeSync({
        keyValue: {
            get: async (key) => kv.get(key) ?? null,
            set: async (key, value) => { kv.set(key, value); },
            remove: async (key) => { kv.delete(key); },
            multiGet: async (keys) => keys.map((key) => [key, kv.get(key) ?? null] as [string, string | null]),
            multiSet: async (pairs) => { for (const [key, value] of pairs) kv.set(key, value); },
        },
        secrets: { getSecret: async () => null, setSecret: async () => undefined, deleteSecret: async () => undefined },
        localData: () => ({ getData: async () => { throw new Error('no local data in this test'); }, saveData: async () => undefined }),
        networkState: () => ({ isConnected: true, isInternetReachable: true }),
        appendLog: async (entry) => { lines.push(entry.message); return null; },
        translate: (key) => key,
        emit: () => undefined,
        trace: (line) => { traces.push(line); },
        scheduleBackgroundSync: (on) => {
            if (refuseSchedule) throw new Error('WorkManager did not store the work');
            schedules.push(on);
        },
        isFossBuild: false,
    });
    return { sync, kv, schedules, lines, traces };
};

const fetches: string[] = [];
/** A server that refuses the password: a failure core does not retry, so a cycle fails at once. */
const failingFetch = (async (input: RequestInfo | URL) => {
    fetches.push(String(input));
    return new Response('', { status: 401, statusText: 'Unauthorized' });
}) as typeof fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
    fetches.length = 0;
    delete globals.__mindwtrCryptoCall;
    setLogger(null);
});

describe('native background sync binding', () => {
    it('schedules the background job only for a configured WebDAV or cloud backend (core\'s decision)', async () => {
        const off = host();
        await off.sync.settingsHost.reconcileBackgroundSync();
        expect(off.schedules).toEqual([false]);
        const webdav = host({ [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: 'http://127.0.0.1:1/dav' });
        await webdav.sync.settingsHost.reconcileBackgroundSync();
        expect(webdav.schedules).toEqual([true]);
        const file = host({ [SYNC_BACKEND_KEY]: 'file', '@mindwtr_sync_path': 'content://folder' });
        await file.sync.settingsHost.reconcileBackgroundSync();
        expect(file.schedules).toEqual([false]);
    });

    // Review S4a 4: the schedule is reported only once WorkManager stored it; a refusal reaches the caller (and is retried at the
    // next start, resume or leave, which reconcile again).
    it('reports the job scheduled only once the host stored it; a refusal fails the reconcile', async () => {
        const { sync, traces } = host({ [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: 'http://127.0.0.1:1/dav' }, true);
        await expect(sync.settingsHost.reconcileBackgroundSync()).rejects.toThrow('WorkManager did not store the work');
        expect(traces.filter((line) => line.startsWith('Native Android background sync schedule'))).toEqual([]);
        const stored = host({ [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: 'http://127.0.0.1:1/dav' });
        await stored.sync.settingsHost.reconcileBackgroundSync();
        expect(stored.traces).toContain('Native Android background sync schedule=on');
    });

    it('a capture run with nothing imported sends nothing; one with an import syncs and records its failure', async () => {
        globalThis.fetch = failingFetch;
        const { sync, kv } = host({ [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: 'http://127.0.0.1:1/dav' });
        expect(await sync.backgroundSync('capture', 0)).toEqual({ schedule: true });
        expect(kv.has(BACKGROUND_SYNC_FAILURE_STATE_KEY)).toBe(false);
        await sync.backgroundSync('capture', 1);
        expect(JSON.parse(kv.get(BACKGROUND_SYNC_FAILURE_STATE_KEY)!).consecutiveFailures).toBe(1);
    });

    it('a scheduled run inside the failure cooldown is skipped and fetches nothing', async () => {
        globalThis.fetch = failingFetch;
        const { sync, lines } = host({
            [SYNC_BACKEND_KEY]: 'webdav',
            [WEBDAV_URL_KEY]: 'http://127.0.0.1:1/dav',
            [BACKGROUND_SYNC_FAILURE_STATE_KEY]: JSON.stringify({ lastFailureAt: Date.now(), consecutiveFailures: 1 }),
        });
        expect(await sync.backgroundSync('scheduled', 0)).toEqual({ schedule: true });
        expect(fetches).toEqual([]);
        expect(lines).toContain('Mobile background sync skipped during failure cooldown');
    });

    it('answers schedule false once sync is off, so the running job does not queue its next run', async () => {
        const { sync } = host();
        expect(await sync.backgroundSync('scheduled', 0)).toEqual({ schedule: false });
    });

    it('refuses a sync request that would start past the run\'s deadline (RN\'s setMobileSyncRequestDeadline)', async () => {
        const deadline = createDeadlineFetch(failingFetch);
        expect((await deadline.fetch('http://a/1')).status).toBe(401);
        deadline.setDeadline(Date.now() - 1);
        await expect(deadline.fetch('http://a/2')).rejects.toMatchObject({ name: 'AbortError' });
        deadline.setDeadline(null);
        expect((await deadline.fetch('http://a/3')).status).toBe(401);
        expect(fetches).toEqual(['http://a/1', 'http://a/3']);
    });

    // About 35 s: the aborted cycle's WebDAV read retries (core's backoff) before it ends; none of them is sent (the signal is
    // aborted, so the host's fetch refuses each before it starts).
    it('a run abandoned at its deadline ends its cycle with no follow-up: the job, not a timer, retries it (review S4a 1)', async () => {
        const sent: string[] = [];
        globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) => {
            const cancelled = () => reject(Object.assign(new Error('Request cancelled'), { name: 'AbortError' }));
            if (init?.signal?.aborted) return cancelled();
            sent.push(String(input));
            init?.signal?.addEventListener('abort', cancelled);
        })) as typeof fetch;
        const { sync, kv, lines } = host({ [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: 'http://127.0.0.1:1/dav' });
        await sync.backgroundSync('scheduled', 0, 50);
        expect(lines).toContain('Mobile background sync did not finish before its deadline and was abandoned');
        expect(JSON.parse(kv.get(BACKGROUND_SYNC_FAILURE_STATE_KEY)!).consecutiveFailures).toBe(1);
        for (let waited = 0; waited < 50_000 && !lines.includes('Sync aborted at the background run\'s deadline'); waited += 500) {
            await new Promise((done) => setTimeout(done, 500));
        }
        expect(lines).toContain('Sync aborted at the background run\'s deadline');
        await new Promise((done) => setTimeout(done, 1_000));
        expect(lines).not.toContain('Sync follow-up scheduled');
        expect(sent).toHaveLength(1);
    }, 60_000);
});
