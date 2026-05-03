import SwiftUI
import AppKit

@main
struct ManagerApp: App {
    @StateObject private var resolver = DaemonResolver()

    // Hardcoded repo path. Fine for personal-use install through v1.1.x;
    // v1.2's app-bundling pass will replace this with `Bundle.main.url(...)`
    // once the docs ship inside the .app.
    private static let repoRoot = "/Users/shobeir/Code/Manager"

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(resolver)
                .frame(minWidth: 1100, minHeight: 700)
                .task {
                    await resolver.resolve()
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
                    Self.openDoc("docs/TUTORIAL.md")
                }
                Button("Local model setup") {
                    Self.openDoc("docs/LOCAL_MODELS.md")
                }
                Button("Architecture") {
                    Self.openDoc("docs/ARCHITECTURE.md")
                }
                Divider()
                Button("GitHub repo") {
                    if let url = URL(string: "https://github.com/S-KSM/Manager") {
                        NSWorkspace.shared.open(url)
                    }
                }
            }
        }
    }

    private static func openDoc(_ relativePath: String) {
        let url = URL(fileURLWithPath: repoRoot).appendingPathComponent(relativePath)
        NSWorkspace.shared.open(url)
    }
}
