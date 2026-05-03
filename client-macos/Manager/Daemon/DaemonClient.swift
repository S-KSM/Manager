import Foundation

/// Abstract surface for talking to the Manager daemon.
///
/// Both the live `LiveDaemonClient` (HTTP + WS over `URLSession`) and the
/// in-process `MockDaemonClient` conform to this. Views depend only on this
/// protocol so previews/tests/offline-launches can swap in mock data without
/// changing call sites.
protocol DaemonClientProtocol: Sendable {
    func listWorkstreams() async throws -> [Workstream]
    func getWorkstream(id: String) async throws -> Workstream
    func getMemory(workstreamID: String) async throws -> String
    func getEvents(workstreamID: String) async throws -> [Event]
    func streamEvents(workstreamID: String) -> AsyncStream<Event>
    /// Returns `false` on connection error; never throws. Used by
    /// `DaemonResolver` to choose live vs mock at startup.
    func health() async -> Bool
}

enum DaemonError: Error, LocalizedError {
    case badURL
    case badResponse(Int)
    case decoding(Error)
    case transport(Error)

    var errorDescription: String? {
        switch self {
        case .badURL:                 return "Bad daemon URL."
        case .badResponse(let code):  return "Daemon returned HTTP \(code)."
        case .decoding(let e):        return "Could not decode daemon response: \(e)"
        case .transport(let e):       return "Transport error: \(e)"
        }
    }
}

/// HTTP + WebSocket client for the local daemon.
///
/// API contract (docs/ARCHITECTURE.md):
///   GET  /workstreams
///   GET  /workstreams/{id}
///   GET  /workstreams/{id}/memory   (raw Markdown body)
///   GET  /workstreams/{id}/events   (JSON array of envelope events)
///   GET  /health                    (200 OK)
///   WS   /workstreams/{id}/events/stream
final class LiveDaemonClient: DaemonClientProtocol, @unchecked Sendable {
    static let defaultBaseURL = URL(string: "http://localhost:9876")!

    private let baseURL: URL
    private let session: URLSession
    private let decoder: JSONDecoder

    init(baseURL: URL = LiveDaemonClient.defaultBaseURL,
                session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601WithFractionalSeconds
        self.decoder = d
    }

    func health() async -> Bool {
        let url = baseURL.appendingPathComponent("health")
        var req = URLRequest(url: url)
        req.timeoutInterval = 1.0
        do {
            let (_, response) = try await session.data(for: req)
            guard let http = response as? HTTPURLResponse else { return false }
            return (200..<300).contains(http.statusCode)
        } catch {
            return false
        }
    }

    func listWorkstreams() async throws -> [Workstream] {
        try await getJSON(path: "workstreams")
    }

    func getWorkstream(id: String) async throws -> Workstream {
        try await getJSON(path: "workstreams/\(id)")
    }

    func getMemory(workstreamID: String) async throws -> String {
        let url = baseURL.appendingPathComponent("workstreams/\(workstreamID)/memory")
        let (data, response) = try await session.data(from: url)
        try Self.assertOK(response)
        return String(data: data, encoding: .utf8) ?? ""
    }

    func getEvents(workstreamID: String) async throws -> [Event] {
        try await getJSON(path: "workstreams/\(workstreamID)/events")
    }

    func streamEvents(workstreamID: String) -> AsyncStream<Event> {
        // Build a ws:// URL alongside the http base.
        var components = URLComponents(url: baseURL,
                                       resolvingAgainstBaseURL: false) ?? URLComponents()
        components.scheme = (baseURL.scheme == "https") ? "wss" : "ws"
        components.path = "/workstreams/\(workstreamID)/events/stream"
        guard let wsURL = components.url else {
            return AsyncStream { $0.finish() }
        }

        let task = session.webSocketTask(with: wsURL)
        let decoder = self.decoder

        return AsyncStream { continuation in
            task.resume()

            func receiveNext() {
                task.receive { result in
                    switch result {
                    case .failure:
                        continuation.finish()
                        task.cancel(with: .goingAway, reason: nil)
                    case .success(let message):
                        let data: Data?
                        switch message {
                        case .string(let s): data = s.data(using: .utf8)
                        case .data(let d):   data = d
                        @unknown default:    data = nil
                        }
                        if let data,
                           let event = try? decoder.decode(Event.self, from: data) {
                            continuation.yield(event)
                        }
                        receiveNext()
                    }
                }
            }
            receiveNext()

            continuation.onTermination = { _ in
                task.cancel(with: .goingAway, reason: nil)
            }
        }
    }

    // MARK: - private

    private func getJSON<T: Decodable>(path: String) async throws -> T {
        let url = baseURL.appendingPathComponent(path)
        do {
            let (data, response) = try await session.data(from: url)
            try Self.assertOK(response)
            do {
                return try decoder.decode(T.self, from: data)
            } catch {
                throw DaemonError.decoding(error)
            }
        } catch let e as DaemonError {
            throw e
        } catch {
            throw DaemonError.transport(error)
        }
    }

    private static func assertOK(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else {
            throw DaemonError.badResponse(-1)
        }
        guard (200..<300).contains(http.statusCode) else {
            throw DaemonError.badResponse(http.statusCode)
        }
    }
}

extension JSONDecoder.DateDecodingStrategy {
    /// ISO-8601 with optional fractional seconds, matching the daemon's
    /// `2026-05-02T22:30:14.123Z` shape.
    static let iso8601WithFractionalSeconds: JSONDecoder.DateDecodingStrategy = .custom { decoder in
        let container = try decoder.singleValueContainer()
        let raw = try container.decode(String.self)

        let fmtFractional = ISO8601DateFormatter()
        fmtFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = fmtFractional.date(from: raw) { return d }

        let fmtPlain = ISO8601DateFormatter()
        fmtPlain.formatOptions = [.withInternetDateTime]
        if let d = fmtPlain.date(from: raw) { return d }

        throw DecodingError.dataCorruptedError(
            in: container,
            debugDescription: "Not an ISO-8601 timestamp: \(raw)"
        )
    }
}
