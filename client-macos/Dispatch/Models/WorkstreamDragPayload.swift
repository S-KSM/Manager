import CoreTransferable
import Foundation
import UniformTypeIdentifiers

/// Drag payload moved between kanban columns. Carries enough context for the
/// drop handler to issue the right `PATCH /workstreams/:id` call without
/// re-fetching the workstream first.
///
/// `currentStatus` is the column the card was *dragged from*; the drop
/// destination compares it against the column it represents and skips the
/// PATCH when they match (so dropping a card back on its own column is a
/// no-op rather than a redundant network round-trip).
struct WorkstreamDragPayload: Codable, Transferable, Hashable, Sendable {
    let id: String
    let currentStatus: Workstream.Status

    static var transferRepresentation: some TransferRepresentation {
        CodableRepresentation(contentType: .json)
    }
}
