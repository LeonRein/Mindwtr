import type { NativeHostResult } from './native-host-contract';
import type { AppData, Project, Section, Task } from './types';
import type { PreparedAreaAuthority, PreparedNativeSaveBoundary } from './store-types';
import { exact, iso, record } from './native-host-contract-project-shared';
import { validSection } from './native-host-contract-project-section-rename';
import { validFrozenFocusDate } from './native-host-contract-task-focus';
import { historyRowLoadProjection } from './native-host-contract-task-checklist';
import { createAreaSaveGuard, readAreaDurableData } from './native-host-contract-area-durable';
import { createNativeRequestReceipts, NativeReceiptSqliteAdapter } from './native-request-receipts';
import { taskEditValuesEqual } from './json-value-equality';
import { buildEntityMap, ensureDeviceId } from './store-helpers';
import { referenceTasksTagEffect } from './native-host-contract-reference-bulk-tag';
import { getStorageAdapter, useTaskStore } from './store';
import { projectFocusDateValues, type FocusDateProjection } from './task-utils';
import { buildBulkTaskTokenUpdates } from './bulk-task-tokens';
import { logInfo } from './logger';
import { referenceBatchModules } from './store-reference-batch-modules';
import { detachReferenceBatchJson, detachReferenceBatchValue, readReferenceBatchSelectionRequest,
    rawReferenceBatchScope, referenceBatchSettingsReadable,
    requiredReferenceBatchDates, referenceBatchSourcesMatch, validReferenceBatchTask,
    validReferenceBatchProject, validReferenceBatchArea, relevantReferenceBatchSettings, referenceTasksMoveScope,
    type NativeReferenceTasksMoveParams, type NativeReferenceTasksMoveRequest,
    type NativeReferenceTasksMoveScope } from './native-host-contract-reference-bulk-status';

export type NativeReferenceTasksRemoveTagRequest = { requestId: string; taskIds: string[];
    taskRevisions: Record<string, string>; tags: string[]; params: NativeReferenceTasksMoveParams };
export type NativeReferenceTasksRemoveTagResult = { count: number; changed: true };
export type NativeReferenceTasksRemoveTagPrepared = {
    version: 1; request: NativeReferenceTasksRemoveTagRequest; scope: NativeReferenceTasksMoveScope;
    effect: { tasks: { before: Task; after: Task }[]; projects: { before: Project; after: Project }[];
        sections: { before: Section; after: Section }[] };
    deviceIdBefore: string | null; deviceIdToInitialize: string | null;
    updateAt: string; preparedLocalDay: string; preparedOffsetMinutes: number;
    boundaryOffsetMinutes: number; futureBoundary: string; dates: FocusDateProjection[];
    result: NativeReferenceTasksRemoveTagResult;
};
export type NativeReferenceTasksRemoveTagEnvelope = { request: NativeReferenceTasksRemoveTagRequest; prepared: NativeReferenceTasksRemoveTagPrepared };
export type NativeReferenceTasksRemoveTagPreparation = { kind: 'noop'; result: { count: 0; changed: false } }
    | { kind: 'prepared'; prepared: NativeReferenceTasksRemoveTagPrepared };

