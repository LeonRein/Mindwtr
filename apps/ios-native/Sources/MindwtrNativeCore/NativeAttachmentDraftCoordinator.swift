import Foundation
import CoreFoundation
import Darwin

#if DEBUG
enum AttachmentDraftBoundary: Sendable, Equatable {
    case beforeIntent, afterIntent, afterReservation, beforeStageProof, afterStageProof
    case beforeFilled, afterFilled, beforePublication, afterPublication, afterPublicationProof
    case beforeResult, afterResult, beforeCheckpoint, afterCheckpoint, beforeMarker, afterMarker
    case beforeDiscardDecision, afterDiscardDecision, beforeDetach, afterDetach
    case beforeAdvanceIntent, afterAdvanceIntent, beforeAdvanceEditor, afterAdvanceEditor
    case beforeAdvanceMarker, afterAdvanceMarker
    case afterSaveFreeze, afterSaveJournal, beforeSaveCommit, afterSaveCommit
    case beforeSaveTerminal, afterSaveTerminal, beforeSaveEditorDetach, afterSaveEditorDetach
    case beforeSaveStage(Int), afterSaveStage(Int), beforeSaveRelease, afterSaveRelease
    case beforeSaveJournalClear, afterSaveJournalClear, beforeSaveThaw, afterSaveThaw
    case beforeDiscardFinishJournal, afterDiscardFinishJournal
    case beforeDiscardTarget(Int), afterDiscardTarget(Int), beforeDiscardStage(Int), afterDiscardStage(Int)
    case beforeDiscardTerminal, afterDiscardTerminal, beforeDiscardRelease, afterDiscardRelease
    case beforeDiscardJournalClear, afterDiscardJournalClear
}
final class AttachmentDraftHostHooks: @unchecked Sendable {
    var boundary: ((AttachmentDraftBoundary) throws -> Void)?
}
#endif

/// Serialized by CoreHost's existing library owner. Descriptor proofs remain
/// native; editor projection and task authority remain in shared core.
final class NativeAttachmentDraftCoordinator {
    private typealias Store = NativeAttachmentDraftStore
    private let store: Store
    private let editor: EditorDraftStore
    private let jobs: NativeAttachmentFileJobs
    private let invoke: (String, [Any]) throws -> String
    private let managedURI: String
    #if DEBUG
    var hooks: AttachmentDraftHostHooks?
    #endif
    private static let failure = HostFailure("Attachment draft operation could not be confirmed; retained evidence requires exact recovery")

    init(databaseURL: URL, jobs: NativeAttachmentFileJobs, invoke: @escaping (String, [Any]) throws -> String) throws {
        store = Store(databaseURL: databaseURL)
        editor = EditorDraftStore(databaseURL: databaseURL)
        self.jobs = jobs
        self.invoke = invoke
        let directories = try Self.object(jobs.directoriesJSON)
        guard let document = directories["document"] as? String, let root = URL(string: document) else { throw Self.failure }
        managedURI = root.appendingPathComponent("attachments", isDirectory: true).absoluteString
    }

