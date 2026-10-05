import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createNativeHostContract, type NativeHostResult } from './native-host-contract';
import { prepareNativeAttachmentDraftAddV3, prepareNativeAttachmentDraftRemoveV3, type NativeAttachmentDraftOperationV3 } from './native-attachment-draft';
import { ASSOCIATIONS, LIFECYCLE, RECURRENCE, SCHEDULE, getNativeTaskRecurrenceBase, getNativeTaskScheduleBase } from './native-host-contract-task-save';
import { createOwnedEditorCompleteTaskDraftSaveMethods, createOwnedEditorFileEditTaskDraftSaveMethods,
    type OwnedEditorCompleteSaveRequest, type OwnedEditorCompleteSaveEnvelope,
    type OwnedEditorCompleteCancellationUndoEnvelope } from './native-host-contract-owned-file-edit-save';
import { validateNativeTaskEditorSaveCheckpoint } from './native-task-editor-save-checkpoint';
import { createNativeRequestReceipts, NativeReceiptSqliteAdapter, resetNativeRequestReceipts } from './native-request-receipts';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { SqliteClient } from './sqlite-adapter';
import { createTaskDraft, type TaskDraft, type TaskDraftField } from './task-draft';
import { normalizeRecurrenceForLoad } from './recurrence';
import { normalizeTimeSpentMinutes } from './time-spent';
import { normalizeRelativeStartOffset } from './task-relative-start';
import { getTaskEditorDailyInterval } from './task-editor-model';
import { getTaskEditorRecurrenceInputValues, getTaskEditorRelativeStart, getTaskEditorTimeEstimate } from './task-editor-schedule';
import { toChecklist } from './native-host-contract-task-view';
import { taskEditValuesEqual } from './json-value-equality';
import type { AppData, Attachment, ChecklistItem, Task } from './types';

const require = createRequire(import.meta.url);
type Database = { exec: (sql: string) => void; prepare: (sql: string) => {
    run: (...params: unknown[]) => unknown; all: (...params: unknown[]) => unknown[];
}; close: () => void };
const DatabaseSync = (require('node:sqlite') as { DatabaseSync: new (path: string) => Database }).DatabaseSync;
const AT = '2026-10-05T10:00:00.000Z', ID = '99999999-1111-4111-8111-111111111111';
const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ROOT = 'file:///private/documents/attachments/';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const unwrap = <T>(result: NativeHostResult<T>): T => { if (!result.ok) throw new Error(JSON.stringify(result)); return result.value; };
const file: Attachment = { id: 'baseline-file', kind: 'file', title: 'Baseline', uri: ROOT + 'baseline.pdf', size: 3,
    createdAt: AT, updatedAt: AT, localStatus: 'available' };
const link: Attachment = { id: 'baseline-link', kind: 'link', title: 'Link', uri: 'https://example.test', createdAt: AT, updatedAt: AT };
const item = (id: string, title: string, isCompleted = false): ChecklistItem => ({ id, title, isCompleted });
const task = (extra: Partial<Task> = {}): Task => ({ id: 'complete', title: 'Saved task', status: 'next', taskMode: 'list', projectId: 'project',
    tags: [], contexts: [], checklist: [item('one', 'First'), item('two', 'Second')], description: 'Saved notes',
    attachments: [file, link, { ...file, id: 'old-tombstone', deletedAt: AT }], createdAt: AT, updatedAt: AT, rev: 8, revBy: 'before-device', ...extra });
const seed = (extra: Partial<Task> = {}, settings: AppData['settings'] = { deviceId: 'complete-save-device' }): AppData => ({
    tasks: [task(extra), task({ id: 'other', title: 'Other', tags: ['#legacy', '#legacy'], contexts: ['@legacy', '@legacy'] })],
    projects: [{ id: 'project', title: 'Project', status: 'active', color: '#000000', order: 0, createdAt: AT, updatedAt: AT }],
    sections: [], areas: [], people: [], settings });