const same = taskEditValuesEqual;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= limit;
const unique = (rows: { id: string }[]) => new Set(rows.map((row) => row.id)).size === rows.length;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'TASK_NOT_FOUND' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const canonicalPayload = (value: unknown): string => JSON.stringify(value, (_name, item) => record(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const selectionRequest = (request: NativeReferenceTasksRemoveTagRequest): NativeReferenceTasksMoveRequest => ({
    requestId: request.requestId, taskIds: request.taskIds, taskRevisions: request.taskRevisions, params: request.params, status: 'next' });
const readRequest = (input: unknown): NativeReferenceTasksRemoveTagRequest | null => {
    const request = detachReferenceBatchJson<NativeReferenceTasksRemoveTagRequest>(input);
    return request && exact(request, ['requestId', 'taskIds', 'taskRevisions', 'tags', 'params'])
        && Array.isArray(request.tags) && request.tags.length > 0 && request.tags.length <= 10_000
        && request.tags.every((tag) => text(tag, 2_000_000)) && new Set(request.tags).size === request.tags.length
        && readReferenceBatchSelectionRequest(selectionRequest(request)) ? request : null;
};
export const referenceTasksRemoveTagScope = (request: NativeReferenceTasksRemoveTagRequest,
    data: Pick<AppData, 'tasks' | 'projects' | 'sections' | 'areas' | 'settings'>): NativeReferenceTasksMoveScope =>
    referenceTasksMoveScope(selectionRequest(request), data);
const tagUpdates = (request: NativeReferenceTasksRemoveTagRequest, scope: NativeReferenceTasksMoveScope, at: string) =>
    buildBulkTaskTokenUpdates(request.taskIds, buildEntityMap(scope.tasks.map((row) => historyRowLoadProjection(row, at))), 'tags', request.tags, 'remove');

/** Same RN planner as Add tag; only the shared token builder's operation differs. */
export const referenceTasksRemoveTagEffect = (prepared: Pick<NativeReferenceTasksRemoveTagPrepared,
    'request' | 'scope' | 'deviceIdBefore' | 'deviceIdToInitialize' | 'updateAt' | 'futureBoundary' | 'dates'>): NativeReferenceTasksRemoveTagPrepared['effect'] | null =>
    referenceTasksTagEffect(prepared, tagUpdates(prepared.request, prepared.scope, prepared.updateAt));
export const readReferenceTasksRemoveTagEnvelope = (input: unknown): NativeReferenceTasksRemoveTagEnvelope | null => {
    const envelope = detachReferenceBatchJson<Record<string, unknown>>(input);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readRequest(envelope.request); const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'request', 'scope', 'effect', 'deviceIdBefore', 'deviceIdToInitialize', 'updateAt',
        'preparedLocalDay', 'preparedOffsetMinutes', 'boundaryOffsetMinutes', 'futureBoundary', 'dates', 'result'])
        || raw.version !== 1 || !same(raw.request, request) || !record(raw.scope)
        || !exact(raw.scope, ['tasks', 'projects', 'sections', 'areas', 'settings'])
        || !Array.isArray(raw.scope.tasks) || !raw.scope.tasks.every(validReferenceBatchTask) || !unique(raw.scope.tasks)
        || !Array.isArray(raw.scope.projects) || !raw.scope.projects.every(validReferenceBatchProject) || !unique(raw.scope.projects)
        || !Array.isArray(raw.scope.sections) || !raw.scope.sections.every((row) => record(row) && text(row.id, 500)
            && text(row.projectId, 500) && validSection(row, row.id, row.projectId)) || !unique(raw.scope.sections)
        || !Array.isArray(raw.scope.areas) || !raw.scope.areas.every(validReferenceBatchArea) || !unique(raw.scope.areas)
        || !record(raw.scope.settings) || !same(relevantReferenceBatchSettings(raw.scope.settings), raw.scope.settings)
        || !record(raw.effect) || !exact(raw.effect, ['tasks', 'projects', 'sections'])
        || !Array.isArray(raw.effect.tasks) || !Array.isArray(raw.effect.projects) || !Array.isArray(raw.effect.sections)
        || (raw.deviceIdBefore !== null && !text(raw.deviceIdBefore, 500))
        || (raw.deviceIdBefore === null ? typeof raw.deviceIdToInitialize !== 'string' || !UUID.test(raw.deviceIdToInitialize) : raw.deviceIdToInitialize !== null)
        || !iso(raw.updateAt) || !iso(raw.futureBoundary) || typeof raw.preparedLocalDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.preparedLocalDay)
        || !Number.isInteger(raw.preparedOffsetMinutes) || Math.abs(raw.preparedOffsetMinutes as number) > 840
        || !Number.isInteger(raw.boundaryOffsetMinutes) || Math.abs(raw.boundaryOffsetMinutes as number) > 840
        || !Array.isArray(raw.dates) || !raw.dates.every(validFrozenFocusDate)
        || !record(raw.result) || !exact(raw.result, ['count', 'changed']) || raw.result.changed !== true
        || !Number.isInteger(raw.result.count) || (raw.result.count as number) < 1 || (raw.result.count as number) > request.taskIds.length) return null;
    try {
        const prepared = raw as unknown as NativeReferenceTasksRemoveTagPrepared;
        const expected = referenceTasksRemoveTagEffect(prepared);
        return referenceBatchSourcesMatch(selectionRequest(request), prepared.scope, prepared.updateAt)
            && (prepared.scope.settings.deviceId ?? null) === prepared.deviceIdBefore
            && same(referenceTasksRemoveTagScope(request, prepared.scope), prepared.scope)
            && new Date(Date.parse(prepared.updateAt) - prepared.preparedOffsetMinutes * 60_000).toISOString().slice(0, 10) === prepared.preparedLocalDay
            && new Date(Date.parse(`${prepared.preparedLocalDay}T23:59:59.999Z`) + prepared.boundaryOffsetMinutes * 60_000).toISOString() === prepared.futureBoundary
            && same(requiredReferenceBatchDates(prepared.scope), prepared.dates.map((row) => row.value))
            && expected && same(expected, prepared.effect) && prepared.result.count === tagUpdates(request, prepared.scope, prepared.updateAt).length
            && [...prepared.effect.tasks, ...prepared.effect.projects, ...prepared.effect.sections].every((pair) => record(pair) && exact(pair, ['before', 'after']))
            ? envelope as NativeReferenceTasksRemoveTagEnvelope : null;
    } catch { return null; }
};
export const referenceTasksRemoveTagAuthorityMatches = (prepared: NativeReferenceTasksRemoveTagPrepared, data: AppData): boolean => {
    const current = rawReferenceBatchScope(referenceTasksRemoveTagScope(prepared.request, data));
    return Boolean(current && same(current, prepared.scope) && referenceBatchSourcesMatch(selectionRequest(prepared.request), current, prepared.updateAt)
        && same(referenceTasksRemoveTagEffect({ ...prepared, scope: current }), prepared.effect));
};

