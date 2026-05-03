import Foundation

/// Wire-level representation of a single line in the daemon's per-workstream
/// JSONL event store (see docs/ARCHITECTURE.md > "Event").
///
/// The daemon emits a flat envelope (`ts`, `workstream_id`, `session_id`, `type`,
/// `id`, `parent_id`, `payload`) and the `payload` shape varies per `type`. We
/// model that as a flat `Event` struct with a typed `payload` enum that knows
/// how to decode itself from the envelope's `payload` object.
struct Event: Identifiable, Codable, Hashable, Sendable {
    let ts: Date
    let workstreamID: String
    let sessionID: String?
    let type: EventType
    let id: String
    let parentID: String?
    let payload: EventPayload

    init(
        ts: Date,
        workstreamID: String,
        sessionID: String?,
        type: EventType,
        id: String,
        parentID: String? = nil,
        payload: EventPayload
    ) {
        self.ts = ts
        self.workstreamID = workstreamID
        self.sessionID = sessionID
        self.type = type
        self.id = id
        self.parentID = parentID
        self.payload = payload
    }

    enum CodingKeys: String, CodingKey {
        case ts
        case workstreamID = "workstream_id"
        case sessionID = "session_id"
        case type
        case id
        case parentID = "parent_id"
        case payload
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.ts = try c.decode(Date.self, forKey: .ts)
        self.workstreamID = try c.decode(String.self, forKey: .workstreamID)
        self.sessionID = try c.decodeIfPresent(String.self, forKey: .sessionID)
        self.type = try c.decode(EventType.self, forKey: .type)
        self.id = try c.decode(String.self, forKey: .id)
        self.parentID = try c.decodeIfPresent(String.self, forKey: .parentID)
        self.payload = try EventPayload.decode(type: self.type,
                                               from: c,
                                               key: .payload)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(ts, forKey: .ts)
        try c.encode(workstreamID, forKey: .workstreamID)
        try c.encodeIfPresent(sessionID, forKey: .sessionID)
        try c.encode(type, forKey: .type)
        try c.encode(id, forKey: .id)
        try c.encodeIfPresent(parentID, forKey: .parentID)
        try payload.encode(into: &c, key: .payload)
    }
}

enum EventType: String, Codable, Sendable, CaseIterable {
    case sessionStart  = "session_start"
    case sessionEnd    = "session_end"
    case decision
    case subgoalPush   = "subgoal_push"
    case subgoalPop    = "subgoal_pop"
    case confidence
    case toolUse       = "tool_use"
    case blocked
    case memoryUpdate  = "memory_update"
    case interventionDelivered = "intervention_delivered"
}

/// The typed `payload` for each event variant. The variant order mirrors
/// EventType.
enum EventPayload: Hashable, Sendable {
    case sessionStart(SessionStart)
    case sessionEnd(SessionEnd)
    case decision(Decision)
    case subgoalPush(Subgoal)
    case subgoalPop(SubgoalPop)
    case confidence(Confidence)
    case toolUse(ToolUse)
    case blocked(Blocked)
    case memoryUpdate(MemoryUpdate)
    case interventionDelivered(InterventionDelivered)

    struct SessionStart: Codable, Hashable, Sendable {
        let sessionID: String?
        let runtime: String?
        enum CodingKeys: String, CodingKey {
            case sessionID = "session_id"
            case runtime
        }
        init(sessionID: String? = nil, runtime: String? = nil) {
            self.sessionID = sessionID
            self.runtime = runtime
        }
    }

    struct SessionEnd: Codable, Hashable, Sendable {
        let reason: String?
        init(reason: String? = nil) { self.reason = reason }
    }

    struct Decision: Codable, Hashable, Sendable {
        let considered: [String]
        let choice: String
        let rationale: String
        let confidence: Double
        init(considered: [String], choice: String, rationale: String, confidence: Double) {
            self.considered = considered
            self.choice = choice
            self.rationale = rationale
            self.confidence = confidence
        }
    }

    struct Subgoal: Codable, Hashable, Sendable {
        let goal: String
        init(goal: String) { self.goal = goal }
    }

    struct SubgoalPop: Codable, Hashable, Sendable {
        let goal: String?
        init(goal: String? = nil) { self.goal = goal }
    }