const validateField = (field: TaskDraftField, value: unknown): boolean => {
    if (field === 'timeSpentMinutes') return value === undefined || typeof value === 'number' && Number.isFinite(value) && value >= 0;
    if (field === 'relativeStartOffset') return value === undefined || normalizeRelativeStartOffset(value) !== undefined;
    if (field === 'showFutureRecurrence' || field === 'focusedToday') return typeof value === 'boolean';
    return typeof value === 'string';
};
const root = join(process.cwd(), '../../.orchestrator/tmp'); mkdirSync(root, { recursive: true });
const directories: string[] = [], databases: Database[] = [], faults: Array<{ commits: number; after: number }> = [];
async function open(path: string, initial?: AppData) {
    await flushPendingSave(); resetForTests(); resetNativeRequestReceipts();
    const db = new DatabaseSync(path); databases.push(db);
    const fault = { commits: 0, after: 0 }; faults.push(fault); const writes = vi.fn();
    const client: SqliteClient = {
        run: async (sql, params = []) => {
            if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('fixed before commit'); }
            db.prepare(sql).run(...params);
            if (/^(INSERT|UPDATE|DELETE)/.test(sql)) writes(sql);
            if (sql === 'COMMIT' && fault.after > 0) { fault.after--; throw new Error('fixed lost acknowledgment'); }
        },
        all: async <T,>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params) as T[],
        get: async <T,>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params)[0] as T | undefined,
        exec: async (sql) => { db.exec(sql); },
    };
    if (initial) await new NativeReceiptSqliteAdapter(client).saveData(initial);
    const adapter = new NativeReceiptSqliteAdapter(client, { rejectConcurrentWrites: true }); setStorageAdapter(adapter);
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [], settings: {},
        error: null, persistenceFailure: null, isLoading: false, lastDataChangeAt: 0 } as never);
    const baseHost = createNativeHostContract(); unwrap(await baseHost.activate({ writeSafetyReady: true, recoveryLoad: true }));
    await flushPendingSave(); writes.mockClear();
    const control = { blocked: false };
    const deps = { readiness: (): NativeHostResult<null> => control.blocked
        ? { ok: false, error: { code: 'NOT_READY', message: 'fixed unavailable' } }
        : baseHost.getDataSettings().ok ? { ok: true, value: null } : { ok: false, error: { code: 'NOT_READY', message: 'fixed inactive' } },
    save: async (): Promise<NativeHostResult<null>> => {
        try { await flushPendingSave(); return useTaskStore.getState().persistenceFailure
            ? { ok: false, error: { code: 'SAVE_FAILED', message: 'fixed failed persistence' } } : { ok: true, value: null }; }
        catch { return { ok: false, error: { code: 'SAVE_FAILED', message: 'fixed failure' } }; }
    }, validateField, language: () => 'en', isReadOnly: () => false };
    const host = createOwnedEditorCompleteTaskDraftSaveMethods({ ...deps, receipts: createNativeRequestReceipts({ save: deps.save }) });
    return { db, host, baseHost, adapter, fault, writes, control, deps };
}
let env: Awaited<ReturnType<typeof open>>, path: string;
type RequestOptions = { events?: string[]; edits?: Partial<TaskDraft>; checklist?: ChecklistItem[]; intent?: 'cancel' | 'skip' };
async function request(options: RequestOptions = {}): Promise<OwnedEditorCompleteSaveRequest> {
    const raw = (await env.adapter.getData({ rawTasks: true })).tasks.find((row) => row.id === 'complete')!;
    const draft = createTaskDraft({ ...raw, recurrence: normalizeRecurrenceForLoad(raw.recurrence), timeSpentMinutes: normalizeTimeSpentMinutes(raw.timeSpentMinutes) });
    const edited: Record<string, unknown> = Object.fromEntries(Object.entries(options.edits ?? {}).map(([field, value]) => [field, value ?? null]));
    for (const group of [SCHEDULE, RECURRENCE, ASSOCIATIONS, LIFECYCLE]) if (group.some((field) => Object.hasOwn(edited, field)))
        for (const field of group) if (!Object.hasOwn(edited, field)) edited[field] = draft[field] ?? null;
    const touched = Object.keys(edited), touchedBase = Object.fromEntries(touched.map((field) => [field, draft[field as keyof TaskDraft] ?? null]));
    const current = { ...draft, ...edited } as TaskDraft;
    const scheduleOwned = SCHEDULE.some((field) => touched.includes(field)), recurrenceOwned = RECURRENCE.some((field) => touched.includes(field));
    const tokens = Object.fromEntries(['contexts', 'tags', 'assignedTo'].filter((field) => touched.includes(field)).map((field) => [field, edited[field]]));
    const relative = scheduleOwned ? getTaskEditorRelativeStart(current, (key) => key) : null;
    const recurrence = getTaskEditorRecurrenceInputValues(current, getTaskEditorDailyInterval(current.recurrence, current.recurrenceRRule));
    const estimate = touched.includes('timeEstimate') ? getTaskEditorTimeEstimate(current.timeEstimate, (key) => key).customText : '';
    const timeSpent = touched.includes('timeSpentMinutes') && current.timeSpentMinutes != null ? String(current.timeSpentMinutes) : '';
    const base = raw.attachments ?? [], checklistBase = toChecklist(raw.checklist), checklistValue = options.checklist ?? checklistBase;
    const initialPayloadJSON = JSON.stringify({ version: 2, taskID: raw.id, tab: 'task', touchedBase, edited,
        raw: { title: touched.includes('title') ? edited.title : '', note: touched.includes('description') ? edited.description : '',
            location: touched.includes('location') ? edited.location : '', estimate, estimateResolved: estimate, timeSpent, timeSpentResolved: timeSpent,
            tokens: clone(tokens), tokenCanonical: clone(tokens), tokenResolved: clone(tokens), tokenEdited: Object.keys(tokens),
            checklistInputs: {}, checklistAppend: '', relativeAmount: relative ? String(relative.amount) : '', relativeUnit: relative?.unit ?? '',
            relativeOwned: false, relativeCommitRequested: false, recurrenceInputs: recurrenceOwned ? { interval: String(recurrence.interval), count: String(recurrence.count) } : {},
            recurrenceOwned: [], recurrenceCommitRequested: [] }, scheduleEdits: [], scheduleFailedID: null,
        attachmentsOwned: true, attachmentsBase: base, attachments: base, linkSheet: {},
        ...(options.checklist ? { checklistBase, checklistValue } : {}), ...(scheduleOwned ? { scheduleBase: getNativeTaskScheduleBase(raw) } : {}),
        ...(recurrenceOwned ? { recurrenceBase: getNativeTaskRecurrenceBase({ ...raw, recurrence: normalizeRecurrenceForLoad(raw.recurrence) }) } : {}) });
    const priorOperations: NativeAttachmentDraftOperationV3[] = []; let beforePayloadJSON = initialPayloadJSON;
    for (const [index, event] of (options.events ?? ['add', 'baseline-file']).entries()) {
        const lineage = { version: 3 as const, taskID: raw.id, initialPayloadJSON, beforePayloadJSON, priorOperations, managedDirectoryURI: ROOT };
        const requestId = `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`;
        if (event === 'add') {
            const added = await prepareNativeAttachmentDraftAddV3({ ...lineage, requestId,
                picked: { uri: `file:///cache/${index}.pdf`, name: 'Report.pdf', mimeType: null, size: 3 }, measuredSize: 3 },
            { assertEditable: () => {}, t: (key) => key });
            if (added.kind !== 'prepared') throw new Error('Fixture Add refused');
            priorOperations.push({ kind: 'add', operation: added }); beforePayloadJSON = added.afterPayloadJSON;
        } else {
            const removed = prepareNativeAttachmentDraftRemoveV3({ ...lineage, requestId, attachmentId: event }, { assertEditable: () => {}, t: (key) => key });
            priorOperations.push({ kind: 'remove', operation: removed }); beforePayloadJSON = removed.afterPayloadJSON;
        }
    }
    const changed = new Set(touched.filter((field) => !taskEditValuesEqual(touchedBase[field], edited[field])));
    for (const group of [ASSOCIATIONS, RECURRENCE, LIFECYCLE]) if (group.some((field) => changed.has(field))) group.forEach((field) => changed.add(field));
    return clone({ version: 2, kind: 'owned-editor-file-edit-save', checkpoint: { version: 1, sessionID: SESSION, taskID: raw.id,
        generation: priorOperations.length + 1, payloadJSON: beforePayloadJSON }, ownedDraft: { version: 3, taskID: raw.id, initialPayloadJSON,
        beforePayloadJSON, priorOperations, managedDirectoryURI: ROOT }, saveRequest: { id: raw.id, requestId: ID,
        base: Object.fromEntries([...changed].map((field) => [field, touchedBase[field]])),
        patch: Object.fromEntries([...changed].map((field) => [field, edited[field]])), scheduleBase: getNativeTaskScheduleBase(raw),
        ...(RECURRENCE.some((field) => changed.has(field)) ? { recurrenceBase: getNativeTaskRecurrenceBase({ ...raw, recurrence: normalizeRecurrenceForLoad(raw.recurrence) }) } : {}),
        checklist: { base: checklistBase, value: checklistValue }, attachments: { base, value: JSON.parse(beforePayloadJSON).attachments },
        ...(options.intent ? { intent: options.intent } : {}) } }) as OwnedEditorCompleteSaveRequest;
}
async function plan(input?: OwnedEditorCompleteSaveRequest): Promise<OwnedEditorCompleteSaveEnvelope> {
    const selected = input ?? await request();
    const prepared = unwrap(await env.host.prepareOwnedEditorCompleteTaskDraftSave(selected)); return clone({ request: selected, prepared: prepared.prepared });
}
const rows = (table = 'tasks') => env.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
const rawTask = async () => (await env.adapter.getData({ rawTasks: true })).tasks.find((row) => row.id === 'complete')!;
const after = (envelope: OwnedEditorCompleteSaveEnvelope) => envelope.prepared.decision.kind === 'changed'
    ? envelope.prepared.decision.prepared.effect.tasks.find((row) => row.after.id === 'complete')!.after : envelope.prepared.decision.prepared.witness.source;
beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(AT);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const directory = mkdtempSync(join(root, 'owned-complete-')); directories.push(directory); path = join(directory, 'data.sqlite'); env = await open(path, seed());
});
afterEach(async () => {
    for (const fault of faults.splice(0)) { fault.commits = 0; fault.after = 0; }
    await flushPendingSave(); resetForTests(); resetNativeRequestReceipts(); vi.restoreAllMocks(); vi.useRealTimers();
    for (const db of databases.splice(0)) db.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('internal complete owned editor Save', () => {
    it('atomically saves checklist, ordinary fields and mixed files from raw data, retaining concurrent cloud metadata and unrelated cells', async () => {
        const input = await request({ edits: { title: 'Edited', description: 'Edited notes' }, checklist: [item('one', 'Changed', true), item('three', 'Third')] });
        const durable = await rawTask(); durable.attachments![1].cloudKey = 'retained-cloud';
        env.db.prepare('UPDATE tasks SET attachments = ? WHERE id = ?').run(JSON.stringify(durable.attachments), durable.id);
        const other = env.db.prepare('SELECT * FROM tasks WHERE id = ?').all('other');
        const envelope = await plan(input), validation = unwrap(env.host.validatePreparedOwnedEditorCompleteTaskDraftSave(envelope));
        expect(envelope.prepared.decision.kind).toBe('changed');
        expect(after(envelope).attachments?.find((attachment) => attachment.id === 'baseline-link')?.cloudKey).toBe('retained-cloud');
        expect(validation.settlementPlan.some((candidate) => candidate.attachment.id === 'baseline-file')).toBe(true);
        expect(unwrap(await env.host.commitPreparedOwnedEditorCompleteTaskDraftSave(envelope))).toEqual(validation.result);
        expect(await rawTask()).toMatchObject({ title: 'Edited', description: 'Edited notes', checklist: input.saveRequest.checklist.value });
        expect(env.db.prepare('SELECT * FROM tasks WHERE id = ?').all('other')).toEqual(other);
    });
    it('freezes recurring completion and every generated file reference across cold clock/zone replay', async () => {
        env = await open(path, seed({ dueDate: '2026-10-05', recurrence: { rule: 'daily', strategy: 'strict' } }));
        const envelope = await plan(await request({ edits: { status: 'done' }, checklist: [item('one', 'First', true), item('two', 'Second', true)] }));
        expect(envelope.prepared.decision.kind).toBe('changed'); if (envelope.prepared.decision.kind !== 'changed') throw new Error('Expected completion');
        const proof = envelope.prepared.decision.prepared, child = proof.effect.tasks.find((row) => row.after.id !== 'complete')!.after;
        expect(child.attachments?.some((attachment) => attachment.uri === file.uri && !attachment.deletedAt)).toBe(true);
        expect(proof.rawBefore.tasks.find((row) => row.id === child.id)?.before).toBeNull();
        unwrap(await env.host.commitPreparedOwnedEditorCompleteTaskDraftSave(envelope)); const saved = rows();
        env = await open(path); const oldZone = process.env.TZ;
        try { process.env.TZ = 'Pacific/Auckland'; vi.setSystemTime('2030-04-01T10:00:00.000Z');
            unwrap(env.host.validatePreparedOwnedEditorCompleteTaskDraftSave(envelope)); unwrap(await env.host.commitPreparedOwnedEditorCompleteTaskDraftSave(envelope));
        } finally { process.env.TZ = oldZone; }
        expect(rows()).toEqual(saved); expect((await env.adapter.getData({ rawTasks: true })).tasks.filter((row) => row.id === child.id)).toHaveLength(1);
    });
    it('saves backdated completion/time spent and Focus with the actual checklist policy', async () => {
        const envelope = await plan(await request({ edits: { status: 'done', completedAt: '2026-10-04T08:30:00.000Z', timeSpentMinutes: 12.5 }, checklist: [item('one', 'First', true)] }));
        expect(after(envelope)).toMatchObject({ status: 'done', completedAt: '2026-10-04T08:30:00.000Z', timeSpentMinutes: 12.5 });
        unwrap(await env.host.commitPreparedOwnedEditorCompleteTaskDraftSave(envelope));
        env = await open(path + '.focus', seed()); const focus = await plan(await request({ edits: { focusedToday: true } }));
        expect(after(focus).isFocusedToday).toBe(true); unwrap(await env.host.commitPreparedOwnedEditorCompleteTaskDraftSave(focus));
        expect((await rawTask()).isFocusedToday).toBe(true);
    });
    it('binds changed full schedule/recurrence groups and resolved raw inputs through the selected checkpoint', async () => {
        env = await open(path, seed({ dueDate: '2026-10-05', recurrence: { rule: 'daily', strategy: 'strict' } }));
        const input = await request({ edits: { dueDate: '2026-10-12', startTime: '2026-10-10', relativeStartOffset: { amount: -2, unit: 'day' },
            reviewAt: '2026-10-13', recurrence: 'weekly', recurrenceRRule: 'FREQ=WEEKLY', recurrenceStrategy: 'strict', showFutureRecurrence: true } });
        const payload = JSON.parse(input.checkpoint.payloadJSON);
        expect(payload.raw.relativeAmount).toBe('2'); expect(payload.raw.recurrenceInputs).toEqual({ interval: '1', count: '1' });
        const envelope = await plan(input); expect(after(envelope)).toMatchObject({ dueDate: '2026-10-12', startTime: '2026-10-10',
            relativeStartOffset: { amount: -2, unit: 'day' }, reviewAt: '2026-10-13', recurrence: { rule: 'weekly', strategy: 'strict' }, showFutureRecurrence: true });
        unwrap(await env.host.commitPreparedOwnedEditorCompleteTaskDraftSave(envelope)); const saved = rows(); env = await open(path);
        unwrap(env.host.validatePreparedOwnedEditorCompleteTaskDraftSave(envelope)); unwrap(await env.host.commitPreparedOwnedEditorCompleteTaskDraftSave(envelope)); expect(rows()).toEqual(saved);
    });
    it('rechecks fresh Focus capacity/settings before an owned write', async () => {
        const data = seed({}, { deviceId: 'complete-save-device', gtd: { focusTaskLimit: 1 } });
        env = await open(path, data); const envelope = await plan(await request({ edits: { focusedToday: true } }));
        env.db.prepare('UPDATE tasks SET isFocusedToday = ? WHERE id = ?').run(1, 'other'); const saved = rows();
        expect(await env.host.commitPreparedOwnedEditorCompleteTaskDraftSave(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } }); expect(rows()).toEqual(saved);
    });
    it('preserves existing archived-parent refusal before an owned reactivation request can change any task, project or section', async () => {
        const data = seed({ status: 'done', completedAt: AT }); data.projects[0].status = 'archived';
        data.sections = [{ id: 'section', projectId: 'project', title: 'Section', order: 0, createdAt: AT, updatedAt: AT }];
        env = await open(path, data); const input = await request({ edits: { status: 'next', completedAt: '' } });
        const tasks = rows(), projects = rows('projects'), sections = rows('sections'); env.writes.mockClear();
        expect(await env.host.prepareOwnedEditorCompleteTaskDraftSave(input)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(rows()).toEqual(tasks); expect(rows('projects')).toEqual(projects); expect(rows('sections')).toEqual(sections); expect(env.writes).not.toHaveBeenCalled();
    });
    it('saves a dirty recurring Skip and replays exactly one child carrying the edited files', async () => {
        env = await open(path, seed({ dueDate: '2026-10-05', recurrence: { rule: 'daily', strategy: 'strict' } }));
        const envelope = await plan(await request({ intent: 'skip', edits: { title: 'Skipped edited task' }, checklist: [item('one', 'Edited row')] }));
        if (envelope.prepared.decision.kind !== 'changed') throw new Error('Expected Skip');
        const child = envelope.prepared.decision.prepared.effect.tasks.find((row) => row.after.id !== 'complete')!.after;
        expect(child.attachments?.map((attachment) => attachment.uri).sort()).toEqual(after(envelope).attachments?.filter((attachment) => !attachment.deletedAt).map((attachment) => attachment.uri).sort());
        expect(child.title).toBe('Skipped edited task');
        expect(after(envelope)).toMatchObject({ status: 'archived', cancelledAt: AT });
        unwrap(await env.host.commitPreparedOwnedEditorCompleteTaskDraftSave(envelope)); const saved = rows(); env = await open(path);
        unwrap(await env.host.commitPreparedOwnedEditorCompleteTaskDraftSave(envelope)); expect(rows()).toEqual(saved);
    });
    it('binds owned Cancel to the original UUID/stamp and Undo preserves later title and attachment edits', async () => {
        const cancel = await plan(await request({ intent: 'cancel', edits: { title: 'Cancelled edited' }, checklist: [item('one', 'Cancel row', true)] }));
        const result = unwrap(await env.host.commitPreparedOwnedEditorCompleteTaskDraftSave(cancel)); expect(result.cancellation?.cancelledAt).toBe(AT);
        const later = await rawTask(), laterAttachment = { ...file, id: 'later', uri: ROOT + 'later.pdf' }; later.attachments!.push(laterAttachment);
        env.db.prepare('UPDATE tasks SET title = ?, description = ?, attachments = ?, rev = rev + 1 WHERE id = ?')
            .run('Later title', 'Later notes', JSON.stringify(later.attachments), later.id); env = await open(path);
        const undoRequest = { requestId: '88888888-1111-4111-8111-111111111111', cancelRequestId: ID };
        const prepared = unwrap(await env.host.prepareOwnedEditorCompleteTaskCancellationUndo({ request: undoRequest, cancel })).prepared;
        const undo: OwnedEditorCompleteCancellationUndoEnvelope = { request: undoRequest, prepared }; expect(prepared.cancel).toEqual(cancel);
        expect(env.baseHost.validatePreparedTaskCancellationUndo(undo as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        unwrap(env.host.validatePreparedOwnedEditorCompleteTaskCancellationUndo(undo)); unwrap(await env.host.commitPreparedOwnedEditorCompleteTaskCancellationUndo(undo));
        expect(await rawTask()).toMatchObject({ title: 'Later title', description: 'Later notes', status: 'next', attachments: later.attachments });
        expect((await rawTask()).cancelledAt).toBeUndefined(); const saved = rows(); env = await open(path);
        unwrap(await env.host.commitPreparedOwnedEditorCompleteTaskCancellationUndo(undo)); expect(rows()).toEqual(saved);
    });
    it('returns INVALID_INPUT for malformed selected Undo IDs without throwing or touching domain cells', async () => {
        const cancel = await plan(await request({ intent: 'cancel' })); unwrap(await env.host.commitPreparedOwnedEditorCompleteTaskDraftSave(cancel));
        const saved = rows(); env.writes.mockClear();
        for (const value of [null, 42, true, {}, [], ID + '\n', 'not-a-uuid']) for (const field of ['requestId', 'cancelRequestId']) {
            const candidate = { requestId: '88888888-1111-4111-8111-111111111111', cancelRequestId: ID, [field]: value };
            await expect(env.host.prepareOwnedEditorCompleteTaskCancellationUndo({ request: candidate as never, cancel }))
                .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(rows()).toEqual(saved); expect(env.writes).not.toHaveBeenCalled();
    });
    it('saves valid empty history without granting cleanup over old baseline tombstones', async () => {
        const envelope = await plan(await request({ events: [], edits: { title: 'Empty ordinary Save' } }));
        expect(unwrap(env.host.validatePreparedOwnedEditorCompleteTaskDraftSave(envelope)).settlementPlan).toEqual([]);
        expect(after(envelope).attachments).toEqual(envelope.request.saveRequest.attachments.base);
        unwrap(await env.host.commitPreparedOwnedEditorCompleteTaskDraftSave(envelope)); expect((await rawTask()).attachments).toEqual(task().attachments);
    });
    it.each(['checklist', 'cancel', 'skip'] as const)('saves valid empty history with %s and keeps all baseline file bytes outside cleanup ownership', async (mode) => {
        if (mode === 'skip') env = await open(path, seed({ dueDate: '2026-10-05', recurrence: { rule: 'daily', strategy: 'strict' } }));
        const envelope = await plan(await request({ events: [], checklist: [item('one', 'Empty owned row', true)],
            ...(mode === 'checklist' ? {} : { intent: mode }) }));
        expect(unwrap(env.host.validatePreparedOwnedEditorCompleteTaskDraftSave(envelope)).settlementPlan).toEqual([]);
        expect(after(envelope).attachments).toEqual(envelope.request.saveRequest.attachments.base);
        unwrap(await env.host.commitPreparedOwnedEditorCompleteTaskDraftSave(envelope));
        expect((await rawTask()).attachments).toEqual(envelope.request.saveRequest.attachments.base);
    });
    it('confirms a strict empty-history no-op without revisions, device initialization or persistence writes', async () => {
        env = await open(path, seed({}, {})); const before = rows(), settings = await env.adapter.getData({ rawTasks: true });
        const envelope = await plan(await request({ events: [] })); expect(envelope.prepared.decision.kind).toBe('noop');
        expect(envelope.prepared.decision.prepared).not.toHaveProperty('effect'); expect(envelope.prepared.decision.prepared.witness.deviceIdToInitialize).toBeNull();
        unwrap(await env.host.commitPreparedOwnedEditorCompleteTaskDraftSave(envelope)); expect(rows()).toEqual(before); expect(env.writes).not.toHaveBeenCalled();
        expect((await env.adapter.getData({ rawTasks: true })).settings).toEqual(settings.settings); env = await open(path);
        unwrap(await env.host.commitPreparedOwnedEditorCompleteTaskDraftSave(envelope)); expect(rows()).toEqual(before); expect(env.writes).not.toHaveBeenCalled();
    });
    it('keeps old outer, checklist, Undo and checkpoint grammars sealed against complete-v2 proofs', async () => {
        const envelope = await plan(await request({ edits: { status: 'done' }, checklist: [item('one', 'First', true)] }));
        const old = createOwnedEditorFileEditTaskDraftSaveMethods(env.deps);
        expect(old.validatePreparedOwnedEditorFileEditTaskDraftSave(envelope as never)).toMatchObject({ ok: false });
        if (envelope.prepared.decision.kind !== 'changed') throw new Error('Expected changed');
        expect(env.baseHost.validatePreparedTaskChecklistWrite({ request: envelope.request.saveRequest, prepared: envelope.prepared.decision.prepared } as never)).toMatchObject({ ok: false });
        expect(validateNativeTaskEditorSaveCheckpoint({ payloadJSON: envelope.request.checkpoint.payloadJSON, saveRequest: envelope.request.saveRequest,
            beforeTask: envelope.prepared.decision.prepared.witness.source }, validateField)).toMatchObject({ ok: false });
        expect(env.writes).not.toHaveBeenCalled();
    });
    it('refuses unresolved or mismatched full checkpoint buffers without changing retained input or domain cells', async () => {
        const input = await request({ edits: { title: 'Edited' }, checklist: [item('one', 'Edited row')] }), before = rows();
        for (const mutate of [(payload: Record<string, any>) => { payload.raw.title = 'unresolved'; },
            (payload: Record<string, any>) => { payload.raw.checklistInputs = { 0: 'Uncommitted' }; },
            (payload: Record<string, any>) => { delete payload.checklistValue; },
            (payload: Record<string, any>) => { payload.checklistValue[0].title = 'Mismatch'; },
            (payload: Record<string, any>) => { payload.scheduleEdits = [{ id: 'pending' }]; }]) {
            const candidate = clone(input), payload = JSON.parse(candidate.checkpoint.payloadJSON); mutate(payload);
            const bytes = JSON.stringify(payload); candidate.checkpoint.payloadJSON = bytes; candidate.ownedDraft.beforePayloadJSON = bytes;
            expect(await env.host.prepareOwnedEditorCompleteTaskDraftSave(candidate)).toMatchObject({ ok: false }); expect(candidate.checkpoint.payloadJSON).toBe(bytes);
        }
        expect(rows()).toEqual(before); expect(env.writes).not.toHaveBeenCalled();
    });
    it('refuses a changed container or generated-ID collision before overlaying any raw row', async () => {
        const envelope = await plan(); env.db.prepare('UPDATE projects SET status = ? WHERE id = ?').run('archived', 'project'); const saved = rows();
        expect(await env.host.commitPreparedOwnedEditorCompleteTaskDraftSave(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } }); expect(rows()).toEqual(saved);
        env = await open(path, seed({ dueDate: '2026-10-05', recurrence: { rule: 'daily', strategy: 'strict' } }));
        const recurring = await plan(await request({ edits: { status: 'done' } })); if (recurring.prepared.decision.kind !== 'changed') throw new Error('Expected completion');
        const child = recurring.prepared.decision.prepared.effect.tasks.find((row) => row.after.id !== 'complete')!.after;
        env.db.prepare('UPDATE tasks SET id = ? WHERE id = ?').run(child.id, 'other'); const collision = rows();
        expect(await env.host.commitPreparedOwnedEditorCompleteTaskDraftSave(recurring)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } }); expect(rows()).toEqual(collision);
    });
    it('refuses A→B→C replay despite the same frozen request UUID, retaining every later cell', async () => {
        const envelope = await plan(); unwrap(await env.host.commitPreparedOwnedEditorCompleteTaskDraftSave(envelope));
        env.db.prepare('UPDATE tasks SET description = ?, rev = rev + 1 WHERE id = ?').run('Later C', 'complete'); const later = rows(); env = await open(path);
        expect(await env.host.commitPreparedOwnedEditorCompleteTaskDraftSave(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } }); expect(rows()).toEqual(later);
    });
    it.each(['commits', 'after'] as const)('recovers the exact raw effect after %s failure without duplicating a recurring child', async (fault) => {
        env = await open(path, seed({ dueDate: '2026-10-05', recurrence: { rule: 'daily', strategy: 'strict' } }));
        const envelope = await plan(await request({ edits: { status: 'done' } })); env.fault[fault] = 100;
        expect(await env.host.commitPreparedOwnedEditorCompleteTaskDraftSave(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        env.fault[fault] = 0;
        unwrap(await env.host.commitPreparedOwnedEditorCompleteTaskDraftSave(envelope)); const saved = rows(); env = await open(path);
        unwrap(await env.host.commitPreparedOwnedEditorCompleteTaskDraftSave(envelope)); expect(rows()).toEqual(saved);
        expect((await env.adapter.getData({ rawTasks: true })).tasks).toHaveLength(3);
    });
});
