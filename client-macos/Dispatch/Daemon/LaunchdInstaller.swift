import Foundation
import OSLog

/// First-launch / version-bump self-installer for the bundled daemon.
///
/// The .app ships its own daemon at `Contents/Resources/daemon/bundle.cjs`.
/// On startup we make sure a launchd user-agent is loaded that points at
/// that exact path. If `~/Library/LaunchAgents/com.dispatch.daemon.plist`
/// is missing or stale (path drift after the user moves the .app), we
/// rewrite + bootstrap it.
///
/// This is what removes the need for a separate `bin/install.sh` for users
/// who only want the .app — drag to Applications, launch, done.
@MainActor
enum LaunchdInstaller {
    private static let label = "com.dispatch.daemon"
    private static let logger = Logger(subsystem: "com.dispatch.app", category: "LaunchdInstaller")

    /// True if this build embeds a daemon under `Contents/Resources/daemon/`.
    /// Source-tree builds run from a non-bundled DerivedData path; in that
    /// case we skip the auto-install so the dev's `bin/install.sh`-managed
    /// agent (pointing at `daemon/dist/index.js`) keeps owning port 9876.
    static var hasBundledDaemon: Bool {
        bundledDaemonURL != nil
    }

    /// True when the running .app lives on a transient mount — typically
    /// because the user opened it directly from the DMG instead of dragging
    /// to /Applications first. Writing a launchd plist that points there
    /// would leave a broken job pointing at a path that disappears on
    /// eject. The UI surfaces this via `installBlockedReason`.
    static var runningFromTransientMount: Bool {
        Bundle.main.bundleURL.path.hasPrefix("/Volumes/")
    }

    /// User-readable reason the auto-install was skipped, if any. nil when
    /// `ensureInstalled()` would proceed. Surfaced by the WelcomeView so the
    /// user knows what to do (e.g. "drag to Applications first").
    static var installBlockedReason: String? {
        if runningFromTransientMount {
            return "Dispatch is running from a disk image. Drag Dispatch.app to Applications, then open it from there."
        }
        return nil
    }

    /// Idempotent. Safe to call on every launch — only writes the plist +
    /// re-bootstraps when the on-disk plist's `ProgramArguments` no longer
    /// matches the bundle's daemon path (e.g. user moved the .app).
    static func ensureInstalled() async {
        if runningFromTransientMount {
            logger.notice("LaunchdInstaller: bundle is on /Volumes/* — skipping install (drag to /Applications first).")
            return
        }
        guard let daemonURL = bundledDaemonURL else {
            logger.info("LaunchdInstaller: no bundled daemon — skipping (dev build).")
            return
        }
        let plistURL = plistDestination()
        let expectedXML = renderPlist(daemonPath: daemonURL.path)

        let alreadyCorrect: Bool
        if let current = try? String(contentsOf: plistURL, encoding: .utf8),
           current == expectedXML {
            alreadyCorrect = true
        } else {
            alreadyCorrect = false
        }

        if alreadyCorrect {
            // Plist on disk already matches what we'd write. Make sure the
            // agent is actually loaded (launchctl print returns 0). Cold
            // start after reboot can leave the plist intact but the agent
            // unloaded if RunAtLoad failed.
            if await isAgentLoaded() {
                logger.info("LaunchdInstaller: agent already loaded for current bundle.")
                return
            }
        }

        do {
            try FileManager.default.createDirectory(
                at: plistURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try expectedXML.write(to: plistURL, atomically: true, encoding: .utf8)
            logger.info("LaunchdInstaller: wrote \(plistURL.path)")
        } catch {
            logger.error("LaunchdInstaller: failed to write plist: \(error.localizedDescription)")
            return
        }

        // Bootout any previous incarnation, then bootstrap fresh. `bootout`
        // returns non-zero when no agent is loaded — ignored.
        let domain = "gui/\(getuid())"
        _ = await runLaunchctl(["bootout", "\(domain)/\(Self.label)"])
        let started = await runLaunchctl(["bootstrap", domain, plistURL.path])
        if started {
            logger.info("LaunchdInstaller: bootstrapped \(Self.label).")
        } else {
            logger.error("LaunchdInstaller: launchctl bootstrap failed for \(plistURL.path).")
        }
    }

    // MARK: - Helpers

    /// `Contents/Resources/daemon/bundle.cjs` if the running .app has the
    /// embedded daemon. nil for dev builds (xcodebuild Debug from a fresh
    /// clone before the embed phase has run, or `swift run`-style runs).
    static var bundledDaemonURL: URL? {
        guard let resources = Bundle.main.resourceURL else { return nil }
        let candidate = resources
            .appendingPathComponent("daemon", isDirectory: true)
            .appendingPathComponent("bundle.cjs")
        return FileManager.default.fileExists(atPath: candidate.path) ? candidate : nil
    }

    /// Vendored arm64 Node binary at `Contents/Resources/node/bin/node`,
    /// used by the launchd plist so the daemon runs without `node` being
    /// on the user's PATH. nil for dev builds.
    static var bundledNodeURL: URL? {
        guard let resources = Bundle.main.resourceURL else { return nil }
        let candidate = resources
            .appendingPathComponent("node", isDirectory: true)
            .appendingPathComponent("bin", isDirectory: true)
            .appendingPathComponent("node")
        return FileManager.default.fileExists(atPath: candidate.path) ? candidate : nil
    }

    private static func plistDestination() -> URL {
        FileManager.default
            .homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(Self.label).plist")
    }

    /// Build the launchd plist XML pointing at the bundled node + daemon.
    /// We invoke the vendored `Contents/Resources/node/bin/node` directly
    /// so the user doesn't need Node on PATH. Falls back to `/usr/bin/env
    /// node` only for dev builds where the bundled node is missing.
    private static func renderPlist(daemonPath: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let logsDir = "\(home)/Library/Logs"
        let programArgs: String
        if let node = bundledNodeURL?.path {
            programArgs = """
              <array>
                <string>\(node)</string>
                <string>\(daemonPath)</string>
                <string>start</string>
              </array>
            """
        } else {
            programArgs = """
              <array>
                <string>/usr/bin/env</string>
                <string>node</string>
                <string>\(daemonPath)</string>
                <string>start</string>
              </array>
            """
        }
        return """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>Label</key>
          <string>\(Self.label)</string>
          <key>ProgramArguments</key>
        \(programArgs)
          <key>EnvironmentVariables</key>
          <dict>
            <key>PATH</key>
            <string>/usr/bin:/bin</string>
            <key>HOME</key>
            <string>\(home)</string>
          </dict>
          <key>StandardOutPath</key>
          <string>\(logsDir)/dispatch.daemon.out.log</string>
          <key>StandardErrorPath</key>
          <string>\(logsDir)/dispatch.daemon.err.log</string>
          <key>RunAtLoad</key>
          <true/>
          <key>KeepAlive</key>
          <true/>
        </dict>
        </plist>
        """
    }

    private static func isAgentLoaded() async -> Bool {
        let domain = "gui/\(getuid())"
        return await runLaunchctl(["print", "\(domain)/\(Self.label)"])
    }

    private static func runLaunchctl(_ args: [String]) async -> Bool {
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
}
