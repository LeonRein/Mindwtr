import { describe, expect, it, vi } from 'vitest';
import { prepareNativeAttachmentDraftAddV3, prepareNativeAttachmentDraftAddV4, prepareNativeAttachmentDraftRemoveV4,
    completeNativeAttachmentDraftAdd, completeNativeAttachmentDraftAddV4, readNativeAttachmentDraftFrozen,
    readNativeAttachmentDraftFrozenV2, validateNativeAttachmentDraftLineageV3, validateNativeAttachmentDraftLineageV4,
    validateNativeAttachmentDraftBeginV4, type NativeAttachmentDraftOperationV4 } from './native-attachment-draft';
import { prepareNativeAttachmentDraftDiscardCandidatesV3, prepareNativeAttachmentDraftDiscardCandidatesV4 } from './native-attachment-draft-discard';
import { softDeleteAttachment } from './attachment-editor-model';
import type { Attachment } from './types';
const ROOT = 'file:///owned/documents/attachments/', HASH = 'a'.repeat(64), AT = '2026-10-06T00:00:00.000Z';
const id = (n: number) => `${n.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
const ports = () => ({ assertEditable: vi.fn(), t: (key: string) => key });
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const payload = (rows: Attachment[] = []) => JSON.stringify({ version: 2, taskID: 'task', attachmentsOwned: true,
    attachmentsBase: rows, attachments: rows, raw: { notes: 'é / 保留' } });
const lineage = (beforePayloadJSON = payload(), priorOperations: NativeAttachmentDraftOperationV4[] = [], initialPayloadJSON = payload()) =>
    ({ version: 4 as const, taskID: 'task', initialPayloadJSON, beforePayloadJSON, priorOperations, managedDirectoryURI: ROOT });
const picked = { uri: 'file:///cache/processed.png', name: 'Photo.png', mimeType: 'image/png', size: 999999 };
async function add(input = lineage(), requestId = id(1)) {
    const result = await prepareNativeAttachmentDraftAddV4({ ...input, requestId, picked, measuredSize: 7, sourceSha256: HASH }, ports());
    if (result.kind !== 'prepared') throw Error('Fixture refused');
    return result;
}
describe('selected v4 hash-bearing mixed history', () => {
    it('binds captured SHA to source and completed metadata, preserving policy metadata and measured size', async () => {
        const frozen = await add();
        expect(frozen.version).toBe(2); expect(frozen.sourceSha256).toBe(HASH);
        expect(frozen.prepared.attachment.fileHash).toBe(HASH); expect(frozen.attachment.fileHash).toBe(HASH);
        expect(frozen.attachment.size).toBe(7); expect(frozen.picked.size).toBe(999999);
        expect(JSON.parse(frozen.afterPayloadJSON).attachments[0]).toEqual(frozen.attachment);
        expect(readNativeAttachmentDraftFrozenV2(copy(frozen))).toEqual(frozen);
        expect(await completeNativeAttachmentDraftAddV4({ prepared: frozen }, ports())).toMatchObject({ version: 2, kind: 'added', attachment: frozen.attachment });
        expect(() => readNativeAttachmentDraftFrozen(frozen)).toThrow('INVALID_INPUT');
        await expect(completeNativeAttachmentDraftAdd({ prepared: frozen }, ports())).rejects.toThrow('INVALID_INPUT');
        const old = await prepareNativeAttachmentDraftAddV3({ ...lineage(), version: 3, requestId: id(2), picked, measuredSize: 7 }, ports());
        expect(old.kind).toBe('prepared'); if (old.kind !== 'prepared') return;
        expect(old.attachment).not.toHaveProperty('fileHash'); expect(old).not.toHaveProperty('sourceSha256');
        expect(() => readNativeAttachmentDraftFrozenV2(old)).toThrow('INVALID_INPUT');
        await expect(prepareNativeAttachmentDraftAddV3({ ...lineage(), version: 3, requestId: id(3), picked, measuredSize: 7, sourceSha256: HASH }, ports())).rejects.toThrow('INVALID_INPUT');
    });
    it('refuses missing, malformed and independently tampered digest fields and full payload effect', async () => {
        const frozen = await add();
        for (const hash of [null, '', 'A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)]) {
            await expect(prepareNativeAttachmentDraftAddV4({ ...lineage(), requestId: id(2), picked, measuredSize: 7, sourceSha256: hash }, ports())).rejects.toThrow('INVALID_INPUT');
        }
        for (const mutate of [
            (value: any) => { value.sourceSha256 = 'b'.repeat(64); },
            (value: any) => { value.prepared.attachment.fileHash = 'b'.repeat(64); },
            (value: any) => { value.attachment.fileHash = 'b'.repeat(64); },
            (value: any) => { const after = JSON.parse(value.afterPayloadJSON); after.attachments[0].fileHash = 'b'.repeat(64); value.afterPayloadJSON = JSON.stringify(after); },
        ]) { const changed = copy(frozen) as any; mutate(changed); expect(() => readNativeAttachmentDraftFrozenV2(changed)).toThrow('INVALID_INPUT'); }
    });
    it('keeps Add/Remove/Add hash identities and selects Discard3/history4 while sealing old pairs', async () => {
        const first = await add(), prior: NativeAttachmentDraftOperationV4[] = [{ kind: 'add', operation: first }];
        const removed = prepareNativeAttachmentDraftRemoveV4({ ...lineage(first.afterPayloadJSON, prior), requestId: id(2), attachmentId: id(1) }, ports());
        expect(removed.version).toBe(1); prior.push({ kind: 'remove', operation: removed });
        const second = await add(lineage(removed.afterPayloadJSON, prior), id(3)); prior.push({ kind: 'add', operation: second });
        expect(validateNativeAttachmentDraftLineageV4(lineage(second.afterPayloadJSON, prior)).version).toBe(4);
        expect(() => validateNativeAttachmentDraftLineageV3({ ...lineage(second.afterPayloadJSON, prior), version: 3 })).toThrow('INVALID_INPUT');
        const input = { version: 3, historyVersion: 4, taskID: 'task', managedDirectoryURI: ROOT, initialPayloadJSON: payload(),
            checkpointPayloadJSON: second.afterPayloadJSON, operations: prior.map((entry) => ({ kind: entry.kind, phase: 'checkpointed', preparedJSON: JSON.stringify(entry.operation) })) };
        expect(prepareNativeAttachmentDraftDiscardCandidatesV4(input)).toMatchObject({ version: 3, historyVersion: 4,
            candidates: [{ requestId: id(1), targetURI: first.targetURI }, { requestId: id(3), targetURI: second.targetURI }] });
        expect(() => prepareNativeAttachmentDraftDiscardCandidatesV3(input)).toThrow('INVALID_INPUT');
        expect(() => prepareNativeAttachmentDraftDiscardCandidatesV4({ ...input, historyVersion: 3 })).toThrow('INVALID_INPUT');
        expect(validateNativeAttachmentDraftBeginV4({ taskID: 'task', payloadJSON: payload() }, ports()).version).toBe(4);
    });
    it('admits empty and 128 mixed operations, refuses 129 and actual escaped aggregate overflow', async () => {
        const template = await add(), initial = payload(), operations: NativeAttachmentDraftOperationV4[] = []; let before = initial;
        for (let n = 0; n < 128; n++) {
            const requestId = id(n + 1), value = JSON.parse(before);
            if (n % 2 === 0) {
                const prepared = { ...template.prepared, attachment: { ...template.prepared.attachment, id: requestId } };
                const targetURI = ROOT + requestId + '.png', attachment = { ...prepared.attachment, uri: targetURI };
                value.attachments.push(attachment); const after = JSON.stringify(value);
                operations.push({ kind: 'add', operation: { ...template, requestId, prepared, targetURI, attachment,
                    beforePayloadJSON: before, afterPayloadJSON: after } }); before = after;
            } else {
                value.attachments = softDeleteAttachment(value.attachments, id(n), AT); const after = JSON.stringify(value);
                operations.push({ kind: 'remove', operation: { version: 1, kind: 'prepared-file-remove', taskID: 'task', requestId,
                    attachmentId: id(n), removedAt: AT, beforePayloadJSON: before, afterPayloadJSON: after } }); before = after;
            }
        }
        expect(validateNativeAttachmentDraftLineageV4(lineage()).version).toBe(4);
        expect(validateNativeAttachmentDraftLineageV4(lineage(before, operations, initial)).version).toBe(4);
        const requestId = id(129), prepared = { ...template.prepared, attachment: { ...template.prepared.attachment, id: requestId } };
        const targetURI = ROOT + requestId + '.png', attachment = { ...prepared.attachment, uri: targetURI };
        const after = JSON.parse(before); after.attachments.push(attachment);
        const last = { ...template, requestId, prepared, targetURI, attachment, beforePayloadJSON: before, afterPayloadJSON: JSON.stringify(after) };
        expect(readNativeAttachmentDraftFrozenV2(last)).toEqual(last);
        expect(operations.some((entry) => entry.operation.requestId === requestId)).toBe(false);
        const overCount = lineage(last.afterPayloadJSON, [...operations, { kind: 'add', operation: last }], initial);
        expect(new TextEncoder().encode(JSON.stringify(overCount)).byteLength).toBeLessThan(8 * 1024 * 1024);
        expect(() => validateNativeAttachmentDraftLineageV4(overCount)).toThrow('INVALID_INPUT');
        const oversized = copy(operations); for (const entry of oversized) { entry.operation.beforePayloadJSON += '\n'.repeat(50000); entry.operation.afterPayloadJSON += '\n'.repeat(50000); }
        expect(() => validateNativeAttachmentDraftLineageV4(lineage(before, oversized, initial))).toThrow('INVALID_INPUT');
    }, 30000);
});
