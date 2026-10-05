import { preparePickedAttachment, persistPreparedPickedAttachment, type PreparedPickedAttachment } from './attachment-editor-model';
import { getManagedAttachmentFileName } from './mobile-attachment-files';
import { readNativeAttachments, readNativeTaskLinkHalf } from './native-host-contract-attachments';
import { taskEditValuesEqual } from './json-value-equality';
import { validateAttachmentForUpload } from './attachment-validation';
import type { Attachment } from './types';

/** Internal projection only. Native durable descriptor proofs grant file authority separately. */
export type NativeAttachmentDraftDependencies = {
    assertEditable(taskID: string): void;
    t(key: string): string;
};
export type NativeAttachmentDraftPicked = Readonly<{
    uri: string; name: string | null; mimeType: string | null; size: number | null;
}>;
export type NativeAttachmentDraftFile = Readonly<{
    id: string; kind: 'file'; title: string; uri: string; mimeType?: string; size: number;
    createdAt: string; updatedAt: string; localStatus: 'available';
}>;
export type NativeAttachmentDraftBeginInput = { taskID: string; payloadJSON: string };
export type NativeAttachmentDraftBegin = Readonly<{ version: 1; taskID: string; payloadJSON: string }>;
export type NativeAttachmentDraftPrepared = Readonly<{
    version: 1; kind: 'prepared'; taskID: string; requestId: string;
    picked: NativeAttachmentDraftPicked; measuredSize: number; managedDirectoryURI: string;
    beforePayloadJSON: string; afterPayloadJSON: string; prepared: PreparedPickedAttachment;
    targetURI: string; attachment: NativeAttachmentDraftFile;
}>;
export type NativeAttachmentDraftLineageInput = {
    version: 1; taskID: string; initialPayloadJSON: string; beforePayloadJSON: string;
    priorAdditions: readonly NativeAttachmentDraftPrepared[]; managedDirectoryURI: string;
};
/** A structural history acknowledgment only; it grants no task or file authority. */
export type NativeAttachmentDraftLineage = NativeAttachmentDraftBegin;
export type NativeAttachmentDraftPrepareInput = NativeAttachmentDraftLineageInput & {
    requestId: string;
    picked: NativeAttachmentDraftPicked; measuredSize: number;
};
export type NativeAttachmentDraftLineageInputV2 = Omit<NativeAttachmentDraftLineageInput, 'version'> & { version: 2 };
export type NativeAttachmentDraftPrepareInputV2 = Omit<NativeAttachmentDraftPrepareInput, 'version'> & { version: 2 };
export type NativeAttachmentDraftLineageV2 = Omit<NativeAttachmentDraftLineage, 'version'> & { version: 2 };
export type NativeAttachmentDraftRefusal = { kind: 'refused'; message: string };
export type NativeAttachmentDraftCompleteInput = { prepared: NativeAttachmentDraftPrepared };
export type NativeAttachmentDraftAdded = Readonly<{
    version: 1; kind: 'added'; taskID: string; requestId: string;
    afterPayloadJSON: string; attachment: NativeAttachmentDraftFile;
}>;

const PAYLOAD_BYTES = 1_000_000;
const PREPARED_BYTES = 2 * 1024 * 1024;
const PREPARE_BYTES = 8 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const PREPARED_FIELDS = ['version', 'kind', 'taskID', 'requestId', 'picked', 'measuredSize',
    'managedDirectoryURI', 'beforePayloadJSON', 'afterPayloadJSON', 'prepared', 'targetURI', 'attachment'];
