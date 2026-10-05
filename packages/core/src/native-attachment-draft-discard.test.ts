import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareNativeAttachmentDraftDiscardCandidates as candidates,
    type NativeAttachmentDraftDiscardInput, type NativeAttachmentDraftDiscardPhase } from './native-attachment-draft-discard';
import { prepareNativeAttachmentDraftAdd, prepareNativeAttachmentDraftAddV2,
    type NativeAttachmentDraftPrepared } from './native-attachment-draft';
import * as draft from './native-attachment-draft';
import * as editor from './attachment-editor-model';
import * as upload from './attachment-validation';
import * as settlement from './attachment-draft-settlement';
import type { Attachment } from './types';

const ERROR = 'INVALID_INPUT: A bounded retained attachment Discard history is required';
const ROOT = 'file:///owned/documents/attachments/';
const AT = '2026-10-05T00:00:00.000Z';
const ID = '11111111-1111-4111-8111-111111111111';
const NEXT = '22222222-2222-4222-8222-222222222222';
const file: Attachment = { id: 'saved-file', kind: 'file', title: 'Saved', uri: ROOT + 'saved.pdf',
    size: 2, createdAt: AT, updatedAt: AT };
const dead: Attachment = { ...file, id: 'tombstone', uri: ROOT + 'deleted.pdf', deletedAt: AT };
const link: Attachment = { id: 'saved-link', kind: 'link', title: 'Link', uri: 'https://example.test', createdAt: AT, updatedAt: AT };
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const opening = (base: Attachment[] = [file, dead, link]) => JSON.stringify({ version: 2, taskID: 'task',
    attachmentsOwned: true, attachmentsBase: base, attachments: base, raw: { title: '保留', note: '', scheduleEdits: [] } });
const edit = (json: string, fields: Record<string, unknown>) => JSON.stringify({ ...JSON.parse(json), ...fields });
const ports = () => ({ assertEditable: vi.fn(), t: (key: string) => key });
async function add(historyVersion: 1 | 2 = 1, initial = opening(), before = initial,
    prior: NativeAttachmentDraftPrepared[] = [], requestId = ID): Promise<NativeAttachmentDraftPrepared> {
    const factory = historyVersion === 1 ? prepareNativeAttachmentDraftAdd : prepareNativeAttachmentDraftAddV2;
    const result = await factory({ version: historyVersion, taskID: 'task', initialPayloadJSON: initial,
        beforePayloadJSON: before, priorAdditions: prior, managedDirectoryURI: ROOT, requestId,
        picked: { uri: 'file:///cache/borrowed.pdf', name: 'Picked.pdf', mimeType: null, size: null }, measuredSize: 3 }, ports());
    if (result.kind !== 'prepared') throw new Error('Fixture refused');
    return result;
}
function request(additions: NativeAttachmentDraftPrepared[] = [], historyVersion: 1 | 2 = 1,
    checkpoint = additions.at(-1)?.afterPayloadJSON ?? opening(), initial = opening()): NativeAttachmentDraftDiscardInput {
    return { version: 1, historyVersion, taskID: 'task', managedDirectoryURI: ROOT,
        initialPayloadJSON: initial, checkpointPayloadJSON: checkpoint,
        operations: additions.map((prepared) => ({ phase: 'checkpointed', preparedJSON: JSON.stringify(prepared) })) };
}
const pendingPhases: NativeAttachmentDraftDiscardPhase[] = ['intent', 'stagePrepared', 'stageFilled', 'published', 'resultDurable'];
const reject = (value: unknown) => expect(() => candidates(value)).toThrow(ERROR);

