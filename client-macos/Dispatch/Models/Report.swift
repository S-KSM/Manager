import Foundation

/// Wire-level representations for the v1.1 Updates feature
/// (see docs/ARCHITECTURE.md > "Reports").
///
/// The Dispatch daemon exposes a small report-engine surface:
///
///   GET    /report-presets
///   POST   /reports/generate
///   GET    /reports?status=draft|saved|archived
///   GET    /reports/:id
///   PATCH  /reports/:id
///   DELETE /reports/:id
///   GET    /scheduler/jobs
///   PATCH  /scheduler/jobs/:id
///
/// Snake-case JSON throughout. All explicit `CodingKeys` mappings live below.

// MARK: - Report status

enum ReportStatus: String, Codable, CaseIterable, Sendable {
    case draft
    case saved
    case archived
}

// MARK: - Report preset

/// One audience preset surfaced by `/report-presets`. The daemon owns the
/// `system_prompt` text; the client treats it as opaque (rendered for power
/// users only via tooltip / debug surfaces).
struct ReportPreset: Codable, Identifiable, Sendable, Hashable {
    let id: String
    let name: String
    let description: String
    let systemPrompt: String

    init(id: String, name: String, description: String, systemPrompt: String) {
        self.id = id
        self.name = name
        self.description = description
        self.systemPrompt = systemPrompt
    }

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case description
        case systemPrompt = "system_prompt"
    }
}

// MARK: - Report

/// A generated update. Body is Markdown. `audiencePreset` may be nil when the
/// caller used a free-text-only override; `audienceFreetext` may be nil when
/// the caller used a preset only. `savedAt` is non-nil only when status flips
/// to `.saved`.
struct Report: Codable, Identifiable, Sendable, Hashable {
    let id: String
    let title: String
    let audiencePreset: String?
    let audienceFreetext: String?
    let periodSince: Date
    let periodUntil: Date
    let workstreamIDs: [String]
    let provider: String
    let model: String?
    let bodyMD: String
    let status: ReportStatus
    let generatedAt: Date
    let savedAt: Date?

    init(
        id: String,
        title: String,
        audiencePreset: String?,
        audienceFreetext: String?,
        periodSince: Date,
        periodUntil: Date,
        workstreamIDs: [String],
        provider: String,
        model: String?,
        bodyMD: String,
        status: ReportStatus,
        generatedAt: Date,
        savedAt: Date?
    ) {
        self.id = id
        self.title = title
        self.audiencePreset = audiencePreset
        self.audienceFreetext = audienceFreetext
        self.periodSince = periodSince
        self.periodUntil = periodUntil
        self.workstreamIDs = workstreamIDs
        self.provider = provider
        self.model = model
        self.bodyMD = bodyMD
        self.status = status
        self.generatedAt = generatedAt
        self.savedAt = savedAt
    }

    enum CodingKeys: String, CodingKey {
        case id
        case title
        case provider
        case model
        case status
        case audiencePreset = "audience_preset"
        case audienceFreetext = "audience_freetext"
        case periodSince = "period_since"
        case periodUntil = "period_until"
        case workstreamIDs = "workstream_ids"
        case bodyMD = "body_md"
        case generatedAt = "generated_at"
        case savedAt = "saved_at"
    }
}

// MARK: - Generate params

/// Body for `POST /reports/generate`. Most fields are optional so the daemon
/// can apply sensible defaults (since = now-7d, until = now, all active
/// workstreams, etc.).
struct GenerateReportParams: Codable, Sendable, Hashable {
    let workstreamIDs: [String]
    let since: Date?
    let until: Date?
    let audiencePreset: String?
    let audienceFreetext: String?
    /// "claude" | "ollama"
    let provider: String
    let model: String?
    let save: Bool
    let title: String?

    init(
        workstreamIDs: [String],
        since: Date? = nil,
        until: Date? = nil,
        audiencePreset: String? = nil,
        audienceFreetext: String? = nil,
        provider: String,
        model: String? = nil,
        save: Bool = false,
        title: String? = nil
    ) {
        self.workstreamIDs = workstreamIDs
        self.since = since
        self.until = until
        self.audiencePreset = audiencePreset
        self.audienceFreetext = audienceFreetext
        self.provider = provider
        self.model = model
        self.save = save
        self.title = title
    }

    enum CodingKeys: String, CodingKey {
        case provider
        case model
        case save
        case title
        case since
        case until
        case workstreamIDs = "workstream_ids"
        case audiencePreset = "audience_preset"
        case audienceFreetext = "audience_freetext"
    }
}

// MARK: - Patch fields

/// Partial-update body for `PATCH /reports/:id`. Pass `nil` for any field you
/// don't want to change. Setting `status = .saved` causes the daemon to set
/// `saved_at = now`.
struct ReportUpdateFields: Codable, Sendable, Hashable {
    let title: String?
    let bodyMD: String?
    let status: ReportStatus?

    init(title: String? = nil, bodyMD: String? = nil, status: ReportStatus? = nil) {
        self.title = title
        self.bodyMD = bodyMD
        self.status = status
    }

    enum CodingKeys: String, CodingKey {
        case title
        case status
        case bodyMD = "body_md"
    }
}

// MARK: - Scheduler job

/// Wire shape of a single scheduler config row from `/scheduler/jobs`.
/// Only `weekly_report` and `monthly_report` ids are emitted in v1.1.
struct SchedulerJob: Codable, Identifiable, Sendable, Hashable {
    let id: String
    let enabled: Bool
    let cron: String
    let audiencePreset: String?
    let provider: String
    let model: String?
    let nextFireAt: Date?

    init(
        id: String,
        enabled: Bool,
        cron: String,
        audiencePreset: String?,
        provider: String,
        model: String?,
        nextFireAt: Date?
    ) {
        self.id = id
        self.enabled = enabled
        self.cron = cron
        self.audiencePreset = audiencePreset
        self.provider = provider
        self.model = model
        self.nextFireAt = nextFireAt
    }

    enum CodingKeys: String, CodingKey {
        case id
        case enabled
        case cron
        case provider
        case model
        case audiencePreset = "audience_preset"
        case nextFireAt = "next_fire_at"
    }
}

/// Partial-update body for `PATCH /scheduler/jobs/:id`.
struct SchedulerJobUpdateFields: Codable, Sendable, Hashable {
    let enabled: Bool?
    let cron: String?
    let audiencePreset: String?
    let provider: String?
    let model: String?

    init(
        enabled: Bool? = nil,
        cron: String? = nil,
        audiencePreset: String? = nil,
        provider: String? = nil,
        model: String? = nil
    ) {
        self.enabled = enabled
        self.cron = cron
        self.audiencePreset = audiencePreset
        self.provider = provider
        self.model = model
    }

    enum CodingKeys: String, CodingKey {
        case enabled
        case cron
        case provider
        case model
        case audiencePreset = "audience_preset"
    }
}
