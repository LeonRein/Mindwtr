import XCTest
import Foundation
import Darwin
import UniformTypeIdentifiers
import CryptoKit
@testable import MindwtrNativeCore
#if canImport(UIKit)
import UIKit
#endif

/// Controlled callbacks exercise the actual native load frame and descriptors.
/// Only the UIKit cases establish actual photo encoding/V3 producer behavior.
final class NativePhotoProviderHostTests: XCTestCase {
    private final class Provider: NSItemProvider, @unchecked Sendable {
        private let stateLock = NSLock()
        private var callback: ((URL?, Error?) -> Void)?
        let returnedProgress = Progress(totalUnitCount: 1)
        var requested: (() -> Void)?
        var synchronousURL: URL?
        var afterDelivery: (() -> Void)?
        private(set) var loads = 0
        override init() {
            super.init()
            registerDataRepresentation(forTypeIdentifier: UTType.png.identifier, visibility: .all) { done in
                done(nil, NativeAttachmentFilesError.unavailable); return nil
            }
        }
        override func loadFileRepresentation(forTypeIdentifier typeIdentifier: String,
                                             completionHandler: @escaping (URL?, Error?) -> Void) -> Progress {
            stateLock.lock(); loads += 1; callback = completionHandler; let url = synchronousURL; stateLock.unlock()
            requested?()
            if let url { completionHandler(url, nil); afterDelivery?() }
            return returnedProgress
        }
        func deliver(_ url: URL?, error: Error? = nil) {
            stateLock.lock(); let reply = callback; stateLock.unlock()
            reply?(url, error); afterDelivery?()
        }
    }
    private var root: URL!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var cache: URL { root.appendingPathComponent("attachment-files/cache", isDirectory: true) }
    private var store: NativeAttachmentDraftStore { .init(databaseURL: database) }
    private var editor: EditorDraftStore { .init(databaseURL: database) }
    private let taskID = "photo-provider-task"
    private let at = "2026-10-06T12:00:00.000Z"
    override func setUpWithError() throws {
        let checkout = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let directory = checkout.appendingPathComponent(".build/task283/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw NativeAttachmentFilesError.unavailable }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func source(_ bytes: Data = Data("borrowed callback bytes".utf8)) throws -> URL {
        let directory = root.appendingPathComponent("provider", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent("Private.png"); try bytes.write(to: url); return url
    }
    private func entries() throws -> [URL] { try FileManager.default.contentsOfDirectory(at: cache, includingPropertiesForKeys: nil) }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    private func object(_ value: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(value.utf8)) as? [String: Any]) }
    private func inode(_ url: URL) throws -> String {
        var value = stat(); guard lstat(url.path, &value) == 0 else { throw HostFailure("Fixture missing") }
        return "\(value.st_dev):\(value.st_ino)"
    }
    private func replace(_ url: URL) throws {
        let bytes = try Data(contentsOf: url), previous = try inode(url)
        try FileManager.default.moveItem(at: url, to: url.appendingPathExtension("retained")); try bytes.write(to: url)
        XCTAssertNotEqual(try inode(url), previous)
    }
    private func expectRefusal(_ work: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await work(); XCTFail("Expected refusal", file: file, line: line) }
        catch { XCTAssertFalse(error.localizedDescription.contains("file:///"), file: file, line: line) }
    }

    func testSynchronousCaptureFinishesBeforeBorrowedCallbackURLExpires() async throws {
        let files = try NativeAttachmentFiles(libraryRoot: root), jobs = try NativeAttachmentFileJobs(libraryRoot: root)
        defer { jobs.shutdown() }
        let selected = try source(), bytes = try Data(contentsOf: selected), token = NativeAttachmentCancellation()
        let provider = Provider(); provider.synchronousURL = selected
        var callbackEnded = false, captures = 0, expiryFailure: Error?
        provider.afterDelivery = {
            callbackEnded = true
            do { try FileManager.default.removeItem(at: selected) } catch { expiryFailure = error }
        }
        let frame = NativeAttachmentPhotoLoadFrame { url in
            XCTAssertFalse(callbackEnded); captures += 1
            return try jobs.copyProviderSource(url, cancellation: token)
        }
        let receipt = try await frame.load(provider, typeIdentifier: UTType.png.identifier)
        XCTAssertEqual(captures, 1); XCTAssertEqual(provider.loads, 1); XCTAssertTrue(callbackEnded); XCTAssertNil(expiryFailure)
        XCTAssertFalse(FileManager.default.fileExists(atPath: selected.path))
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(URL(string: receipt.sourceURI))), bytes)
        try jobs.requireProviderSource(receipt)
    }

    func testCancelBeforeLoadAndLateDuplicateCallbackDoNoIO() async throws {
        let files = try NativeAttachmentFiles(libraryRoot: root), selected = try source()
        let before = try Data(contentsOf: selected)
        var captures = 0
        let early = NativeAttachmentPhotoLoadFrame { url in captures += 1; return try files.copyProviderSource(url, checkCancellation: {}) }
        early.cancel(); let never = Provider()
        await expectRefusal { _ = try await early.load(never, typeIdentifier: UTType.png.identifier) }
        XCTAssertEqual(never.loads, 0)
        let waiting = NativeAttachmentPhotoLoadFrame { url in captures += 1; return try files.copyProviderSource(url, checkCancellation: {}) }
        let provider = Provider(), requested = expectation(description: "load requested")
        provider.requested = { requested.fulfill() }
        let task = Task { try await waiting.load(provider, typeIdentifier: UTType.png.identifier) }
        await fulfillment(of: [requested], timeout: 2)
        waiting.cancel()
        await expectRefusal { _ = try await task.value }
        XCTAssertTrue(provider.returnedProgress.isCancelled)
        provider.deliver(selected); provider.deliver(selected)
        XCTAssertEqual(captures, 0); XCTAssertTrue(try entries().isEmpty)
        XCTAssertEqual(try Data(contentsOf: selected), before)
    }

    func testCancelWhileCopyingStillDeliversExactCreatedReceiptOnce() async throws {
        let files = try NativeAttachmentFiles(libraryRoot: root), selected = try source(), bytes = try Data(contentsOf: selected)
        let provider = Provider(); provider.synchronousURL = selected
        var captures = 0, frame: NativeAttachmentPhotoLoadFrame!
        frame = NativeAttachmentPhotoLoadFrame { url in
            captures += 1
            let receipt = try files.copyProviderSource(url, checkCancellation: {})
            frame.cancel() // Creation succeeded; copying frame must retain the receipt.
            return receipt
        }
        let receipt = try await frame.load(provider, typeIdentifier: UTType.png.identifier)
        provider.deliver(selected)
        XCTAssertEqual(captures, 1); XCTAssertTrue(provider.returnedProgress.isCancelled)
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(URL(string: receipt.sourceURI))), bytes)
        XCTAssertEqual(try files.retireProviderSource(receipt, checkCancellation: {}), .removed)
        XCTAssertTrue(try entries().isEmpty); XCTAssertEqual(try Data(contentsOf: selected), bytes)
    }

    func testLateCaptureAfterJobsShutdownRefusesWithoutCacheCreation() async throws {
        let files = try NativeAttachmentFiles(libraryRoot: root), jobs = try NativeAttachmentFileJobs(libraryRoot: root)
        let selected = try source(), bytes = try Data(contentsOf: selected), token = NativeAttachmentCancellation()
        let frame = NativeAttachmentPhotoLoadFrame { url in try jobs.copyProviderSource(url, cancellation: token) }
        let provider = Provider(), requested = expectation(description: "awaiting provider")
        provider.requested = { requested.fulfill() }
        let task = Task { try await frame.load(provider, typeIdentifier: UTType.png.identifier) }
        await fulfillment(of: [requested], timeout: 2)
        jobs.shutdown(); provider.deliver(selected)
        await expectRefusal { _ = try await task.value }
        XCTAssertTrue(try entries().isEmpty); XCTAssertEqual(try Data(contentsOf: selected), bytes)
    }

    func testCancellationCallbacksRunOutsideRegistryAndTokenLocks() {
        let requests = NativeAttachmentLocalRequests(), token = NativeAttachmentCancellation(), id = UUID()
        var hits = 0
        token.setCancellationHandler { hits += 1; requests.remove(id); XCTAssertTrue(token.isCancelled) }
        requests.close(); requests.register(token, id: id)
        XCTAssertEqual(hits, 1)
        token.cancel(); XCTAssertEqual(hits, 1)
        token.setCancellationHandler(nil)
    }

    func testSparseOversizePhotoSourceRefusesBeforeReadDecodeOrOutput() throws {
        let files = try NativeAttachmentFiles(libraryRoot: root), selected = try source(Data())
        let fd = Darwin.open(selected.path, O_WRONLY | O_NOFOLLOW | O_CLOEXEC)
        XCTAssertGreaterThanOrEqual(fd, 0); guard fd >= 0 else { return }; defer { Darwin.close(fd) }
        XCTAssertEqual(Darwin.ftruncate(fd, NativeAttachmentPhotoEncoder.maximumInputBytes + 1), 0)
        let identity = try inode(selected)
        let selection = NativeAttachmentPhotoSelection(loadType: UTType.png.identifier, preferredType: UTType.png.identifier, suggestedName: "Private")
        XCTAssertThrowsError(try files.copyPhotoProviderSource(selected, selection: selection, checkCancellation: {})) { error in
            guard case NativeAttachmentFilesError.providerTooLarge = error else { return XCTFail("Expected bounded size admission") }
        }
        XCTAssertTrue(try entries().isEmpty); XCTAssertEqual(try inode(selected), identity)
        var current = stat(); XCTAssertEqual(lstat(selected.path, &current), 0)
        XCTAssertEqual(current.st_size, NativeAttachmentPhotoEncoder.maximumInputBytes + 1)
    }

    #if canImport(UIKit)
    private func core() throws -> CoreHost {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("Set MINDWTR_CORE_BUNDLE to actual core-host.js") }
        let host = CoreHost(databaseURL: database, bundleURL: URL(fileURLWithPath: path))
        addTeardownBlock { await host.close() }; return host
    }
    private func sql(_ statement: String, _ parameters: [Any] = []) throws -> String {
        let db = try SQLiteBridge(url: database); defer { db.close() }
        return try db.execute(statement, parametersJSON: json(parameters))
    }
    private func rows() throws -> String { try json(NativeJSON.jsonObject(with: Data(sql("SELECT * FROM tasks ORDER BY id").utf8))) }
    private func latest() throws -> EditorDraftSnapshot { try XCTUnwrap(editor.read()?.snapshot) }
    private func lastAdd() throws -> NativeAttachmentDraftStore.Operation {
        guard let entry = try store.readMixed()?.operations.last, case .add(let op) = entry else { throw HostFailure("Fixture Add missing") }; return op
    }
    private func imageBytes() throws -> Data {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 16, height: 8)).image { context in
            UIColor.systemBlue.setFill(); context.fill(CGRect(x: 0, y: 0, width: 16, height: 8))
        }
        return try XCTUnwrap(image.pngData())
    }
    private func provider(_ url: URL) -> NSItemProvider {
        let item = NSItemProvider()
        item.registerFileRepresentation(forTypeIdentifier: UTType.png.identifier, fileOptions: [], visibility: .all) { done in
            done(url, false, nil); return Progress(totalUnitCount: 1)
        }
        item.suggestedName = "Private.photo.png"
        return item
    }
    private func seed(hooks: NativeAttachmentHostHooks? = nil) async throws -> (CoreHost, [String: Any]) {
        let boot = try core(); _ = try await boot.start(); await boot.close()
        _ = try sql("INSERT INTO tasks(id,title,status,contexts,tags,attachments,checklist,createdAt,updatedAt,rev,revBy) VALUES (?,'Photo task','inbox','[]','[]',NULL,NULL,?,?,1,'fixture')", [taskID, at, at])
        let host = try core(); if let hooks { await host.configureAttachmentHost(hooks) }; _ = try await host.start()
        let opening = try object(await host.call("editorModel", argumentsJSON: json([taskID])))
        let raw: [String: Any] = ["title": "", "note": "", "location": "", "estimate": "", "estimateResolved": "", "timeSpent": "", "timeSpentResolved": "", "tokens": [:], "tokenCanonical": [:], "tokenResolved": [:], "tokenEdited": [], "checklistInputs": [:], "checklistAppend": "", "relativeAmount": "", "relativeUnit": "", "relativeOwned": false, "relativeCommitRequested": false, "recurrenceInputs": [:], "recurrenceOwned": [], "recurrenceCommitRequested": []]
        let payload = try json(["version": 2, "taskID": taskID, "tab": "task", "touchedBase": [:], "edited": [:], "raw": raw,
            "scheduleEdits": [], "scheduleFailedID": NSNull(), "attachmentsOwned": true, "attachmentsBase": [], "attachments": [], "linkSheet": [:], "checklistBase": [], "checklistValue": []] as [String: Any])
        try await host.checkpointEditorDraft(.init(sessionID: UUID().uuidString.lowercased(), taskID: taskID, generation: 1, payloadJSON: payload))
        return (host, opening)
    }
    private func add(_ host: CoreHost, item: NSItemProvider, id: String = UUID().uuidString.lowercased()) async throws -> String {
        let snapshot = try latest()
        return try await host.addPhotoProviderAttachmentV3(itemProvider: item, expectedSession: snapshot.sessionID,
            expectedGeneration: snapshot.generation, requestId: id)
    }
    func testActualPhotoAddSaveAndColdOpenUseProcessedMetadataAndExactBytes() async throws {
        let (host, opening) = try await seed(), before = try rows(), bytes = try imageBytes(), selected = try source(bytes)
        let id = UUID().uuidString.lowercased(), reply = try object(await add(host, item: provider(selected), id: id)), op = try lastAdd()
        XCTAssertEqual(reply["status"] as? String, "added"); XCTAssertEqual(op.requestId, id); XCTAssertEqual(op.phase, .checkpointed)
        let oracle = try XCTUnwrap(UIImage(data: bytes)?.pngData()), target = try XCTUnwrap(URL(string: op.targetURI))
        XCTAssertEqual(try Data(contentsOf: target), oracle); XCTAssertEqual(op.source.size, Int64(oracle.count))
        let picked = try XCTUnwrap(object(op.requestJSON)["picked"] as? [String: Any])
        XCTAssertEqual(picked["name"] as? String, "Private.photo.png.png"); XCTAssertEqual(picked["mimeType"] as? String, "image/png")
        XCTAssertEqual(picked["size"] as? Int, oracle.count); XCTAssertTrue(try entries().isEmpty); XCTAssertEqual(try rows(), before)
        XCTAssertEqual(try Data(contentsOf: selected), bytes)
        let snapshot = try latest(), attachments = try XCTUnwrap(object(snapshot.payloadJSON)["attachments"] as? [[String: Any]])
        let save: [String: Any] = ["id": taskID, "requestId": UUID().uuidString.lowercased(), "base": [:], "patch": [:], "scheduleBase": try XCTUnwrap(opening["scheduleBase"]),
            "checklist": ["base": [], "value": []], "attachments": ["base": [], "value": attachments]]
        _ = try await host.saveAttachmentDraftComplete(saveRequestJSON: json(save), expectedSession: snapshot.sessionID, expectedGeneration: snapshot.generation)
        await host.close(); let cold = try core(); _ = try await cold.start()
        let savedRows = try rows(), plan = try object(await cold.prepareTaskFileOpen(requestJSON: json(["owner": ["kind": "task", "taskId": taskID, "attachments": attachments], "attachmentId": id])))
        XCTAssertEqual(plan["status"] as? String, "available"); XCTAssertEqual((plan["open"] as? [String: Any])?["kind"] as? String, "image")
        XCTAssertEqual(try Data(contentsOf: target), oracle); XCTAssertEqual(try rows(), savedRows)
        let log = try String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"))
        XCTAssertTrue(log.contains("v1.3.5/ios-task-photo-add")); XCTAssertFalse(log.contains("Private.photo"))
    }
    func testWaitingPhotoBlocksConflictingOwnersAndCancelPreservesProtectedEditor() async throws {
        let (host, opening) = try await seed(), snapshot = try latest(), rowsBefore = try rows(), selected = try source(imageBytes())
        let controlled = Provider(), requested = expectation(description: "photo is awaiting selection bytes")
        controlled.requested = { requested.fulfill() }
        let requestID = UUID().uuidString.lowercased()
        let operation = Task { try await host.addPhotoProviderAttachmentV3(itemProvider: controlled,
            expectedSession: snapshot.sessionID, expectedGeneration: snapshot.generation, requestId: requestID) }
        await fulfillment(of: [requested], timeout: 2)
        let ownerBytes = try Data(contentsOf: store.url), editorBytes = try Data(contentsOf: editor.url)
        let ownerIdentity = try inode(store.url), editorIdentity = try inode(editor.url)
        XCTAssertEqual(try store.readMixed()?.operations.count, 0)
        await expectRefusal { try await host.checkpointEditorDraft(snapshot) }
        await expectRefusal { _ = try await host.recoverAttachmentDraftV3(expectedSession: snapshot.sessionID) }
        await expectRefusal { _ = try await host.beginAttachmentDraftV3(expectedSession: snapshot.sessionID, expectedGeneration: snapshot.generation) }
        let validSave: [String: Any] = ["id": taskID, "requestId": UUID().uuidString.lowercased(), "base": [:], "patch": [:],
            "scheduleBase": try XCTUnwrap(opening["scheduleBase"]), "checklist": ["base": [], "value": []], "attachments": ["base": [], "value": []]]
        let validDiscard = try json(["version": 1, "requestId": UUID().uuidString.lowercased(), "sessionID": snapshot.sessionID, "generation": snapshot.generation])
        await expectRefusal { _ = try await host.saveAttachmentDraftComplete(saveRequestJSON: self.json(validSave), expectedSession: snapshot.sessionID, expectedGeneration: snapshot.generation) }
        await expectRefusal { _ = try await host.discardAttachmentDraftV3(requestJSON: validDiscard) }
        operation.cancel(); await expectRefusal { _ = try await operation.value }
        controlled.deliver(selected); controlled.deliver(selected)
        XCTAssertTrue(controlled.returnedProgress.isCancelled)
        XCTAssertEqual(try Data(contentsOf: store.url), ownerBytes); XCTAssertEqual(try Data(contentsOf: editor.url), editorBytes)
        XCTAssertEqual(try inode(store.url), ownerIdentity); XCTAssertEqual(try inode(editor.url), editorIdentity)
        XCTAssertEqual(try rows(), rowsBefore); XCTAssertTrue(try entries().isEmpty)
        _ = try await host.checkAttachmentDraftResumeV3(expectedSession: snapshot.sessionID, expectedGeneration: snapshot.generation)
        _ = try await add(host, item: provider(selected))
        XCTAssertEqual(try lastAdd().phase, .checkpointed)
    }

    func testProviderFailureAndMalformedAdmissionNeverCreateAnAdd() async throws {
        let (host, _) = try await seed(), snapshot = try latest(), before = try rows(), selected = try source(imageBytes())
        let invalid = Provider()
        for (session, generation, request) in [(snapshot.sessionID, snapshot.generation, "not-a-uuid"),
            (snapshot.sessionID, snapshot.generation + 1, UUID().uuidString.lowercased()),
            (UUID().uuidString.lowercased(), snapshot.generation, UUID().uuidString.lowercased())] {
            await expectRefusal { _ = try await host.addPhotoProviderAttachmentV3(itemProvider: invalid,
                expectedSession: session, expectedGeneration: generation, requestId: request) }
        }
        XCTAssertEqual(invalid.loads, 0); XCTAssertNil(try store.readVersioned())
        let controlled = Provider(), requested = expectation(description: "provider load")
        controlled.requested = { requested.fulfill() }
        let operation = Task { try await self.add(host, item: controlled) }
        await fulfillment(of: [requested], timeout: 2)
        controlled.deliver(nil, error: NSError(domain: "private-provider", code: 1,
            userInfo: [NSLocalizedDescriptionKey: "Private failure file:///private/secret.png"]))
        await expectRefusal { _ = try await operation.value }
        XCTAssertEqual(try store.readMixed()?.operations.count, 0); XCTAssertEqual(try latest(), snapshot)
        XCTAssertEqual(try rows(), before); XCTAssertTrue(try entries().isEmpty)
        _ = try await add(host, item: provider(selected))
    }

    func testSameByteEditorOrOwnerReplacementDuringLoadRefusesAddAndKeepsCreationReceipt() async throws {
        let outer = try XCTUnwrap(root)
        for ownerFile in [false, true] {
            root = outer.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { root = outer }
            let (host, _) = try await seed(), snapshot = try latest(), before = try rows(), bytes = try imageBytes(), selected = try source(bytes)
            let controlled = Provider(), requested = expectation(description: "provider awaiting owner")
            controlled.requested = { requested.fulfill() }
            let operation = Task { try await self.add(host, item: controlled) }
            await fulfillment(of: [requested], timeout: 2)
            let file = ownerFile ? store.url : editor.url
            try replace(file); let replacementBytes = try Data(contentsOf: file), replacementIdentity = try inode(file)
            controlled.deliver(selected)
            await expectRefusal { _ = try await operation.value }
            XCTAssertEqual(try store.readMixed()?.operations.count, 0); XCTAssertEqual(try latest(), snapshot)
            XCTAssertEqual(try Data(contentsOf: file), replacementBytes); XCTAssertEqual(try inode(file), replacementIdentity)
            XCTAssertEqual(try rows(), before); XCTAssertEqual(try entries().count, 1)
            XCTAssertEqual(try Data(contentsOf: XCTUnwrap(entries().first)), try XCTUnwrap(UIImage(data: bytes)?.pngData()))
            XCTAssertEqual(try Data(contentsOf: selected), bytes); await host.close()
        }
    }

    func testHostCloseCancelsAwaitingPhotoAndLateDeliveryNeverCopies() async throws {
        let (host, _) = try await seed(), snapshot = try latest(), before = try rows(), selected = try source(imageBytes())
        let controlled = Provider(), requested = expectation(description: "provider waiting before close")
        controlled.requested = { requested.fulfill() }
        let operation = Task { try await self.add(host, item: controlled) }
        await fulfillment(of: [requested], timeout: 2)
        let ownerBytes = try Data(contentsOf: store.url), editorBytes = try Data(contentsOf: editor.url)
        await host.close(); await expectRefusal { _ = try await operation.value }
        controlled.deliver(selected)
        XCTAssertEqual(try Data(contentsOf: store.url), ownerBytes); XCTAssertEqual(try Data(contentsOf: editor.url), editorBytes)
        XCTAssertEqual(try latest(), snapshot); XCTAssertEqual(try rows(), before); XCTAssertTrue(try entries().isEmpty)
        let cold = try core(); _ = try await cold.start()
        _ = try await cold.checkAttachmentDraftResumeV3(expectedSession: snapshot.sessionID, expectedGeneration: snapshot.generation)
    }

    func testCancellationWhileEncodedOutputIsBeingFilledRemovesOnlyCreationAndDoesNotAdd() async throws {
        let hooks = NativeAttachmentHostHooks()
        var operation: Task<String, Error>?, reached = false
        hooks.configureJobs = { jobs in jobs.beforeStageSync = { reached = true; operation?.cancel() } }
        let (host, _) = try await seed(hooks: hooks), snapshot = try latest(), before = try rows(), bytes = try imageBytes(), selected = try source(bytes)
        operation = Task { try await self.add(host, item: provider(selected)) }
        await expectRefusal { _ = try await XCTUnwrap(operation).value }
        XCTAssertTrue(reached); XCTAssertEqual(try store.readMixed()?.operations.count, 0)
        XCTAssertEqual(try latest(), snapshot); XCTAssertEqual(try rows(), before); XCTAssertTrue(try entries().isEmpty)
        XCTAssertEqual(try Data(contentsOf: selected), bytes)
    }

    func testInterruptedProcessedPhotoRecoversColdWithOriginalUUIDWithoutProviderReload() async throws {
        let outer = try XCTUnwrap(root)
        for boundary in [AttachmentDraftBoundary.afterIntent, .afterFilled] {
            root = outer.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { root = outer }
            let (host, _) = try await seed(), snapshot = try latest(), before = try rows(), bytes = try imageBytes(), selected = try source(bytes)
            let hooks = AttachmentDraftHostHooks(); var fired = false
            hooks.boundary = { if $0 == boundary { fired = true; throw HostFailure("Controlled photo interruption") } }
            await host.configureAttachmentDraftHost(hooks)
            let item = provider(selected), requestID = UUID().uuidString.lowercased()
            await expectRefusal { _ = try await self.add(host, item: item, id: requestID) }
            XCTAssertTrue(fired)
            let pending = try lastAdd(), scratch = try XCTUnwrap(URL(string: pending.source.sourceURI)), processed = try Data(contentsOf: scratch)
            XCTAssertEqual(pending.requestId, requestID); XCTAssertEqual(pending.phase, boundary == .afterIntent ? .intent : .stageFilled)
            XCTAssertEqual(processed, try XCTUnwrap(UIImage(data: bytes)?.pngData())); XCTAssertEqual(try latest(), snapshot)
            let log = root.appendingPathComponent("logs/mindwtr.log")
            if FileManager.default.fileExists(atPath: log.path) {
                XCTAssertFalse(try String(contentsOf: log).contains("v1.3.5/ios-task-photo-add"))
            }
            try FileManager.default.removeItem(at: selected)
            await host.close(); let cold = try core(); _ = try await cold.start()
            _ = try await cold.recoverAttachmentDraftV3(expectedSession: snapshot.sessionID)
            let completed = try lastAdd()
            XCTAssertEqual(completed.requestId, requestID); XCTAssertEqual(completed.phase, .checkpointed)
            XCTAssertEqual(try Data(contentsOf: XCTUnwrap(URL(string: completed.targetURI))), processed)
            XCTAssertEqual(try rows(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: selected.path)); await cold.close()
        }
    }

    func testProcessedPhotoDiscardRetiresTargetAndPreservesBorrowedSourceAndTask() async throws {
        let (host, _) = try await seed(), before = try rows(), bytes = try imageBytes(), selected = try source(bytes)
        _ = try await add(host, item: provider(selected))
        let op = try lastAdd(), target = try XCTUnwrap(URL(string: op.targetURI)), snapshot = try latest(), discardID = UUID().uuidString.lowercased()
        let result = try object(await host.discardAttachmentDraftV3(requestJSON: json(["version": 1, "requestId": discardID, "sessionID": snapshot.sessionID, "generation": snapshot.generation])))
        XCTAssertEqual(result["status"] as? String, "cleanupPending")
        _ = try await host.finishAttachmentDraftDiscardV3(expectedSession: snapshot.sessionID, requestId: discardID)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertNil(try store.readVersioned()); XCTAssertNil(try editor.read())
        XCTAssertEqual(try Data(contentsOf: selected), bytes); XCTAssertEqual(try rows(), before)
    }
    #endif
}
