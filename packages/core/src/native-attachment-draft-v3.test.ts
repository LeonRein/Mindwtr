import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareNativeAttachmentDraftAddV3, prepareNativeAttachmentDraftRemoveV3,
    readNativeAttachmentDraftRemoveFrozen, validateNativeAttachmentDraftLineageV3,
    validateNativeAttachmentDraftLineageV2, prepareNativeAttachmentDraftAddV2,
    type NativeAttachmentDraftLineageInputV3, type NativeAttachmentDraftOperationV3,
    type NativeAttachmentDraftPrepared, type NativeAttachmentDraftRemovePrepared } from './native-attachment-draft';
import { softDeleteAttachment } from './attachment-editor-model';
import * as upload from './attachment-validation';
import type { Attachment } from './types';

const AT = '2026-10-05T00:00:00.000Z';
const ROOT = 'file:///owned/documents/attachments/';
const id = (n: number) => `${n.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
const baseline: Attachment = { id: 'legacy-file-id', kind: 'file', title: 'Original', uri: ROOT + 'legacy.pdf',
    createdAt: AT, updatedAt: AT, cloudKey: 'cloud/original', fileHash: 'hash', contentRev: 7,
    contentSize: 4, pendingContentUpload: true, localStatus: 'missing' };
const link: Attachment = { id: 'link', kind: 'link', title: 'Link', uri: 'https://example.test', createdAt: AT, updatedAt: AT };
const ports = () => ({ assertEditable: vi.fn(), t: (key: string) => key });
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const opening = (rows = [baseline, link]) => JSON.stringify({ version: 2, taskID: 'task', attachmentsOwned: true,
    attachmentsBase: rows, attachments: rows, raw: { notes: 'Opening', unknown: ['保留', null, 4] } });
const edit = (json: string, patch: Record<string, unknown>) => JSON.stringify({ ...JSON.parse(json), ...patch });
const input = (patch: Partial<NativeAttachmentDraftLineageInputV3> = {}): NativeAttachmentDraftLineageInputV3 => ({
    version: 3, taskID: 'task', initialPayloadJSON: opening(), beforePayloadJSON: opening(), priorOperations: [],
    managedDirectoryURI: ROOT, ...patch,
});
const picked = { uri: 'file:///cache/picked.pdf', name: 'Picked.pdf', mimeType: null, size: null };
async function add(value = input(), requestId = id(1)): Promise<NativeAttachmentDraftPrepared> {
    const result = await prepareNativeAttachmentDraftAddV3({ ...value, requestId, picked, measuredSize: 3 }, ports());
    if (result.kind !== 'prepared') throw Error('Fixture refused');
    return result;
}
const remove = (value = input(), attachmentId = baseline.id, requestId = id(2)) =>
    prepareNativeAttachmentDraftRemoveV3({ ...value, requestId, attachmentId }, ports());
const taggedAdd = (operation: NativeAttachmentDraftPrepared): NativeAttachmentDraftOperationV3 => ({ kind: 'add', operation });
const taggedRemove = (operation: NativeAttachmentDraftRemovePrepared): NativeAttachmentDraftOperationV3 => ({ kind: 'remove', operation });

describe('sealed v3 mixed attachment draft history', () => {
    afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

    it('preserves Add -> Remove -> ordinary notes -> Add -> baseline Remove and exact raw bytes', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(AT);
        const first = await add();
        const r1 = remove(input({ beforePayloadJSON: first.afterPayloadJSON, priorOperations: [taggedAdd(first)] }), first.requestId);
        const notes = ` \n${edit(r1.afterPayloadJSON, { raw: { notes: 'Pending @literal', unknown: { keep: true } } })}\n`;
        const prior = [taggedAdd(first), taggedRemove(r1)];
        vi.setSystemTime('2026-10-06T00:00:00.000Z');
        const second = await add(input({ beforePayloadJSON: notes, priorOperations: prior }), id(3));
        prior.push(taggedAdd(second));
        const r2 = remove(input({ beforePayloadJSON: second.afterPayloadJSON, priorOperations: prior }), baseline.id, id(4));
        prior.push(taggedRemove(r2));
        const frozen = copy(prior), latest = ` \n${r2.afterPayloadJSON}\n`;
        expect(validateNativeAttachmentDraftLineageV3(input({ beforePayloadJSON: latest, priorOperations: prior })))
            .toEqual({ version: 3, taskID: 'task', payloadJSON: latest });
        expect(prior).toEqual(frozen); expect(second.beforePayloadJSON).toBe(notes);
        expect(first.attachment.createdAt).toBe(AT); expect(r1.removedAt).toBe(AT);
        expect(r2.removedAt).toBe('2026-10-06T00:00:00.000Z');
        const after = JSON.parse(r2.afterPayloadJSON);
        expect(after.attachmentsBase).toEqual([baseline, link]);
        expect(after.raw).toEqual(JSON.parse(notes).raw);
        expect(after.attachments[0]).toEqual({ ...baseline, deletedAt: r2.removedAt, updatedAt: r2.removedAt });
        expect(after.attachments[1]).toEqual(link);
        expect(after.attachments[2]).toEqual({ ...first.attachment, deletedAt: r1.removedAt, updatedAt: r1.removedAt });
        expect(after.attachments[3]).toEqual(second.attachment);
    });

    it('uses RN soft delete for a nonUUID baseline file, retaining every content/cloud/opaque field', () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(AT);
        const before = ` \n${opening()}\n`, deps = ports();
        const result = prepareNativeAttachmentDraftRemoveV3({ ...input({ beforePayloadJSON: before }), requestId: id(1), attachmentId: baseline.id }, deps);
        expect(result.beforePayloadJSON).toBe(before);
        expect(JSON.parse(result.afterPayloadJSON)).toEqual({ ...JSON.parse(before),
            attachments: softDeleteAttachment([baseline, link], baseline.id, AT) });
        expect(Object.keys(result).sort()).toEqual(['version', 'kind', 'taskID', 'requestId', 'attachmentId', 'removedAt',
            'beforePayloadJSON', 'afterPayloadJSON'].sort());
        expect(deps.assertEditable).toHaveBeenCalledTimes(2);
    });

    it('frozen retry retains timestamp and bytes without a clock or current policy', () => {
        const first = remove(), bytes = JSON.stringify(first);
        vi.spyOn(upload, 'validateAttachmentForUpload').mockRejectedValue(Error('No historical policy'));
        const clock = vi.spyOn(Date.prototype, 'toISOString');
        expect(readNativeAttachmentDraftRemoveFrozen(copy(first))).toEqual(first);
        expect(clock.mock.calls.every((_, i) => clock.mock.instances[i].getTime() === Date.parse(first.removedAt))).toBe(true);
        expect(JSON.stringify(first)).toBe(bytes);
        expect(validateNativeAttachmentDraftLineageV3(input({ beforePayloadJSON: first.afterPayloadJSON, priorOperations: [taggedRemove(first)] })).version).toBe(3);
        expect(upload.validateAttachmentForUpload).not.toHaveBeenCalled();
    });

    it.each(['unknown', 'link', 'deleted', 'removed', 'metadata', 'undelete'])(
        'refuses unsupported fresh removal/projection: %s', (kind) => {
            let value = input(), attachmentId = baseline.id;
            if (kind === 'unknown') attachmentId = 'missing';
            if (kind === 'link') attachmentId = link.id;
            if (kind === 'deleted') {
                const rows = [{ ...baseline, deletedAt: AT }, link]; value = input({ initialPayloadJSON: opening(rows), beforePayloadJSON: opening(rows) });
            }
            if (kind === 'removed') value.beforePayloadJSON = edit(opening(), { attachments: [link] });
            if (kind === 'metadata') value.beforePayloadJSON = edit(opening(), { attachments: [{ ...baseline, cloudKey: 'changed' }, link] });
            if (kind === 'undelete') {
                const rows = [{ ...baseline, deletedAt: AT }, link]; value.initialPayloadJSON = opening(rows);
            }
            const deps = ports();
            expect(() => prepareNativeAttachmentDraftRemoveV3({ ...value, requestId: id(1), attachmentId }, deps)).toThrow('INVALID_INPUT');
            expect(deps.assertEditable).not.toHaveBeenCalled();
        });

    it.each(['opaque', 'title', 'uri', 'cloud', 'omit', 'reorder', 'base', 'time', 'kind', 'extra', 'request', 'task'])(
        'refuses forged frozen Remove: %s', (kind) => {
            const value = copy(remove()), after = JSON.parse(value.afterPayloadJSON);
            if (kind === 'opaque') after.raw.notes = 'Forged';
            if (kind === 'title') after.attachments[0].title = 'Forged';
            if (kind === 'uri') after.attachments[0].uri = ROOT + 'foreign';
            if (kind === 'cloud') after.attachments[0].cloudKey = 'Forged';
            if (kind === 'omit') after.attachments.shift();
            if (kind === 'reorder') after.attachments.reverse();
            if (kind === 'base') after.attachmentsBase = [];
            if (kind === 'time') value.removedAt = '2026-10-05';
            if (kind === 'kind') (value as unknown as { kind: string }).kind = 'prepared';
            if (kind === 'extra') Object.assign(value, { permission: true });
            if (kind === 'request') value.requestId = baseline.id;
            if (kind === 'task') value.taskID = 'other';
            value.afterPayloadJSON = JSON.stringify(after);
            expect(() => readNativeAttachmentDraftRemoveFrozen(value)).toThrow('INVALID_INPUT');
        });

    it.each(['missing', 'duplicate', 'crossKindDuplicate', 'reorder', 'base', 'root', 'initialEdit', 'afterList', 'tag'])(
        'refuses mixed lineage drift: %s', async (kind) => {
            const first = await add(), r = remove(input({ beforePayloadJSON: first.afterPayloadJSON, priorOperations: [taggedAdd(first)] }), first.requestId);
            const value = copy(input({ beforePayloadJSON: r.afterPayloadJSON, priorOperations: [taggedAdd(first), taggedRemove(r)] }));
            if (kind === 'missing') value.priorOperations = [taggedRemove(r)];
            if (kind === 'duplicate') value.priorOperations = [taggedAdd(first), taggedAdd(first), taggedRemove(r)];
            if (kind === 'crossKindDuplicate') value.priorOperations = [taggedAdd(first), taggedRemove({ ...r, requestId: first.requestId })];
            if (kind === 'reorder') value.priorOperations = [...value.priorOperations].reverse();
            if (kind === 'base') value.beforePayloadJSON = edit(r.afterPayloadJSON, { attachmentsBase: [] });
            if (kind === 'root') value.managedDirectoryURI = 'file:///foreign/';
            if (kind === 'initialEdit') value.initialPayloadJSON = edit(opening(), { attachments: [baseline] });
            if (kind === 'afterList') value.beforePayloadJSON = first.afterPayloadJSON;
            if (kind === 'tag') (value.priorOperations[1] as unknown as { kind: string }).kind = 'add';
            expect(() => validateNativeAttachmentDraftLineageV3(value)).toThrow('INVALID_INPUT');
        });

    it('rejects repeat request IDs across Add/Remove and already removed Add rows before policy', async () => {
        const first = await add(), value = input({ beforePayloadJSON: first.afterPayloadJSON, priorOperations: [taggedAdd(first)] });
        expect(() => remove(value, baseline.id, first.requestId)).toThrow('INVALID_INPUT');
        const r = remove(value, first.requestId), next = input({ beforePayloadJSON: r.afterPayloadJSON, priorOperations: [...value.priorOperations, taggedRemove(r)] });
        expect(() => remove(next, first.requestId, id(3))).toThrow('INVALID_INPUT');
        const policy = vi.spyOn(upload, 'validateAttachmentForUpload');
        await expect(add(next, r.requestId)).rejects.toThrow('INVALID_INPUT');
        expect(policy).not.toHaveBeenCalled();
    });

    it.each(['getter', 'sparse', 'iterator', 'prototype', 'entryGetter', 'symbol', 'pollution'])(
        'rejects unsafe capture without invoking accessors: %s', async (kind) => {
            const r = remove(), value = input(), getter = vi.fn(() => r), entries: unknown[] = [taggedRemove(r)];
            if (kind === 'getter') Object.defineProperty(entries, '0', { enumerable: true, get: getter });
            if (kind === 'sparse') { entries.length = 2; }
            if (kind === 'iterator') Object.defineProperty(entries, Symbol.iterator, { get: getter });
            if (kind === 'prototype') Object.setPrototypeOf(entries, { get toJSON() { getter(); return undefined; } });
            if (kind === 'entryGetter') Object.defineProperty(entries[0], 'operation', { enumerable: true, get: getter });
            if (kind === 'symbol') Object.assign(entries[0] as object, { [Symbol('extra')]: 1 });
            if (kind === 'pollution') value.beforePayloadJSON = opening().replace(/}$/, ',"__proto__":{"bad":true}}');
            if (kind !== 'pollution') value.priorOperations = entries as NativeAttachmentDraftOperationV3[];
            expect(() => validateNativeAttachmentDraftLineageV3(value)).toThrow('INVALID_INPUT');
            await expect(add(value)).rejects.toThrow('INVALID_INPUT'); expect(getter).not.toHaveBeenCalled();
        });

    it('captures the entire mixed history and new Add fields before awaited upload policy', async () => {
        const r = remove(), value = { ...input({ beforePayloadJSON: r.afterPayloadJSON, priorOperations: [taggedRemove(r)] }),
            requestId: id(3), picked: { ...picked }, measuredSize: 3 };
        const original = copy(value), policy = upload.validateAttachmentForUpload;
        let release!: () => void;
        const wait = new Promise<void>((resolve) => { release = resolve; });
        vi.spyOn(upload, 'validateAttachmentForUpload').mockImplementation(async (...args) => { await wait; return policy(...args); });
        const pending = prepareNativeAttachmentDraftAddV3(value, ports());
        value.beforePayloadJSON = opening(); value.picked.name = 'Later'; value.priorOperations = [];
        release(); const result = await pending;
        expect(result).toMatchObject({ kind: 'prepared', beforePayloadJSON: original.beforePayloadJSON, attachment: { title: picked.name } });
    });

    it('checks fresh editability before and after current Remove projection and propagates refusal', () => {
        const deps = ports(); deps.assertEditable.mockImplementationOnce(() => undefined).mockImplementationOnce(() => { throw Error('READ_ONLY'); });
        expect(() => prepareNativeAttachmentDraftRemoveV3({ ...input(), requestId: id(1), attachmentId: baseline.id }, deps)).toThrow('READ_ONLY');
        expect(deps.assertEditable).toHaveBeenCalledTimes(2);
    });

    it('accepts 128-entry historical lineage but refuses fresh work before policy/projection', async () => {
        const rows: Attachment[] = Array.from({ length: 128 }, (_, n) => ({ id: `x${n}`, kind: 'file', title: '', uri: '', createdAt: 'x', updatedAt: 'x' }));
        const initial = opening(rows), prior: NativeAttachmentDraftOperationV3[] = [];
        let before = initial;
        for (let n = 0; n < 128; n++) {
            const after = edit(before, { attachments: softDeleteAttachment(JSON.parse(before).attachments, rows[n].id, AT) });
            const r: NativeAttachmentDraftRemovePrepared = { version: 1, kind: 'prepared-file-remove', taskID: 'task', requestId: id(n + 10),
                attachmentId: rows[n].id, removedAt: AT, beforePayloadJSON: before, afterPayloadJSON: after };
            prior.push(taggedRemove(r)); before = after;
        }
        const value = input({ initialPayloadJSON: initial, beforePayloadJSON: before, priorOperations: prior });
        expect(validateNativeAttachmentDraftLineageV3(value).version).toBe(3);
        const deps = ports(), policy = vi.spyOn(upload, 'validateAttachmentForUpload');
        await expect(prepareNativeAttachmentDraftAddV3({ ...value, requestId: id(999), picked, measuredSize: 3 }, deps)).rejects.toThrow('INVALID_INPUT');
        expect(() => prepareNativeAttachmentDraftRemoveV3({ ...value, requestId: id(999), attachmentId: 'missing' }, deps)).toThrow('INVALID_INPUT');
        expect(deps.assertEditable).not.toHaveBeenCalled(); expect(policy).not.toHaveBeenCalled();
    });

    it.each(['entries', 'payload', 'rows', 'aggregate', 'overflow', 'depth', 'nodes', 'timestampInput'])(
        'bounds input before current authority: %s', async (kind) => {
            const value = input(), r = remove();
            if (kind === 'entries') value.priorOperations = Array(129).fill(taggedRemove(r));
            if (kind === 'payload') value.beforePayloadJSON = edit(opening(), { raw: '界'.repeat(350_000) });
            if (kind === 'rows') { const rows = Array.from({ length: 1001 }, (_, n) => ({ ...baseline, id: `f${n}` })); value.initialPayloadJSON = opening(rows); }
            if (kind === 'aggregate') {
                const before = edit(opening(), { raw: 'x'.repeat(180_000) }), after = edit(before, { attachments: softDeleteAttachment([baseline, link], baseline.id, AT) });
                value.priorOperations = Array(24).fill(taggedRemove({ ...r, beforePayloadJSON: before, afterPayloadJSON: after }));
            }
            if (kind === 'overflow') value.beforePayloadJSON = opening().replace(/}$/, ',"number":1e400}');
            if (kind === 'depth') value.beforePayloadJSON = edit(opening(), { raw: JSON.parse('['.repeat(70) + '0' + ']'.repeat(70)) });
            if (kind === 'nodes') value.beforePayloadJSON = edit(opening(), { raw: Array(100_001).fill(0) });
            const deps = ports(), request = { ...value, requestId: id(1), attachmentId: baseline.id,
                ...(kind === 'timestampInput' ? { removedAt: AT } : {}) };
            expect(() => prepareNativeAttachmentDraftRemoveV3(request, deps)).toThrow('INVALID_INPUT');
            expect(deps.assertEditable).not.toHaveBeenCalled();
        });

    it('uses the shared 500 UTF16-unit ID grammar for Unicode baseline IDs', () => {
        const row = { ...baseline, id: '界'.repeat(500) }, initial = opening([row]);
        const result = remove(input({ initialPayloadJSON: initial, beforePayloadJSON: initial }), row.id);
        expect(result.attachmentId).toBe(row.id);
        expect(readNativeAttachmentDraftRemoveFrozen(result)).toEqual(result);
        expect(() => remove(input(), '界'.repeat(501))).toThrow('INVALID_INPUT');
    });

    it.each(['\n', '\r\n', ' '])('rejects nonexact V3 UUIDs in fresh and frozen history: %j', async (suffix) => {
        const deps = ports();
        expect(() => prepareNativeAttachmentDraftRemoveV3({ ...input(), requestId: id(1) + suffix, attachmentId: baseline.id }, deps)).toThrow('INVALID_INPUT');
        await expect(prepareNativeAttachmentDraftAddV3({ ...input(), requestId: id(1) + suffix, picked, measuredSize: 3 }, deps)).rejects.toThrow('INVALID_INPUT');
        const r = remove();
        expect(() => readNativeAttachmentDraftRemoveFrozen({ ...r, requestId: r.requestId + suffix })).toThrow('INVALID_INPUT');
        const first = await add(), requestId = first.requestId + suffix;
        const forged = { ...first, requestId, prepared: { ...first.prepared, attachment: { ...first.prepared.attachment, id: requestId } },
            attachment: { ...first.attachment, id: requestId } };
        expect(() => validateNativeAttachmentDraftLineageV3(input({ beforePayloadJSON: first.afterPayloadJSON, priorOperations: [taggedAdd(forged)] }))).toThrow('INVALID_INPUT');
        expect(deps.assertEditable).not.toHaveBeenCalled();
    });

    it('keeps v1/v2 versions and Add-only schema sealed', async () => {
        const r = remove(), value = input({ beforePayloadJSON: r.afterPayloadJSON, priorOperations: [taggedRemove(r)] });
        expect(() => validateNativeAttachmentDraftLineageV2(value)).toThrow('INVALID_INPUT');
        await expect(prepareNativeAttachmentDraftAddV2({ ...value, requestId: id(3), picked, measuredSize: 3 }, ports())).rejects.toThrow('INVALID_INPUT');
        expect(() => validateNativeAttachmentDraftLineageV3({ ...input(), version: 2 })).toThrow('INVALID_INPUT');
    });
});
