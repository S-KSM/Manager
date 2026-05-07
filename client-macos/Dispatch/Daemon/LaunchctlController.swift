import Foundation

/// v1.4.6 — Diagnostics tab "Restart Daemon — Hard" helper.
///
/// The hard restart is intentionally NOT a daemon endpoint: the daemon
/// would die mid-response, leaving the macOS app waiting on a socket
/// that goes away. Instead the app shells out directly to
/// `launchctl kickstart -k gui/<uid>/com.dispatch.daemon`, which asks
/// launchd to stop the running job (`-k`) and immediately re-run it.
/// `DaemonResolver.retryConnection()` already polls `/health`, so the
/// UI catches the new daemon on the next probe.
///
/// Soft restart (re-read settings + re-instantiate tickers) lives on the
/// daemon at `POST /admin/restart` and is invoked through `DaemonClient`.
enum LaunchctlController {
    /// launchd label registered by `LaunchdInstaller` and `bin/install.sh`.
    /// Kept in sync with the `Label` key in the bundled plist.
    static let label = "com.dispatch.daemon"

    /// Run `launchctl kickstart -k gui/<uid>/com.dispatch.daemon`.
    ///
    /// Returns:
    ///  - `.success` when the underlying process exits 0,
    ///  - `.failure(KickstartError.nonZeroExit(code, stderr))` when launchctl
    ///    runs but reports an error (most commonly: agent not registered),
    ///  - `.failure(KickstartError.transport(err))` when we couldn't even
    ///    start the process (sandbox / launchctl missing).
    ///
    /// Synchronous-ish: the underlying Process call uses `waitUntilExit`,
    /// which is fine because launchctl returns within a few hundred ms.
    @discardableResult
    static func kickstart() -> Result<Void, KickstartError> {
        runLaunchctl(["kickstart", "-k", "gui/\(getuid())/\(label)"])
    }

    /// Errors surfaced to the Diagnostics view so the user sees the
    /// underlying reason in the "Daemon restart triggered…" toast.
    enum KickstartError: Error, LocalizedError {
        case nonZeroExit(code: Int32, stderrTail: String)
        case transport(Error)

        var errorDescription: String? {
            switch self {
            case .nonZeroExit(let code, let stderrTail):
                let trimmed = stderrTail.trimmingCharacters(
                    in: .whitespacesAndNewlines
                )
                if trimmed.isEmpty {
                    return "launchctl exited \(code)"
                }
                return "launchctl exited \(code): \(trimmed)"
            case .transport(let err):
                return "Couldn't run launchctl: \(err.localizedDescription)"
            }
        }
    }

    /// Test-injection seam. Tests pass a stub that records the args and
    /// returns the canned exit; production wires through to the real
    /// `/bin/launchctl` via `Process`.
    typealias Runner = (_ args: [String]) -> (status: Int32, stderr: String)

    /// Production runner using `Process` + `/bin/launchctl`.
    private static let defaultRunner: Runner = { args in
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = args
        let stderrPipe = Pipe()
        process.standardOutput = Pipe()
        process.standardError = stderrPipe
        do {
            try process.run()
            process.waitUntilExit()
            let data = (try? stderrPipe.fileHandleForReading.readToEnd()) ?? Data()
            let tail = String(data: data, encoding: .utf8) ?? ""
            return (process.terminationStatus, tail)
        } catch {
            // Surface the underlying NSError via .transport upstream.
            // We fold "couldn't even start" into a sentinel exit code so
            // the caller's switch is uniform; the Result wrapper below
            // converts it to .transport.
            return (Int32.min, error.localizedDescription)
        }
    }

    /// Internal entry point used by `kickstart()` and the test seams. Public
    /// to file scope; not called from outside the type.
    static func runLaunchctl(
        _ args: [String],
        runner: Runner = defaultRunner
    ) -> Result<Void, KickstartError> {
        let outcome = runner(args)
        if outcome.status == 0 {
            return .success(())
        }
        if outcome.status == Int32.min {
            // The default runner's "couldn't start" sentinel.
            let underlying = NSError(
                domain: "com.dispatch.app.launchctl",
                code: -1,
                userInfo: [NSLocalizedDescriptionKey: outcome.stderr]
            )
            return .failure(.transport(underlying))
        }
        return .failure(.nonZeroExit(code: outcome.status, stderrTail: outcome.stderr))
    }
}