    struct Confidence: Codable, Hashable, Sendable {
        let value: Double
        let note: String?
        init(value: Double, note: String? = nil) {
            self.value = value
            self.note = note
        }
    }

    struct ToolUse: Codable, Hashable, Sendable {
        let tool: String
        let phase: String?         // "pre" | "post"
        let summary: String?
        init(tool: String, phase: String? = nil, summary: String? = nil) {
            self.tool = tool
            self.phase = phase
            self.summary = summary
        }
    }

    struct Blocked: Codable, Hashable, Sendable {
        let reason: String
        init(reason: String) { self.reason = reason }
    }

    struct MemoryUpdate: Codable, Hashable, Sendable {
        let section: String
        let summary: String?
        init(section: String, summary: String? = nil) {
            self.section = section
            self.summary = summary
        }
    }

    struct InterventionDelivered: Codable, Hashable, Sendable {
        let interventionID: String
        let kind: String
        enum CodingKeys: String, CodingKey {
            case interventionID = "intervention_id"
            case kind
        }
        init(interventionID: String, kind: String) {
            self.interventionID = interventionID
            self.kind = kind
        }
    }
}

extension EventPayload {
    static func decode<K: CodingKey>(
        type: EventType,
        from container: KeyedDecodingContainer<K>,
        key: K
    ) throws -> EventPayload {
        switch type {
        case .sessionStart:
            return .sessionStart(try container.decode(SessionStart.self, forKey: key))
        case .sessionEnd:
            return .sessionEnd(try container.decode(SessionEnd.self, forKey: key))
        case .decision:
            return .decision(try container.decode(Decision.self, forKey: key))
        case .subgoalPush:
            return .subgoalPush(try container.decode(Subgoal.self, forKey: key))
        case .subgoalPop:
            return .subgoalPop(try container.decode(SubgoalPop.self, forKey: key))
        case .confidence:
            return .confidence(try container.decode(Confidence.self, forKey: key))
        case .toolUse:
            return .toolUse(try container.decode(ToolUse.self, forKey: key))
        case .blocked:
            return .blocked(try container.decode(Blocked.self, forKey: key))
        case .memoryUpdate:
            return .memoryUpdate(try container.decode(MemoryUpdate.self, forKey: key))
        case .interventionDelivered:
            return .interventionDelivered(try container.decode(InterventionDelivered.self, forKey: key))
        }
    }

    func encode<K: CodingKey>(
        into container: inout KeyedEncodingContainer<K>,
        key: K
    ) throws {
        switch self {
        case .sessionStart(let p):           try container.encode(p, forKey: key)
        case .sessionEnd(let p):             try container.encode(p, forKey: key)
        case .decision(let p):               try container.encode(p, forKey: key)
        case .subgoalPush(let p):            try container.encode(p, forKey: key)
        case .subgoalPop(let p):             try container.encode(p, forKey: key)
        case .confidence(let p):             try container.encode(p, forKey: key)
        case .toolUse(let p):                try container.encode(p, forKey: key)
        case .blocked(let p):                try container.encode(p, forKey: key)
        case .memoryUpdate(let p):           try container.encode(p, forKey: key)
        case .interventionDelivered(let p):  try container.encode(p, forKey: key)
        }
    }
}

extension Event {
    /// Short one-line label for the live ticker.
    var tickerSummary: String {
        switch payload {
        case .decision(let d):
            return "decision: \(d.choice)"
        case .subgoalPush(let s):
            return "sub-goal → \(s.goal)"
        case .subgoalPop(let s):
            return "sub-goal done\(s.goal.map { " (\($0))" } ?? "")"
        case .confidence(let c):
            let pct = Int((c.value * 100).rounded())
            return "confidence \(pct)%\(c.note.map { " — \($0)" } ?? "")"
        case .toolUse(let t):
            return "tool: \(t.tool)\(t.summary.map { " — \($0)" } ?? "")"
        case .blocked(let b):
            return "BLOCKED: \(b.reason)"
        case .memoryUpdate(let m):
            return "memory ↦ \(m.section)"
        case .sessionStart:
            return "session start"
        case .sessionEnd:
            return "session end"
        case .interventionDelivered(let i):
            return "intervention delivered (\(i.kind))"
        }
    }
}
