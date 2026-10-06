import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createProjectAttachmentWriteMethods, createProjectFileRemoveWriteMethods,
    type NativeProjectFileRemoveWriteRequest,
} from './native-host-contract-project-attachments';
import { openSqliteHost } from './screen-parity.replay';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { projectAttachmentWriteEffect, projectFileRemoveWriteEffect } from './store-projects/project-actions';
import type { AppData, Area, Attachment, Project, Section, Task } from './types';

const now = '2026-10-06T15:00:00.000Z';
const later = '2026-10-06T16:00:00.000Z';
const requestId = '73799899-d143-40c1-84bd-a09172bba5a4';
const file: Attachment = { id: 'file', kind: 'file', title: 'Keep metadata.pdf', uri: 'file:///keep.pdf',
    mimeType: 'application/pdf', size: 12, cloudKey: 'cloud-file', fileHash: 'hash', contentRev: 7,
    contentMtimeMs: 12, contentSize: 12, pendingContentUpload: true, localStatus: 'missing',
    createdAt: now, updatedAt: now };
const link: Attachment = { id: 'link', kind: 'link', title: 'Keep link', uri: 'https://example.test/keep',
    createdAt: now, updatedAt: now };
const project = (id = 'target', overrides: Partial<Project> = {}): Project => ({
    id, title: id, status: 'active', color: '#3b82f6', order: 0, tagIds: ['#work'],
    supportNotes: 'Keep notes', areaId: 'area', dueDate: '2026-10-20', isSequential: true,
    sequentialScope: 'section', taskSortBy: 'dueDate', viewSectionIds: { next: 'section' },
    attachments: [file, link, { ...file, id: 'sibling' }], rev: 3, revBy: 'old-device',
    createdAt: now, updatedAt: now, ...overrides,
});
const task: Task = { id: 'task', title: 'Keep task', status: 'next', projectId: 'target', tags: [], contexts: [],
    attachments: [{ ...file, id: 'task-file' }], createdAt: now, updatedAt: now };
const section: Section = { id: 'section', projectId: 'target', title: 'Keep section', order: 0,
    createdAt: now, updatedAt: now };
const area: Area = { id: 'area', name: 'Keep area', order: 0, createdAt: now, updatedAt: now };

async function open(initial: Partial<AppData> = {}, failure: { disk?: () => boolean; ack?: () => boolean } = {}) {
    await flushPendingSave(); resetForTests();
    let data: AppData = { tasks: [task], projects: [project(), project('other')], sections: [section],
        areas: [area], people: [], settings: { deviceId: 'files-device' }, ...initial };
    let saves = 0;
    setStorageAdapter({ getData: async () => structuredClone(data), saveData: async (next) => {
        if (failure.disk?.()) throw new Error('private disk failure');
        data = structuredClone(next); saves++;
    } });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    const deps = { readiness: () => ({ ok: true as const, value: null }), save: async () => {
        try {
            await flushPendingSave();
            return failure.ack?.() ? { ok: false as const, error: { code: 'SAVE_FAILED' as const, message: 'Could not acknowledge' } }
                : { ok: true as const, value: null };
        } catch { return { ok: false as const, error: { code: 'SAVE_FAILED' as const, message: 'Could not save' } }; }
    }, revision: () => 'stable-revision', t: () => (key: string) => key };
    const links = createProjectAttachmentWriteMethods(deps);
    const methods = createProjectFileRemoveWriteMethods(deps);
    const request = (attachmentId = 'file'): NativeProjectFileRemoveWriteRequest => {
        const options = links.getProjectAttachmentEditOptions({ projectId: 'target' });
        if (!options.ok) throw new Error(options.error.code);
        const { id: _id, ...expected } = options.value.project;
        return { requestId, projectId: 'target', intent: { kind: 'remove', attachmentId }, expected };
    };
    const prepare = (input = request()) => {
        const answer = methods.prepareProjectFileRemoveWrite(input);
        if (!answer.ok || answer.value.kind !== 'prepared')
            throw new Error(answer.ok ? answer.value.kind : `${answer.error.code}: ${answer.error.message}`);
        return { request: input, prepared: answer.value.prepared };
    };
    return { links, methods, request, prepare, data: () => data, saves: () => saves };
}

afterEach(async () => { vi.useRealTimers(); await flushPendingSave(); resetForTests(); });

