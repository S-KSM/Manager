import SwiftUI

/// v1.4.14 — Error label that recognises the "model not found" failure mode
/// from a local-LLM HTTP 4xx and offers a one-click Pull next to the message.
/// Falls back to a plain red Label for any error it can't enrich.
///
/// Used by GenerateReportSheet and any future surface that displays an LLM
/// provider error inline (Headliner debug, manual report generation, etc.).
///
/// Detection is regex-based on the wire shape ollama / mlx_lm.server returns:
///
///   model 'qwen3:8b' not found
///   model "qwen3:8b" not found
///   model `qwen3:8b` not found
///
/// Plus the surrounding daemon-prefixed envelope `Local LLM HTTP 404: {...}`.
struct LLMErrorView: View {
    let message: String
    let client: DaemonClientProtocol

    @State private var pulling = false
    @State private var pullStatus: PullStatus?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(.red)
                .textSelection(.enabled)
            if let modelName = LLMErrorView.extractMissingModelName(from: message) {
                HStack(spacing: 8) {
                    Button {
                        Task { await pull(modelName) }
                    } label: {
                        if pulling {
                            HStack(spacing: 4) {
                                ProgressView().controlSize(.small)
                                Text("Pulling \(modelName)…")
                            }
                        } else {
                            Label("Pull \"\(modelName)\"", systemImage: "arrow.down.circle")
                        }
                    }
                    .controlSize(.small)
                    .disabled(pulling)
                    .help("Run `ollama pull \(modelName)` against the configured local LLM. Resolves a 'model not found' error without leaving this dialog.")
                    if let status = pullStatus {
                        Image(systemName: status.systemImage)
                            .foregroundStyle(status.iconColor)
                        Text(status.line)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .textSelection(.enabled)
                    }
                }
            }
        }
    }

    private func pull(_ model: String) async {
        pulling = true
        pullStatus = nil
        defer { pulling = false }
        do {
            let r = try await client.pullModel(model)
            let tail = LLMErrorView.lastNonEmptyLine(r.output) ?? r.error ?? "(no output)"
            if r.ok {
                pullStatus = .ok("Pulled \(model). Try again.")
            } else if let err = r.error {
                pullStatus = .error(err)
            } else {
                pullStatus = .error("exit \(r.exitCode ?? -1): \(tail)")
            }
        } catch {
            pullStatus = .error(error.localizedDescription)
        }
    }

    /// Extract the model identifier from any "model '<name>' not found" /
    /// '"<name>"' / "`<name>`" variant. Case-insensitive on the literal
    /// "not found"; preserves the model name's case verbatim. Returns nil
    /// when the message isn't a model-not-found error.
    static func extractMissingModelName(from text: String) -> String? {
        // Allow ' " ` as quote chars; model names are [A-Za-z0-9._:/-].
        let pattern = #"model\s+['"`]([A-Za-z0-9._:/-]+)['"`]\s+not\s+found"#
        guard
            let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
        else { return nil }
        let ns = text as NSString
        let range = NSRange(location: 0, length: ns.length)
        guard let match = regex.firstMatch(in: text, options: [], range: range), match.numberOfRanges >= 2
        else { return nil }
        let nameRange = match.range(at: 1)
        guard nameRange.location != NSNotFound else { return nil }
        return ns.substring(with: nameRange)
    }

    static func lastNonEmptyLine(_ text: String) -> String? {
        text
            .split(whereSeparator: { $0.isNewline })
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .last(where: { !$0.isEmpty })
    }
}
