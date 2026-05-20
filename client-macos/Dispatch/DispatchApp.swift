import SwiftUI
import AppKit

@main
struct DispatchApp: App {
    @StateObject private var resolver = DaemonResolver()
    @StateObject private var router = URLRouter()

    init() {
        // Before the first window appears: if we're running from a DMG,
        // prompt to move to /Applications and relaunch. relocateIfNeeded()
        // calls exit(0) when it relocates, so anything below this is the
        // "running from /Applications (or a dev build)" path.
        if MainActor.assumeIsolated({ AppRelocator.relocateIfNeeded() }) {
            // Unreachable — relocateIfNeeded() exits or terminates when it acts.
        }
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(resolver)
                .environmentObject(router)
                .preferredColorScheme(.light)
                .frame(minWidth: 820, idealWidth: 1280, minHeight: 560, idealHeight: 800)
                .resonaBackground()
                .task {
                    // Self-install the bundled daemon's launchd agent before
                    // probing /health, so a freshly-installed .app comes up
                    // live on first launch instead of falling back to mock.
                    await LaunchdInstaller.ensureInstalled()
                    await resolver.resolve()
                }
                .onOpenURL { url in
                    router.handle(url)
                }
        }
        .windowStyle(.titleBar)
        .windowToolbarStyle(.unified)
        .commands {
            CommandGroup(after: .appInfo) {
                Button("Toggle Mock / Live Daemon") {
                    Task { await resolver.toggle() }
                }
                .keyboardShortcut("m", modifiers: [.command, .shift])
            }
            CommandGroup(replacing: .help) {
                Button("Tutorial") {
                    Self.openBundledDoc("TUTORIAL.md")
                }
                Button("Local model setup") {
                    Self.openBundledDoc("LOCAL_MODELS.md")
                }
                Button("Architecture") {
                    Self.openBundledDoc("ARCHITECTURE.md")
                }
                Divider()
                Button("GitHub repo") {
                    if let url = URL(string: "https://github.com/S-KSM/Manager") {
                        NSWorkspace.shared.open(url)
                    }
                }
            }
        }
        Settings {
            PreferencesView(client: resolver.client)
                .environmentObject(resolver)
        }
    }

    /// Opens a doc shipped under `Contents/Resources/docs/` in the user's
    /// default Markdown viewer. Falls back to GitHub if the bundle is
    /// missing the file (dev build before `embed-daemon.sh` ran).
    private static func openBundledDoc(_ name: String) {
        if let resources = Bundle.main.resourceURL {
            let bundled = resources
                .appendingPathComponent("docs", isDirectory: true)
                .appendingPathComponent(name)
            if FileManager.default.fileExists(atPath: bundled.path) {
                NSWorkspace.shared.open(bundled)
                return
            }
        }
        let raw = "https://github.com/S-KSM/Manager/blob/main/docs/\(name)"
        if let url = URL(string: raw) {
            NSWorkspace.shared.open(url)
        }
    }
}
