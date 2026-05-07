import Foundation
import SwiftUI

/// Glue between the WindowGroup's `.onOpenURL` and the Radar's selection
/// state. `DispatchApp` injects this as an `@StateObject` so a single
/// instance survives across view rebuilds; `ContentView` reads it as an
/// `@EnvironmentObject` and reacts via `.onChange(of:)`.
///
/// We don't perform navigation here directly — we expose a published
/// `pendingAction` and let the host view decide how to apply it (e.g.
/// reload first if the workstream isn't in the local list yet). After
/// handling, the host clears `pendingAction` back to nil.
@MainActor
final class URLRouter: ObservableObject {
    @Published var pendingAction: DispatchAction?

    init() {}

    func handle(_ url: URL) {
        pendingAction = DispatchURLParser.parse(url)
    }
}
