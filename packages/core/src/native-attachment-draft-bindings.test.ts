import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateNativeAttachmentDraftBeginV3, validateNativeAttachmentDraftLineageV3,
    prepareNativeAttachmentDraftAddV3, prepareNativeAttachmentDraftRemoveV3,
    readNativeAttachmentDraftRemoveFrozen, createNativeHostContract } from './index';

const AT = '2026-10-05T00:00:00.000Z';
const ROOT = 'file:///owned/documents/attachments/';
const attachment = { id: 'baseline', kind: 'file', title: 'Original', uri: ROOT + 'baseline.pdf', createdAt: AT, updatedAt: AT };
const payloadJSON = ` \n${JSON.stringify({ version: 2, taskID: 'task', attachmentsOwned: true,
    attachmentsBase: [attachment], attachments: [attachment], raw: { notes: 'Keep exact opaque bytes' } })}\n`;
const deps = () => ({ assertEditable: vi.fn(), t: (key: string) => key });
const lineage = { version: 3, taskID: 'task', initialPayloadJSON: payloadJSON,
    beforePayloadJSON: payloadJSON, priorOperations: [], managedDirectoryURI: ROOT };

describe('private mixed-draft core exports and contract factory', () => {
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

    it('explicit V3 Begin preserves exact bytes and requires current editability', () => {
        const ports = deps();
        expect(validateNativeAttachmentDraftBeginV3({ taskID: 'task', payloadJSON }, ports))
            .toEqual({ version: 3, taskID: 'task', payloadJSON });
        expect(ports.assertEditable).toHaveBeenCalledExactlyOnceWith('task');
        expect(() => validateNativeAttachmentDraftBeginV3({ taskID: 'task', payloadJSON, version: 3 }, ports)).toThrow('INVALID_INPUT');
        ports.assertEditable.mockImplementation(() => { throw Error('NOT_READY'); });
        expect(() => validateNativeAttachmentDraftBeginV3({ taskID: 'task', payloadJSON }, ports)).toThrow('NOT_READY');
    });

    it.each(['depth', 'prototype', 'nodes'])('V3 Begin and lineage refuse initial %s before policy', (kind) => {
        const opening = JSON.parse(payloadJSON);
        if (kind === 'depth') {
            let value: unknown = null;
            for (let depth = 0; depth < 65; depth++) value = { value };
            opening.raw = value;
        } else if (kind === 'prototype') opening.raw = JSON.parse('{"__proto__":{"secret":"retained"}}');
        else opening.raw = Array(100_001).fill(null);
        const invalidJSON = JSON.stringify(opening), ports = deps();
        expect(() => validateNativeAttachmentDraftBeginV3({ taskID: 'task', payloadJSON: invalidJSON }, ports)).toThrow('INVALID_INPUT');
        expect(() => validateNativeAttachmentDraftLineageV3({ ...lineage,
            initialPayloadJSON: invalidJSON, beforePayloadJSON: invalidJSON })).toThrow('INVALID_INPUT');
        expect(ports.assertEditable).not.toHaveBeenCalled();
    });

    it('exported Remove -> Add lineage retains frozen timestamp and opaque checkpoint', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(AT);
        const removed = prepareNativeAttachmentDraftRemoveV3({ ...lineage,
            requestId: '25700000-0000-4000-8000-000000000001', attachmentId: 'baseline' }, deps());
        expect(removed.removedAt).toBe(AT);
        const next = { ...lineage, beforePayloadJSON: removed.afterPayloadJSON,
            priorOperations: [{ kind: 'remove' as const, operation: removed }] };
        const added = await prepareNativeAttachmentDraftAddV3({ ...next,
            requestId: '25700000-0000-4000-8000-000000000002',
            picked: { uri: 'file:///cache/picked.pdf', name: 'Picked.pdf', mimeType: null, size: null }, measuredSize: 3 }, deps());
        expect(added.kind).toBe('prepared');
        if (added.kind !== 'prepared') throw Error('Fixture refused');
        vi.setSystemTime('2027-01-01T00:00:00.000Z');
        expect(readNativeAttachmentDraftRemoveFrozen(removed)).toEqual(removed);
        expect(validateNativeAttachmentDraftLineageV3({ ...next, beforePayloadJSON: added.afterPayloadJSON,
            priorOperations: [...next.priorOperations, { kind: 'add', operation: added }] }))
            .toEqual({ version: 3, taskID: 'task', payloadJSON: added.afterPayloadJSON });
        expect(JSON.parse(added.afterPayloadJSON).raw).toEqual(JSON.parse(payloadJSON).raw);
    });

    it('real contract includes distinct mixed Save methods, preserving old names and readiness', async () => {
        const contract = createNativeHostContract();
        expect(typeof contract.prepareOwnedEditorFileAddTaskDraftSave).toBe('function');
        expect(typeof contract.prepareOwnedEditorFileEditTaskDraftSave).toBe('function');
        expect(typeof contract.validatePreparedOwnedEditorFileEditTaskDraftSave).toBe('function');
        expect(typeof contract.commitPreparedOwnedEditorFileEditTaskDraftSave).toBe('function');
        const prepared = await contract.prepareOwnedEditorFileEditTaskDraftSave({} as never);
        expect(prepared.ok).toBe(false);
        if (!prepared.ok) expect(prepared.error.code).toBe('NOT_READY');
        const validation = contract.validatePreparedOwnedEditorFileEditTaskDraftSave({} as never);
        expect(validation.ok).toBe(false);
        if (!validation.ok) expect(validation.error.code).toBe('INVALID_INPUT');
        const commit = await contract.commitPreparedOwnedEditorFileEditTaskDraftSave({} as never);
        expect(commit.ok).toBe(false);
        if (!commit.ok) expect(commit.error.code).toBe('NOT_READY');
    });
});
