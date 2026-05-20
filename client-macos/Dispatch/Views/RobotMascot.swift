import SwiftUI

/// Funky little robot mascot rendered with pure SwiftUI shapes (no assets).
///
/// Drives one of four states derived from the workstream's projection fields:
/// - `.working` — arms swing, antenna blinks. Use for active sessions.
/// - `.thinking` — eyes pulse, antenna gently glows. Use for idle-but-recent.
/// - `.blocked` — robot shakes, exclamation mark above head. Use when the
///                workstream's `needs_attention` projection is true.
/// - `.idle`    — eyes closed, "z" floats up. Use for paused / retired or
///                long-quiet workstreams.
///
/// Independent of the `state`, the mascot has an awake/asleep `presence`
/// flag — when asleep, the robot dims, eyes close, and a stacked "Zzz"
/// floats above. Asleep is set when the workstream's Claude Code session
/// has ended (no `liveSession` on the wire); the lifecycle status is
/// reflected separately by the "Active / Paused / Retired" pill.
///
/// Two convenience initializers:
/// - `RobotMascot(state: .working)` — explicit state.
/// - `RobotMascot(workstream: ws)`  — derives state and presence from the
///                                    workstream's `needs_attention`,
///                                    `status`, `last_event_at`,
///                                    `liveSession` fields.

enum RobotState {
    case working
    case thinking
    case blocked
    case idle
}

/// Awake / asleep — independent of the four animation states above.
/// Asleep robots get dimmed, closed-eyes treatment plus a floating "Zzz",
/// regardless of their underlying activity state.
enum RobotPresence {
    case awake
    case asleep
}

struct RobotMascot: View {
    let state: RobotState
    let presence: RobotPresence
    var size: CGFloat = 64
    /// Tint accent for the antenna bulb / eyes / arm-tips.
    var accent: Color = .accentColor

    init(
        state: RobotState,
        presence: RobotPresence = .awake,
        size: CGFloat = 64,
        accent: Color = .accentColor
    ) {
        self.state = state
        self.presence = presence
        self.size = size
        self.accent = accent
    }

    init(workstream: Workstream, size: CGFloat = 64) {
        self.state = Self.deriveState(workstream)
        self.presence = workstream.liveSession ? .awake : .asleep
        self.size = size
        self.accent = workstream.statusColor
    }

    private static func deriveState(_ ws: Workstream) -> RobotState {
        if ws.needsAttention { return .blocked }
        if ws.status == .paused || ws.status == .retired { return .idle }
        if let last = ws.lastEventAt {
            let secs = Date().timeIntervalSince(last)
            if secs < 300 { return .working }      // 5 min
            if secs < 1800 { return .thinking }    // 30 min
        }
        return .idle
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            RobotShapes(state: state, presence: presence, size: size, accent: accent, t: t)
                .frame(width: size, height: size * 1.15)
        }
        .accessibilityLabel(accessibilityLabel)
        .help(helpText)
    }

    private var accessibilityLabel: String {
        let stateLabel: String = {
            switch state {
            case .working:  return "working"
            case .thinking: return "thinking"
            case .blocked:  return "blocked, needs attention"
            case .idle:     return "idle"
            }
        }()
        let presenceLabel = presence == .asleep ? " (session ended)" : ""
        return "Robot mascot — \(stateLabel)\(presenceLabel)"
    }

    private var helpText: String {
        presence == .asleep
            ? "No live Claude Code session. Start one to wake the robot up."
            : "Live Claude Code session"
    }
}

// MARK: - Drawing

private struct RobotShapes: View {
    let state: RobotState
    let presence: RobotPresence
    let size: CGFloat
    let accent: Color
    let t: TimeInterval

    private var isAsleep: Bool { presence == .asleep }

