import Foundation

/// In-process implementation of `DaemonClientProtocol` backed by `MockData`.
///
/// Used by:
///  - SwiftUI previews,
///  - the app at launch when the live daemon is unreachable,
///  - unit tests that don't want to spin up a daemon.
final class MockDaemonClient: DaemonClientProtocol, @unchecked Sendable {
    private let workstreams: [Workstream]
    private let eventsByWorkstream: [String: [Event]]
    private let memoryByWorkstream: [String: String]
    private let simulatedLatency: Duration

    init(
        workstreams: [Workstream] = MockData.workstreams,
        eventsByWorkstream: [String: [Event]] = MockData.eventsByWorkstream,
        memoryByWorkstream: [String: String] = MockData.memoryByWorkstream,
        simulatedLatency: Duration = .milliseconds(50)
    ) {
        self.workstreams = workstreams
        self.eventsByWorkstream = eventsByWorkstream
        self.memoryByWorkstream = memoryByWorkstream
        self.simulatedLatency = simulatedLatency
    }

    func health() async -> Bool { true }

    func listWorkstreams() async throws -> [Workstream] {
        try? await Task.sleep(for: simulatedLatency)
        return workstreams
    }

    func getWorkstream(id: String) async throws -> Workstream {
        try? await Task.sleep(for: simulatedLatency)
        guard let ws = workstreams.first(where: { $0.id == id }) else {
            throw DaemonError.badResponse(404)
        }
        return ws
    }

    func getMemory(workstreamID: String) async throws -> String {
        try? await Task.sleep(for: simulatedLatency)
        return memoryByWorkstream[workstreamID]
            ?? "# Workstream: \(workstreamID)\n\n_(no memory yet)_\n"
    }

    func getEvents(workstreamID: String) async throws -> [Event] {
        try? await Task.sleep(for: simulatedLatency)
        return eventsByWorkstream[workstreamID] ?? []
    }

    func streamEvents(workstreamID: String) -> AsyncStream<Event> {
        let events = eventsByWorkstream[workstreamID] ?? []
        return AsyncStream { continuation in
            let task = Task {
                for e in events.suffix(8) {
                    try? await Task.sleep(for: .milliseconds(400))
                    if Task.isCancelled { break }
                    continuation.yield(e)
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
