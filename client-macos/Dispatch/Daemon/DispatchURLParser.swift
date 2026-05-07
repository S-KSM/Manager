import Foundation

/// What a parsed `dispatch://...` URL asks the app to do. One case for now;
/// a future entry could be `case openDecision(String, String)` etc.
enum DispatchAction: Equatable {
    case openWorkstream(String)
}

/// Pure parser. Mirrors `daemon/src/url-scheme.ts` — same accept/reject set
/// so the Claude Code `/dispatcher` slash command and the macOS handler agree
/// on what's a valid URL.
///
/// Accepted: `dispatch://workstream/<slug>`. Slug must match `[a-z0-9-]+`,
/// no slashes, no `..`. Trailing slash and query string are tolerated.
enum DispatchURLParser {
    static func parse(_ url: URL) -> DispatchAction? {
        guard url.scheme?.lowercased() == "dispatch" else { return nil }
        guard url.host == "workstream" else { return nil }

        // Strip leading + trailing slashes and reject nested paths.
        var path = url.path
        while path.hasPrefix("/") { path.removeFirst() }
        while path.hasSuffix("/") { path.removeLast() }
        guard !path.isEmpty else { return nil }
        guard !path.contains("/") else { return nil }
        guard path != ".." && path != "." else { return nil }

        // Slug must be lowercase alnum + dash only.
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789-")
        if path.unicodeScalars.contains(where: { !allowed.contains($0) }) {
            return nil
        }
        return .openWorkstream(path)
    }
}