    var body: some View {
        let unit = size / 64

        // Cycle helpers — when asleep, suppress fast animations so the robot
        // looks dormant rather than mid-motion-with-eyes-shut.
        let armPhase = isAsleep ? 0 : sin(t * 4)
        let blink = isAsleep ? 0.0 : (sin(t * 3) + 1) / 2
        let breathe = isAsleep ? 0.2 : (sin(t * 1.4) + 1) / 2
        let shakeOffset = isAsleep ? 0 : sin(t * 18) * 1.4

        ZStack {
            // ─── Above-head badge / floating glyph ─────────────────────────
            // When asleep the stacked Zzz wins regardless of state, since
            // "session ended" is the louder signal than "working".
            Group {
                if isAsleep {
                    SleepingZees(unit: unit, size: size, t: t)
                } else {
                    awakeBadge(unit: unit)
                }
            }

            // ─── Antenna ───────────────────────────────────────────────────
            VStack(spacing: 0) {
                Circle()
                    .fill(antennaColor(blink: blink, breathe: breathe))
                    .frame(width: 8 * unit, height: 8 * unit)
                    .shadow(color: accent.opacity(state == .working && !isAsleep ? 0.9 : 0.0),
                            radius: 4 * unit)
                Rectangle()
                    .fill(Resona.Palette.stone.opacity(0.85))
                    .frame(width: 2 * unit, height: 8 * unit)
                Spacer()
            }
            .frame(height: size)

            // ─── Body group (head + torso + arms) ──────────────────────────
            VStack(spacing: 2 * unit) {
                // Head
                ZStack {
                    RoundedRectangle(cornerRadius: 8 * unit, style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: [Resona.Palette.parchment, Resona.Palette.cream],
                                startPoint: .top, endPoint: .bottom
                            )
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 8 * unit, style: .continuous)
                                .stroke(accent.opacity(0.45), lineWidth: 1.2)
                        )
                        .shadow(color: accent.opacity(0.25), radius: 4 * unit, x: 0, y: 1.5 * unit)
                        .frame(width: 36 * unit, height: 28 * unit)
                    HStack(spacing: 8 * unit) {
                        Eye(state: state, presence: presence, blink: blink, accent: accent, unit: unit)
                        Eye(state: state, presence: presence, blink: blink, accent: accent, unit: unit)
                    }
                    // Mouth — small line, smiles a bit when working;
                    // sleeping faces get a flat neutral mouth.
                    Capsule()
                        .fill(Resona.Palette.ink.opacity(0.75))
                        .frame(width: 10 * unit, height: 2 * unit)
                        .offset(y: 8 * unit)
                        .rotationEffect(.degrees(
                            (state == .working && !isAsleep) ? 3 + Double(armPhase) * 2 : 0
                        ))
                }

                // Torso + arms
                ZStack {
                    // Arms (rotated rects)
                    Arm(side: .left,  state: state, presence: presence, phase: armPhase, accent: accent, unit: unit)
                        .offset(x: -22 * unit, y: -2 * unit)
                    Arm(side: .right, state: state, presence: presence, phase: -armPhase, accent: accent, unit: unit)
                        .offset(x: 22 * unit, y: -2 * unit)
                    // Torso
                    RoundedRectangle(cornerRadius: 6 * unit, style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: [Resona.Palette.parchment, Resona.Palette.mist],
                                startPoint: .top, endPoint: .bottom
                            )
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 6 * unit, style: .continuous)
                                .stroke(accent.opacity(0.40), lineWidth: 1.1)
                        )
                        .frame(width: 28 * unit, height: 22 * unit)
                    // Chest light — dim and steady when asleep
                    Circle()
                        .fill(accent.opacity(isAsleep ? 0.15 : 0.4 + 0.6 * breathe))
                        .frame(width: 6 * unit, height: 6 * unit)
                }

                // Tiny feet
                HStack(spacing: 6 * unit) {
                    Capsule().fill(Resona.Palette.lavender.opacity(0.6))
                        .frame(width: 8 * unit, height: 4 * unit)
                    Capsule().fill(Resona.Palette.lavender.opacity(0.6))
                        .frame(width: 8 * unit, height: 4 * unit)
                }
            }
            .offset(x: state == .blocked && !isAsleep ? CGFloat(shakeOffset) * unit : 0)
        }
        // Whole-mascot dimming + slight desaturation makes the asleep state
        // read as "off" without losing the silhouette.
        .opacity(isAsleep ? 0.5 : 1.0)
        .saturation(isAsleep ? 0.4 : 1.0)
    }

    @ViewBuilder
    private func awakeBadge(unit: CGFloat) -> some View {
        let breathe = (sin(t * 1.4) + 1) / 2
        switch state {
        case .blocked:
            Text("!")
                .font(.system(size: 18 * unit, weight: .black, design: .rounded))
                .foregroundStyle(Resona.Palette.coral)
                .offset(y: -size * 0.55 + sin(t * 6) * 2 * unit)
        case .idle:
            let zRise = (t.truncatingRemainder(dividingBy: 2.6)) / 2.6
            Text("z")
                .font(.system(size: 14 * unit, weight: .semibold, design: .rounded))
                .foregroundStyle(Resona.Palette.lavender)
                .opacity(1 - zRise)
                .offset(x: 14 * unit, y: -size * 0.55 - CGFloat(zRise) * 18 * unit)
        case .thinking:
            Text("?")
                .font(.system(size: 12 * unit, weight: .bold, design: .rounded))
                .foregroundStyle(Resona.Palette.lavender)
                .opacity(0.4 + 0.6 * breathe)
                .offset(x: 14 * unit, y: -size * 0.5)
        case .working:
            EmptyView()
        }
    }

    private func antennaColor(blink: Double, breathe: Double) -> Color {
        if isAsleep { return Resona.Palette.stone.opacity(0.45) }
        switch state {
        case .working:  return accent.opacity(0.5 + 0.5 * blink)
        case .thinking: return accent.opacity(0.35 + 0.35 * breathe)
        case .blocked:  return Resona.Palette.coral
        case .idle:     return Resona.Palette.lavender.opacity(0.6)
        }
    }
}