describe('prepared native metadata-only Project file Remove', () => {
    it.each(['active', 'waiting', 'someday'] as const)('tombstones only the selected file on a %s Project', async (status) => {
        vi.useFakeTimers(); vi.setSystemTime(later);
        const env = await open({ projects: [project('target', { status }), project('other')] });
        const before = structuredClone(useTaskStore.getState()._allProjects[0]);
        const children = { tasks: structuredClone(useTaskStore.getState()._allTasks),
            sections: structuredClone(useTaskStore.getState()._allSections) };
        const settings = structuredClone(useTaskStore.getState().settings);
        const frozen = env.prepare();
        expect(frozen.prepared).toMatchObject({ version: 2, updateAt: later, deviceIdBefore: 'files-device',
            deviceIdToInitialize: null, scope: { project: before }, result: { id: 'target', attachmentIds: ['file'] } });
        expect(frozen.prepared.effect.project).toEqual({ before, after: { ...before,
            attachments: [{ ...file, deletedAt: later, updatedAt: later }, link, before.attachments![2]],
            updatedAt: later, rev: 4, revBy: 'files-device' } });
        expect(env.methods.validatePreparedProjectFileRemoveWrite(frozen)).toEqual({ ok: true, value: frozen.prepared.result });
        expect(await env.methods.commitPreparedProjectFileRemoveWrite(frozen)).toEqual({ ok: true, value: frozen.prepared.result });
        expect(env.data().projects[0]).toEqual(frozen.prepared.effect.project.after);
        expect(env.data().projects[1]).toEqual(project('other'));
        expect(env.data().tasks).toEqual(children.tasks);
        expect(env.data().sections).toEqual(children.sections);
        expect(env.data().settings).toEqual(settings);
        expect(env.saves()).toBe(1);
    });

    it.each(['file:///keep.pdf', 'file:///missing.pdf', 'file:///foreign/private.pdf', ''])
    ('removes file metadata regardless of local URI availability: %j', async (uri) => {
        const env = await open({ projects: [project('target', { attachments: [{ ...file, uri }, link] })] });
        const frozen = env.prepare();
        expect(frozen.prepared.effect.project.after.attachments).toEqual([
            { ...file, uri, deletedAt: frozen.prepared.updateAt, updatedAt: frozen.prepared.updateAt }, link,
        ]);
        expect(await env.methods.commitPreparedProjectFileRemoveWrite(frozen)).toMatchObject({ ok: true });
    });

    it('preserves raw nullable columns in the before row and carries an exact complete after receipt', async () => {
        const env = await open();
        const raw = { ...project(), areaId: null, areaTitle: null, supportNotes: null, startDate: null,
            dueDate: null, reviewAt: null, rev: null, revBy: null, deletedAt: null, purgedAt: null } as unknown as Project;
        useTaskStore.setState({ _allProjects: [raw] });
        const frozen = env.prepare();
        expect(frozen.prepared.scope.project).toEqual(raw);
        expect(frozen.prepared.effect.project.before).toEqual(raw);
        expect(frozen.prepared.effect.project.after).toMatchObject({ areaId: null, supportNotes: null,
            startDate: null, dueDate: null, reviewAt: null, rev: 1, revBy: 'files-device' });
        expect(await env.methods.commitPreparedProjectFileRemoveWrite(frozen)).toMatchObject({ ok: true });
        const second = await open(structuredClone(env.data()));
        expect(await second.methods.commitPreparedProjectFileRemoveWrite(frozen)).toMatchObject({ ok: true });
        expect(second.saves()).toBe(0);
    });

    it('writes nothing for missing, already removed, or absent attachments and refuses a live link', async () => {
        const env = await open({ projects: [project('target', { attachments: [file, link, { ...file, id: 'deleted', deletedAt: now }] })] });
        for (const attachmentId of ['missing', 'deleted'])
            expect(env.methods.prepareProjectFileRemoveWrite(env.request(attachmentId)))
                .toEqual({ ok: true, value: { kind: 'noop', result: { id: 'target', attachmentIds: [] } } });
        expect(env.methods.prepareProjectFileRemoveWrite(env.request('link')))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        useTaskStore.setState({ _allProjects: [{ ...project(), attachments: null } as unknown as Project] });
        expect(env.methods.prepareProjectFileRemoveWrite(env.request()))
            .toEqual({ ok: true, value: { kind: 'noop', result: { id: 'target', attachmentIds: [] } } });
        expect(env.saves()).toBe(0);
    });

    it('checks the expected token before archived/no-op policy and refuses deleted, purged, or absent Projects', async () => {
        const env = await open();
        const stale = env.request('missing');
        useTaskStore.setState({ _allProjects: [project('target', { status: 'archived', rev: 4 })] });
        expect(env.methods.prepareProjectFileRemoveWrite(stale)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(env.links.getProjectAttachmentEditOptions({ projectId: 'target' })).toMatchObject({ ok: true, value: { canEdit: false } });
        const archived = env.request();
        expect(env.methods.prepareProjectFileRemoveWrite(archived))
            .toEqual({ ok: true, value: { kind: 'blocked', result: { blocked: '' } } });
        for (const change of [{ deletedAt: now }, { purgedAt: now }]) {
            useTaskStore.setState({ _allProjects: [project('target', change)] });
            expect(env.methods.prepareProjectFileRemoveWrite(stale)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        }
        useTaskStore.setState({ _allProjects: [] });
        expect(env.methods.prepareProjectFileRemoveWrite(stale)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(env.saves()).toBe(0);
    });

    it('refuses any complete row change after preparation, including fields outside the expected token', async () => {
        const env = await open();
        const frozen = env.prepare();
        for (const change of [{ color: '#000000' }, { supportNotes: 'Later' }, { status: 'archived' as const },
            { attachments: [file, { ...link, title: 'Later' }] }, { deletedAt: now }, { purgedAt: now }]) {
            useTaskStore.setState({ _allProjects: [project('target', change)] });
            expect(await env.methods.commitPreparedProjectFileRemoveWrite(frozen))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        }
        expect(env.saves()).toBe(0);
    });

    it('rejects malformed requests and forged journals without leaking input or writing', async () => {
        vi.useFakeTimers(); vi.setSystemTime(later);
        const env = await open();
        const input = env.request();
        for (const bad of [{ ...input, requestId: requestId.toUpperCase() }, { ...input, extra: true },
            { ...input, intent: { kind: 'add', text: 'https://alice:secret@example.org/private' } },
            { ...input, intent: { kind: 'remove', attachmentId: 'x'.repeat(501) } },
            { ...input, intent: { ...input.intent, extra: true } },
            { ...input, expected: { ...input.expected, extra: true } }]) {
            const answer = env.methods.prepareProjectFileRemoveWrite(bad as never);
            expect(answer).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(JSON.stringify(answer)).not.toMatch(/alice|secret|private/);
            expect(env.methods.probeProjectFileRemoveWriteOutcome(bad as never))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        const frozen = env.prepare(input);
        for (const mutate of [
            (value: typeof frozen) => { value.prepared.effect.project.after.title = 'Forged'; },
            (value: typeof frozen) => { value.prepared.effect.project.after.attachments![0].cloudKey = 'Forged'; },
            (value: typeof frozen) => { value.prepared.effect.project.after.attachments![1].title = 'Forged sibling'; },
            (value: typeof frozen) => { value.prepared.result.attachmentIds = ['wrong']; },
            (value: typeof frozen) => { value.prepared.scope.project.color = '#000000'; },
            (value: typeof frozen) => { value.prepared.updateAt = now; },
            (value: typeof frozen) => { (value.prepared as unknown as Record<string, unknown>).extra = true; },
            (value: typeof frozen) => { value.prepared.deviceIdToInitialize = 'bad-device'; },
        ]) {
            const forged = structuredClone(frozen); mutate(forged);
            expect(env.methods.validatePreparedProjectFileRemoveWrite(forged))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await env.methods.commitPreparedProjectFileRemoveWrite(forged))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(env.methods.validatePreparedProjectFileRemoveWrite({ ...frozen,
            prepared: { ...frozen.prepared, extra: 'x'.repeat(2_000_001) } } as never))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(env.methods.probeProjectFileRemoveWriteOutcome(input))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(env.saves()).toBe(0);
    });

    it('seals historical link version 1 from file version 2, including the store writer', async () => {
        const env = await open();
        const frozen = env.prepare();
        expect(env.links.prepareProjectAttachmentWrite(frozen.request)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(env.links.validatePreparedProjectAttachmentWrite(frozen as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await env.links.commitPreparedProjectAttachmentWrite(frozen as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await useTaskStore.getState().commitPreparedProjectAttachmentWrite(frozen.prepared)).toMatchObject({ success: false });
        expect(await useTaskStore.getState().commitPreparedProjectAttachmentWrite({ ...frozen.prepared, version: 1 } as never))
            .toMatchObject({ success: false });
        const linkRequest = { ...frozen.request, intent: { kind: 'remove' as const, attachmentId: 'link' } };
        const linkPlan = env.links.prepareProjectAttachmentWrite(linkRequest);
        if (!linkPlan.ok || linkPlan.value.kind !== 'prepared') throw new Error('link prepare failed');
        const legacy = { request: linkRequest, prepared: linkPlan.value.prepared };
        expect(legacy.prepared.version).toBe(1);
        expect(env.methods.validatePreparedProjectFileRemoveWrite(legacy as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await env.methods.commitPreparedProjectFileRemoveWrite(legacy as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await useTaskStore.getState().commitPreparedProjectFileRemoveWrite(legacy.prepared as never)).toMatchObject({ success: false });
        expect(env.methods.validatePreparedProjectFileRemoveWrite({ ...frozen, prepared: { ...frozen.prepared, version: 1 } } as never))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(projectAttachmentWriteEffect(project(), frozen.request.intent, ['file'], 'device', later)).toBeNull();
        expect(projectFileRemoveWriteEffect(project(), linkRequest.intent, ['link'], 'device', later)).toBeNull();
        expect(env.saves()).toBe(0);
    });

    it('retries a failed durable save with its frozen timestamp, revision and initialized device', async () => {
        let failed = true;
        const env = await open({ settings: {} }, { disk: () => failed });
        useTaskStore.setState((state) => {
            const { deviceId: _deviceId, ...settings } = state.settings;
            return { settings };
        });
        const frozen = env.prepare();
        expect(frozen.prepared.deviceIdToInitialize).toMatch(/^[0-9a-f-]{36}$/);
        expect(await env.methods.commitPreparedProjectFileRemoveWrite(frozen)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(env.data().projects[0].rev).toBe(3);
        failed = false;
        expect(await env.methods.commitPreparedProjectFileRemoveWrite(frozen)).toEqual({ ok: true, value: frozen.prepared.result });
        expect(env.data().projects[0]).toEqual(frozen.prepared.effect.project.after);
        expect(env.data().settings.deviceId).toBe(frozen.prepared.deviceIdToInitialize);
        const second = await open(structuredClone(env.data()));
        expect(await second.methods.commitPreparedProjectFileRemoveWrite(frozen)).toMatchObject({ ok: true });
        expect(second.saves()).toBe(0);
        useTaskStore.setState((state) => ({ settings: { ...state.settings, deviceId: 'different-device' } }));
        expect(await second.methods.commitPreparedProjectFileRemoveWrite(frozen)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('replays the exact durable after row after acknowledgement failure and host reload', async () => {
        const first = await open({}, { ack: () => true });
        const frozen = first.prepare();
        expect(await first.methods.commitPreparedProjectFileRemoveWrite(frozen)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(first.data().projects[0]).toEqual(frozen.prepared.effect.project.after);
        expect(first.saves()).toBe(1);
        const second = await open(structuredClone(first.data()));
        expect(await second.methods.commitPreparedProjectFileRemoveWrite(frozen)).toEqual({ ok: true, value: frozen.prepared.result });
        expect(second.saves()).toBe(0);
        useTaskStore.setState({ _allProjects: [{ ...second.data().projects[0], supportNotes: 'Intervening edit' }] });
        expect(await second.methods.commitPreparedProjectFileRemoveWrite(frozen)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('persists one complete Project receipt through actual SQLite process death and refuses later row changes', async () => {
        const env = await openSqliteHost({ projects: [project(), project('other')], tasks: [task], sections: [section], areas: [area],
            settings: { deviceId: 'files-device' } });
        try {
            const options = env.host.getProjectAttachmentEditOptions({ projectId: 'target' });
            if (!options.ok) throw new Error(options.error.code);
            const { id: _id, ...expected } = options.value.project;
            const request = JSON.parse(JSON.stringify({ requestId, projectId: 'target', expected,
                intent: { kind: 'remove', attachmentId: 'file' } })) as NativeProjectFileRemoveWriteRequest;
            const plan = env.host.prepareProjectFileRemoveWrite(request);
            if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(plan.ok ? plan.value.kind : plan.error.code);
            const frozen = { request, prepared: plan.value.prepared };
            expect(await env.host.commitPreparedProjectFileRemoveWrite(frozen)).toEqual({ ok: true, value: frozen.prepared.result });
            const saved = await env.sql<{ rev: number; attachments: string }>('SELECT rev, attachments FROM projects WHERE id = ?', ['target']);
            expect(saved[0].rev).toBe(frozen.prepared.effect.project.after.rev);
            expect(JSON.parse(saved[0].attachments)).toEqual(frozen.prepared.effect.project.after.attachments);
            const replay = await env.replay((host) => host.commitPreparedProjectFileRemoveWrite(frozen));
            expect(replay).toEqual({ result: { ok: true, value: frozen.prepared.result }, wrote: false, receipts: false });
            expect((await useTaskStore.getState().updateProject('target', { supportNotes: 'Later notes' })).success).toBe(true);
            await flushPendingSave();
            const changed = await env.replay((host) => host.commitPreparedProjectFileRemoveWrite(frozen));
            expect(changed.result).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(changed.wrote).toBe(false);
            expect(changed.receipts).toBe(false);
        } finally { await env.close(); }
    });
});
