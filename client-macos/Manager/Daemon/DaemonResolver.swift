import Foundation
import OSLog

/// Picks the live or mock client at startup, based on `health()`.
///
/// At launch it pings the live daemon once. If the daemon answers, we use it;
/// otherwise we fall back to `MockDaemonClient` so the app still has something
/// to render. Either way we log the choice, and the user can flip with
/// Cmd-Shift-M (see `ManagerApp`) — useful for development.
@MainActor
final class DaemonResolver: ObservableObject {
    enum Mode: Equatable, Sendable {
        case live
        case mock
    }

    @Published private(set) var mode: Mode = .mock
    @Published private(set) var client: DaemonClientProtocol = MockDaemonClient()
    /// Bumped whenever `mode` changes; SwiftUI views can use this in
    /// `.task(id:)` to reload data when the underlying client swaps.
    @Published private(set) var modeToken: Int = 0

    private let liveBaseURL: URL
    private let logger = Logger(subsystem: "com.manager.app", category: "DaemonResolver")
    private let forcedMode: Mode?

    /// - Parameters:
    ///   - liveBaseURL: where the daemon lives. Defaults to `http://localhost:9876`.
    ///   - forcedMode: when set, skips probing and locks in this mode (used by
    ///     SwiftUI previews that want deterministic mock data).
    init(liveBaseURL: URL = LiveDaemonClient.defaultBaseURL,
                forcedMode: Mode? = nil) {
        self.liveBaseURL = liveBaseURL
        self.forcedMode = forcedMode
        if let forcedMode {
            self.mode = forcedMode
            self.client = (forcedMode == .live)
                ? LiveDaemonClient(baseURL: liveBaseURL)
                : MockDaemonClient()
        }
    }

    /// Probes the daemon and chooses a client. Safe to call multiple times.
    func resolve() async {
        if let forcedMode {
            logger.info("DaemonResolver: forced mode = \(String(describing: forcedMode))")
            return
        }

        // Allow override via env var so devs can force mock mode without
        // having to take the daemon down.
        if let env = ProcessInfo.processInfo.environment["MANAGER_DAEMON"],
           env.lowercased() == "mock" {
            logger.info("DaemonResolver: MANAGER_DAEMON=mock — using mock client.")
            switchTo(.mock, client: MockDaemonClient())
            return
        }

        let live = LiveDaemonClient(baseURL: liveBaseURL)
        let healthy = await live.health()
        if healthy {
            logger.info("DaemonResolver: live daemon at \(self.liveBaseURL.absoluteString) is healthy — using LiveDaemonClient.")
            switchTo(.live, client: live)
        } else {
            logger.notice("DaemonResolver: no live daemon at \(self.liveBaseURL.absoluteString) — falling back to MockDaemonClient.")
            switchTo(.mock, client: MockDaemonClient())
        }
    }

    /// Manual flip — wired to the Cmd-Shift-M menu item.
    func toggle() async {
        switch mode {
        case .live: switchTo(.mock, client: MockDaemonClient())
        case .mock:
            let live = LiveDaemonClient(baseURL: liveBaseURL)
            switchTo(.live, client: live)
        }
    }

    private func switchTo(_ newMode: Mode, client: DaemonClientProtocol) {
        self.mode = newMode
        self.client = client
        self.modeToken &+= 1
    }
}