// MARK: - Sleeping Zees

/// Three stacked Z's of decreasing size with a slight rotation, gently rising
/// and fading. Sits top-right of the mascot bubble. Different from the
/// `.idle` state's single floating "z" — this is a louder, unmistakeable
/// "session ended" indicator.
private struct SleepingZees: View {
    let unit: CGFloat
    let size: CGFloat
    let t: TimeInterval

    var body: some View {
        // Single rising/fading cycle, ~3.2s long.
        let cycle = (t.truncatingRemainder(dividingBy: 3.2)) / 3.2
        ZStack(alignment: .bottomLeading) {
            zee(scale: 1.0,  index: 0, cycle: cycle)
            zee(scale: 0.78, index: 1, cycle: cycle)
            zee(scale: 0.58, index: 2, cycle: cycle)
        }
        .offset(x: 16 * unit, y: -size * 0.55)
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private func zee(scale: CGFloat, index: Int, cycle: Double) -> some View {
        // Stagger each Z a little — bigger one rises first, smaller ones lag.
        let phase = max(0, min(1, cycle - 0.12 * Double(index)))
        let dx = 9 * scale * unit + CGFloat(index) * 5 * unit
        let dy = -CGFloat(index) * 9 * unit - CGFloat(phase) * 14 * unit
        Text("Z")
            .font(.system(size: 13 * unit * scale, weight: .heavy, design: .rounded))
            .foregroundStyle(Resona.Palette.lavender)
            .opacity(0.85 * (1 - phase))
            .rotationEffect(.degrees(-12 + Double(index) * 4))
            .offset(x: dx, y: dy)
    }
}

// MARK: - Eye

private struct Eye: View {
    let state: RobotState
    let presence: RobotPresence
    let blink: Double
    let accent: Color
    let unit: CGFloat

