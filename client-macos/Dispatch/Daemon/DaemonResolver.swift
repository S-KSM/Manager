import Foundation
import OSLog

/// Picks the live or mock client at startup, based on `health()`.
///
/// At launch it pings the live daemon a few times (with backoff) so a slow
/// cold-start doesn't fall through to the mock. If every attempt fails we
/// drop into `MockDaemonClient` so the app still has something to render —
/// HomeView surfaces a banner in that case so the user knows they're seeing
/// demo data, not their real workstreams. Either way we log the choice, and
/// the user can flip with Cmd-Shift-M (see `DispatchApp`).
@MainActor
final class DaemonResolver: ObservableObject {
    enum Mode: Equatable, Sendable {
        case live
        case mock
    }

    /// Why we ended up in the current mode. Used by HomeView to pick the
    /// right banner copy ("daemon offline" vs "explicit mock override" vs
    /// "you toggled it manually"). `unknown` only appears before `resolve()`
    /// runs; we seed `mode = .mock` so previews stay deterministic.
    enum ModeReason: Equatable, Sendable {
        /// Initial state, before `resolve()` has run.
        case unknown
        /// Live daemon answered `/health` with 2xx.
        case liveHealthy
        /// `/health` never answered after retries — assume the daemon is offline.
        case liveUnreachable
        /// `DISPATCH_DAEMON=mock` (or legacy `MANAGER_DAEMON=mock`) env var.
        case envOverride
        /// User picked it via the Cmd-Shift-M toggle.
        case userToggled
        /// `forcedMode:` constructor argument (SwiftUI previews / tests).
        case forced
    }

    @Published private(set) var mode: Mode = .mock
    @Published private(set) var modeReason: ModeReason = .unknown
    @Published private(set) var client: DaemonClientProtocol = MockDaemonClient()
    /// Bumped whenever `mode` changes; SwiftUI views can use this in
    /// `.task(id:)` to reload data when the underlying client swaps.
    @Published private(set) var modeToken: Int = 0

    private let liveBaseURL: URL
    private let logger = Logger(subsystem: "com.dispatch.app", category: "DaemonResolver")
    private let forcedMode: Mode?

    /// Number of `/health` probes before we give up and fall back to mock.
    /// 4 attempts × ~1.5s spacing covers a launchd cold start where the
    /// daemon's still warming up when the app's first probe fires.
    private let healthProbeAttempts: Int = 4
    private let healthProbeBackoff: Duration = .milliseconds(750)

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
            self.modeReason = .forced
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
        // having to take the daemon down. `DISPATCH_DAEMON` is the v1.2+
        // name; `MANAGER_DAEMON` is honored as a deprecated fallback for one
        // release so existing scheme env vars don't silently stop working.
        let env = ProcessInfo.processInfo.environment
        let dispatchVar = env["DISPATCH_DAEMON"]
        let legacyVar = env["MANAGER_DAEMON"]
        if dispatchVar == nil, legacyVar != nil {
            logger.notice("DaemonResolver: MANAGER_DAEMON is deprecated — set DISPATCH_DAEMON instead. Honoring legacy value for now.")
        }
        if let value = dispatchVar ?? legacyVar,
           value.lowercased() == "mock" {
            logger.info("DaemonResolver: DISPATCH_DAEMON=mock — using mock client.")
            switchTo(.mock, reason: .envOverride, client: MockDaemonClient())
            return
        }