export function createReferenceTasksRemoveTagMethods(deps: {
    readiness: () => NativeHostResult<null>; save: () => Promise<NativeHostResult<null>>;
}) {
    const guardedAdapter = (): NativeHostResult<null> => {
        const adapter = getStorageAdapter();
        return adapter instanceof NativeReceiptSqliteAdapter && adapter.concurrentWritesGuarded
            ? { ok: true, value: null } : fail('SAVE_FAILED', 'Reference Remove tag requires guarded canonical SQLite storage');
    };
    const checkForeignKeyAuthority = async (adapter: ReturnType<typeof getStorageAdapter>): Promise<NativeHostResult<null>> => {
        if (getStorageAdapter() !== adapter) return fail('STALE_REVISION', 'Reference Remove tag storage changed while reading');
        if (!(adapter instanceof NativeReceiptSqliteAdapter) || !adapter.concurrentWritesGuarded)
            return fail('SAVE_FAILED', 'Reference Remove tag requires guarded canonical SQLite storage');
        try {
            const invalid = await adapter.hasForeignKeyViolations();
            if (getStorageAdapter() !== adapter) return fail('STALE_REVISION', 'Reference Remove tag storage changed while reading');
            return invalid ? fail('SAVE_FAILED', 'Saved Reference data has invalid container references') : { ok: true, value: null };
        } catch { return fail('SAVE_FAILED', 'Saved Reference container references could not be checked'); }
    };
    const saves = createAreaSaveGuard(deps.save);
    let pending: { envelope: NativeReferenceTasksRemoveTagEnvelope; adapter: ReturnType<typeof getStorageAdapter>;
        boundary: PreparedNativeSaveBoundary | undefined } | null = null;
    const payload = (envelope: NativeReferenceTasksRemoveTagEnvelope) => canonicalPayload(['referenceTasksRemoveTag', envelope]);
    const checkAuthority = (envelope: NativeReferenceTasksRemoveTagEnvelope, authority: PreparedAreaAuthority): NativeHostResult<null> => {
        const guarded = guardedAdapter(); if (!guarded.ok) return guarded;
        if (!referenceBatchSettingsReadable(authority.snapshot.settings)) return fail('SAVE_FAILED', 'Saved Reference settings JSON is unreadable');
        const prepared = envelope.prepared; const current = rawReferenceBatchScope(referenceTasksRemoveTagScope(envelope.request, authority.snapshot));
        if (!current) return fail('SAVE_FAILED', 'Saved Reference raw JSON could not be bound safely');
        if (!same(current, prepared.scope) || !referenceBatchSourcesMatch(selectionRequest(envelope.request), current, prepared.updateAt))
            return fail('STALE_REVISION', 'Reference selection or its saved dependency context changed');
        try { return same(referenceTasksRemoveTagEffect({ ...prepared, scope: current }), prepared.effect)
            ? { ok: true, value: null } : fail('STALE_REVISION', 'Reference Remove tag rules changed since preparation'); }
        catch { return fail('STALE_REVISION', 'Reference Remove tag destination changed since preparation'); }
    };
    const apply = (envelope: NativeReferenceTasksRemoveTagEnvelope, authority: PreparedAreaAuthority) =>
        useTaskStore.getState().commitPreparedReferenceTasksRemoveTag(envelope.prepared, authority);
    const receipts = createNativeRequestReceipts({ save: async (requestId) => {
        const owned = pending;
        if (!owned || owned.envelope.request.requestId !== requestId) return fail('SAVE_FAILED', 'Reference Remove tag has no owned raw save');
        if (useTaskStore.getState().persistenceFailure) {
            if (!saves.mayApply(owned.envelope, owned.adapter)) return fail('SAVE_FAILED', 'Reference Remove tag has an unrelated persistence failure');
            const read = await readAreaDurableData(true, true); if (!read.ok) return read;
            if (read.value.adapter !== owned.adapter) return fail('STALE_REVISION', 'Reference Remove tag storage changed before retry');
            const foreignKeys = await checkForeignKeyAuthority(read.value.adapter); if (!foreignKeys.ok) return foreignKeys;
            const checked = checkAuthority(owned.envelope, read.value.authority); if (!checked.ok) return checked;
            const applied = await apply(owned.envelope, read.value.authority);
            if (!applied.success || applied.outcome !== 'applied') return fail('STALE_REVISION', applied.error ?? 'Reference Remove tag retry was superseded');
            owned.boundary = read.value.authority.saveBoundary;
        }
        const saved = await saves.finish(owned.envelope, owned.adapter, false, owned.boundary);
        if (saved.ok) pending = null;
        return saved;
    } });
    return {
        async prepareReferenceTasksRemoveTag(input: NativeReferenceTasksRemoveTagRequest): Promise<NativeHostResult<NativeReferenceTasksRemoveTagPreparation>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const guarded = guardedAdapter(); if (!guarded.ok) return guarded;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'Select saved Reference tasks with exact revisions, tag and list scope');
            const memory = useTaskStore.getState(); const now = new Date();
            if (!referenceBatchSourcesMatch(selectionRequest(request), { tasks: memory._allTasks, projects: memory._allProjects,
                sections: memory._allSections, areas: memory._allAreas, settings: memory.settings }, now.toISOString()))
                return fail('STALE_REVISION', 'Reference selection changed since it was shown');
            const read = await readAreaDurableData(false, true); if (!read.ok) return read;
            const foreignKeys = await checkForeignKeyAuthority(read.value.adapter); if (!foreignKeys.ok) return foreignKeys;
            const data = read.value.authority.snapshot;
            if (!referenceBatchSettingsReadable(data.settings)) return fail('SAVE_FAILED', 'Saved Reference settings JSON is unreadable');
            const scope = rawReferenceBatchScope(referenceTasksRemoveTagScope(request, data));
            if (!scope) return fail('SAVE_FAILED', 'Saved Reference raw JSON could not be bound safely');
            if (!referenceBatchSourcesMatch(selectionRequest(request), scope, now.toISOString())) return fail('STALE_REVISION', 'Saved Reference selection changed');
            if (!tagUpdates(request, scope, now.toISOString()).length) return { ok: true, value: { kind: 'noop', result: { count: 0, changed: false } } };
            const end = new Date(now); end.setHours(23, 59, 59, 999); const device = ensureDeviceId(scope.settings);
            const base = { version: 1 as const, request, scope, deviceIdBefore: scope.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null, updateAt: now.toISOString(),
                preparedLocalDay: new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10),
                preparedOffsetMinutes: now.getTimezoneOffset(), boundaryOffsetMinutes: end.getTimezoneOffset(), futureBoundary: end.toISOString(),
                dates: projectFocusDateValues(requiredReferenceBatchDates(scope)),
                result: { count: tagUpdates(request, scope, now.toISOString()).length, changed: true as const } };
            let effect;
            try {
                const fullScope = rawReferenceBatchScope({ tasks: data.tasks, projects: data.projects, sections: data.sections,
                    areas: data.areas, settings: relevantReferenceBatchSettings(data.settings) });
                if (!fullScope) return fail('SAVE_FAILED', 'Saved Reference raw JSON could not be bound safely');
                const first = referenceTasksRemoveTagEffect({ ...base, scope: fullScope, dates: projectFocusDateValues(requiredReferenceBatchDates(fullScope)) });
                effect = referenceTasksRemoveTagEffect(base);
                if (!same(first, effect)) effect = null;
            } catch { effect = null; }
            const prepared = effect && detachReferenceBatchValue<NativeReferenceTasksRemoveTagPrepared>({ ...base, effect });
            return prepared && readReferenceTasksRemoveTagEnvelope({ request, prepared }) ? { ok: true, value: { kind: 'prepared', prepared } }
                : fail('INVALID_INPUT', 'Reference Remove tag cannot prepare these rows or its journal is too large; select fewer tasks');
        },
        validatePreparedReferenceTasksRemoveTag(input: NativeReferenceTasksRemoveTagEnvelope): NativeHostResult<NativeReferenceTasksRemoveTagResult> {
            const envelope = readReferenceTasksRemoveTagEnvelope(input); return envelope ? { ok: true, value: envelope.prepared.result }
                : fail('INVALID_INPUT', 'Prepared Reference Remove tag is malformed');
        },
        referenceTasksRemoveTagOutcome(input: NativeReferenceTasksRemoveTagEnvelope): NativeHostResult<NativeReferenceTasksRemoveTagResult | null> {
            const envelope = readReferenceTasksRemoveTagEnvelope(input); return envelope
                ? receipts.saved<NativeReferenceTasksRemoveTagResult>(envelope.request.requestId, payload(envelope)) ?? { ok: true, value: null }
                : fail('INVALID_INPUT', 'Prepared Reference Remove tag is malformed');
        },
        async commitPreparedReferenceTasksRemoveTag(input: NativeReferenceTasksRemoveTagEnvelope): Promise<NativeHostResult<NativeReferenceTasksRemoveTagResult>> {
            const envelope = readReferenceTasksRemoveTagEnvelope(input); if (!envelope) return fail('INVALID_INPUT', 'Prepared Reference Remove tag is malformed');
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const guarded = guardedAdapter(); if (!guarded.ok) return guarded;
            const boundPayload = payload(envelope); const saved = receipts.saved<NativeReferenceTasksRemoveTagResult>(envelope.request.requestId, boundPayload);
            if (saved) return saved.ok && !same(saved.value, envelope.prepared.result)
                ? fail('INVALID_INPUT', 'Saved Reference Remove tag result does not match its journal') : saved;
            let prewriteFailure: NativeHostResult<never> | null = null;
            const notLanded = (message: string): NativeHostResult<never> => { prewriteFailure = fail('SAVE_FAILED', message);
                return { ok: false, error: { code: 'ACTION_FAILED', message } }; };
            const confirmed = await receipts.run(envelope.request.requestId, boundPayload, async () => {
                if (useTaskStore.getState().persistenceFailure) return notLanded('Reference Remove tag has an unresolved persistence failure');
                const read = await readAreaDurableData(false, true);
                if (!read.ok) return read.error.code === 'SAVE_FAILED' ? notLanded(read.error.message) : read;
                const foreignKeys = await checkForeignKeyAuthority(read.value.adapter);
                if (!foreignKeys.ok) return foreignKeys.error.code === 'SAVE_FAILED' ? notLanded(foreignKeys.error.message) : foreignKeys;
                const checked = checkAuthority(envelope, read.value.authority); if (!checked.ok) return checked;
                const applied = await apply(envelope, read.value.authority);
                if (!applied.success || applied.outcome !== 'applied') return fail('STALE_REVISION', applied.error ?? 'Reference Remove tag conflicts with saved data');
                pending = { envelope, adapter: read.value.adapter, boundary: read.value.authority.saveBoundary };
                return { ok: true, value: envelope.prepared.result };
            });
            if (prewriteFailure) return prewriteFailure;
            if (confirmed.ok && !same(confirmed.value, envelope.prepared.result)) return fail('INVALID_INPUT', 'Saved Reference Remove tag result does not match its journal');
            if (confirmed.ok) {
                try { logInfo('Native Reference bulk Remove tag confirmed', { scope: 'native-host', category: 'storage',
                    context: { releaseCheck: 'v1.3.4/ios-reference-bulk-remove-tag', count: confirmed.value.count, outcome: 'removed' } }); }
                catch { /* Diagnostics cannot invalidate a durable acknowledgment. */ }
            }
            return confirmed;
        },
    };
}

// The store's Reference removeTag action reads these here: it cannot import this module (store-reference-batch-modules.ts).
referenceBatchModules.shared = { historyRowLoadProjection, NativeReceiptSqliteAdapter };
referenceBatchModules.removeTag = (input) => {
    const prepared = input as NativeReferenceTasksRemoveTagPrepared;
    return {
        validateEnvelope: () => Boolean(readReferenceTasksRemoveTagEnvelope({ request: prepared.request, prepared })),
        authorityMatches: (data) => referenceTasksRemoveTagAuthorityMatches(prepared, data),
    };
};
