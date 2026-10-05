import Foundation
import XCTest
@testable import MindwtrWidgetActionStore

final class MindwtrWidgetTaskItemTests: XCTestCase {
    private func decode(_ fields: [String: Any] = [:]) throws -> MindwtrWidgetTaskItem {
        let row = ["id": "task-1", "title": "Task"].merging(fields) { _, next in next }
        return try JSONDecoder().decode(MindwtrWidgetTaskItem.self, from: JSONSerialization.data(withJSONObject: row))
    }

    func testCachedRowsWithoutContextsStillDecode() throws {
        let item = try decode(["contextLabel": "Project"])
        XCTAssertNil(item.contexts)
        XCTAssertNil(item.contextsLabel)
        XCTAssertEqual(item.detailLabel, "Project")
        XCTAssertNil(try decode().detailLabel)
    }

    func testContextsRetainTheirTokensAndProjectIdentity() throws {
        let item = try decode([
            "contexts": ["@office", "@电话", "@home"],
            "contextLabel": "Launch",
            "identityColor": "#ABCDEF",
            "dueLabel": "Today",
            "completionToken": "token-1",
        ])
        XCTAssertEqual(item.contextsLabel, "@office @电话 @home")
        XCTAssertEqual(item.detailLabel, "@office @电话 @home · Launch")
        XCTAssertEqual(item.identityColor, "#ABCDEF")
        XCTAssertEqual(item.dueLabel, "Today")
        XCTAssertEqual(item.completionToken, "token-1")
    }

    func testBlankAndNullContextsDoNotConsumeADetailLine() throws {
        for contexts in [NSNull(), [], ["", " \n "]] as [Any] {
            let item = try decode(["contexts": contexts, "contextLabel": "  Home  "])
            XCTAssertNil(item.contextsLabel)
            XCTAssertEqual(item.detailLabel, "Home")
        }
        XCTAssertEqual(try decode(["contexts": [" @calls ", "", "@errands"]]).detailLabel, "@calls @errands")
    }

    func testCompactRowsFitWithMixedContextsAndAtExactHeight() throws {
        let bare = try decode()
        let contextual = try decode(["contexts": ["@office", "@calls"]])
        let items = [bare, contextual, bare, contextual]
        func count(_ height: Double, scale: Double = 1, limit: Int = 12) -> Int {
            MindwtrCompactTaskLayout.visibleTaskCount(
                items: items, availableHeight: height,
                titleRowHeight: 16 * scale, contextRowHeight: 12 * scale,
                rowSpacing: 2, limit: limit
            )
        }
        XCTAssertEqual(count(0), 0)
        XCTAssertEqual(count(15), 0)
        XCTAssertEqual(count(16), 1)
        XCTAssertEqual(count(45), 1)
        XCTAssertEqual(count(46), 2)
        XCTAssertEqual(count(64), 3)
        XCTAssertEqual(count(64, limit: 2), 2)
        XCTAssertEqual(count(64, scale: 2), 1)
    }

    func testBareRowsRetainCompactDensityAndFamilyCaps() throws {
        let bare = try decode()
        let items = Array(repeating: bare, count: 30)
        for limit in [3, 5, 12, 24] {
            XCTAssertEqual(MindwtrCompactTaskLayout.visibleTaskCount(
                items: items, availableHeight: 1000, titleRowHeight: 16,
                contextRowHeight: 12, rowSpacing: 2, limit: limit
            ), limit)
        }
        XCTAssertEqual(MindwtrCompactTaskLayout.visibleTaskCount(
            items: items, availableHeight: 52, titleRowHeight: 16,
            contextRowHeight: 12, rowSpacing: 2, limit: 5
        ), 3)
    }
}