        let live = LiveDaemonClient(baseURL: liveBaseURL)
        let healthy = await probeHealthWithRetry(live)
        if healthy {
            logger.info("DaemonResolver: live daemon at \(self.liveBaseURL.absoluteString) is healthy — using LiveDaemonClient.")
            switchTo(.live, reason: .liveHealthy, client: live)
        } else {
            logger.notice("DaemonResolver: no live daemon at \(self.liveBaseURL.absoluteString) after \(self.healthProbeAttempts) attempts — falling back to MockDaemonClient.")
            switchTo(.mock, reason: .liveUnreachable, client: MockDaemonClient())
        }
    }

    /// Re-probes the daemon and switches to live mode if it's reachable.
    /// If the probe fails, attempts to start the launchd-managed daemon
    /// (`com.dispatch.daemon`) and re-probes once. Used as a "Retry" /
    /// "Start daemon" affordance from the mock-mode banner.
    func retryConnection() async {
        if forcedMode != nil { return }
        let live = LiveDaemonClient(baseURL: liveBaseURL)
        if await probeHealthWithRetry(live) {
            logger.info("DaemonResolver: retryConnection succeeded — switching to live.")
            switchTo(.live, reason: .liveHealthy, client: live)
            return
        }
        logger.notice("DaemonResolver: probe failed — attempting to start launchd agent com.dispatch.daemon.")
        let started = await startLaunchdAgent()
        if started, await probeHealthWithRetry(live) {
            logger.info("DaemonResolver: launchd agent started, daemon healthy — switching to live.")
            switchTo(.live, reason: .liveHealthy, client: live)
            return
        }
        logger.notice("DaemonResolver: retryConnection failed — staying on mock.")
        modeToken &+= 1
    }

    /// Tries to bring the launchd-managed daemon up. Order:
    ///   1. `kickstart -k` — works whether the agent is loaded (kills +
    ///      restarts) or not (returns non-zero, which we ignore).
    ///   2. `bootstrap` — only succeeds when the agent isn't loaded; loads
    ///      the plist from `~/Library/LaunchAgents`.
    /// Returns true if either step exited 0. Sandbox must be disabled
    /// (entitlements: `com.apple.security.app-sandbox = false`) for
    /// `Process()` to spawn `/bin/launchctl`; v1.2 already disables it.
    private func startLaunchdAgent() async -> Bool {
        let label = "com.dispatch.daemon"
        let uid = getuid()
        let domain = "gui/\(uid)"
        let plist = FileManager.default
            .homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(label).plist")
            .path

        if await runLaunchctl(["kickstart", "-k", "\(domain)/\(label)"]) {
            return true
        }
        if FileManager.default.fileExists(atPath: plist),
           await runLaunchctl(["bootstrap", domain, plist]) {
            return true
        }
        return false
    }

    private func runLaunchctl(_ args: [String]) async -> Bool {
        await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            DispatchQueue.global().async {
                let p = Process()
                p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
                p.arguments = args
                p.standardOutput = Pipe()
                p.standardError = Pipe()
                do {
                    try p.run()
                    p.waitUntilExit()
                    cont.resume(returning: p.terminationStatus == 0)
                } catch {
                    cont.resume(returning: false)
                }
            }
        }
    }

    /// Manual flip — wired to the Cmd-Shift-M menu item.
    func toggle() async {
        switch mode {
        case .live:
            switchTo(.mock, reason: .userToggled, client: MockDaemonClient())
        case .mock:
            let live = LiveDaemonClient(baseURL: liveBaseURL)
            switchTo(.live, reason: .userToggled, client: live)
        }
    }

    /// Hammers `/health` up to `healthProbeAttempts` times with a short
    /// backoff between attempts. First-launch cold starts (the daemon's
    /// launchd job hasn't woken up yet) are the dominant failure mode for
    /// a single-shot probe; retrying buys us ~3 seconds of grace without
    /// making warm starts feel slow.
    private func probeHealthWithRetry(_ live: LiveDaemonClient) async -> Bool {
        for attempt in 1...healthProbeAttempts {
            if await live.health() { return true }
            if attempt < healthProbeAttempts {
                try? await Task.sleep(for: healthProbeBackoff)
            }
        }
        return false
    }

    private func switchTo(_ newMode: Mode,
                          reason: ModeReason,
                          client: DaemonClientProtocol) {
        self.mode = newMode
        self.modeReason = reason
        self.client = client
        self.modeToken &+= 1
    }
}
