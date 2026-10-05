import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareNativeAttachmentDraftAddV3, prepareNativeAttachmentDraftRemoveV3,
    readNativeAttachmentDraftFrozen, readNativeAttachmentDraftRemoveFrozen, validateNativeAttachmentDraftLineageV3,
    validateNativeAttachmentDraftBegin, validateNativeAttachmentDraftBeginV2, validateNativeAttachmentDraftBeginV3,
    validateNativeAttachmentDraftLineage, validateNativeAttachmentDraftLineageV2, prepareNativeAttachmentDraftAddV2,
    type NativeAttachmentDraftLineageInputV3, type NativeAttachmentDraftOperationV3,
    type NativeAttachmentDraftPrepared, type NativeAttachmentDraftRemovePrepared } from './native-attachment-draft';
import { softDeleteAttachment } from './attachment-editor-model';
import { prepareNativeAttachmentDraftDiscardCandidatesV3 } from './native-attachment-draft-discard';
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
const newLink = (n: number): Attachment => ({ ...link, id: id(n), title: `Link ${n}`, uri: `https://example.test/${n}` });

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

    it.each(['add', 'edit', 'remove'])('admits existing link %s before V3 Begin without changing old Begin grammar', (mode) => {
        let rows = [baseline, link];
        if (mode === 'add') rows = [...rows, newLink(100)];
        if (mode === 'edit') rows[1] = { ...link, title: 'Edited link', uri: 'https://example.test/edited' };
        if (mode === 'remove') rows = softDeleteAttachment(rows, link.id, AT);
        const payloadJSON = ` \n${edit(opening(), { attachments: rows })}\n`, deps = ports();
        expect(validateNativeAttachmentDraftBeginV3({ taskID: 'task', payloadJSON }, deps))
            .toEqual({ version: 3, taskID: 'task', payloadJSON });
        expect(validateNativeAttachmentDraftLineageV3(input({ initialPayloadJSON: payloadJSON, beforePayloadJSON: payloadJSON })))
            .toEqual({ version: 3, taskID: 'task', payloadJSON });
        expect(validateNativeAttachmentDraftBegin({ taskID: 'task', payloadJSON }, ports()).version).toBe(1);
        expect(() => validateNativeAttachmentDraftBeginV2({ taskID: 'task', payloadJSON }, ports())).toThrow('INVALID_INPUT');
    });

    it('retains link gaps around real Add/Remove preparation and Discard plans only the Add', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(AT);
        const dead = { ...baseline, id: 'tombstone', uri: ROOT + 'dead.pdf', deletedAt: AT };
        const initial = edit(opening([baseline, dead, link]), { attachments: [newLink(100), baseline, dead, link] });
        const first = await add(input({ initialPayloadJSON: initial, beforePayloadJSON: initial }));
        const rows = softDeleteAttachment(JSON.parse(first.afterPayloadJSON).attachments, id(100), AT);
        rows[3] = { ...link, title: 'Edited link', uri: 'https://example.test/edited' };
        const before = ` \n${edit(first.afterPayloadJSON, { attachments: [rows[3], rows[1], rows[0], rows[2], rows[4], newLink(101)],
            raw: { notes: 'Ordinary input @literal', opaque: ['保留', null] } })}\n`;
        const r = remove(input({ initialPayloadJSON: initial, beforePayloadJSON: before, priorOperations: [taggedAdd(first)] }), first.requestId);
        const latest = ` \n${edit(r.afterPayloadJSON, { attachments: softDeleteAttachment(JSON.parse(r.afterPayloadJSON).attachments, id(101), AT),
            raw: { notes: 'Last ordinary input', opaque: ['保留', null] } })}\n`;
        const history = [taggedAdd(first), taggedRemove(r)], frozen = JSON.stringify(history);
        expect(validateNativeAttachmentDraftLineageV3(input({ initialPayloadJSON: initial, beforePayloadJSON: latest, priorOperations: history })))
            .toEqual({ version: 3, taskID: 'task', payloadJSON: latest });
        expect(first.beforePayloadJSON).toBe(initial); expect(r.beforePayloadJSON).toBe(before);
        expect(JSON.parse(latest).attachmentsBase).toEqual([baseline, dead, link]);
        expect(JSON.parse(latest).attachments.filter((row: Attachment) => row.kind === 'file'))
            .toEqual(JSON.parse(r.afterPayloadJSON).attachments.filter((row: Attachment) => row.kind === 'file'));
        expect(prepareNativeAttachmentDraftDiscardCandidatesV3({ version: 2, historyVersion: 3, taskID: 'task',
            managedDirectoryURI: ROOT, initialPayloadJSON: initial, checkpointPayloadJSON: latest,
            operations: history.map((entry) => ({ kind: entry.kind, phase: 'checkpointed', preparedJSON: JSON.stringify(entry.operation) })) }).candidates)
            .toEqual([{ requestId: first.requestId, targetURI: first.targetURI, reason: 'uncommitted-draft' }]);
        expect(JSON.stringify(history)).toBe(frozen);
    });

    it.each(['id', 'kind', 'title', 'uri', 'mimeType', 'size', 'createdAt', 'updatedAt', 'cloudKey', 'fileHash',
        'contentRev', 'contentMtimeMs', 'contentSize', 'pendingContentUpload', 'localStatus', 'deletedAt',
        'dropMetadata', 'omit', 'extraFile', 'reorderFiles', 'undelete'])(
        'refuses file %s drift at opening, between operations, and current checkpoint', async (mode) => {
            const dead = { ...baseline, id: 'tombstone', uri: ROOT + 'dead.pdf', deletedAt: AT };
            const initial = opening([baseline, dead, link]);
            const first = await add(input({ initialPayloadJSON: initial, beforePayloadJSON: initial }));
            const r = remove(input({ initialPayloadJSON: initial, beforePayloadJSON: first.afterPayloadJSON,
                priorOperations: [taggedAdd(first)] }), first.requestId);
            const changed = (encoded: string): string => {
                const rows: Attachment[] = copy(JSON.parse(encoded).attachments);
                if (mode === 'dropMetadata') delete rows[0].cloudKey;
                else if (mode === 'omit') rows.shift();
                else if (mode === 'extraFile') rows.push({ ...baseline, id: 'foreign-file' });
                else if (mode === 'reorderFiles') [rows[0], rows[1]] = [rows[1], rows[0]];
                else if (mode === 'undelete') delete rows[1].deletedAt;
                else Object.assign(rows[0], { [mode]: mode === 'kind' ? 'link'
                    : mode === 'pendingContentUpload' ? false : mode === 'localStatus' ? 'available'
                        : ['size', 'contentRev', 'contentMtimeMs', 'contentSize'].includes(mode) ? 9
                            : ['createdAt', 'updatedAt', 'deletedAt'].includes(mode) ? '2026-10-06T00:00:00.000Z' : 'changed' });
                return edit(encoded, { attachments: rows });
            };
            const openingGap = changed(initial), deps = ports();
            expect(() => validateNativeAttachmentDraftBeginV3({ taskID: 'task', payloadJSON: openingGap }, deps)).toThrow('INVALID_INPUT');
            expect(() => validateNativeAttachmentDraftLineageV3(input({ initialPayloadJSON: openingGap, beforePayloadJSON: openingGap })))
                .toThrow('INVALID_INPUT');
            const before = changed(r.beforePayloadJSON), gapRemove = { ...r, beforePayloadJSON: before,
                afterPayloadJSON: edit(before, { attachments: softDeleteAttachment(JSON.parse(before).attachments, r.attachmentId, r.removedAt) }) };
            expect(readNativeAttachmentDraftRemoveFrozen(gapRemove)).toEqual(gapRemove);
            expect(() => validateNativeAttachmentDraftLineageV3(input({ initialPayloadJSON: initial,
                beforePayloadJSON: gapRemove.afterPayloadJSON, priorOperations: [taggedAdd(first), taggedRemove(gapRemove)] }))).toThrow('INVALID_INPUT');
            expect(() => validateNativeAttachmentDraftLineageV3(input({ initialPayloadJSON: initial,
                beforePayloadJSON: changed(r.afterPayloadJSON), priorOperations: [taggedAdd(first), taggedRemove(r)] }))).toThrow('INVALID_INPUT');
            expect(deps.assertEditable).not.toHaveBeenCalled();
        });

    it.each(['url', 'id', 'createdAt', 'updatedAt', 'deletedAt', 'metadata', 'kind', 'duplicate', 'omit', 'changedKind'])(
        'refuses malformed link %s at opening and current gap before fresh file policy', async (mode) => {
            const first = await add(), rows = (encoded: string): Attachment[] => {
                const value: Attachment[] = copy(JSON.parse(encoded).attachments), added = newLink(100);
                if (mode === 'url') added.uri = 'https://';
                if (mode === 'id') added.id = 'noncanonical-link';
                if (mode === 'createdAt' || mode === 'updatedAt' || mode === 'deletedAt') added[mode] = '2026-10-05';
                if (mode === 'metadata') added.cloudKey = 'forged';
                if (mode === 'kind') added.kind = 'file';
                if (mode === 'duplicate') added.id = link.id;
                if (mode === 'omit') value.splice(1, 1);
                if (mode === 'changedKind') value[1] = { ...link, kind: 'file' };
                return [...value, added];
            };
            const initial = edit(opening(), { attachments: rows(opening()) }), deps = ports();
            expect(() => validateNativeAttachmentDraftBeginV3({ taskID: 'task', payloadJSON: initial }, deps)).toThrow('INVALID_INPUT');
            const current = input({ beforePayloadJSON: edit(first.afterPayloadJSON, { attachments: rows(first.afterPayloadJSON) }),
                priorOperations: [taggedAdd(first)] });
            expect(() => validateNativeAttachmentDraftLineageV3(current)).toThrow('INVALID_INPUT');
            const policy = vi.spyOn(upload, 'validateAttachmentForUpload');
            await expect(prepareNativeAttachmentDraftAddV3({ ...current, requestId: id(3), picked, measuredSize: 3 }, deps)).rejects.toThrow('INVALID_INPUT');
            expect(policy).not.toHaveBeenCalled(); expect(deps.assertEditable).not.toHaveBeenCalled();
        });

    it('refuses an Add UUID already used by an ordinary link before upload policy', async () => {
        const initial = edit(opening(), { attachments: [baseline, link, newLink(1)] }), policy = vi.spyOn(upload, 'validateAttachmentForUpload');
        expect(validateNativeAttachmentDraftLineageV3(input({ initialPayloadJSON: initial, beforePayloadJSON: initial })).version).toBe(3);
        await expect(add(input({ initialPayloadJSON: initial, beforePayloadJSON: initial }))).rejects.toThrow('INVALID_INPUT');
        expect(policy).not.toHaveBeenCalled();
    });

    it.each(['add', 'remove'])('rejects a link mutation inside a frozen file %s transform', async (mode) => {
        const first = await add(), r = remove(input({ beforePayloadJSON: first.afterPayloadJSON, priorOperations: [taggedAdd(first)] }));
        const operation = copy(mode === 'add' ? first : r);
        operation.afterPayloadJSON = edit(operation.afterPayloadJSON, {
            attachments: [...JSON.parse(operation.afterPayloadJSON).attachments, newLink(100)],
        });
        if (mode === 'add') expect(() => readNativeAttachmentDraftFrozen(operation)).toThrow('INVALID_INPUT');
        else expect(() => readNativeAttachmentDraftRemoveFrozen(operation)).toThrow('INVALID_INPUT');
        const history = mode === 'add' ? [taggedAdd(operation as NativeAttachmentDraftPrepared)]
            : [taggedAdd(first), taggedRemove(operation as NativeAttachmentDraftRemovePrepared)];
        expect(() => validateNativeAttachmentDraftLineageV3(input({ beforePayloadJSON: operation.afterPayloadJSON, priorOperations: history })))
            .toThrow('INVALID_INPUT');
    });

    it('keeps V1/V2 historical link-gap equality sealed', async () => {
        const first = await add(), current = edit(first.afterPayloadJSON, { attachments: [...JSON.parse(first.afterPayloadJSON).attachments, newLink(100)] });
        const second = await add(input({ beforePayloadJSON: current, priorOperations: [taggedAdd(first)] }), id(3));
        for (const version of [1, 2] as const) {
            const validate = version === 1 ? validateNativeAttachmentDraftLineage : validateNativeAttachmentDraftLineageV2;
            const value = { version, taskID: 'task', initialPayloadJSON: opening(), managedDirectoryURI: ROOT };
            expect(() => validate({ ...value, beforePayloadJSON: current, priorAdditions: [first] })).toThrow('INVALID_INPUT');
            expect(() => validate({ ...value, beforePayloadJSON: second.afterPayloadJSON, priorAdditions: [first, second] })).toThrow('INVALID_INPUT');
        }
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
    }, 30_000);

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
