import Foundation
import AppKit

/// Auto-move the .app from the DMG mount to /Applications, then relaunch.
///
/// Why this exists: users open a DMG, double-click Dispatch.app *inside the
/// DMG window* instead of dragging it to /Applications first. The .app
/// then runs from `/Volumes/...`, which (a) disappears when the DMG is
/// ejected, and (b) makes our launchd self-install point at a path that
/// vanishes. Detecting this and doing the right thing is friendlier than
/// printing a "drag me to Applications" instruction the user will ignore.
@MainActor
enum AppRelocator {
    /// If the .app is running from /Volumes/, prompt the user, then copy
    /// to /Applications and relaunch from there. Calls `exit(0)` on
    /// success — the new process is the one that returns to the user.
    /// Returns true when relocation happened (caller should not continue).
    static func relocateIfNeeded() -> Bool {
        let bundleURL = Bundle.main.bundleURL
        guard bundleURL.path.hasPrefix("/Volumes/") else { return false }

        let appName = bundleURL.lastPathComponent  // "Dispatch.app"
        let target = URL(fileURLWithPath: "/Applications").appendingPathComponent(appName)

        let alert = NSAlert()
        alert.messageText = "Move Dispatch to Applications?"
        alert.informativeText = """
            Dispatch is running from a disk image. To finish setup, it needs to live in your Applications folder. Click "Move" and Dispatch will copy itself there and relaunch.
            """
        alert.alertStyle = .informational
        alert.addButton(withTitle: "Move to Applications")
        alert.addButton(withTitle: "Quit")
        let response = alert.runModal()
        guard response == .alertFirstButtonReturn else {
            // User picked Quit. Don't continue running from /Volumes/ —
            // the daemon self-install would write a broken plist.
            NSApp.terminate(nil)
            return true
        }

        do {
            try copy(from: bundleURL, to: target)
        } catch {
            let err = NSAlert()
            err.messageText = "Could not copy Dispatch to Applications."
            err.informativeText = "\(error.localizedDescription)\n\nTry dragging Dispatch.app to your Applications folder manually, then opening it from there."
            err.alertStyle = .warning
            err.addButton(withTitle: "OK")
            err.runModal()
            NSApp.terminate(nil)
            return true
        }

        // Relaunch from the /Applications copy. We `open` (returns
        // immediately) and `exit(0)` to let the new process take over.
        // The DMG eject is left to macOS — Finder cleans it up on logout
        // or the user can eject manually.
        let openTask = Process()
        openTask.launchPath = "/usr/bin/open"
        openTask.arguments = [target.path]
        try? openTask.run()
        openTask.waitUntilExit()
        exit(0)
    }

    private static func copy(from source: URL, to target: URL) throws {
        let fm = FileManager.default
        if fm.fileExists(atPath: target.path) {
            try fm.removeItem(at: target)
        }
        try fm.copyItem(at: source, to: target)
    }
}
