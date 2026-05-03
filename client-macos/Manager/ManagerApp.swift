import SwiftUI

@main
struct ManagerApp: App {
    @StateObject private var resolver = DaemonResolver()

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
        }
    }
}