describe('pure retained owned Add Discard candidates', () => {
    afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

    it.each([1, 2] as const)('returns an exact frozen empty result for history v%s', (version) => {
        const result = candidates(request([], version));
        expect(result).toEqual({ version: 1, kind: 'owned-add-discard-candidates', taskID: 'task', historyVersion: version, candidates: [] });
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.candidates)).toBe(true);
    });

    it.each([1, 2] as const)('uses real frozen factories and planner, preserving live files/tombstones/links for v%s', async (version) => {
        const first = await add(version), second = await add(version, opening(), first.afterPayloadJSON, [first], NEXT);
        const value = request([first, second], version), snapshot = copy(value);
        const planner = vi.spyOn(settlement, 'planAttachmentDraftSettlement');
        const result = candidates(value);
        expect(result.candidates).toEqual([first, second].map((operation) => ({ requestId: operation.requestId,
            targetURI: operation.targetURI, reason: 'uncommitted-draft' })));
        expect(planner).toHaveBeenCalledExactlyOnceWith({ baselineAttachments: [file, dead, link],
            draftAttachments: [file, dead, link, first.attachment, second.attachment], committedAttachments: [file, dead, link] });
        expect(result.candidates.every(Object.isFrozen)).toBe(true);
        expect(value).toEqual(snapshot);
        expect(result.candidates.some((candidate) => [file.uri, dead.uri, link.uri, first.picked.uri].includes(candidate.targetURI))).toBe(false);
    });

    it.each(pendingPhases)('includes a proposed target at pending %s without treating logical after as checkpoint', async (phase) => {
        const first = await add(), value = request([first], 1, first.beforePayloadJSON);
        value.operations[0] = { phase, preparedJSON: JSON.stringify(first) };
        expect(candidates(value).candidates).toEqual([{ requestId: ID, targetURI: first.targetURI, reason: 'uncommitted-draft' }]);
        reject({ ...value, checkpointPayloadJSON: first.afterPayloadJSON });
    });

    it.each([1, 2] as const)('validates the acknowledged prefix separately from a pending last Add for v%s', async (version) => {
        const first = await add(version), second = await add(version, opening(), first.afterPayloadJSON, [first], NEXT);
        const value = request([first, second], version, second.beforePayloadJSON);
        value.operations[1] = { phase: 'stageFilled', preparedJSON: JSON.stringify(second) };
        expect(candidates(value).candidates.map((candidate) => candidate.requestId)).toEqual([ID, NEXT]);
        reject({ ...value, checkpointPayloadJSON: opening() });
        reject({ ...value, checkpointPayloadJSON: ` ${second.beforePayloadJSON}` });
    });

    it('preserves v2 ordinary/Unicode/opaque spelling before, between and after Adds', async () => {
        const initial = ` \n${opening()}\n`;
        const firstBefore = edit(initial, { raw: { title: '第一', note: '\\u4e00' } });
        const first = await add(2, initial, firstBefore);
        const nextBefore = `\n${edit(first.afterPayloadJSON, { raw: { title: 'Second', opaque: ['😀'] } })} `;
        const second = await add(2, initial, nextBefore, [first], NEXT);
        const latest = ` ${edit(second.afterPayloadJSON, { raw: { title: 'Newest', unknown: { preserved: true } } })}\n`;
        const value = request([first, second], 2, latest, initial), snapshot = copy(value);
        expect(candidates(value).candidates.map((candidate) => candidate.requestId)).toEqual([ID, NEXT]);
        expect(value).toEqual(snapshot);
        reject({ ...value, historyVersion: 1 });
        const pending = request([first, second], 2, nextBefore, initial);
        pending.operations[1] = { phase: 'intent', preparedJSON: JSON.stringify(second) };
        expect(candidates(pending).candidates).toHaveLength(2);
    });

    it('allows initial link-only edits under v1 and keeps v2 initial no-edit boundary sealed', async () => {
        const initial = edit(opening(), { attachments: [file, dead, { ...link, title: 'Changed link' }] });
        const first = await add(1, initial), value = request([first], 1, first.afterPayloadJSON, initial);
        expect(candidates(value).candidates).toHaveLength(1);
        reject({ ...value, historyVersion: 2 });
    });

    it('reads no current clock, IDs, editability/upload policy, completion or persistence', async () => {
        const first = await add(2), value = request([first], 2);
        const policy = vi.spyOn(upload, 'validateAttachmentForUpload').mockRejectedValue(new Error('Settings changed'));
        const complete = vi.spyOn(draft, 'completeNativeAttachmentDraftAdd').mockRejectedValue(new Error('Readonly task'));
        const prepare = vi.spyOn(editor, 'preparePickedAttachment').mockRejectedValue(new Error('No new metadata'));
        const persist = vi.spyOn(editor, 'persistPreparedPickedAttachment').mockRejectedValue(new Error('No IO'));
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('No clock'); });
        expect(candidates(value).candidates[0]).toEqual({ requestId: ID, targetURI: first.targetURI, reason: 'uncommitted-draft' });
        for (const spy of [policy, complete, prepare, persist, clock]) expect(spy).not.toHaveBeenCalled();
    });

    it.each(['title', 'time', 'source', 'size', 'target', 'uuid', 'root', 'after', 'base', 'unknown'])(
        'refuses altered frozen %s with controlled error only', async (field) => {
            const first = copy(await add()), value = request([first]);
            const raw = first as unknown as Record<string, unknown>;
            if (field === 'title') raw.attachment = { ...first.attachment, title: 'UNTRUSTED' };
            if (field === 'time') raw.attachment = { ...first.attachment, createdAt: '2026-10-06T00:00:00.000Z' };
            if (field === 'source') raw.picked = { ...first.picked, uri: 'file:///cache/other.pdf' };
            if (field === 'size') raw.measuredSize = 99;
            if (field === 'target') raw.targetURI = ROOT + 'foreign.pdf';
            if (field === 'uuid') raw.requestId = NEXT;
            if (field === 'root') raw.managedDirectoryURI = 'file:///foreign/';
            if (field === 'after') raw.afterPayloadJSON = edit(first.afterPayloadJSON, { raw: 'Changed frozen ordinary field' });
            if (field === 'base') raw.beforePayloadJSON = edit(first.beforePayloadJSON, { attachmentsBase: [] });
            if (field === 'unknown') raw.copySucceeded = true;
            value.operations[0] = { phase: 'checkpointed', preparedJSON: JSON.stringify(first) };
            reject(value);
        });

    it.each(['task', 'root', 'version', 'historyVersion', 'unknown', 'missing', 'phase', 'notLast', 'duplicate'])(
        'refuses malformed outer history: %s', async (field) => {
            const first = await add(), value = copy(request([first])) as unknown as Record<string, unknown>;
            if (field === 'task') value.taskID = 'foreign';
            if (field === 'root') value.managedDirectoryURI = 'file:///foreign/';
            if (field === 'version') value.version = 2;
            if (field === 'historyVersion') value.historyVersion = 3;
            if (field === 'unknown') value.owner = true;
            if (field === 'missing') delete value.taskID;
            if (field === 'phase') value.operations = [{ phase: 'saved', preparedJSON: JSON.stringify(first) }];
            if (field === 'notLast') value.operations = [{ phase: 'intent', preparedJSON: JSON.stringify(first) },
                { phase: 'checkpointed', preparedJSON: JSON.stringify(first) }];
            if (field === 'duplicate') value.operations = [{ phase: 'checkpointed', preparedJSON: JSON.stringify(first) },
                { phase: 'checkpointed', preparedJSON: JSON.stringify(first) }];
            reject(value);
        });

    it('refuses a target URI already retained by a different opening baseline ID', async () => {
        const first = await add(), baseline = { ...file, uri: first.targetURI };
        const initial = opening([baseline]), collision = await add(1, initial);
        reject(request([collision], 1, collision.afterPayloadJSON, initial));
    });

    it.each(['getter', 'sparse', 'iterator', 'toJSON', 'prototype', 'alias', 'tooMany', 'extra', 'hidden'])(
        'rejects hostile operation arrays without invoking hooks: %s', async (field) => {
            const first = await add(), value = copy(request([first]));
            const operations = value.operations as unknown[], hook = vi.fn(() => operations[0]);
            if (field === 'getter') Object.defineProperty(operations, '0', { get: hook, enumerable: true });
            if (field === 'sparse') delete operations[0];
            if (field === 'iterator') Object.defineProperty(operations, Symbol.iterator, { get: hook });
            if (field === 'toJSON') Object.defineProperty(operations, 'toJSON', { get: hook });
            if (field === 'prototype') Object.setPrototypeOf(operations, Object.create(Array.prototype,
                { toJSON: { get: hook } }));
            if (field === 'alias') operations.push(operations[0]);
            if (field === 'tooMany') operations.length = 129;
            if (field === 'extra') Object.assign(operations, { owned: true });
            if (field === 'hidden') Object.defineProperty(operations, 'hidden', { value: true });
            reject(value); expect(hook).not.toHaveBeenCalled();
        });

    it.each(['outerGetter', 'opGetter', 'outerPrototype', 'opPrototype', 'toJSON', 'symbol', 'cycle'])(
        'rejects unsafe records without accessing caller values: %s', async (field) => {
            const first = await add(), value = copy(request([first])), hook = vi.fn(() => 'secret');
            if (field === 'outerGetter') Object.defineProperty(value, 'taskID', { get: hook, enumerable: true });
            if (field === 'opGetter') Object.defineProperty(value.operations[0], 'preparedJSON', { get: hook, enumerable: true });
            if (field === 'outerPrototype') Object.setPrototypeOf(value, { get toJSON() { return hook(); } });
            if (field === 'opPrototype') Object.setPrototypeOf(value.operations[0], { get toJSON() { return hook(); } });
            if (field === 'toJSON') Object.defineProperty(value, 'toJSON', { get: hook });
            if (field === 'symbol') Object.defineProperty(value, Symbol('hidden'), { value: true });
            if (field === 'cycle') (value.operations[0] as unknown as Record<string, unknown>).preparedJSON = value;
            reject(value); expect(hook).not.toHaveBeenCalled();
        });

    it.each(['initialUTF8', 'checkpointUTF8', 'preparedUTF8', 'aggregate', 'escapedAggregate', 'taskUTF8'])(
        'refuses actual UTF8/serialized capacity before parsing: %s', (field) => {
            const value = copy(request()) as unknown as Record<string, unknown>;
            if (field === 'initialUTF8') value.initialPayloadJSON = '界'.repeat(333_334);
            if (field === 'checkpointUTF8') value.checkpointPayloadJSON = '😀'.repeat(250_001);
            if (field === 'preparedUTF8') value.operations = [{ phase: 'intent', preparedJSON: '界'.repeat(699_051) }];
            if (field === 'aggregate') value.operations = Array.from({ length: 5 }, (_, index) =>
                ({ phase: index === 4 ? 'intent' : 'checkpointed', preparedJSON: ' '.repeat(2 * 1024 * 1024) }));
            if (field === 'escapedAggregate') value.operations = Array.from({ length: 3 }, (_, index) =>
                ({ phase: index === 2 ? 'intent' : 'checkpointed', preparedJSON: '\\'.repeat(2 * 1024 * 1024) }));
            if (field === 'taskUTF8') value.taskID = '界'.repeat(167);
            const parse = vi.spyOn(JSON, 'parse');
            reject(value); expect(parse).not.toHaveBeenCalled();
        });

    it.each(['depth', 'nodes', 'number', 'malformed', 'unowned', 'attachmentDrift'])(
        'refuses unsafe opaque payload graphs before lineage: %s', (field) => {
            const value = copy(request());
            let json = opening();
            if (field === 'depth') json = edit(json, { raw: JSON.parse('['.repeat(42) + '0' + ']'.repeat(42)) });
            if (field === 'nodes') json = edit(json, { raw: Array(100_001).fill(null) });
            if (field === 'number') json = json.replace(/}$/, ',"overflow":1e400}');
            if (field === 'malformed') json = '{not-json';
            if (field === 'unowned') json = edit(json, { attachmentsOwned: false });
            if (field === 'attachmentDrift') json = edit(json, { attachments: [] });
            reject({ ...value, checkpointPayloadJSON: json });
        });

    it('bounds opaque nested frozen metadata before the existing frozen reader', async () => {
        const first = copy(await add()), raw = first as unknown as Record<string, unknown>;
        raw.prepared = JSON.parse('['.repeat(42) + '0' + ']'.repeat(42));
        const read = vi.spyOn(draft, 'readNativeAttachmentDraftFrozen');
        reject({ ...request(), operations: [{ phase: 'intent', preparedJSON: JSON.stringify(first) }] });
        expect(read).not.toHaveBeenCalled();
    });

    it('accepts null-prototype data records without serialization hooks', async () => {
        const first = await add(), value = Object.assign(Object.create(null), request([first]));
        value.operations[0] = Object.assign(Object.create(null), value.operations[0]);
        expect(candidates(value).candidates[0].requestId).toBe(ID);
    });
});
