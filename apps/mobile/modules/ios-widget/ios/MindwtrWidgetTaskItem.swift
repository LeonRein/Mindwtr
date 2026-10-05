import Foundation

// Shared by the WidgetKit templates and the Foundation-only widget tests.
struct MindwtrWidgetTaskItem: Decodable {
    let id: String
    let title: String
    let statusLabel: String?
    let dueLabel: String?
    let dueTone: String?
    let openUri: String?
    let priorityColor: String?
    let contextLabel: String?
    let identityColor: String?
    let completionToken: String?
    // Optional so cached payloads from older app versions still decode.
    let contexts: [String]?

    var contextsLabel: String? {
        let labels = (contexts ?? []).compactMap(Self.nonEmpty)
        return labels.isEmpty ? nil : labels.joined(separator: " ")
    }

    var detailLabel: String? {
        let labels = [contextsLabel, Self.nonEmpty(contextLabel)].compactMap { $0 }
        return labels.isEmpty ? nil : labels.joined(separator: " · ")
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }
}

enum MindwtrCompactTaskLayout {
    // Context-bearing rows have one extra line. Budget those rows individually
    // so bare tasks keep the compact widget's existing density at every size.
    static func visibleTaskCount(
        items: [MindwtrWidgetTaskItem],
        availableHeight: Double,
        titleRowHeight: Double,
        contextRowHeight: Double,
        rowSpacing: Double,
        limit: Int
    ) -> Int {
        var remaining = max(0, availableHeight)
        var count = 0
        for item in items.prefix(max(0, limit)) {
            let height = titleRowHeight + (item.contextsLabel == nil ? 0 : contextRowHeight)
            let cost = height + (count == 0 ? 0 : rowSpacing)
            guard cost <= remaining else { break }
            remaining -= cost
            count += 1
        }
        return count
    }
}
