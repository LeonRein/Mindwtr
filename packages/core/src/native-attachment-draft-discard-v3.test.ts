import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareNativeAttachmentDraftDiscardCandidatesV3 as candidates,
    prepareNativeAttachmentDraftDiscardCandidates as legacy,
    type NativeAttachmentDraftDiscardInputV3, type NativeAttachmentDraftDiscardPhase } from './native-attachment-draft-discard';
import { prepareNativeAttachmentDraftAddV3, prepareNativeAttachmentDraftRemoveV3,
    readNativeAttachmentDraftFrozen, readNativeAttachmentDraftRemoveFrozen,
    type NativeAttachmentDraftOperationV3, type NativeAttachmentDraftPrepared,
    type NativeAttachmentDraftRemovePrepared } from './native-attachment-draft';
import { softDeleteAttachment } from './attachment-editor-model';
import { getManagedAttachmentFileName } from './mobile-attachment-files';
import * as upload from './attachment-validation';
import * as settlement from './attachment-draft-settlement';
import type { Attachment } from './types';

const ERROR = 'INVALID_INPUT: A bounded retained attachment Discard history is required';
const ROOT = 'file:///owned/documents/attachments/';
const AT = '2026-10-05T00:00:00.000Z';
const id = (n: number) => `${n.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
const file: Attachment = { id: 'saved-file', kind: 'file', title: 'Saved', uri: ROOT + 'saved.pdf',
    createdAt: AT, updatedAt: AT, cloudKey: 'retained-cloud' };
const dead: Attachment = { ...file, id: 'tombstone', uri: ROOT + 'deleted.pdf', deletedAt: AT };
const link: Attachment = { id: 'saved-link', kind: 'link', title: 'Link', uri: 'https://example.test', createdAt: AT, updatedAt: AT };
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const opening = (rows: Attachment[] = [file, dead, link], extra = '') => JSON.stringify({ version: 2, taskID: 'task',
    attachmentsOwned: true, attachmentsBase: rows, attachments: rows, raw: { notes: '保留', extra } });
const edit = (json: string, patch: Record<string, unknown>) => JSON.stringify({ ...JSON.parse(json), ...patch });
const taggedAdd = (operation: NativeAttachmentDraftPrepared): NativeAttachmentDraftOperationV3 => ({ kind: 'add', operation });
const taggedRemove = (operation: NativeAttachmentDraftRemovePrepared): NativeAttachmentDraftOperationV3 => ({ kind: 'remove', operation });
const ports = () => ({ assertEditable: vi.fn(), t: (key: string) => key });
const lineage = (history: NativeAttachmentDraftOperationV3[] = [], before = history.at(-1)?.operation.afterPayloadJSON ?? opening(), initial = opening()) => ({
    version: 3, taskID: 'task', managedDirectoryURI: ROOT, initialPayloadJSON: initial, beforePayloadJSON: before, priorOperations: history,
});
async function add(history: NativeAttachmentDraftOperationV3[] = [], before?: string, requestId = id(1), initial = opening()): Promise<NativeAttachmentDraftPrepared> {
    const result = await prepareNativeAttachmentDraftAddV3({ ...lineage(history, before, initial), requestId,
        picked: { uri: 'file:///cache/private.pdf', name: 'Picked.pdf', mimeType: null, size: null }, measuredSize: 3 }, ports());
    if (result.kind !== 'prepared') throw Error('Fixture refused');
    return result;
}
const remove = (history: NativeAttachmentDraftOperationV3[] = [], attachmentId = file.id, requestId = id(2), before?: string, initial = opening()) =>
    prepareNativeAttachmentDraftRemoveV3({ ...lineage(history, before, initial), requestId, attachmentId }, ports());
function request(history: NativeAttachmentDraftOperationV3[] = [], checkpoint = history.at(-1)?.operation.afterPayloadJSON ?? opening(), initial = opening()): NativeAttachmentDraftDiscardInputV3 {
    return { version: 2, historyVersion: 3, taskID: 'task', managedDirectoryURI: ROOT, initialPayloadJSON: initial,
        checkpointPayloadJSON: checkpoint, operations: history.map((entry) => ({ kind: entry.kind,
            phase: 'checkpointed', preparedJSON: JSON.stringify(entry.operation) })) };
}
const reject = (value: unknown) => expect(() => candidates(value)).toThrow(ERROR);
const expected = (operation: NativeAttachmentDraftPrepared) => ({ requestId: operation.requestId,
    targetURI: operation.targetURI, reason: 'uncommitted-draft' });
async function mixed() {
    const first = await add(), r1 = remove([taggedAdd(first)], first.requestId);
    const history = [taggedAdd(first), taggedRemove(r1)];
    const notes = ` \n${edit(r1.afterPayloadJSON, { raw: { notes: 'Later @literal 文', retained: ['e\u0301', null] } })}\n`;
    const second = await add(history, notes, id(3)); history.push(taggedAdd(second));
    const r2 = remove(history, file.id, id(4)); history.push(taggedRemove(r2));
    return { first, r1, notes, second, r2, history };
}
const pendingPhases: NativeAttachmentDraftDiscardPhase[] = ['intent', 'stagePrepared', 'stageFilled', 'published', 'resultDurable'];

describe('sealed pure mixed V3 Discard candidates', () => {
    afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

    it('returns exact frozen empty candidates for empty and baseline-Remove-only histories', () => {
        const removed = remove();
        for (const value of [request(), request([taggedRemove(removed)])]) {
            const result = candidates(value);
            expect(result).toEqual({ version: 2, kind: 'owned-mixed-discard-candidates', taskID: 'task', historyVersion: 3, candidates: [] });
            expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.candidates)).toBe(true);
        }
    });

    it('plans the actual latest mixed projection in Add order without baseline/tombstone cleanup or fresh policy', async () => {
        const f = await mixed(), checkpoint = ` \n${edit(f.r2.afterPayloadJSON, { notes: 'Raw after final Remove' })}\n`;
        const value = request(f.history, checkpoint), before = copy(value), planner = vi.spyOn(settlement, 'planAttachmentDraftSettlement');
        const policy = vi.spyOn(upload, 'validateAttachmentForUpload').mockRejectedValue(Error('private historical policy'));
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2040-01-01T00:00:00.000Z');
        const result = candidates(value);
        expect(result.candidates).toEqual([expected(f.first), expected(f.second)]);
        expect(planner).toHaveBeenCalledExactlyOnceWith({ baselineAttachments: [file, dead, link],
            draftAttachments: JSON.parse(checkpoint).attachments, committedAttachments: [file, dead, link] });
        expect(JSON.parse(checkpoint).attachments.find((row: Attachment) => row.id === f.first.requestId).deletedAt).toBe(f.r1.removedAt);
        expect(result.candidates.every(Object.isFrozen)).toBe(true); expect(value).toEqual(before);
        expect(policy).not.toHaveBeenCalled(); expect(f.second.beforePayloadJSON).toBe(f.notes);
    });

    it.each(pendingPhases)('includes only real Adds when the last Add is pending at %s', async (phase) => {
        const r = remove(), first = await add([taggedRemove(r)]), value = request([taggedRemove(r), taggedAdd(first)], first.beforePayloadJSON);
        value.operations[1] = { kind: 'add', phase, preparedJSON: JSON.stringify(first) };
        expect(candidates(value).candidates).toEqual([expected(first)]);
        reject({ ...value, checkpointPayloadJSON: first.afterPayloadJSON });
        reject({ ...value, checkpointPayloadJSON: ` ${first.beforePayloadJSON}` });
    });

    it.each(['baseline', 'added'] as const)('retains exact pending Remove before and plans only Adds: %s', async (selected) => {
        const first = await add(), r = remove([taggedAdd(first)], selected === 'baseline' ? file.id : first.requestId);
        const value = request([taggedAdd(first), taggedRemove(r)], r.beforePayloadJSON);
        value.operations[1] = { kind: 'remove', phase: 'intent', preparedJSON: JSON.stringify(r) };
        expect(candidates(value).candidates).toEqual([expected(first)]);
        reject({ ...value, checkpointPayloadJSON: r.afterPayloadJSON });
        reject({ ...value, checkpointPayloadJSON: edit(r.beforePayloadJSON, { notes: 'same attachments but different checkpoint' }) });
    });

    it.each(['version', 'historyVersion', 'task', 'root', 'kind', 'phase', 'middlePending', 'duplicate', 'crossKindDuplicate', 'extra', 'missing'])(
        'rejects invalid mixed protocol/history: %s', async (field) => {
            const f = await mixed(), value = copy(request(f.history)) as unknown as Record<string, unknown>;
            const entries = value.operations as Record<string, unknown>[];
            if (field === 'version') value.version = 1;
            if (field === 'historyVersion') value.historyVersion = 2;
            if (field === 'task') value.taskID = 'foreign';
            if (field === 'root') value.managedDirectoryURI = 'file:///foreign/';
            if (field === 'kind') entries[1].kind = 'add';
            if (field === 'phase') entries[1].phase = 'published';
            if (field === 'middlePending') entries[0].phase = 'intent';
            if (field === 'duplicate') entries.push({ ...entries.at(-1)! });
            if (field === 'crossKindDuplicate') entries[1].preparedJSON = JSON.stringify({ ...f.r1, requestId: f.first.requestId });
            if (field === 'extra') value.deletionAuthority = true;
            if (field === 'missing') delete value.checkpointPayloadJSON;
            reject(value);
        });

    it.each(['opaque', 'metadata', 'uri', 'base', 'omit', 'timestamp', 'tag'])(
        'rejects complete frozen Remove mutation: %s', async (field) => {
            const first = await add(), r = copy(remove([taggedAdd(first)], first.requestId)), payload = JSON.parse(r.afterPayloadJSON);
            if (field === 'opaque') payload.raw.notes = 'forged';
            if (field === 'metadata') payload.attachments.at(-1).title = 'forged';
            if (field === 'uri') payload.attachments.at(-1).uri = ROOT + 'foreign.pdf';
            if (field === 'base') payload.attachmentsBase = [];
            if (field === 'omit') payload.attachments.pop();
            if (field === 'timestamp') r.removedAt = '2026-10-05';
            if (field === 'tag') (r as unknown as Record<string, unknown>).kind = 'prepared';
            r.afterPayloadJSON = JSON.stringify(payload);
            reject(request([taggedAdd(first), taggedRemove(r)]));
        });

    it('rejects an Add URI alias to baseline and an Add ID already in baseline', async () => {
        const first = await add(), baseline = { ...file, uri: first.targetURI }, initial = opening([baseline]);
        const collision = await add([], initial, id(1), initial);
        reject(request([taggedAdd(collision)], collision.afterPayloadJSON, initial));
        const row = { ...file, id: id(1) }, sameID = opening([row]);
        const repeated = { ...first, beforePayloadJSON: sameID,
            afterPayloadJSON: edit(sameID, { attachments: [row, first.attachment] }) };
        reject(request([taggedAdd(repeated)], repeated.afterPayloadJSON, sameID));
    });

    it.each(['outerGetter', 'entryGetter', 'arrayGetter', 'iterator', 'toJSON', 'prototype', 'symbol', 'sparse', 'alias', 'cycle'])(
        'captures only own dense data without invoking hostile hooks: %s', (field) => {
            const r = remove(), value = copy(request([taggedRemove(r)])), hook = vi.fn(() => 'private-data');
            const entries = value.operations as unknown[];
            if (field === 'outerGetter') Object.defineProperty(value, 'taskID', { enumerable: true, get: hook });
            if (field === 'entryGetter') Object.defineProperty(entries[0], 'preparedJSON', { enumerable: true, get: hook });
            if (field === 'arrayGetter') Object.defineProperty(entries, '0', { enumerable: true, get: hook });
            if (field === 'iterator') Object.defineProperty(entries, Symbol.iterator, { get: hook });
            if (field === 'toJSON') Object.defineProperty(value, 'toJSON', { get: hook });
            if (field === 'prototype') Object.setPrototypeOf(entries[0], { get toJSON() { return hook(); } });
            if (field === 'symbol') Object.defineProperty(entries, Symbol('extra'), { value: true });
            if (field === 'sparse') delete entries[0];
            if (field === 'alias') entries.push(entries[0]);
            if (field === 'cycle') (entries[0] as Record<string, unknown>).preparedJSON = value;
            reject(value); expect(hook).not.toHaveBeenCalled();
        });

    it.each(['payloadUTF8', 'preparedUTF8', 'aggregate', 'escapedAggregate', 'taskUTF8'])(
        'bounds UTF8 and actual escaped encoding before parsing: %s', (field) => {
            const value = copy(request()) as unknown as Record<string, unknown>;
            if (field === 'payloadUTF8') value.checkpointPayloadJSON = '界'.repeat(333_334);
            if (field === 'preparedUTF8') value.operations = [{ kind: 'remove', phase: 'intent', preparedJSON: '😀'.repeat(524_289) }];
            if (field === 'aggregate') value.operations = Array.from({ length: 5 }, (_, n) =>
                ({ kind: 'remove', phase: n === 4 ? 'intent' : 'checkpointed', preparedJSON: ' '.repeat(2 * 1024 * 1024) }));
            if (field === 'escapedAggregate') value.operations = Array.from({ length: 3 }, (_, n) =>
                ({ kind: 'remove', phase: n === 2 ? 'intent' : 'checkpointed', preparedJSON: '\\'.repeat(2 * 1024 * 1024) }));
            if (field === 'taskUTF8') value.taskID = '界'.repeat(167);
            const parse = vi.spyOn(JSON, 'parse'); reject(value); expect(parse).not.toHaveBeenCalled();
        });

    it.each(['depth', 'nodes', 'number', 'proto', 'constructor', 'malformed', 'attachments'])(
        'rejects hostile parsed payloads without exposing their content: %s', (field) => {
            let json = opening();
            if (field === 'depth') json = edit(json, { raw: JSON.parse('['.repeat(66) + '0' + ']'.repeat(66)) });
            if (field === 'nodes') json = edit(json, { raw: Array(100_001).fill(null) });
            if (field === 'number') json = json.replace(/}$/, ',"overflow":1e400}');
            if (field === 'proto') json = json.replace(/}$/, ',"__proto__":{"private":"file:///private"}}');
            if (field === 'constructor') json = json.replace(/}$/, ',"constructor":{"private":"file:///private"}}');
            if (field === 'malformed') json = '{private raw draft';
            if (field === 'attachments') json = edit(json, { attachments: [] });
            reject({ ...request(), checkpointPayloadJSON: json });
        });

    it('accepts V3 opaque nesting beyond the old Discard depth without touching its grammar', () => {
        const payload = edit(opening(), { raw: JSON.parse('['.repeat(45) + '0' + ']'.repeat(45)) });
        expect(candidates(request([], payload, payload)).candidates).toEqual([]);
        expect(() => legacy({ ...request([], payload, payload), version: 1, historyVersion: 2 })).toThrow(ERROR);
        reject({ ...request(), version: 1, historyVersion: 2 });
        expect(() => legacy(request())).toThrow(ERROR);
    });

    it('accepts 128 mixed entries and rejects 129 before parsing', async () => {
        const initial = opening([]), history: NativeAttachmentDraftOperationV3[] = [], additions: NativeAttachmentDraftPrepared[] = [];
        const template = await add([], initial, id(1), initial);
        let before = initial;
        for (let n = 0; n < 64; n++) {
            const source = { ...template.prepared.attachment, id: id(n * 2 + 10) };
            const targetURI = ROOT + getManagedAttachmentFileName(source), attachment = { ...source, uri: targetURI };
            const after = edit(before, { attachments: [...JSON.parse(before).attachments, attachment] });
            const addition = readNativeAttachmentDraftFrozen({ ...template, requestId: source.id, beforePayloadJSON: before,
                afterPayloadJSON: after, targetURI, attachment, prepared: { kind: 'prepared', attachment: source } });
            history.push(taggedAdd(addition)); additions.push(addition);
            const removed = readNativeAttachmentDraftRemoveFrozen({ version: 1, kind: 'prepared-file-remove', taskID: 'task',
                requestId: id(n * 2 + 11), attachmentId: source.id, removedAt: AT, beforePayloadJSON: after,
                afterPayloadJSON: edit(after, { attachments: softDeleteAttachment(JSON.parse(after).attachments, source.id, AT) }) });
            history.push(taggedRemove(removed)); before = removed.afterPayloadJSON;
        }
        const value = request(history, before, initial);
        expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(8 * 1024 * 1024);
        expect(candidates(value).candidates).toEqual(additions.map(expected));
        const parse = vi.spyOn(JSON, 'parse');
        reject({ ...value, operations: [...value.operations, { ...value.operations.at(-1)! }] });
        expect(parse).not.toHaveBeenCalled();
    }, 15_000);

    it('accepts the exact actual 8MiB input boundary and rejects its next encoded byte', () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(AT);
        const rows = Array.from({ length: 6 }, (_, n) => ({ ...file, id: `large-${n}`, uri: '' }));
        const build = (padding: number) => {
            const initial = opening(rows, 'x'.repeat(padding)), history: NativeAttachmentDraftOperationV3[] = [];
            for (const [n, row] of rows.entries()) history.push(taggedRemove(remove(history, row.id, id(n + 20),
                history.at(-1)?.operation.afterPayloadJSON ?? initial, initial)));
            return request(history, history.at(-1)!.operation.afterPayloadJSON, initial);
        };
        const emptySize = Buffer.byteLength(JSON.stringify(build(0))), value = build(Math.floor((8 * 1024 * 1024 - emptySize) / 14));
        const remaining = 8 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(value));
        expect(remaining).toBeGreaterThanOrEqual(0); expect(remaining).toBeLessThan(14);
        const exact = { ...value, checkpointPayloadJSON: ' '.repeat(remaining) + value.checkpointPayloadJSON };
        expect(Buffer.byteLength(JSON.stringify(exact))).toBe(8 * 1024 * 1024);
        expect(candidates(exact).candidates).toEqual([]);
        const parse = vi.spyOn(JSON, 'parse'); reject({ ...exact, checkpointPayloadJSON: ' ' + exact.checkpointPayloadJSON });
        expect(parse).not.toHaveBeenCalled();
    });

    it('accepts null-prototype data and freezes output without mutating captured strings', () => {
        const r = remove(), value = Object.assign(Object.create(null), request([taggedRemove(r)]));
        value.operations[0] = Object.assign(Object.create(null), value.operations[0]);
        const before = value.operations[0].preparedJSON;
        expect(candidates(value).candidates).toEqual([]); expect(value.operations[0].preparedJSON).toBe(before);
    });
});
