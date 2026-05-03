import Foundation

/// Typed wrapper around the workstream Markdown memory file.
///
/// The daemon stores one Markdown file per workstream at
/// `~/.claude/manager/memory/<workstream_id>.md`. The convention from
/// `docs/ARCHITECTURE.md` uses fixed `## Goal`, `## Current state`,
/// `## Key decisions`, `## Open questions`, `## Skills learned` sections —
/// but the agent owns the file, so this wrapper is best-effort: the raw
/// Markdown is always preserved verbatim, and parsed sections are a
/// projection on top.
struct WorkstreamMemory: Hashable, Sendable {
    let workstreamID: String
    let raw: String
    let sections: [Section]

    struct Section: Hashable, Sendable, Identifiable {
        let heading: String
        let body: String
        var id: String { heading }
        init(heading: String, body: String) {
            self.heading = heading
            self.body = body
        }
    }

    init(workstreamID: String, raw: String) {
        self.workstreamID = workstreamID
        self.raw = raw
        self.sections = WorkstreamMemory.parseSections(raw)
    }

    /// Naive `## Heading`-level Markdown section split. Anything before the
    /// first `##` is dropped (typically the `# Workstream: …` title line).
    private static func parseSections(_ md: String) -> [Section] {
        var sections: [Section] = []
        var currentHeading: String? = nil
        var currentBody: [String] = []

        for line in md.split(separator: "\n", omittingEmptySubsequences: false) {
            let s = String(line)
            if s.hasPrefix("## ") {
                if let h = currentHeading {
                    sections.append(Section(
                        heading: h,
                        body: currentBody.joined(separator: "\n")
                            .trimmingCharacters(in: .whitespacesAndNewlines)
                    ))
                }
                currentHeading = String(s.dropFirst(3))
                    .trimmingCharacters(in: .whitespaces)
                currentBody = []
            } else if currentHeading != nil {
                currentBody.append(s)
            }
        }
        if let h = currentHeading {
            sections.append(Section(
                heading: h,
                body: currentBody.joined(separator: "\n")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
            ))
        }
        return sections
    }
}