    var body: some View {
        Group {
            // Asleep always wins — closed-eye sleep arc regardless of state.
            if presence == .asleep {
                // Curved, downward arc — asleep face, distinct from .idle's
                // simple horizontal line.
                Path { p in
                    p.move(to: CGPoint(x: 0, y: 1 * unit))
                    p.addQuadCurve(
                        to: CGPoint(x: 8 * unit, y: 1 * unit),
                        control: CGPoint(x: 4 * unit, y: 4 * unit)
                    )
                }
                .stroke(Resona.Palette.ink.opacity(0.75),
                        style: StrokeStyle(lineWidth: 1.4, lineCap: .round))
                .frame(width: 8 * unit, height: 4 * unit)
            } else {
                switch state {
                case .idle:
                    // Closed (line)
                    Capsule()
                        .fill(Resona.Palette.ink.opacity(0.7))
                        .frame(width: 8 * unit, height: 2 * unit)
                case .blocked:
                    // Wide, alarmed
                    Circle()
                        .fill(Resona.Palette.coral)
                        .frame(width: 8 * unit, height: 8 * unit)
                default:
                    // Working / thinking — pupil that blinks (heightens occasionally)
                    let blinkFactor = blink < 0.05 ? 0.2 : 1.0
                    Circle()
                        .fill(accent)
                        .frame(width: 7 * unit, height: 7 * unit * blinkFactor)
                }
            }
        }
    }
}

// MARK: - Arm

private struct Arm: View {
    enum Side { case left, right }
    let side: Side
    let state: RobotState
    let presence: RobotPresence
    let phase: Double  // -1 … 1
    let accent: Color
    let unit: CGFloat

    var body: some View {
        let angle: Double = {
            // Asleep arms hang at rest, no matter the underlying state.
            if presence == .asleep { return 0 }
            switch state {
            case .working:  return phase * 35    // big swings
            case .thinking: return phase * 8     // gentle sway
            case .blocked:  return -25           // arms up in alarm
            case .idle:     return 0
            }
        }()
        let restAngle: Double = side == .left ? 20 : -20
        let isAsleep = presence == .asleep

        return Capsule()
            .fill(Resona.Palette.lavender.opacity(0.55))
            .frame(width: 5 * unit, height: 18 * unit)
            .overlay(
                Circle()
                    .fill(accent.opacity(isAsleep ? 0.2 : (state == .working ? 0.85 : 0.4)))
                    .frame(width: 5 * unit, height: 5 * unit)
                    .offset(y: 8 * unit)
            )
            .rotationEffect(.degrees(restAngle + angle), anchor: .top)
    }
}

// MARK: - Previews

#Preview("RobotMascot — all states") {
    HStack(spacing: 24) {
        VStack { RobotMascot(state: .working);  Text("working").font(.caption) }
        VStack { RobotMascot(state: .thinking); Text("thinking").font(.caption) }
        VStack { RobotMascot(state: .blocked);  Text("blocked").font(.caption) }
        VStack { RobotMascot(state: .idle);     Text("idle").font(.caption) }
    }
    .padding(40)
}

#Preview("RobotMascot — asleep variants (Zzz)") {
    HStack(spacing: 24) {
        VStack { RobotMascot(state: .working,  presence: .asleep); Text("working — asleep").font(.caption) }
        VStack { RobotMascot(state: .thinking, presence: .asleep); Text("thinking — asleep").font(.caption) }
        VStack { RobotMascot(state: .blocked,  presence: .asleep); Text("blocked — asleep").font(.caption) }
        VStack { RobotMascot(state: .idle,     presence: .asleep); Text("idle — asleep").font(.caption) }
    }
    .padding(40)
}

#Preview("RobotMascot — small (card size)") {
    HStack(spacing: 16) {
        RobotMascot(state: .working,  size: 32)
        RobotMascot(state: .thinking, size: 32)
        RobotMascot(state: .blocked,  size: 32)
        RobotMascot(state: .idle,     size: 32)
        RobotMascot(state: .working, presence: .asleep, size: 32)
        RobotMascot(state: .idle,    presence: .asleep, size: 32)
    }
    .padding(20)
}
