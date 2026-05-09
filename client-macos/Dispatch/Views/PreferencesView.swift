import SwiftUI

/// Cmd-, Settings window. Three tabs:
///   - Daemon: live/mock status + bundled daemon hint.
///   - Providers: pick the LLM that powers activity headlines + sub-goal
///     synthesis (the "summary" features), and stash an Anthropic API key /
///     Ollama URL without touching env vars.
///   - Diagnostics (v1.4.6): kill / restart the local LLM and soft- /
///     hard-restart the daemon. Lives next to the launchctl plumbing
///     because that's the only place those buttons can survive a daemon
///     dying mid-response.
struct PreferencesView: View {
    let client: DaemonClientProtocol

    var body: some View {
        TabView {
            DaemonStatusSettings()
                .tabItem { Label("Daemon", systemImage: "gearshape") }
            ProvidersSettings(client: client)
                .tabItem { Label("Providers", systemImage: "cpu") }
            DiagnosticsSettings(client: client)
                .tabItem { Label("Diagnostics", systemImage: "stethoscope") }
        }
        .frame(width: 560, height: 460)
    }
}

private struct DaemonStatusSettings: View {
    @EnvironmentObject private var resolver: DaemonResolver

    var body: some View {
        Form {
            Section("Status") {
                LabeledContent("Mode") {
                    Text(resolver.mode == .live ? "Live daemon" : "Mock data")
                }
                LabeledContent("Reason") {
                    Text(reasonText(resolver.modeReason))
                        .foregroundStyle(.secondary)
                }
            }

            Section("Bundled daemon") {
                if let url = LaunchdInstaller.bundledDaemonURL {
                    Text(url.path)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                    Text("First launch writes a launchd agent pointing at this file. Move the .app and the agent rewires itself on next launch.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Text("Running a dev build (no daemon embedded). Use bin/install.sh to register the launchd agent against daemon/dist/index.js.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            HStack {
                Spacer()
                Button("Retry / Start daemon") { Task { await resolver.retryConnection() } }
                    .help("Re-probe the daemon; if it's down, kick the launchd agent.")
            }
        }
        .padding(20)
    }

    private func reasonText(_ r: DaemonResolver.ModeReason) -> String {
        switch r {
        case .unknown:         return "Probing…"
        case .liveHealthy:     return "Daemon answered /health."
        case .liveUnreachable: return "Daemon did not respond."
        case .envOverride:     return "DISPATCH_DAEMON=mock env var."
        case .userToggled:     return "Toggled via Cmd-Shift-M."
        case .forced:          return "Preview / test override."
        }
    }
}

/// Local-model + API-key settings. Backed by `GET/PATCH /settings`.
///
/// Layout:
///   - Provider segmented picker (Claude / Ollama).
///   - Model TextField (placeholder shows the per-provider default).
///   - Ollama URL TextField (only enabled when Ollama is selected, but
///     always editable so a user can pre-fill before switching).
///   - Anthropic API key SecureField with placeholder reflecting whether the
///     daemon already has a key on file.
///   - Status row: daemon /health probe + a quick provider reachability hint.
private struct ProvidersSettings: View {
    let client: DaemonClientProtocol

    @State private var loaded = false
    @State private var loadingError: String?

    @State private var provider: ProviderSettings.Provider = .ollama
    @State private var model: String = ""
    @State private var ollamaURL: String = "http://localhost:8080/v1"
    @State private var anthropicAPIKey: String = ""
    @State private var anthropicConfigured = false
    @State private var linearAPIKey: String = ""
    @State private var linearConfigured = false
    /// v1.4.6 — `localLLMStartCommand` is cleartext on the wire (not a
    /// credential). The Diagnostics tab's Restart-Model button stays
    /// disabled when this is empty.
    @State private var localLLMStartCommand: String = ""

    /// v1.4.13 — pull-model button state. `pullStatus` carries the human
    /// summary line shown under the Model field after a click; stays nil
    /// until the user pulls. Errors get the same field — distinguished by
    /// the leading icon when rendered.
    @State private var pulling = false
    @State private var pullStatus: PullStatus?

    @State private var saving = false
    @State private var saveError: String?
    @State private var savedAt: Date?

    @State private var daemonReachable: Bool?
    @State private var providerReachable: Bool?
    @State private var probing = false

    var body: some View {
        Form {
            Section("Provider") {
                Picker("Powers summaries", selection: $provider) {
                    ForEach(ProviderSettings.Provider.allCases) { p in
                        Text(p.displayName).tag(p)
                    }
                }
                .pickerStyle(.segmented)

                HStack(alignment: .firstTextBaseline) {
                    TextField("Model", text: $model, prompt: Text(modelPlaceholder))
                        .textFieldStyle(.roundedBorder)
                        .help("The model id sent to the provider. Leave blank to use the daemon's default for this provider.")
                    // v1.4.13 — Pull-model button. Ollama-only because mlx_lm
                    // and llama.cpp don't have a pull command (they fetch
                    // from HuggingFace on first inference). Disabled when the
                    // model field is empty or the provider is .claude.
                    if provider == .ollama {
                        Button {
                            Task { await pullModel() }
                        } label: {
                            if pulling {
                                ProgressView().controlSize(.small)
                            } else {
                                Label("Pull", systemImage: "arrow.down.circle")
                            }
                        }
                        .disabled(pulling || model.trimmingCharacters(in: .whitespaces).isEmpty)
                        .help("Run `ollama pull <model>` against the configured local LLM. Use this when the daemon reports a 404 for an unknown model. mlx_lm.server fetches models on first use, so the button is Ollama-specific.")
                    }
                }

                // v1.4.13 — pull result line. Mirrors the spot the saved-at /
                // error timestamp uses; surfaces the tail of `ollama pull`'s
                // stdout/stderr so the user can see why it failed.
                if let status = pullStatus {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Image(systemName: status.systemImage)
                            .foregroundStyle(status.iconColor)
                        Text(status.line)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(3)
                            .textSelection(.enabled)
                    }
                }

                if provider == .ollama {
                    TextField("Local LLM URL", text: $ollamaURL,
                              prompt: Text("http://localhost:8080/v1"))
                        .textFieldStyle(.roundedBorder)
                        .help("Base URL for your OpenAI-compatible local LLM server. Defaults to mlx_lm.server (port 8080); for Ollama, use http://localhost:11434.")

                    TextField("Local LLM start command",
                              text: $localLLMStartCommand,
                              prompt: Text("mlx_lm.server --port 8080"))
                        .textFieldStyle(.roundedBorder)
                        .help("Shell command the Diagnostics tab's Restart-Model button runs after killing the existing process. Optional; leave blank to disable that button.")
                }
            }

            Section("Anthropic API key") {
                SecureField(anthropicConfigured ? "•••• configured" : "sk-ant-…",
                            text: $anthropicAPIKey)
                    .textFieldStyle(.roundedBorder)
                    .help("Required only when Provider = Claude. Stored in ~/.claude/dispatch/settings.json with 0600 permissions; never returned by the daemon once saved.")
                if anthropicConfigured && anthropicAPIKey.isEmpty {
                    Text("A key is on file. Type a new one to replace it; clear and save to remove it.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Section("Linear API key") {
                SecureField(linearConfigured ? "•••• configured" : "lin_api_…",
                            text: $linearAPIKey)
                    .textFieldStyle(.roundedBorder)
                    .help("Required for the Link-to-Linear chip in the agent detail view, plus the bidirectional Linear sync. Same redaction + storage as the Anthropic key.")
                if linearConfigured && linearAPIKey.isEmpty {
                    Text("A key is on file. Type a new one to replace it; clear and save to remove it.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Section("Connectivity") {
                LabeledContent("Daemon") {
                    statusBadge(reachable: daemonReachable, probing: probing,
                                okText: "Connected", failText: "Unreachable")
                }
                LabeledContent(provider == .claude ? "Anthropic" : "Local LLM") {
                    statusBadge(reachable: providerReachable, probing: probing,
                                okText: "Reachable",
                                failText: provider == .ollama ? "Not reachable" : "Key missing")
                }
                Button("Test now") { Task { await probe() } }
                    .disabled(probing)
                    .help("Probe the daemon and the selected provider")
            }

            HStack {
                if let err = loadingError ?? saveError {
                    Text(err)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .lineLimit(2)
                } else if let savedAt {
                    Text("Saved \(savedAt.formatted(date: .omitted, time: .standard)).")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Save") { Task { await save() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(saving || !loaded)
                    .help("Save provider, model, and key changes")
            }
        }
        .padding(20)
        .task {
            await load()
            await probe()
        }
    }

    private var modelPlaceholder: String {
        provider == .claude ? "claude-haiku-4-5-20251001" : "qwen3:4b"
    }

    private func load() async {
        do {
            let s = try await client.getSettings()
            provider = s.headlineProvider
            model = s.headlineModel
            ollamaURL = s.ollamaURL
            anthropicConfigured = s.anthropicAPIKeyConfigured
            linearConfigured = s.linearAPIKeyConfigured
            localLLMStartCommand = s.localLLMStartCommand
            anthropicAPIKey = ""
            linearAPIKey = ""
            loaded = true
            loadingError = nil
        } catch {
            loadingError = "Couldn't read settings: \(error.localizedDescription)"
            // Still let the user edit + save; PATCH will return the same error
            // shape if the daemon is down.
            loaded = true
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        var patch = ProviderSettingsPatch()
        patch.headlineProvider = provider
        patch.headlineModel = model
        patch.ollamaURL = ollamaURL
        // Only send the key when the user typed something — otherwise we'd
        // either clobber an existing key with `""` or echo the placeholder.
        if !anthropicAPIKey.isEmpty {
            patch.anthropicAPIKey = anthropicAPIKey
        }
        if !linearAPIKey.isEmpty {
            patch.linearAPIKey = linearAPIKey
        }
        // localLLMStartCommand is cleartext: always send the current value
        // (including empty, which the daemon treats as "clear").
        patch.localLLMStartCommand = localLLMStartCommand
        do {
            let s = try await client.patchSettings(patch)
            provider = s.headlineProvider
            model = s.headlineModel
            ollamaURL = s.ollamaURL
            anthropicConfigured = s.anthropicAPIKeyConfigured
            linearConfigured = s.linearAPIKeyConfigured
            localLLMStartCommand = s.localLLMStartCommand
            anthropicAPIKey = ""
            linearAPIKey = ""
            saveError = nil
            savedAt = Date()
            // Probe again now that settings have changed (URL / provider may
            // have moved underneath us).
            await probe()
        } catch {
            saveError = "Save failed: \(error.localizedDescription)"
        }
    }

    /// v1.4.13 — Run `ollama pull <model>` via the daemon. Synchronous on
    /// the wire (the daemon waits for the pull before responding), so the
    /// button stays in `pulling` state until ollama is done. We surface the
    /// last line of stdout/stderr so a typo / network fail / disk-full
    /// message reaches the user without a separate logs screen.
    private func pullModel() async {
        let trimmed = model.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        pulling = true
        pullStatus = .info("Pulling \(trimmed)…")
        defer { pulling = false }
        do {
            let r = try await client.pullModel(trimmed)
            let tail = lastNonEmptyLine(r.output) ?? r.error ?? "(no output)"
            if r.ok {
                pullStatus = .ok("Pulled \(trimmed). \(tail)")
            } else if let err = r.error {
                pullStatus = .error("Pull failed: \(err)")
            } else {
                pullStatus = .error("Pull failed (exit \(r.exitCode ?? -1)): \(tail)")
            }
        } catch {
            pullStatus = .error("Pull failed: \(error.localizedDescription)")
        }
    }

    /// Cheap reachability check: daemon /health, then a quick HEAD/GET on the
    /// chosen provider. We deliberately keep this off the LLM API surface so
    /// it doesn't burn tokens.
    private func probe() async {
        probing = true
        defer { probing = false }
        daemonReachable = await client.health()

        switch provider {
        case .ollama:
            providerReachable = await probeOllama(url: ollamaURL)
        case .claude:
            // No-cost probe: we treat "key configured OR typed" as reachable.
            // A real round-trip would charge the user a token; surfacing a
            // network probe to api.anthropic.com would also leak that we ran
            // one. The actual auth check happens on the next summary tick.
            providerReachable = anthropicConfigured || !anthropicAPIKey.isEmpty
        }
    }

    /// Cheap reachability probe for any OpenAI-compatible local LLM server
    /// (mlx_lm.server / Ollama / llama.cpp). Hits `GET <baseUrl>/models`,
    /// the OpenAI-compat list endpoint. A 404 means we got a TCP response
    /// from *something* but it doesn't speak the API — treat as reachable
    /// so the user can still see "the box is up" and fix the URL. Network
    /// errors / refusal → not reachable.
    private func probeOllama(url: String) async -> Bool {
        guard let base = URL(string: url) else { return false }
        let modelsURL = base.appendingPathComponent("models")
        var req = URLRequest(url: modelsURL)
        req.timeoutInterval = 1.5
        do {
            let (_, response) = try await URLSession.shared.data(for: req)
            if let http = response as? HTTPURLResponse {
                if (200..<500).contains(http.statusCode) {
                    return true
                }
                return false
            }
            return false
        } catch {
            // 404 fallback: try a bare TCP-ish check on the host:port via a
            // root GET. If the host answers anything, the server is up.
            if let host = base.host {
                var components = URLComponents()
                components.scheme = base.scheme
                components.host = host
                if let port = base.port { components.port = port }
                components.path = "/"
                if let rootURL = components.url {
                    var rootReq = URLRequest(url: rootURL)
                    rootReq.timeoutInterval = 1.5
                    if let (_, rootResp) = try? await URLSession.shared.data(for: rootReq),
                       rootResp is HTTPURLResponse {
                        return true
                    }
                }
            }
            return false
        }
    }

    @ViewBuilder
    private func statusBadge(reachable: Bool?, probing: Bool,
                             okText: String, failText: String) -> some View {
        if probing {
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text("Checking…").foregroundStyle(.secondary)
            }
        } else if let reachable {
            HStack(spacing: 6) {
                Circle()
                    .fill(reachable ? .green : .red)
                    .frame(width: 8, height: 8)
                Text(reachable ? okText : failText)
                    .foregroundStyle(.secondary)
            }
        } else {
            Text("Unknown").foregroundStyle(.secondary)
        }
    }
}

/// v1.4.13 — Status of the most recent `Pull` button click. Drives the
/// status line that renders below the Model field on the Providers tab.
enum PullStatus: Equatable {
    case info(String)
    case ok(String)
    case error(String)

    var line: String {
        switch self {
        case .info(let s), .ok(let s), .error(let s): return s
        }
    }
    var systemImage: String {
        switch self {
        case .info: return "ellipsis.circle"
        case .ok: return "checkmark.circle.fill"
        case .error: return "exclamationmark.circle.fill"
        }
    }
    var iconColor: Color {
        switch self {
        case .info: return .secondary
        case .ok: return .green
        case .error: return .red
        }
    }
}

/// v1.4.13 — Pluck the last non-empty line of `text`, trimmed. Used to
/// surface ollama's final progress / error line to the user without
/// overwhelming them with multi-line output.
private func lastNonEmptyLine(_ text: String) -> String? {
    text
        .split(whereSeparator: { $0.isNewline })
        .map { $0.trimmingCharacters(in: .whitespaces) }
        .last(where: { !$0.isEmpty })
}

/// v1.4.6 — Diagnostics tab. Four buttons:
///   1. Kill Local LLM        — `POST /admin/llm/kill`
///   2. Restart Local LLM     — `POST /admin/llm/restart`
///                              (disabled until a start command is set)
///   3. Restart Daemon — Soft — `POST /admin/restart` (re-reads settings,
///                              reboots tickers, no process exit)
///   4. Restart Daemon — Hard — `launchctl kickstart -k` via
///                              `LaunchctlController` (the daemon would
///                              die mid-response if this were a daemon
///                              endpoint).
///
/// Destructive actions (Kill, Hard Restart) confirm via
/// `confirmationDialog`; non-destructive ones don't. Each button shows its
/// last result inline so the user knows whether the click landed.
private struct DiagnosticsSettings: View {
    let client: DaemonClientProtocol

    @State private var startCommand: String = ""
    @State private var loadedStartCommand = false

    @State private var killResultText: String?
    @State private var restartLLMResultText: String?
    @State private var restartSoftResultText: String?
    @State private var restartHardResultText: String?

    @State private var killing = false
    @State private var restartingLLM = false
    @State private var restartingSoft = false

    @State private var confirmKill = false
    @State private var confirmHard = false

    var body: some View {
        Form {
            Section("Local LLM") {
                Button("Kill Local LLM") { confirmKill = true }
                    .disabled(killing)
                    .help("Find the PID listening on the configured local LLM port and SIGTERM it (with a 3-second grace period before SIGKILL).")
                if let text = killResultText {
                    Text(text)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }

                Button("Restart Local LLM") { Task { await restartLLM() } }
                    .disabled(restartingLLM || startCommand.isEmpty || !loadedStartCommand)
                    .help(
                        startCommand.isEmpty
                            ? "Set a start command first (Providers tab → Local LLM start command)."
                            : "Kill the existing process, then run the start command via bash -lc detached."
                    )
                if let text = restartLLMResultText {
                    Text(text)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
            }

            Section("Daemon") {
                Button("Restart Daemon — Soft") { Task { await restartSoft() } }
                    .disabled(restartingSoft)
                    .help("Re-read settings.json and re-instantiate the background tickers (Headliner / SubgoalSynthesizer / LinearCommentSyncer). The daemon process keeps running.")
                if let text = restartSoftResultText {
                    Text(text)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }

                Button("Restart Daemon — Hard") { confirmHard = true }
                    .help("Run launchctl kickstart -k. Daemon process exits and launchd brings it back. The Radar reconnects automatically.")
                if let text = restartHardResultText {
                    Text(text)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
            }
        }
        .padding(20)
        .task {
            // Pull the configured start command so we can disable the
            // Restart-Model button without a roundtrip on every render.
            if let s = try? await client.getSettings() {
                startCommand = s.localLLMStartCommand
            }
            loadedStartCommand = true
        }
        .confirmationDialog(
            "Kill the local LLM?",
            isPresented: $confirmKill,
            titleVisibility: .visible
        ) {
            Button("Kill", role: .destructive) { Task { await killLLM() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Sends SIGTERM, escalates to SIGKILL after 3s if it doesn't exit.")
        }
        .confirmationDialog(
            "Hard-restart the daemon?",
            isPresented: $confirmHard,
            titleVisibility: .visible
        ) {
            Button("Restart", role: .destructive) { hardRestart() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Runs `launchctl kickstart -k`. The daemon exits and launchd respawns it. Existing connections drop.")
        }
    }

    private func killLLM() async {
        killing = true
        defer { killing = false }
        do {
            let result = try await client.killLLM()
            if let pid = result.killed {
                let suffix = result.escalated ? " (SIGKILL after grace period)" : ""
                killResultText = "Killed PID \(pid)\(suffix)."
            } else {
                killResultText = "Nothing was running on the configured port."
            }
        } catch {
            killResultText = "Kill failed: \(error.localizedDescription)"
        }
    }

    private func restartLLM() async {
        restartingLLM = true
        defer { restartingLLM = false }
        do {
            let result = try await client.restartLLM()
            let killedNote: String
            if let pid = result.killedPID {
                killedNote = "killed PID \(pid), "
            } else {
                killedNote = ""
            }
            restartLLMResultText = "Local LLM restarted (\(killedNote)started=\(result.started))."
        } catch {
            restartLLMResultText = "Restart failed: \(error.localizedDescription)"
        }
    }

    private func restartSoft() async {
        restartingSoft = true
        defer { restartingSoft = false }
        do {
            let result = try await client.restartDaemon()
            if result.restarted.isEmpty {
                restartSoftResultText = "No tickers were running to restart."
            } else {
                restartSoftResultText = "Restarted: \(result.restarted.joined(separator: ", "))."
            }
        } catch {
            restartSoftResultText = "Soft restart failed: \(error.localizedDescription)"
        }
    }

    private func hardRestart() {
        switch LaunchctlController.kickstart() {
        case .success:
            restartHardResultText = "Daemon restart triggered. The Radar will reconnect on the next /health probe."
        case .failure(let error):
            restartHardResultText = "Hard restart failed: \(error.localizedDescription)"
        }
    }
}

#if DEBUG
#Preview("Providers — Ollama default") {
    PreferencesView(client: MockDaemonClient(simulatedLatency: .zero))
        .environmentObject(DaemonResolver())
}

#Preview("Diagnostics tab") {
    PreferencesView(client: MockDaemonClient(simulatedLatency: .zero))
        .environmentObject(DaemonResolver())
}
#endif