const FILE_FIELDS = ['id', 'kind', 'title', 'uri', 'size', 'createdAt', 'updatedAt', 'localStatus'];
const invalid = (): never => { throw new Error('INVALID_INPUT'); };
const record = (value: unknown): value is Record<string, unknown> => (
    value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
);
const own = (value: object, field: string): boolean => Object.prototype.hasOwnProperty.call(value, field);
const exact = (value: unknown, fields: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> => (
    record(value) && fields.every((field) => own(value, field))
    && Reflect.ownKeys(value).every((field) => {
        if (typeof field !== 'string' || !fields.includes(field) && !optional.includes(field)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, field);
        return Boolean(descriptor?.enumerable && own(descriptor, 'value'));
    })
);

// Works on native JS engines without requiring a TextEncoder host capability.
const utf8Bytes = (text: string, limit = Number.MAX_SAFE_INTEGER): number => {
    let bytes = 0;
    for (let index = 0; index < text.length; index++) {
        const unit = text.charCodeAt(index);
        if (unit < 0x80) bytes++;
        else if (unit < 0x800) bytes += 2;
        else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length
            && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
            bytes += 4; index++;
        } else bytes += 3;
        if (bytes > limit) return bytes;
    }
    return bytes;
};
const text = (value: unknown, bytes: number, nonempty = false): string => {
    if (typeof value !== 'string' || value.length > bytes || utf8Bytes(value, bytes) > bytes || nonempty && !value) invalid();
    return value as string;
};
const size = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid();
    return value as number;
};
const requestID = (value: unknown): string => {
    if (typeof value !== 'string' || !UUID.test(value)) invalid();
    return value as string;
};
const jsonBytes = (value: unknown, limit: number): number => {
    try {
        const encoded = JSON.stringify(value);
        if (typeof encoded !== 'string') invalid();
        const bytes = utf8Bytes(encoded, limit);
        if (bytes > limit) invalid();
        return bytes;
    } catch { return invalid(); }
};
const same = (left: unknown, right: unknown): boolean => {
    try { return taskEditValuesEqual(left, right); } catch { return false; }
};
const fileURI = (value: unknown, directory = false): string => {
    const uri = text(value, 16 * 1024, true);
    // URL parsers may silently discard ASCII whitespace/control units.
    for (let index = 0; index < uri.length; index++) {
        if (uri.charCodeAt(index) <= 32 || uri.charCodeAt(index) === 127) invalid();
    }
    try {
        const parsed = new URL(uri);
        const path = decodeURIComponent(uri.slice('file://'.length));
        if (!uri.startsWith('file:///') || parsed.protocol !== 'file:' || parsed.host || parsed.username || parsed.password
            || /[?#\\]/.test(uri) || path.includes('\\') || path.includes('\0')
            || !path.startsWith('/') || path.split('/').some((part) => part === '.' || part === '..')
            || directory && !uri.endsWith('/')) invalid();
    } catch { return invalid(); }
    return uri;
};
const picked = (value: unknown): NativeAttachmentDraftPicked => {
    if (!exact(value, ['uri', 'name', 'mimeType', 'size'])) invalid();
    const input = value as Record<string, unknown>;
    if (input.name !== null && (typeof input.name !== 'string' || input.name.length > 100_000)
        || input.mimeType !== null && (typeof input.mimeType !== 'string' || input.mimeType.length > 500)
        || input.size !== null && (typeof input.size !== 'number' || !Number.isFinite(input.size) || input.size < 0)) invalid();
    return Object.freeze({ uri: fileURI(input.uri), name: input.name as string | null,
        mimeType: input.mimeType as string | null, size: input.size as number | null });
};
const attachment = (value: unknown): NativeAttachmentDraftFile => {
    if (!exact(value, FILE_FIELDS, ['mimeType'])) invalid();
    const input = value as Record<string, unknown>;
    const id = requestID(input.id), uri = fileURI(input.uri);
    if (input.kind !== 'file' || typeof input.title !== 'string' || input.title.length > 100_000
        || input.localStatus !== 'available' || own(input, 'mimeType') && (typeof input.mimeType !== 'string' || input.mimeType.length > 500)
        || typeof input.createdAt !== 'string' || input.createdAt.length > 100 || input.createdAt !== input.updatedAt) invalid();
    const createdAt = input.createdAt as string;
    try { if (new Date(createdAt).toISOString() !== createdAt) invalid(); } catch { return invalid(); }
    const file: NativeAttachmentDraftFile = Object.freeze({ id, kind: 'file', title: input.title as string, uri,
        ...(own(input, 'mimeType') ? { mimeType: input.mimeType as string } : {}), size: size(input.size),
        createdAt, updatedAt: createdAt, localStatus: 'available' });
    if (!readNativeAttachments([file])) invalid();
    return file;
};
const payload = (encoded: unknown, taskID: string): { object: Record<string, unknown>; attachments: Attachment[] } => {
    const bounded = text(encoded, PAYLOAD_BYTES, true);
    let value: unknown;
    try {
        value = JSON.parse(bounded, (_field, entry: unknown) => {
            // Overflowing JSON numbers would otherwise stringify as null and
            // change an unrelated editor field during attachment projection.
            if (typeof entry === 'number' && !Number.isFinite(entry)) invalid();
            return entry;
        });
    } catch { return invalid(); }
    if (!record(value) || value.version !== 2 || value.taskID !== taskID || value.attachmentsOwned !== true
        || !readNativeAttachments(value.attachmentsBase)) invalid();
    const object = value as Record<string, unknown>;
    const attachments = readNativeAttachments(object.attachments);
    if (!attachments) invalid();
    return { object, attachments: attachments! };
};
const initialPayload = (encoded: unknown, taskID: string): void => {
    const before = payload(encoded, taskID);
    if (!readNativeTaskLinkHalf({ base: before.object.attachmentsBase, value: before.attachments }, false)) invalid();
};

/** Capture bounded scalar proof fields before parsing payloads or awaiting shared policy. */
const frozenShape = (value: unknown): NativeAttachmentDraftPrepared => {
    if (!exact(value, PREPARED_FIELDS)) invalid();
    const input = value as Record<string, unknown>;
    if (input.version !== 1 || input.kind !== 'prepared' || !exact(input.prepared, ['kind', 'attachment'])
        || input.prepared.kind !== 'prepared') invalid();
    const prepared = Object.freeze({ kind: 'prepared' as const,
        attachment: attachment((input.prepared as Record<string, unknown>).attachment) });
    const result: NativeAttachmentDraftPrepared = Object.freeze({ version: 1, kind: 'prepared',
        taskID: text(input.taskID, 500, true), requestId: requestID(input.requestId), picked: picked(input.picked),
        measuredSize: size(input.measuredSize), managedDirectoryURI: fileURI(input.managedDirectoryURI, true),
        beforePayloadJSON: text(input.beforePayloadJSON, PAYLOAD_BYTES, true),
        afterPayloadJSON: text(input.afterPayloadJSON, PAYLOAD_BYTES, true), prepared,
        targetURI: fileURI(input.targetURI), attachment: attachment(input.attachment) });
    jsonBytes(result, PREPARED_BYTES);
    return result;
};
const validateFrozen = (value: NativeAttachmentDraftPrepared): void => {
    const source = value.prepared.attachment;
    if (source.id !== value.requestId || source.title !== (value.picked.name || 'file') || source.uri !== value.picked.uri
        || source.mimeType !== (value.picked.mimeType ?? undefined) || source.size !== value.measuredSize
        || value.targetURI !== value.managedDirectoryURI + getManagedAttachmentFileName(source)
        || !same(value.attachment, { ...source, uri: value.targetURI, size: value.measuredSize, localStatus: 'available' })) invalid();
    const before = payload(value.beforePayloadJSON, value.taskID), after = payload(value.afterPayloadJSON, value.taskID);
    if (before.attachments.length >= 1_000 || before.attachments.some((item) => item.id === value.requestId)
        || !same(after.object, { ...before.object, attachments: [...before.attachments, value.attachment] })) invalid();
};

/** Internal structural reader; no current policy, IO or publication authority. */
export function readNativeAttachmentDraftFrozen(input: unknown): NativeAttachmentDraftPrepared {
    const captured = frozenShape(input);
    validateFrozen(captured);
    return captured;
}

/** Internal attachment projection reader. Opaque editor fields remain untouched. */
export function readNativeAttachmentDraftPayload(input: unknown, taskID: string): {
    baselineAttachments: Attachment[]; attachments: Attachment[];
} {
    const captured = payload(input, taskID);
    return { baselineAttachments: readNativeAttachments(captured.object.attachmentsBase)!,
        attachments: captured.attachments };
}

type CapturedLineage = Omit<NativeAttachmentDraftLineageInput, 'version'> & { version: 1 | 2 };
const captureLineage = (object: Record<string, unknown>, additionalFields: object = {}, version: 1 | 2 = 1): CapturedLineage => {
    if (object.version !== version || !Array.isArray(object.priorAdditions) || object.priorAdditions.length > 128) invalid();
    const additions = object.priorAdditions as unknown[];
    if (Reflect.ownKeys(additions).length !== additions.length + 1) invalid();
    const captured = { version, taskID: text(object.taskID, 500, true),
        initialPayloadJSON: text(object.initialPayloadJSON, PAYLOAD_BYTES, true),
        beforePayloadJSON: text(object.beforePayloadJSON, PAYLOAD_BYTES, true), priorAdditions: [] as NativeAttachmentDraftPrepared[],
        managedDirectoryURI: fileURI(object.managedDirectoryURI, true) };
    // Bound each record before measuring the aggregate. Prepare supplies its
    // already bounded new-operation fields so the same 8 MiB total applies.
    let encodedBytes = jsonBytes({ ...captured, ...additionalFields }, PREPARE_BYTES);
    for (let index = 0; index < additions.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(additions, String(index));
        if (!descriptor?.enumerable || !own(descriptor, 'value')) invalid();
        const copy = frozenShape(descriptor!.value);
        encodedBytes += jsonBytes(copy, PREPARED_BYTES) + (captured.priorAdditions.length ? 1 : 0);
        if (encodedBytes > PREPARE_BYTES) invalid();
        captured.priorAdditions.push(copy);
    }
    return captured;
};
const validateLineage = (captured: CapturedLineage): Set<string> => {
    initialPayload(captured.initialPayloadJSON, captured.taskID);
    let previous = captured.initialPayloadJSON;
    const ids = new Set<string>();
    for (const prior of captured.priorAdditions) {
        validateFrozen(prior);
        if (prior.taskID !== captured.taskID || prior.managedDirectoryURI !== captured.managedDirectoryURI
            || prior.beforePayloadJSON !== previous || ids.has(prior.requestId)) invalid();
        ids.add(prior.requestId); previous = prior.afterPayloadJSON;
    }
    if (captured.beforePayloadJSON !== previous) invalid();
    return ids;
};

// Only the v2 entry points select projection continuity. Every operation still
// retains its complete frozen before/after bytes; ordinary editor changes
// between operations grant neither Save permission nor filesystem authority.
const validateLineageV2 = (captured: CapturedLineage): Set<string> => {
    initialPayload(captured.initialPayloadJSON, captured.taskID);
    const initial = payload(captured.initialPayloadJSON, captured.taskID);
    if (!same(initial.object.attachmentsBase, initial.attachments)) invalid();
    let previous = initial.attachments;
    const ids = new Set<string>();
    for (const prior of captured.priorAdditions) {
        validateFrozen(prior);
        const before = payload(prior.beforePayloadJSON, captured.taskID);
        if (prior.taskID !== captured.taskID || prior.managedDirectoryURI !== captured.managedDirectoryURI
            || ids.has(prior.requestId) || !same(before.object.attachmentsBase, initial.object.attachmentsBase)
            || !same(before.attachments, previous)) invalid();
        ids.add(prior.requestId);
        previous = payload(prior.afterPayloadJSON, captured.taskID).attachments;
    }
    const latest = payload(captured.beforePayloadJSON, captured.taskID);
    if (!same(latest.object.attachmentsBase, initial.object.attachmentsBase) || !same(latest.attachments, previous)) invalid();
    return ids;
};

/** Validate retained Add history, including on Discard of a now-readonly task. */
export function validateNativeAttachmentDraftLineage(input: unknown): NativeAttachmentDraftLineage {
    if (!exact(input, ['version', 'taskID', 'initialPayloadJSON', 'beforePayloadJSON', 'priorAdditions', 'managedDirectoryURI'])) invalid();
    const captured = captureLineage(input as Record<string, unknown>);
    validateLineage(captured);
    return Object.freeze({ version: 1, taskID: captured.taskID, payloadJSON: captured.beforePayloadJSON });
}

export function validateNativeAttachmentDraftLineageV2(input: unknown): NativeAttachmentDraftLineageV2 {
    if (!exact(input, ['version', 'taskID', 'initialPayloadJSON', 'beforePayloadJSON', 'priorAdditions', 'managedDirectoryURI'])) invalid();
    const captured = captureLineage(input as Record<string, unknown>, {}, 2);
    validateLineageV2(captured);
    return Object.freeze({ version: 2, taskID: captured.taskID, payloadJSON: captured.beforePayloadJSON });
}

export function validateNativeAttachmentDraftBegin(input: unknown, deps: NativeAttachmentDraftDependencies): NativeAttachmentDraftBegin {
    if (!exact(input, ['taskID', 'payloadJSON'])) invalid();
    const object = input as Record<string, unknown>;
    const taskID = text(object.taskID, 500, true), payloadJSON = text(object.payloadJSON, PAYLOAD_BYTES, true);
    initialPayload(payloadJSON, taskID);
    deps.assertEditable(taskID);
    return Object.freeze({ version: 1, taskID, payloadJSON });
}

export function validateNativeAttachmentDraftBeginV2(input: unknown, deps: NativeAttachmentDraftDependencies): NativeAttachmentDraftLineageV2 {
    if (!exact(input, ['taskID', 'payloadJSON'])) invalid();
    const object = input as Record<string, unknown>;
    const taskID = text(object.taskID, 500, true), payloadJSON = text(object.payloadJSON, PAYLOAD_BYTES, true);
    initialPayload(payloadJSON, taskID);
    const initial = payload(payloadJSON, taskID);
    if (!same(initial.object.attachmentsBase, initial.attachments)) invalid();
    deps.assertEditable(taskID);
    return Object.freeze({ version: 2, taskID, payloadJSON });
}

export async function prepareNativeAttachmentDraftAdd(input: unknown, deps: NativeAttachmentDraftDependencies):
Promise<NativeAttachmentDraftPrepared | NativeAttachmentDraftRefusal> {
    return prepareDraftAdd(input, deps, 1);
}

export async function prepareNativeAttachmentDraftAddV2(input: unknown, deps: NativeAttachmentDraftDependencies):
Promise<NativeAttachmentDraftPrepared | NativeAttachmentDraftRefusal> {
    return prepareDraftAdd(input, deps, 2);
}

async function prepareDraftAdd(input: unknown, deps: NativeAttachmentDraftDependencies, version: 1 | 2):
Promise<NativeAttachmentDraftPrepared | NativeAttachmentDraftRefusal> {
    if (!exact(input, ['version', 'taskID', 'initialPayloadJSON', 'beforePayloadJSON', 'priorAdditions',
        'requestId', 'picked', 'measuredSize', 'managedDirectoryURI'])) invalid();
    const object = input as Record<string, unknown>;
    const additionalFields = { requestId: requestID(object.requestId), picked: picked(object.picked), measuredSize: size(object.measuredSize) };
    const captured = { ...captureLineage(object, additionalFields, version), ...additionalFields };
    if ((version === 1 ? validateLineage(captured) : validateLineageV2(captured)).has(captured.requestId)) invalid();
    const before = payload(captured.beforePayloadJSON, captured.taskID);
    if (before.attachments.length >= 1_000 || before.attachments.some((item) => item.id === captured.requestId)) invalid();
    const { assertEditable, t } = deps;
    assertEditable(captured.taskID);
    const result = await preparePickedAttachment({ source: 'file', asset: { ...captured.picked, size: captured.measuredSize },
        newId: () => captured.requestId, t });
    assertEditable(captured.taskID);
    if (result.kind === 'refused') return result;
    // RN's optional undefined MIME field is absent in the durable JSON record.
    const preparedAttachment = { ...result.attachment };
    if (preparedAttachment.mimeType === undefined) delete preparedAttachment.mimeType;
    const prepared = Object.freeze({ kind: 'prepared' as const, attachment: attachment(preparedAttachment) });
    const targetURI = captured.managedDirectoryURI + getManagedAttachmentFileName(prepared.attachment);
    fileURI(targetURI);
    if (targetURI === captured.picked.uri) return { kind: 'refused', message: t('attachments.fileNotReadable') };
    const completed = attachment({ ...prepared.attachment, uri: targetURI, size: captured.measuredSize, localStatus: 'available' });
    let afterPayloadJSON: string;
    try { afterPayloadJSON = JSON.stringify({ ...before.object, attachments: [...before.attachments, completed] }); }
    catch { return invalid(); }
    text(afterPayloadJSON, PAYLOAD_BYTES, true);
    const frozen: NativeAttachmentDraftPrepared = Object.freeze({ version: 1, kind: 'prepared', taskID: captured.taskID,
        requestId: captured.requestId, picked: captured.picked, measuredSize: captured.measuredSize,
        managedDirectoryURI: captured.managedDirectoryURI, beforePayloadJSON: captured.beforePayloadJSON,
        afterPayloadJSON, prepared, targetURI, attachment: completed });
    jsonBytes(frozen, PREPARED_BYTES);
    return frozen;
}

/** Call only after native publication proof. This projection neither copies nor owns bytes. */
export async function completeNativeAttachmentDraftAdd(input: unknown, deps: NativeAttachmentDraftDependencies):
Promise<NativeAttachmentDraftAdded | NativeAttachmentDraftRefusal> {
    if (!exact(input, ['prepared'])) invalid();
    const frozen = frozenShape((input as Record<string, unknown>).prepared);
    validateFrozen(frozen);
    const { assertEditable, t } = deps;
    assertEditable(frozen.taskID);
    // Historical additions are structurally preserved; only the current
    // completion rechecks shared upload policy without generating metadata.
    const validation = await validateAttachmentForUpload(frozen.prepared.attachment, frozen.measuredSize);
    assertEditable(frozen.taskID);
    if (!validation.valid) invalid();
    const result = await persistPreparedPickedAttachment({ prepared: frozen.prepared,
        persist: async () => ({ ...frozen.attachment }), t });
    assertEditable(frozen.taskID);
    if (result.kind === 'refused') return result;
    return Object.freeze({ version: 1, kind: 'added', taskID: frozen.taskID, requestId: frozen.requestId,
        afterPayloadJSON: frozen.afterPayloadJSON, attachment: frozen.attachment });
}
