import XCTest
import Foundation
import Darwin
@testable import MindwtrNativeCore

final class AttachmentOpenHostTests: XCTestCase {
    private var root: URL!
    private var bundle: URL!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var managed: URL { root.appendingPathComponent("attachment-files/documents/attachments", isDirectory: true) }
    private var cache: URL { root.appendingPathComponent("attachment-files/cache", isDirectory: true) }
    private let taskID = "file-open-task"
    private let at = "2026-10-06T12:00:00.000Z"
    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("Set MINDWTR_CORE_BUNDLE") }
        bundle = URL(fileURLWithPath: path)
        let checkout = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let directory = checkout.appendingPathComponent(".build/task277-fixtures/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw NativeAttachmentFilesError.unavailable }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    private func object(_ raw: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any]) }
    private func core(_ faults: HostIOFaults = HostIOFaults(), bundleURL: URL? = nil) -> CoreHost {
        let host = CoreHost(databaseURL: database, bundleURL: bundleURL ?? bundle, faults: faults)
        addTeardownBlock { await host.close() }; return host
    }
    private func sql(_ statement: String, _ args: [Any] = []) throws -> String {
        let db = try SQLiteBridge(url: database); defer { db.close() }
        return try db.execute(statement, parametersJSON: json(args))
    }
    private func rows() throws -> String { try json(NativeJSON.jsonObject(with: Data(sql("SELECT * FROM tasks ORDER BY id").utf8))) }
    private func inode(_ url: URL) throws -> String {
        var value = stat(); guard lstat(url.path, &value) == 0 else { throw HostFailure("Fixture identity unavailable") }
        return "\(UInt64(value.st_dev)):\(UInt64(value.st_ino))"
    }
    private func seed(_ attachments: [[String: Any]] = [], deleted: Bool = false, archived: Bool = false) async throws {
        let initial = core(); _ = try await initial.start(); await initial.close()
        try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true)
        if archived { _ = try sql("INSERT INTO projects(id,title,status,color,supportNotes,createdAt,updatedAt,rev) VALUES ('archived','Archived','archived','#94a3b8','',?,?,1)", [at, at]) }
        let storedAttachments: Any = attachments.isEmpty ? NSNull() : try json(attachments)
        _ = try sql("INSERT INTO tasks(id,title,status,taskMode,projectId,contexts,tags,attachments,checklist,createdAt,updatedAt,deletedAt,rev,revBy) VALUES (?,'Preserved title','next','list',?,'[]','[]',?,NULL,?,?,?,1,'fixture')",
            [taskID, archived ? "archived" : NSNull(), storedAttachments, at, at, deleted ? at : NSNull()])
    }
    private func item(_ id: String, uri: String, mime: String = "text/plain") -> [String: Any] {
        ["id": id, "kind": "file", "title": "Private.txt", "uri": uri, "mimeType": mime,
         "size": 5, "createdAt": at, "updatedAt": at, "localStatus": "available"]
    }
    private func request(_ rows: [[String: Any]], id: String, task: String? = nil) throws -> String {
        try json(["owner": ["kind": "task", "taskId": task ?? taskID, "attachments": rows], "attachmentId": id])
    }
    private func opened(_ host: CoreHost, _ rows: [[String: Any]], id: String) async throws -> [String: Any] {
        try object(await host.prepareTaskFileOpen(requestJSON: request(rows, id: id)))
    }
    private func markers() throws -> Int {
        let log = root.appendingPathComponent("logs/mindwtr.log")
        guard FileManager.default.fileExists(atPath: log.path) else { return 0 }
        return try String(contentsOf: log).components(separatedBy: "v1.3.5/ios-local-file-open").count - 1
    }
    private func refused(_ operation: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await operation(); XCTFail("Expected safe refusal", file: file, line: line) }
        catch { XCTAssertFalse(error.localizedDescription.contains("file:///"), file: file, line: line); XCTAssertFalse(error.localizedDescription.contains("Private.txt"), file: file, line: line) }
    }
    private func latest() throws -> EditorDraftSnapshot { try XCTUnwrap(EditorDraftStore(databaseURL: database).read()?.snapshot) }
    private func produce(_ host: CoreHost) async throws -> [[String: Any]] {
        let opening = try object(await host.call("editorModel", argumentsJSON: json([taskID])))
        let raw: [String: Any] = ["title": "", "note": "", "location": "", "estimate": "", "estimateResolved": "", "timeSpent": "", "timeSpentResolved": "",
            "tokens": [:], "tokenCanonical": [:], "tokenResolved": [:], "tokenEdited": [], "checklistInputs": [:], "checklistAppend": "", "relativeAmount": "", "relativeUnit": "",
            "relativeOwned": false, "relativeCommitRequested": false, "recurrenceInputs": [:], "recurrenceOwned": [], "recurrenceCommitRequested": []]
        let payload = try json(["version": 2, "taskID": taskID, "tab": "task", "touchedBase": [:], "edited": [:], "raw": raw,
            "scheduleEdits": [], "scheduleFailedID": NSNull(), "attachmentsOwned": true, "attachmentsBase": [], "attachments": [], "linkSheet": [:], "checklistBase": [], "checklistValue": []] as [String: Any])
        let snapshot = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: taskID, generation: 1, payloadJSON: payload)
        try await host.checkpointEditorDraft(snapshot)
        _ = try await host.beginAttachmentDraftV3(expectedSession: snapshot.sessionID, expectedGeneration: snapshot.generation)
        for (name, mime, bytes) in [("Private.txt", "text/plain", Data("plain".utf8)),
            ("Private.png", "image/png", Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1cAAAAASUVORK5CYII=")!),
            ("Private.wav", "audio/wav", Data(base64Encoded: "UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQQAAAAAAAAA")!)] {
            let source = cache.appendingPathComponent(name); try bytes.write(to: source)
            let before = try latest()
            _ = try await host.addAttachmentDraftV3(requestJSON: json(["version": 1, "requestId": UUID().uuidString.lowercased(), "sessionID": before.sessionID, "generation": before.generation,
                "picked": ["uri": source.absoluteString, "name": name, "mimeType": mime, "size": NSNull()]] as [String: Any]))
        }
        let before = try latest(), value = try object(before.payloadJSON)
        let rows = try XCTUnwrap(value["attachments"] as? [[String: Any]])
        let save: [String: Any] = ["id": taskID, "requestId": UUID().uuidString.lowercased(), "base": [:], "patch": [:], "scheduleBase": try XCTUnwrap(opening["scheduleBase"]),
            "checklist": ["base": [], "value": []], "attachments": ["base": [], "value": rows]]
        _ = try await host.saveAttachmentDraftComplete(saveRequestJSON: json(save), expectedSession: before.sessionID, expectedGeneration: before.generation)
        return rows
    }

    func testActualAddCompleteSaveAndColdFileImageAudioPlansPreserveBytesAndRows() async throws {
        try await seed(); let host = core(); _ = try await host.start()
        let attachments = try await produce(host)
        let files = try attachments.map { try XCTUnwrap(URL(string: XCTUnwrap($0["uri"] as? String))) }
        let contents = try files.map { try Data(contentsOf: $0) }, identities = try files.map(inode)
        await host.close(); let cold = core(); _ = try await cold.start()
        let before = try rows(), count = try markers()
        for (index, kind) in ["file", "image", "audio"].enumerated() {
            let result = try await opened(cold, attachments, id: XCTUnwrap(attachments[index]["id"] as? String))
            XCTAssertEqual(result["status"] as? String, "available"); XCTAssertTrue(result["update"] is NSNull)
            let plan = try XCTUnwrap(result["open"] as? [String: Any]); XCTAssertEqual(plan["kind"] as? String, kind)
            XCTAssertEqual(kind == "file" ? plan["uri"] as? String : (plan["attachment"] as? [String: Any])?["uri"] as? String, files[index].absoluteString)
        }
        XCTAssertEqual(try files.map { try Data(contentsOf: $0) }, contents); XCTAssertEqual(try files.map(inode), identities)
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try markers() - count, 3)
        XCTAssertNil(try EditorDraftStore(databaseURL: database).read()); XCTAssertNil(try NativeAttachmentDraftStore(databaseURL: database).readMixed())
        XCTAssertFalse(FileManager.default.fileExists(atPath: database.appendingPathExtension("pending.json").path))
        let log = try String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"))
        XCTAssertFalse(log.contains("Private.txt")); XCTAssertFalse(log.contains(files[0].absoluteString))
    }

    func testMissingManagedFileReturnsExistingUnavailableWithoutWrites() async throws {
        let missing = item("missing", uri: managed.appendingPathComponent("missing.txt").absoluteString)
        try await seed([missing]); let host = core(); _ = try await host.start()
        let before = try rows(), names = try FileManager.default.contentsOfDirectory(atPath: managed.path), count = try markers()
        let result = try await opened(host, [missing], id: "missing")
        XCTAssertEqual(result["status"] as? String, "unavailable"); XCTAssertNotNil(result["message"] as? String)
        XCTAssertTrue(result["open"] is NSNull); XCTAssertTrue(result["update"] is NSNull)
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: managed.path), names)
        XCTAssertEqual(try markers(), count)
    }

    func testUnknownDeletedLinkMalformedAndMissingTaskSelectionsPreserveEvidence() async throws {
        let file = managed.appendingPathComponent("live.txt"), bytes = Data("live bytes".utf8)
        let live = item("live", uri: file.absoluteString)
        try await seed([live]); try bytes.write(to: file)
        let host = core(); _ = try await host.start()
        let before = try rows(), identity = try inode(file), count = try markers()
        var removed = live; removed["deletedAt"] = at
        let link: [String: Any] = ["id": "link", "kind": "link", "title": "Private link", "uri": "https://example.invalid", "createdAt": at, "updatedAt": at]
        let inputs = try [request([live], id: "unknown"), request([removed], id: "live"), request([link], id: "link"),
            request([live], id: "live", task: "missing-task"),
            json(["owner": ["kind": "project", "projectId": "missing", "attachments": [live]], "attachmentId": "live"]),
            json(["owner": ["kind": "task", "taskId": taskID, "attachments": [live]], "attachmentId": "live", "extra": true])]
        for input in inputs { await refused { _ = try await host.prepareTaskFileOpen(requestJSON: input) } }
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try Data(contentsOf: file), bytes)
        XCTAssertEqual(try inode(file), identity); XCTAssertEqual(try markers(), count)
        await host.close()
        _ = try sql("UPDATE tasks SET deletedAt=? WHERE id=?", [at, taskID])
        let cold = core(); _ = try await cold.start(); let deletedRows = try rows()
        await refused { _ = try await self.opened(cold, [live], id: "live") }
        XCTAssertEqual(try rows(), deletedRows); XCTAssertEqual(try Data(contentsOf: file), bytes)
        XCTAssertEqual(try inode(file), identity); XCTAssertEqual(try markers(), count)
    }

    func testForeignCacheRemoteAlternateSpellingAndWrongIDCannotCopy() async throws {
        try await seed()
        let file = managed.appendingPathComponent("live.txt"), outside = root.appendingPathComponent("outside.txt"), cached = cache.appendingPathComponent("cached.txt")
        let bytes = Data("untouched bytes".utf8)
        for url in [file, outside, cached] { try bytes.write(to: url) }
        let alternative = "file:" + file.path
        XCTAssertEqual(try XCTUnwrap(URL(string: alternative)).path, file.path, "Alternate spelling still names the same actual file")
        let prefixRefusals = [item("outside", uri: outside.absoluteString), item("cached", uri: cached.absoluteString),
            item("remote", uri: "https://example.invalid/Private.txt"), item("live", uri: alternative),
            item("live", uri: "file:///var/mobile/Containers/Data/Application/00000000-0000-0000-0000-000000000000/Library/attachments/live.txt"),
            item("live", uri: "file:///private/var/mobile/Containers/Data/Application/00000000-0000-0000-0000-000000000000/Library/attachments/live.txt")]
        let host = core(), hooks = NativeAttachmentHostHooks(); var work = 0
        hooks.configureJobs = { jobs in jobs.beforeWork = { _, _ in work += 1 } }
        await host.configureAttachmentHost(hooks); _ = try await host.start()
        let before = try rows(), identities = try [file, outside, cached].map(inode), names = try FileManager.default.contentsOfDirectory(atPath: managed.path).sorted(), cachedNames = try FileManager.default.contentsOfDirectory(atPath: cache.path).sorted()
        for attachment in prefixRefusals {
            let count = work
            await refused { _ = try await self.opened(host, [attachment], id: XCTUnwrap(attachment["id"] as? String)) }
            XCTAssertEqual(work, count, "Noncanonical or external spelling must stop before file jobs")
        }
        let wrongID = item("different-id", uri: file.absoluteString)
        await refused { _ = try await self.opened(host, [wrongID], id: "different-id") }
        XCTAssertGreaterThan(work, 0, "Managed ID mismatch reaches the existing typed read-only proof")
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try [file, outside, cached].map(inode), identities)
        XCTAssertEqual(try [file, outside, cached].map { try Data(contentsOf: $0) }, [bytes, bytes, bytes])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: managed.path).sorted(), names)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: cache.path).sorted(), cachedNames); XCTAssertEqual(try markers(), 0)
    }

    func testDirectorySymlinkAndHardlinkTargetsCannotProduceOpenPlans() async throws {
        try await seed()
        let directory = managed.appendingPathComponent("directory.txt"), symlink = managed.appendingPathComponent("symlink.txt"), hardlink = managed.appendingPathComponent("hardlink.txt"), source = root.appendingPathComponent("source.txt")
        let bytes = Data("retained source".utf8); try bytes.write(to: source)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        try FileManager.default.createSymbolicLink(at: symlink, withDestinationURL: source)
        try FileManager.default.linkItem(at: source, to: hardlink)
        let paths = [directory, symlink, hardlink, source], identities = try paths.map(inode)
        let host = core(); _ = try await host.start(); let before = try rows()
        for (id, target) in [("directory", directory), ("symlink", symlink), ("hardlink", hardlink)] {
            await refused { _ = try await self.opened(host, [self.item(id, uri: target.absoluteString)], id: id) }
        }
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try paths.map(inode), identities)
        XCTAssertEqual(try Data(contentsOf: source), bytes); XCTAssertEqual(try Data(contentsOf: hardlink), bytes)
        XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: symlink.path), source.path)
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: directory.path).isEmpty); XCTAssertEqual(try markers(), 0)
    }

    func testArchivedReadOnlyTaskCanOpenExistingLocalFile() async throws {
        let file = managed.appendingPathComponent("archived-file.txt"), attachment = item("archived-file", uri: file.absoluteString), bytes = Data("read only bytes".utf8)
        try await seed([attachment], archived: true); try bytes.write(to: file)
        let host = core(); _ = try await host.start(); let before = try rows(), identity = try inode(file)
        let view = try object(await host.call("taskView", argumentsJSON: json([json(["id": taskID])])))
        XCTAssertEqual(view["readOnly"] as? Bool, true)
        let result = try await opened(host, [attachment], id: "archived-file")
        XCTAssertEqual(result["status"] as? String, "available"); XCTAssertTrue(result["update"] is NSNull)
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try inode(file), identity); XCTAssertEqual(try Data(contentsOf: file), bytes)
        XCTAssertEqual(try markers(), 1)
    }

    // A private bundle extension drives real asynchronous JSC tickets. It adds
    // no production evaluator or command and leaves taskView/SQLite unchanged.
    private func probeBundle(_ answers: [[String: Any]]) throws -> URL {
        let suffix = """
        ;(() => {
          const oldPoll = MindwtrHost.poll, replies = new Map(), answers = \(try json(answers));
          let next = 1000000000, call = 0;
          MindwtrHost.attachmentRequest = () => {
            const id = String(++next), value = answers[call++];
            Promise.resolve().then(() => replies.set(id, JSON.stringify({ok:true,value})));
            return id;
          };
          MindwtrHost.poll = id => {
            if (Number(id) > 1000000000) { const value = replies.get(id); if (!value) return null; replies.delete(id); return value; }
            return oldPoll(id);
          };
        })();
        """
        let result = root.appendingPathComponent("probe.js")
        try (String(contentsOf: bundle) + suffix).write(to: result, atomically: true, encoding: .utf8)
        return result
    }

    func testUpdatedForeignMalformedAndMismatchedSharedAnswersAreRefused() async throws {
        let file = managed.appendingPathComponent("live.txt"), bytes = Data("original bytes".utf8), attachment = item("live", uri: file.absoluteString)
        try await seed([attachment]); try bytes.write(to: file)
        let plan: [String: Any] = ["kind": "file", "uri": file.absoluteString, "mimeType": "text/plain", "viewMimeType": "text/plain"]
        func answer(_ open: Any, status: String = "available", update: Any = NSNull()) -> [String: Any] {
            ["status": status, "message": NSNull(), "update": update, "open": open]
        }
        var remote = plan; remote["uri"] = "https://example.invalid/Private.txt"
        var alternate = plan; alternate["uri"] = "file:" + file.path
        var wrong = attachment; wrong["id"] = "wrong"
        var changed = attachment; changed["size"] = 999
        var extra = plan; extra["extra"] = true
        let answers = [answer(plan, update: ["attachments": [attachment]]), answer(NSNull(), status: "unavailable", update: ["attachments": [attachment]]),
            answer(remote), answer(alternate), answer(["kind": "link", "uri": file.absoluteString]),
            answer(["kind": "image", "attachment": wrong]), answer(["kind": "audio", "attachment": changed]), answer(extra)]
        let host = core(bundleURL: try probeBundle(answers + [answer(plan)])); _ = try await host.start()
        let before = try rows(), identity = try inode(file)
        for _ in answers { await refused { _ = try await self.opened(host, [attachment], id: "live") } }
        // The same valid request must consume the final successful ticket,
        // proving earlier refusals actually reached each forged shared answer.
        let accepted = try await opened(host, [attachment], id: "live")
        XCTAssertEqual(accepted["status"] as? String, "available")
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try inode(file), identity); XCTAssertEqual(try Data(contentsOf: file), bytes)
        XCTAssertEqual(try markers(), 1)
    }

    func testChangedFileProofAfterPreflightCannotReturnStalePlan() async throws {
        let file = managed.appendingPathComponent("live.txt"), attachment = item("live", uri: file.absoluteString)
        try await seed([attachment]); try Data("before".utf8).write(to: file)
        let host = core(), hooks = NativeAttachmentHostHooks(); var fired = false, mutationError: Error?
        hooks.configureJobs = { jobs in jobs.afterWork = { id, _ in
            if id == "1" { fired = true; do { try Data("after changed".utf8).write(to: file, options: .atomic) } catch { mutationError = error } }
        } }
        await host.configureAttachmentHost(hooks); _ = try await host.start()
        let before = try rows(), identity = try inode(file)
        await refused { _ = try await self.opened(host, [attachment], id: "live") }
        XCTAssertTrue(fired); XCTAssertNil(mutationError); XCTAssertNotEqual(try inode(file), identity)
        XCTAssertEqual(try Data(contentsOf: file), Data("after changed".utf8)); XCTAssertEqual(try rows(), before); XCTAssertEqual(try markers(), 0)
    }

    func testCancellationDrainsTypedReadBeforeCloseAndReleasesLibraryOnlyAfterward() async throws {
        let file = managed.appendingPathComponent("live.txt"), bytes = Data("cancel bytes".utf8), attachment = item("live", uri: file.absoluteString)
        try await seed([attachment]); try bytes.write(to: file)
        let host = core(), hooks = NativeAttachmentHostHooks(), entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        hooks.configureJobs = { jobs in jobs.beforeWork = { id, _ in if id == "1" { entered.signal(); release.wait() } } }
        await host.configureAttachmentHost(hooks); _ = try await host.start()
        let before = try rows(), identity = try inode(file), input = try request([attachment], id: "live")
        let operation = Task { try await host.prepareTaskFileOpen(requestJSON: input) }
        defer { release.signal() }
        let enteredResult = entered.wait(timeout: .now() + 5); XCTAssertEqual(enteredResult, .success)
        guard enteredResult == .success else { operation.cancel(); release.signal(); _ = try? await operation.value; return }
        operation.cancel()
        let closed = DispatchSemaphore(value: 0), closeTask = Task { await host.close(); closed.signal() }
        XCTAssertEqual(closed.wait(timeout: .now() + 0.05), .timedOut)
        let replacement = core(); await refused { _ = try await replacement.start() }
        release.signal()
        do { _ = try await operation.value; XCTFail("Cancelled opening must not produce a plan") }
        catch is CancellationError { } catch { XCTFail("Expected cancellation") }
        await closeTask.value
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try inode(file), identity); XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertEqual(try markers(), 0)
        _ = try await replacement.start()
        let result = try await opened(replacement, [attachment], id: "live")
        XCTAssertEqual(result["status"] as? String, "available"); XCTAssertEqual(try markers(), 1)
    }

    func testClosedAndPendingDomainHostsRefuseWithoutChangingRetainedEvidence() async throws {
        let file = managed.appendingPathComponent("live.txt"), bytes = Data("pending bytes".utf8), attachment = item("live", uri: file.absoluteString)
        try await seed([attachment]); try bytes.write(to: file)
        let faults = HostIOFaults(), host = core(faults); _ = try await host.start()
        let capture = try object(await host.call("captureOpen"))
        let command = try json([json(["text": "Pending capture", "options": try XCTUnwrap(capture["options"]), "captureId": UUID().uuidString.lowercased(), "openAfterSave": false])])
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected pending COMMIT") } }
        await refused { _ = try await host.call("captureSubmit", argumentsJSON: command) }
        let journal = database.appendingPathExtension("pending.json"), retained = try Data(contentsOf: journal), before = try rows(), identity = try inode(file)
        await refused { _ = try await self.opened(host, [attachment], id: "live") }
        XCTAssertEqual(try Data(contentsOf: journal), retained); XCTAssertEqual(try rows(), before)
        XCTAssertEqual(try inode(file), identity); XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertEqual(try markers(), 0)
        await host.close(); await refused { _ = try await self.opened(host, [attachment], id: "live") }
        XCTAssertEqual(try Data(contentsOf: journal), retained); XCTAssertEqual(try rows(), before); XCTAssertEqual(try Data(contentsOf: file), bytes)
    }
}