    static func hasEvidence(databaseURL: URL) -> Bool {
        var info = stat()
        if lstat(Store(databaseURL: databaseURL).url.path, &info) == 0 { return true }
        return errno != ENOENT
    }
    private static func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed]), as: UTF8.self)
    }
    private static func object(_ text: String, limit: Int = 8 * 1024 * 1024) throws -> [String: Any] {
        guard text.utf8.count <= limit, let value = try NativeJSON.jsonObject(with: Data(text.utf8)) as? [String: Any] else { throw failure }
        return value
    }
    private static func equal(_ lhs: String, _ rhs: String) -> Bool { lhs.utf8.elementsEqual(rhs.utf8) }
    private static func equal(_ lhs: EditorDraftSnapshot, _ rhs: EditorDraftSnapshot) -> Bool {
        lhs.version == rhs.version && equal(lhs.sessionID, rhs.sessionID) && equal(lhs.taskID, rhs.taskID)
            && lhs.generation == rhs.generation && equal(lhs.payloadJSON, rhs.payloadJSON)
    }
    private static func uuid(_ value: Any?) -> String? {
        guard let text = value as? String, UUID(uuidString: text)?.uuidString.lowercased() == text else { return nil }
        return text
    }
    private static func integer(_ value: Any?, positive: Bool = false) -> Int64? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue.rounded(.towardZero) == number.doubleValue,
              number.doubleValue >= (positive ? 1 : 0), number.doubleValue <= 9_007_199_254_740_991 else { return nil }
        return number.int64Value
    }
    private struct Request {
        let id: String
        let session: String
        let generation: Int
        let picked: [String: Any]?
        let json: String
    }
    private static func request(_ raw: String, add: Bool) throws -> Request {
        let value = try object(raw, limit: 64 * 1024)
        guard Set(value.keys) == Set(add ? ["version", "requestId", "sessionID", "generation", "picked"] : ["version", "requestId", "sessionID", "generation"]),
              integer(value["version"]) == 1, let id = uuid(value["requestId"]), let session = uuid(value["sessionID"]),
              let generation = integer(value["generation"], positive: true) else { throw failure }
        let picked = value["picked"] as? [String: Any]
        if add {
            guard let picked, Set(picked.keys) == Set(["uri", "name", "mimeType", "size"]),
                  let uri = picked["uri"] as? String, !uri.isEmpty, uri.utf8.count <= 16 * 1024,
                  picked["name"] is NSNull || (picked["name"] as? String).map({ $0.utf16.count <= 100_000 }) == true,
                  picked["mimeType"] is NSNull || (picked["mimeType"] as? String).map({ $0.utf16.count <= 500 }) == true else { throw failure }
            if !(picked["size"] is NSNull) {
                guard let size = picked["size"] as? NSNumber, CFGetTypeID(size) != CFBooleanGetTypeID(), size.doubleValue.isFinite, size.doubleValue >= 0 else { throw failure }
            }
        }
        let canonical = try json(value)
        guard canonical.utf8.count <= 64 * 1024 else { throw failure }
        return Request(id: id, session: session, generation: Int(generation), picked: picked, json: canonical)
    }
    private func current(_ expected: EditorDraftSnapshot) throws {
        guard let value = try editor.read(), value.attempt == nil, Self.equal(value.snapshot, expected) else { throw Self.failure }
    }
    private func lineage(_ record: Store.Record) throws {
        try history(record)
        if record.session.state == .active {
            guard let value = try editor.read(), value.attempt == nil else { throw Self.failure }
            let after = record.operations.last.flatMap { $0.phase == .resultDurable ? $0.after : nil }
            guard Self.equal(value.snapshot, record.session.checkpoint) || after.map({ Self.equal(value.snapshot, $0) }) == true
                || record.checkpointAdvance.map({ Self.equal(value.snapshot, $0.after) }) == true else { throw Self.failure }
        }
    }
    /// Metadata validation only. Owned Save separately requires its exact full
    /// editor attempt; the existing editable lineage gate is never relaxed.
    private func history(_ record: Store.Record) throws {
        for op in record.operations {
            _ = try prepared(op)
            if let reply = op.replyJSON { guard Self.equal(reply, try addReply(op)) else { throw Self.failure } }
        }
        if let discard = record.discard {
            let request = try Self.request(discard.requestJSON, add: false)
            guard request.id == discard.requestId, request.session == record.session.sessionID,
                  request.generation == discard.expected.generation, Self.equal(request.json, discard.requestJSON) else { throw Self.failure }
            if let reply = discard.replyJSON { guard Self.equal(reply, try discardReply(record, discard)) else { throw Self.failure } }
        }
        let pendingAdd = record.operations.last.map { $0.phase != .checkpointed } == true
        let projected = record.version == 2 && !pendingAdd ? record.session.checkpoint.payloadJSON
            : record.operations.last?.after.payloadJSON ?? record.session.checkpoint.payloadJSON
        try projection(record, payload: projected)
        if let advance = record.checkpointAdvance { try projection(record, payload: advance.after.payloadJSON) }
    }
    private func projection(_ record: Store.Record, payload projected: String) throws {
        let initial = record.operations.first?.before.payloadJSON ?? record.session.checkpoint.payloadJSON
        let input: [String: Any] = ["version": record.version, "taskID": record.session.taskID, "initialPayloadJSON": initial,
            "beforePayloadJSON": projected, "priorAdditions": try record.operations.map { try prepared($0) }, "managedDirectoryURI": managedURI]
        let validated = try Self.object(invoke(record.version == 2 ? "attachmentDraftValidateLineageV2" : "attachmentDraftValidateLineage", [Self.json(input)]))
        guard Set(validated.keys) == Set(["version", "taskID", "payloadJSON"]), Self.integer(validated["version"]) == Int64(record.version),
              let task = validated["taskID"] as? String, Self.equal(task, record.session.taskID),
              let payload = validated["payloadJSON"] as? String, Self.equal(payload, projected) else { throw Self.failure }
    }
    private func prepared(_ op: Store.Operation) throws -> [String: Any] {
        let value = try Self.object(op.preparedJSON, limit: 2 * 1024 * 1024)
        let request = try Self.request(op.requestJSON, add: true)
        guard Set(value.keys) == Set(["version", "kind", "taskID", "requestId", "picked", "measuredSize", "managedDirectoryURI", "beforePayloadJSON", "afterPayloadJSON", "prepared", "targetURI", "attachment"]),
              Self.integer(value["version"]) == 1, value["kind"] as? String == "prepared",
              value["taskID"] as? String == op.before.taskID, value["requestId"] as? String == op.requestId,
              request.id == op.requestId, request.session == op.before.sessionID, request.generation == op.before.generation,
              Self.equal(request.json, op.requestJSON),
              Self.equal(try Self.json(value["picked"]!), try Self.json(request.picked!)),
              (request.picked?["uri"] as? String) == op.source.sourceURI,
              Self.integer(value["measuredSize"]) == op.source.size,
              value["managedDirectoryURI"] as? String == managedURI,
              let before = value["beforePayloadJSON"] as? String, Self.equal(before, op.before.payloadJSON),
              let after = value["afterPayloadJSON"] as? String, Self.equal(after, op.after.payloadJSON),
              value["targetURI"] as? String == op.targetURI,
              let target = URL(string: op.targetURI), target.deletingLastPathComponent().absoluteString == managedURI,
              let attachment = value["attachment"] as? [String: Any], attachment["id"] as? String == op.requestId,
              attachment["uri"] as? String == op.targetURI, Self.integer(attachment["size"]) == op.source.size else { throw Self.failure }
        if let stage = op.stage {
            let expected = managedURI + ".mindwtr-install-" + op.requestId.replacingOccurrences(of: "-", with: "") + ".candidate/stage"
            guard Self.equal(stage.uri, expected) else { throw Self.failure }
        }
        return value
    }
    private func acknowledge(_ operation: String, _ outcome: String) { _ = try? invoke("attachmentDraftAcknowledged", [operation, outcome]) }
    static func readSummary(databaseURL: URL) throws -> String {
        guard let record = try Store(databaseURL: databaseURL).read() else { return "null" }
        return try Self.summary(record)
    }
    private static func summary(_ record: Store.Record) throws -> String {
        let status = record.checkpointAdvance != nil ? "checkpointPending"
            : record.session.state == .cleanupPending ? "cleanupPending" : (record.operations.last?.reason == nil ? "active" : "uncertain")
        return try Self.json(["version": record.version, "status": status, "sessionID": record.session.sessionID,
                       "checkpoint": try Self.object(String(decoding: JSONEncoder().encode(record.session.checkpoint), as: UTF8.self)),
                       "operations": record.operations.map { ["requestId": $0.requestId, "phase": $0.phase.rawValue, "reason": $0.reason.map { $0.rawValue as Any } ?? NSNull()] }])
    }
    func begin(session: String, generation: Int) throws -> String {
        try begin(session: session, generation: generation, version: 1)
    }
    func beginV2(session: String, generation: Int) throws -> String {
        try begin(session: session, generation: generation, version: 2)
    }
    private func begin(session: String, generation: Int, version: Int) throws -> String {
        if version == 2 { jobs.drain() }
        guard Self.uuid(session) != nil, generation > 0, generation <= 9_007_199_254_740_991,
              let value = try editor.read(), value.attempt == nil, value.snapshot.sessionID == session, value.snapshot.generation == generation else { throw Self.failure }
        let snapshot = value.snapshot
        let existing = try store.read()
        if let existing {
            guard existing.version == version, existing.session.state == .active, Self.equal(existing.session.checkpoint, snapshot),
                  version == 1 || (existing.checkpointAdvance == nil && existing.operations.allSatisfy { $0.phase == .checkpointed }) else { throw Self.failure }
        }
        let initial = existing?.operations.first?.before.payloadJSON ?? snapshot.payloadJSON
        let reply = try Self.object(invoke(version == 2 ? "attachmentDraftBeginV2" : "attachmentDraftBegin", [Self.json(["taskID": snapshot.taskID, "payloadJSON": initial])]))
        guard Set(reply.keys) == Set(["version", "taskID", "payloadJSON"]), Self.integer(reply["version"]) == Int64(version),
              let task = reply["taskID"] as? String, Self.equal(task, snapshot.taskID),
              let payload = reply["payloadJSON"] as? String, Self.equal(payload, initial) else { throw Self.failure }
        if let existing {
            try lineage(existing)
        } else {
            try store.write(Store.Record(version: version, session: .init(sessionID: session, taskID: snapshot.taskID, state: .active, checkpoint: snapshot), operations: []))
        }
        return try Self.json(["version": version, "status": "begun", "sessionID": session, "generation": generation])
    }

    /// Ordinary raw editor retention only. Shared lineage proves attachment
    /// continuity; this does not admit Save or recheck upload/task edit policy.
    func advance(_ snapshot: EditorDraftSnapshot) throws {
        // Finish all existing file work before invoking the pure JS validator.
        // No JSC invocation occurs between the durable intent and final marker.
        jobs.drain()
        guard let record = try store.read(), record.version == 2, record.session.state == .active,
              record.discard == nil, record.operations.allSatisfy({ $0.phase == .checkpointed }),
              snapshot.generation > 0, snapshot.generation <= 9_007_199_254_740_991,
              Self.equal(snapshot.sessionID, record.session.sessionID), Self.equal(snapshot.taskID, record.session.taskID) else { throw Self.failure }
        try editor.preflightCheckpoint(snapshot)
        try lineage(record)
        if let pending = record.checkpointAdvance {
            guard Self.equal(snapshot, pending.after) else { throw Self.failure }
            _ = try finishAdvance(record)
            acknowledge("checkpoint", "replayed")
            return
        }
        try current(record.session.checkpoint)
        if Self.equal(snapshot, record.session.checkpoint) {
            // An earlier marker may have been promoted before its parent-sync
            // acknowledgment failed. A read alone cannot confirm that write.
            try requireRecord(record)
            try store.write(record)
            acknowledge("checkpoint", "replayed")
            return
        }
        guard snapshot.generation > record.session.checkpoint.generation else { throw Self.failure }
        try projection(record, payload: snapshot.payloadJSON)
        let pending = checkpointRecord(record, checkpoint: record.session.checkpoint,
            advance: .init(before: record.session.checkpoint, after: snapshot))
        try preflightAdvanceAdmission(pending)
        #if DEBUG
        try hooks?.boundary?(.beforeAdvanceIntent)
        #endif
        try current(record.session.checkpoint)
        try requireRecord(record)
        try store.write(pending)
        #if DEBUG
        try hooks?.boundary?(.afterAdvanceIntent)
        #endif
        _ = try finishAdvance(pending)
        acknowledge("discard-capacity", "confirmed")
        acknowledge("checkpoint", "confirmed")
    }

    private func checkpointRecord(_ record: Store.Record, checkpoint: EditorDraftSnapshot,
                                  advance: Store.CheckpointAdvance?) -> Store.Record {
        Store.Record(version: record.version, session: .init(sessionID: record.session.sessionID,
            taskID: record.session.taskID, state: record.session.state, checkpoint: checkpoint),
            operations: record.operations, discard: record.discard, checkpointAdvance: advance)
    }
    private func requireRecord(_ expected: Store.Record) throws {
        guard let actual = try store.read() else { throw Self.failure }
        // Codable's synthesized String equality is Unicode-normalizing. Compare
        // a stable complete model encoding to retain every opaque byte instead.
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        guard try encoder.encode(actual) == encoder.encode(expected) else { throw Self.failure }
    }
    private func preflightAdvance(_ record: Store.Record) throws {
        guard record.version == 2, let advance = record.checkpointAdvance else { throw Self.failure }
        try editor.preflightCheckpoint(advance.after)
        let settled = checkpointRecord(record, checkpoint: advance.after, advance: nil)
        for candidate in [record, settled] {
            guard try JSONEncoder().encode(candidate).count <= Store.maximumBytes else { throw Self.failure }
        }
        // Before intent, only the pending record can pass retained-write checks;
        // the settled record requires that intent already present on disk.
        try store.preflight(record)
    }
    /// Reserve future Discard only before a new intent is admitted. Recovery
    /// must finish an older recorded pair under its original capacity checks.
    private func preflightAdvanceAdmission(_ record: Store.Record) throws {
        try preflightAdvance(record)
        guard let advance = record.checkpointAdvance else { throw Self.failure }
        let settled = checkpointRecord(record, checkpoint: advance.after, advance: nil)
        let discardID = "ffffffff-ffff-ffff-ffff-ffffffffffff"
        let request = try Self.json(["version": 1, "requestId": discardID,
            "sessionID": advance.after.sessionID, "generation": advance.after.generation])
        let reply = try Self.json(["version": 1, "status": "cleanupPending",
            "requestId": discardID, "sessionID": advance.after.sessionID])
        for phase in [Store.DiscardPhase.decided, .detached] {
            let future = Store.Record(version: settled.version,
                session: .init(sessionID: settled.session.sessionID, taskID: settled.session.taskID,
                    state: .cleanupPending, checkpoint: advance.after), operations: settled.operations,
                discard: .init(requestId: discardID, requestJSON: request, expected: advance.after,
                    phase: phase, replyJSON: phase == .detached ? reply : nil), checkpointAdvance: nil)
            guard try JSONEncoder().encode(future).count <= Store.maximumBytes else { throw Self.failure }
        }
    }
    private func finishAdvance(_ record: Store.Record) throws -> Store.Record {
        guard record.version == 2, let advance = record.checkpointAdvance else { throw Self.failure }
        try preflightAdvance(record)
        try requireRecord(record)
        #if DEBUG
        try hooks?.boundary?(.beforeAdvanceEditor)
        #endif
        try editor.checkpointOwnedAdvanceMatching(before: advance.before, after: advance.after)
        #if DEBUG
        try hooks?.boundary?(.afterAdvanceEditor)
        #endif
        try current(advance.after)
        let settled = checkpointRecord(record, checkpoint: advance.after, advance: nil)
        #if DEBUG
        try hooks?.boundary?(.beforeAdvanceMarker)
        #endif
        try current(advance.after)
        try requireRecord(record)
        try store.write(settled)
        #if DEBUG
        try hooks?.boundary?(.afterAdvanceMarker)
        #endif
        return settled
    }

    struct OwnedSavePreparation {
        let record: NativeAttachmentDraftStore.Record
        let fingerprint: String
        let snapshot: EditorDraftSnapshot
        let envelopeJSON: String
        let resultJSON: String
    }

    /// Native structural correspondence for pre-runtime journal admission.
    /// Shared full lineage/effect validation and descriptor proofs remain separate.
    static func ownedSaveLineageJSON(_ record: NativeAttachmentDraftStore.Record) throws -> String {
        _ = try NativeAttachmentDraftStore.ownedSaveFingerprint(record)
        let additions = try record.operations.map { try object($0.preparedJSON, limit: 2 * 1024 * 1024) }
        guard let root = additions.first?["managedDirectoryURI"] as? String else { throw failure }
        return try json(["version": 2, "taskID": record.session.taskID,
            "initialPayloadJSON": record.operations[0].before.payloadJSON,
            "beforePayloadJSON": record.session.checkpoint.payloadJSON,
            "priorAdditions": additions, "managedDirectoryURI": root])
    }

    func prepareOwnedSave(_ saveRequestJSON: String, session: String, generation: Int) throws -> OwnedSavePreparation {
        jobs.drain()
        guard let record = try store.read(), let value = try editor.read(), value.attempt == nil,
              Self.equal(value.snapshot.sessionID, session), value.snapshot.generation == generation,
              Self.equal(value.snapshot, record.session.checkpoint) else { throw Self.failure }
        let fingerprint = try Store.ownedSaveFingerprint(record)
        try lineage(record)
        try verifyOwnedSavePublished(record)
        let save = try Self.object(saveRequestJSON, limit: 2_000_000)
        let checkpoint = try Self.object(String(decoding: JSONEncoder().encode(value.snapshot), as: UTF8.self))
        let owned = try Self.object(Self.ownedSaveLineageJSON(record))
        let request: [String: Any] = ["version": 1, "kind": "owned-editor-file-add-save", "checkpoint": checkpoint,
                                     "ownedDraft": owned, "saveRequest": save]
        let response = try Self.object(invoke("attachmentOwnedSavePrepare", [Self.json(request)]), limit: 16 * 1024 * 1024)
        guard Set(response.keys) == Set(["kind", "prepared"]), response["kind"] as? String == "prepared",
              let prepared = response["prepared"] as? [String: Any], let repeated = prepared["request"] as? [String: Any],
              Self.equal(try Self.json(repeated), try Self.json(request)) else { throw Self.failure }
        let envelope = try Self.json(["request": request, "prepared": prepared])
        let validation = try Self.object(invoke("attachmentOwnedSaveValidate", [envelope]), limit: 16 * 1024 * 1024)
        guard Set(validation.keys) == Set(["version", "kind", "result"]), Self.integer(validation["version"]) == 1,
              validation["kind"] as? String == "owned-editor-file-add-save",
              let result = validation["result"] as? [String: Any], Set(result.keys) == Set(["id", "draft"]),
              let id = result["id"] as? String, Self.equal(id, value.snapshot.taskID), result["draft"] is [String: Any] else { throw Self.failure }
        return .init(record: record, fingerprint: fingerprint, snapshot: value.snapshot,
                     envelopeJSON: envelope, resultJSON: try Self.json(result))
    }

    /// Call before first invocation and every nonterminal replay. This uses the
    /// recorded published inode/root/content; it never recopies a cache source.
    func verifyOwnedSavePublished(_ record: NativeAttachmentDraftStore.Record) throws {
        jobs.drain()
        _ = try Store.ownedSaveFingerprint(record)
        try history(record)
        let cancellation = NativeAttachmentCancellation()
        for op in record.operations {
            guard let reserved = op.stage, let expected = op.published else { throw Self.failure }
            let raw = try file(.verifyPublication(targetURI: op.targetURI, stage: stage(reserved),
                sha256: op.source.sha256, size: op.source.size), cancellation: cancellation, ignoringCancellation: true)
            let actual = try JSONDecoder().decode(Store.Published.self, from: Data(Self.json(raw).utf8))
            let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
            guard try encoder.encode(actual) == encoder.encode(expected) else { throw Self.failure }
        }
    }

    /// The caller already owns a validated durable success terminal and checks
    /// the exact sidecar/editor before each job. No JSC runs during retirement.
    func retireOwnedSaveStage(_ op: NativeAttachmentDraftStore.Operation) throws {
        guard let reserved = op.stage else { throw Self.failure }
        let value = try file(.retirePrivateStage(stage: stage(reserved), targetURI: op.targetURI,
            operationID: op.requestId.replacingOccurrences(of: "-", with: "")),
            cancellation: NativeAttachmentCancellation(), ignoringCancellation: true)
        guard Set(value.keys) == Set(["status"]), let status = value["status"] as? String,
              ["removed", "missing"].contains(status) else { throw Self.failure }
    }
    func drainOwnedSaveJobs() { jobs.drain() }

    /// Pure domain candidacy only. The Engine separately binds the detached
    /// decision, exact journal/editor and native publication proofs for each IO.
    func prepareOwnedDiscardCandidates(_ record: NativeAttachmentDraftStore.Record) throws -> [NativeAttachmentDraftStore.Operation] {
        jobs.drain()
        _ = try Store.ownedDiscardFingerprint(record)
        guard record.operations.allSatisfy({ [.published, .resultDurable, .checkpointed].contains($0.phase)
            && $0.stage != nil && $0.published != nil }) else { throw Self.failure }
        try history(record)
        let input: [String: Any] = ["version": 1, "historyVersion": record.version,
            "taskID": record.session.taskID, "managedDirectoryURI": managedURI,
            "initialPayloadJSON": record.operations.first?.before.payloadJSON ?? record.session.checkpoint.payloadJSON,
            "checkpointPayloadJSON": record.session.checkpoint.payloadJSON,
            "operations": record.operations.map { ["phase": $0.phase.rawValue, "preparedJSON": $0.preparedJSON] }]
        let response = try Self.object(invoke("attachmentDraftDiscardCandidates", [Self.json(input)]), limit: 4 * 1024 * 1024)
        guard Set(response.keys) == Set(["version", "kind", "historyVersion", "taskID", "candidates"]),
              Self.integer(response["version"]) == 1, response["kind"] as? String == "owned-add-discard-candidates",
              Self.integer(response["historyVersion"]) == Int64(record.version),
              let task = response["taskID"] as? String, Self.equal(task, record.session.taskID),
              let candidates = response["candidates"] as? [[String: Any]], candidates.count == record.operations.count else { throw Self.failure }
        for (candidate, op) in zip(candidates, record.operations) {
            guard Set(candidate.keys) == Set(["requestId", "targetURI", "reason"]),
                  let id = candidate["requestId"] as? String, Self.equal(id, op.requestId),
                  let target = candidate["targetURI"] as? String, Self.equal(target, op.targetURI),
                  candidate["reason"] as? String == "uncommitted-draft" else { throw Self.failure }
        }
        return record.operations
    }

    /// Synchronous typed completion only; this method never enters JSC. Called
    /// inside the trusted live-reference handoff's native retirement callback.
    func retireOwnedDiscardTarget(_ op: NativeAttachmentDraftStore.Operation,
                                  cancellation: NativeAttachmentCancellation) throws -> String {
        guard let proof = op.published else { throw Self.failure }
        defer { jobs.drain() }
        let value = try file(.retirePublished(targetURI: op.targetURI,
            proof: .init(sha256: proof.sha256, size: proof.size, identity: proof.identity,
                         directoryIdentity: proof.directoryIdentity)), cancellation: cancellation)
        guard Set(value.keys) == Set(["status"]), let status = value["status"] as? String,
              ["removed", "absent"].contains(status) else { throw Self.failure }
        return status
    }

    func retireOwnedDiscardStage(_ op: NativeAttachmentDraftStore.Operation,
                                 cancellation: NativeAttachmentCancellation) throws -> String {
        guard let reserved = op.stage else { throw Self.failure }
        defer { jobs.drain() }
        let value = try file(.retirePrivateStage(stage: stage(reserved), targetURI: op.targetURI,
            operationID: op.requestId.replacingOccurrences(of: "-", with: "")), cancellation: cancellation)
        guard Set(value.keys) == Set(["status"]), let status = value["status"] as? String,
              ["removed", "missing"].contains(status) else { throw Self.failure }
        return status
    }

    func add(_ raw: String, cancellation: NativeAttachmentCancellation) throws -> String {
        let request = try Self.request(raw, add: true)
        guard var record = try store.read(), record.session.state == .active, record.session.sessionID == request.session,
              record.checkpointAdvance == nil else { throw Self.failure }
        if let existing = record.operations.first(where: { $0.requestId == request.id }) {
            guard Self.equal(existing.requestJSON, request.json) else { throw Self.failure }
        }
        if record.discard?.requestId == request.id { throw Self.failure }
        try lineage(record)
        if record.operations.last?.phase != .checkpointed, !record.operations.isEmpty { record = try resume(record, cancellation: cancellation) }
        if let existing = record.operations.first(where: { $0.requestId == request.id }) {
            guard existing.phase == .checkpointed, let reply = existing.replyJSON else { throw Self.failure }
            try current(record.session.checkpoint)
            acknowledge("add", "replayed")
            return reply
        }
        try cancellation.check()
        guard record.operations.count < 128, record.session.checkpoint.generation == request.generation,
              request.generation < 9_007_199_254_740_991 else { throw Self.failure }
        if record.version == 2 { guard request.generation < 9_007_199_254_740_990 else { throw Self.failure } }
        try current(record.session.checkpoint)
        let sourceValue = try file(.snapshotSource(sourceURI: request.picked!["uri"] as! String), cancellation: cancellation)
        let source = try JSONDecoder().decode(Store.Source.self, from: Data(Self.json(sourceValue).utf8))
        let input: [String: Any] = ["version": record.version, "taskID": record.session.taskID,
            "initialPayloadJSON": record.operations.first?.before.payloadJSON ?? record.session.checkpoint.payloadJSON,
            "beforePayloadJSON": record.session.checkpoint.payloadJSON,
            "priorAdditions": try record.operations.map { try Self.object($0.preparedJSON, limit: 2 * 1024 * 1024) },
            "requestId": request.id, "picked": request.picked!, "measuredSize": source.size, "managedDirectoryURI": managedURI]
        let frozenJSON = try invoke(record.version == 2 ? "attachmentDraftPrepareV2" : "attachmentDraftPrepare", [Self.json(input)])
        let frozen = try Self.object(frozenJSON, limit: 2 * 1024 * 1024)
        guard let afterPayload = frozen["afterPayloadJSON"] as? String, let target = frozen["targetURI"] as? String else { throw Self.failure }
        let before = record.session.checkpoint
        let after = EditorDraftSnapshot(sessionID: before.sessionID, taskID: before.taskID, generation: before.generation + 1, payloadJSON: afterPayload)
        let op = Store.Operation(requestId: request.id, requestJSON: request.json, phase: .intent, before: before, after: after,
                                 preparedJSON: frozenJSON, targetURI: target, source: source)
        _ = try prepared(op)
        record = Store.Record(version: record.version, session: record.session, operations: record.operations + [op],
                              discard: record.discard, checkpointAdvance: record.checkpointAdvance)
        try preflight(record)
        try cancellation.check()
        #if DEBUG
        try hooks?.boundary?(.beforeIntent)
        #endif
        try store.write(record)
        #if DEBUG
        try hooks?.boundary?(.afterIntent)
        #endif
        record = try resume(record, cancellation: cancellation)
        guard let reply = record.operations.last?.replyJSON else { throw Self.failure }
        acknowledge("add", "confirmed")
        return reply
    }
    func recover(session: String, cancellation: NativeAttachmentCancellation) throws -> String {
        guard Self.uuid(session) != nil, var record = try store.read(), record.session.sessionID == session else { throw Self.failure }
        if record.version == 2 { jobs.drain() }
        try lineage(record)
        if record.checkpointAdvance != nil {
            try cancellation.check()
            record = try finishAdvance(record)
            acknowledge("checkpoint", "confirmed")
        }
        if record.session.state == .cleanupPending { record = try detach(record); return try Self.summary(record) }
        if !record.operations.isEmpty, record.operations.last?.phase != .checkpointed {
            record = try resume(record, cancellation: cancellation)
            acknowledge("add", "confirmed")
        }
        return try Self.summary(record)
    }
    private func addReply(_ op: Store.Operation) throws -> String {
        try Self.json(["version": 1, "status": "added", "requestId": op.requestId, "sessionID": op.after.sessionID, "generation": op.after.generation])
    }
    private func replacing(_ record: Store.Record, _ op: Store.Operation) -> Store.Record {
        let checkpoint = op.phase == .checkpointed ? op.after : record.session.checkpoint
        return Store.Record(version: record.version, session: .init(sessionID: record.session.sessionID, taskID: record.session.taskID, state: record.session.state, checkpoint: checkpoint),
                            operations: Array(record.operations.dropLast()) + [op], discard: record.discard, checkpointAdvance: record.checkpointAdvance)
    }
    private func advancing(_ op: Store.Operation, phase: Store.Phase, stage: Store.Stage? = nil,
                           filled: Store.Filled? = nil, published: Store.Published? = nil, reply: String? = nil,
                           reason: Store.Reason? = nil) -> Store.Operation {
        Store.Operation(requestId: op.requestId, requestJSON: op.requestJSON, phase: phase, reason: reason, before: op.before, after: op.after,
                        preparedJSON: op.preparedJSON, targetURI: op.targetURI, source: op.source,
                        stage: stage ?? op.stage, filled: filled ?? op.filled, published: published ?? op.published, replyJSON: reply ?? op.replyJSON)
    }
    private func stage(_ proof: Store.Stage) -> NativeAttachmentFiles.ReservedAttachmentStageProof {
        .init(stageURI: proof.uri, stagedIdentity: proof.identity, directoryIdentity: proof.directoryIdentity, privateDirectoryIdentity: proof.privateDirectoryIdentity)
    }
    private func source(_ proof: Store.Source) -> NativeAttachmentFiles.CacheSourceProof {
        .init(sourceURI: proof.sourceURI, sha256: proof.sha256, size: proof.size, identity: proof.identity, cacheRootIdentity: proof.cacheRootIdentity, parentIdentity: proof.parentIdentity)
    }
    private func resume(_ original: Store.Record, cancellation: NativeAttachmentCancellation) throws -> Store.Record {
        var record = original
        guard var op = record.operations.last else { return record }
        _ = try prepared(op)
        do {
            if op.phase == .intent {
                guard op.reason != .interruptedReservation else { throw Self.failure }
                try preflight(record)
                try cancellation.check()
                _ = try file(.ensureManagedDirectory, cancellation: cancellation)
                let value: [String: Any]
                do { value = try file(.prepareStage(targetURI: op.targetURI, operationID: op.requestId.replacingOccurrences(of: "-", with: "")), cancellation: cancellation) }
                catch {
                    let retained = advancing(op, phase: op.phase, reason: .interruptedReservation)
                    try? store.write(replacing(record, retained))
                    throw Self.failure
                }
                #if DEBUG
                try hooks?.boundary?(.afterReservation)
                #endif
                guard Set(value.keys) == Set(["stageURI", "stagedIdentity", "directoryIdentity", "privateDirectoryIdentity"]),
                      let uri = value["stageURI"] as? String, let identity = value["stagedIdentity"] as? String,
                      let directory = value["directoryIdentity"] as? String, let privateDirectory = value["privateDirectoryIdentity"] as? String else { throw Self.failure }
                let proof = Store.Stage(uri: uri, identity: identity, directoryIdentity: directory, privateDirectoryIdentity: privateDirectory)
                #if DEBUG
                try hooks?.boundary?(.beforeStageProof)
                #endif
                op = advancing(op, phase: .stagePrepared, stage: proof)
                record = replacing(record, op); try store.write(record)
                #if DEBUG
                try hooks?.boundary?(.afterStageProof)
                #endif
            }
            if op.phase == .stagePrepared {
                try cancellation.check()
                let value = try file(.fillStage(source: source(op.source), stage: stage(op.stage!)), cancellation: cancellation)
                let content = try JSONDecoder().decode(Store.Filled.self, from: Data(Self.json(value).utf8))
                #if DEBUG
                try hooks?.boundary?(.beforeFilled)
                #endif
                op = advancing(op, phase: .stageFilled, filled: content)
                record = replacing(record, op); try store.write(record)
                #if DEBUG
                try hooks?.boundary?(.afterFilled)
                #endif
            }
            if op.phase == .stageFilled {
                // Re-prove an earlier rename before trying publication again.
                var proof = try? file(.verifyPublication(targetURI: op.targetURI, stage: stage(op.stage!), sha256: op.source.sha256, size: op.source.size), cancellation: cancellation, ignoringCancellation: true)
                if proof == nil {
                    try cancellation.check()
                    let latest = try JSONDecoder().decode(Store.Source.self, from: Data(Self.json(file(.snapshotSource(sourceURI: op.source.sourceURI), cancellation: cancellation)).utf8))
                    guard Self.equal(latest.sourceURI, op.source.sourceURI), latest.sha256 == op.source.sha256,
                          latest.size == op.source.size, latest.identity == op.source.identity,
                          latest.cacheRootIdentity == op.source.cacheRootIdentity, latest.parentIdentity == op.source.parentIdentity else { throw Self.failure }
                    #if DEBUG
                    try hooks?.boundary?(.beforePublication)
                    #endif
                    _ = try? file(.publishStage(stage: stage(op.stage!), targetURI: op.targetURI, sha256: op.source.sha256), cancellation: cancellation)
                    #if DEBUG
                    try hooks?.boundary?(.afterPublication)
                    #endif
                    proof = try file(.verifyPublication(targetURI: op.targetURI, stage: stage(op.stage!), sha256: op.source.sha256, size: op.source.size), cancellation: cancellation, ignoringCancellation: true)
                }
                guard let proof else { throw Self.failure }
                let publication = try JSONDecoder().decode(Store.Published.self, from: Data(Self.json(proof).utf8))
                op = advancing(op, phase: .published, published: publication)
                record = replacing(record, op); try store.write(record)
                #if DEBUG
                try hooks?.boundary?(.afterPublicationProof)
                #endif
            }
            if op.phase == .published || op.phase == .resultDurable {
                _ = try file(.verifyPublication(targetURI: op.targetURI, stage: stage(op.stage!), sha256: op.source.sha256, size: op.source.size), cancellation: cancellation, ignoringCancellation: true)
                try cancellation.check()
                #if DEBUG
                try hooks?.boundary?(.beforeResult)
                #endif
                let frozen = try prepared(op)
                let value = try Self.object(invoke("attachmentDraftResult", [Self.json(["prepared": frozen])]))
                guard Set(value.keys) == Set(["version", "kind", "taskID", "requestId", "afterPayloadJSON", "attachment"]),
                      Self.integer(value["version"]) == 1, value["kind"] as? String == "added",
                      value["taskID"] as? String == op.before.taskID, value["requestId"] as? String == op.requestId,
                      let payload = value["afterPayloadJSON"] as? String, Self.equal(payload, op.after.payloadJSON),
                      Self.equal(try Self.json(value["attachment"]!), try Self.json(frozen["attachment"]!)) else { throw Self.failure }
                if op.phase == .published {
                    op = advancing(op, phase: .resultDurable, reply: try addReply(op))
                    record = replacing(record, op); try store.write(record)
                }
                #if DEBUG
                try hooks?.boundary?(.afterResult)
                try hooks?.boundary?(.beforeCheckpoint)
                #endif
                try editor.checkpointMatching(before: op.before, after: op.after)
                #if DEBUG
                try hooks?.boundary?(.afterCheckpoint)
                #endif
                try current(op.after)
                #if DEBUG
                try hooks?.boundary?(.beforeMarker)
                #endif
                op = advancing(op, phase: .checkpointed)
                record = replacing(record, op); try store.write(record)
                #if DEBUG
                try hooks?.boundary?(.afterMarker)
                #endif
            }
            return record
        } catch {
            // Read the actual durable phase rather than a speculative local
            // value when a boundary write or acknowledgment failed.
            if let actual = try? store.read(), let retained = actual.operations.last, retained.phase != .checkpointed {
                try? store.write(replacing(actual, advancing(retained, phase: retained.phase, reason: retained.reason ?? .io)))
            }
            throw Self.failure
        }
    }
    private func preflight(_ record: Store.Record) throws {
        guard let op = record.operations.last else { throw Self.failure }
        // All unknown descriptor tokens have a fixed maximum decimal width.
        // Escaped snapshot/preparation strings are included by the real encoder.
        let token = "18446744073709551615:18446744073709551615"
        let proof = Store.Stage(uri: managedURI + ".mindwtr-install-" + op.requestId.replacingOccurrences(of: "-", with: "") + ".candidate/stage",
                                identity: token, directoryIdentity: token, privateDirectoryIdentity: token)
        let complete = advancing(op, phase: .checkpointed, stage: proof,
            filled: .init(sha256: op.source.sha256, size: op.source.size, identity: token),
            published: .init(sha256: op.source.sha256, size: op.source.size, identity: token, directoryIdentity: token), reply: try addReply(op))
        let checkpointed = replacing(record, complete)
        let failed = replacing(record, advancing(complete, phase: .resultDurable, reason: .interruptedReservation))
        let discardID = "ffffffff-ffff-ffff-ffff-ffffffffffff"
        let request = try Self.json(["version": 1, "requestId": discardID, "sessionID": op.after.sessionID, "generation": op.after.generation])
        let reply = try Self.json(["version": 1, "status": "cleanupPending", "requestId": discardID, "sessionID": op.after.sessionID])
        let retained = Store.Record(version: record.version, session: .init(sessionID: checkpointed.session.sessionID, taskID: checkpointed.session.taskID,
            state: .cleanupPending, checkpoint: op.after), operations: checkpointed.operations,
            discard: .init(requestId: discardID, requestJSON: request, expected: op.after, phase: .detached, replyJSON: reply), checkpointAdvance: record.checkpointAdvance)
        let pendingRequest = try Self.json(["version": 1, "requestId": discardID, "sessionID": op.before.sessionID, "generation": op.before.generation])
        // Before may contain more opaque whitespace than canonical after. A
        // failed Add must still leave room to retain that exact before-half.
        let retainedPending = Store.Record(version: record.version, session: .init(sessionID: failed.session.sessionID, taskID: failed.session.taskID,
            state: .cleanupPending, checkpoint: op.before), operations: failed.operations,
            discard: .init(requestId: discardID, requestJSON: pendingRequest, expected: op.before, phase: .detached, replyJSON: reply), checkpointAdvance: record.checkpointAdvance)
        var candidates = [checkpointed, failed, retained, retainedPending]
        if record.version == 2 {
            guard op.after.generation < 9_007_199_254_740_991 else { throw Self.failure }
            // Budget only incorporation of the acknowledged Add list, using
            // captured after bytes. Arbitrary later edits require their own budget.
            let next = EditorDraftSnapshot(sessionID: op.after.sessionID, taskID: op.after.taskID,
                generation: op.after.generation + 1, payloadJSON: op.after.payloadJSON)
            candidates.append(checkpointRecord(checkpointed, checkpoint: op.after,
                advance: .init(before: op.after, after: next)))
            candidates.append(checkpointRecord(checkpointed, checkpoint: next, advance: nil))
        }
        for candidate in candidates {
            guard try JSONEncoder().encode(candidate).count <= Store.maximumBytes else { throw Self.failure }
        }
    }
    /// Polls one typed ID without entering JSC or taking a raw mailbox frame.
    private func file(_ request: NativeAttachmentDraftFileRequest, cancellation: NativeAttachmentCancellation,
                      ignoringCancellation: Bool = false) throws -> [String: Any] {
        if !ignoringCancellation { try cancellation.check() }
        let id = try jobs.submitDraft(request)
        while true {
            let raw = jobs.takeDraft(id)
            if !raw.isEmpty {
                let answer = try Self.object(raw, limit: 64 * 1024)
                guard answer["id"] as? String == id, Set(answer.keys) == Set(["id", "value"]), let value = answer["value"] as? [String: Any] else { throw Self.failure }
                return value
            }
            if !ignoringCancellation && cancellation.isCancelled { jobs.abort(id) }
            Thread.sleep(forTimeInterval: 0.001)
        }
    }
    func discard(_ raw: String) throws -> String {
        let request = try Self.request(raw, add: false)
        guard var record = try store.read(), record.session.sessionID == request.session,
              record.checkpointAdvance == nil else { throw Self.failure }
        if record.operations.contains(where: { $0.requestId == request.id }) { throw Self.failure }
        try lineage(record)
        if let existing = record.discard {
            guard Self.equal(existing.requestJSON, request.json) else { throw Self.failure }
            record = try detach(record)
            guard let reply = record.discard?.replyJSON else { throw Self.failure }
            acknowledge("discard", "retained")
            return reply
        }
        guard record.session.state == .active, record.session.checkpoint.generation == request.generation else { throw Self.failure }
        // A retained interrupted Add is discardable without resuming IO.
        // Only its exact recorded checkpoint may detach; a physically advanced
        // after-checkpoint still requires exact Add reconciliation first.
        jobs.drain()
        try lineage(record); try current(record.session.checkpoint)
        #if DEBUG
        try hooks?.boundary?(.beforeDiscardDecision)
        #endif
        record = Store.Record(version: record.version, session: .init(sessionID: record.session.sessionID, taskID: record.session.taskID, state: .cleanupPending, checkpoint: record.session.checkpoint), operations: record.operations,
                              discard: .init(requestId: request.id, requestJSON: request.json, expected: record.session.checkpoint, phase: .decided), checkpointAdvance: record.checkpointAdvance)
        try store.write(record)
        #if DEBUG
        try hooks?.boundary?(.afterDiscardDecision)
        #endif
        record = try detach(record)
        guard let reply = record.discard?.replyJSON else { throw Self.failure }
        acknowledge("discard", "retained")
        return reply
    }
    private func discardReply(_ record: Store.Record, _ discard: Store.Discard) throws -> String {
        try Self.json(["version": 1, "status": "cleanupPending", "requestId": discard.requestId, "sessionID": record.session.sessionID])
    }
    private func detach(_ record: Store.Record) throws -> Store.Record {
        guard let discard = record.discard else { throw Self.failure }
        if discard.phase == .detached {
            guard try editor.read() == nil else { throw Self.failure }
            return record
        }
        #if DEBUG
        try hooks?.boundary?(.beforeDetach)
        #endif
        try editor.discardMatching(expected: discard.expected)
        #if DEBUG
        try hooks?.boundary?(.afterDetach)
        #endif
        guard try editor.read() == nil else { throw Self.failure }
        let reply = try discardReply(record, discard)
        let detached = Store.Record(version: record.version, session: record.session, operations: record.operations,
            discard: .init(requestId: discard.requestId, requestJSON: discard.requestJSON, expected: discard.expected, phase: .detached, replyJSON: reply), checkpointAdvance: record.checkpointAdvance)
        try store.write(detached)
        return detached
    }
}
