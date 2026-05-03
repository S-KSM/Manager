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
/// Two convenience initializers:
/// - `RobotMascot(state: .working)` — explicit state.
/// - `RobotMascot(workstream: ws)`  — derives state from the workstream's
///                                    `needs_attention`, `status`,
///                                    `last_event_at` projection.

enum RobotState {
    case working
    case thinking
    case blocked
    case idle
}

struct RobotMascot: View {
    let state: RobotState
    var size: CGFloat = 64
    /// Tint accent for the antenna bulb / eyes / arm-tips.
    var accent: Color = .accentColor

    init(state: RobotState, size: CGFloat = 64, accent: Color = .accentColor) {
        self.state = state
        self.size = size
        self.accent = accent
    }

    init(workstream: Workstream, size: CGFloat = 64) {
        self.state = Self.deriveState(workstream)
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
            RobotShapes(state: state, size: size, accent: accent, t: t)
                .frame(width: size, height: size * 1.15)
        }
        .accessibilityLabel(accessibilityLabel)
    }

    private var accessibilityLabel: String {
        switch state {
        case .working:  return "Robot mascot — working"
        case .thinking: return "Robot mascot — thinking"
        case .blocked:  return "Robot mascot — blocked, needs attention"
        case .idle:     return "Robot mascot — idle"
        }
    }
}

// MARK: - Drawing

private struct RobotShapes: View {
    let state: RobotState
    let size: CGFloat
    let accent: Color
    let t: TimeInterval

    var body: some View {
        let unit = size / 64

        // Cycle helpers
        let armPhase = sin(t * 4)               // -1 … 1, fast for working
        let blink = (sin(t * 3) + 1) / 2        // 0 … 1
        let breathe = (sin(t * 1.4) + 1) / 2    // 0 … 1, slow
        let shakeOffset = sin(t * 18) * 1.4     // for blocked
        let zRise = (t.truncatingRemainder(dividingBy: 2.6)) / 2.6  // 0 → 1

        ZStack {
            // ─── Above-head badge / floating glyph ─────────────────────────
            Group {
                switch state {
                case .blocked:
                    Text("!")
                        .font(.system(size: 18 * unit, weight: .black, design: .rounded))
                        .foregroundStyle(.orange)
                        .offset(y: -size * 0.55 + sin(t * 6) * 2 * unit)
                case .idle:
                    Text("z")
                        .font(.system(size: 14 * unit, weight: .semibold, design: .rounded))
                        .foregroundStyle(.secondary)
                        .opacity(1 - zRise)
                        .offset(x: 14 * unit, y: -size * 0.55 - CGFloat(zRise) * 18 * unit)
                case .thinking:
                    Text("?")
                        .font(.system(size: 12 * unit, weight: .bold, design: .rounded))
                        .foregroundStyle(.secondary)
                        .opacity(0.4 + 0.6 * breathe)
                        .offset(x: 14 * unit, y: -size * 0.5)
                default:
                    EmptyView()
                }
            }

            // ─── Antenna ───────────────────────────────────────────────────
            VStack(spacing: 0) {
                Circle()
                    .fill(antennaColor(blink: blink, breathe: breathe))
                    .frame(width: 8 * unit, height: 8 * unit)
                    .shadow(color: accent.opacity(state == .working ? 0.9 : 0.0),
                            radius: 4 * unit)
                Rectangle()
                    .fill(Color.gray.opacity(0.55))
                    .frame(width: 2 * unit, height: 8 * unit)
                Spacer()
            }
            .frame(height: size)

            // ─── Body group (head + torso + arms) ──────────────────────────
            VStack(spacing: 2 * unit) {
                // Head
                ZStack {
                    RoundedRectangle(cornerRadius: 8 * unit, style: .continuous)
                        .fill(Color(nsColor: .controlBackgroundColor))
                        .overlay(
                            RoundedRectangle(cornerRadius: 8 * unit, style: .continuous)
                                .stroke(Color.gray.opacity(0.5), lineWidth: 1)
                        )
                        .frame(width: 36 * unit, height: 28 * unit)
                    HStack(spacing: 8 * unit) {
                        Eye(state: state, blink: blink, accent: accent, unit: unit)
                        Eye(state: state, blink: blink, accent: accent, unit: unit)
                    }
                    // Mouth — small line, smiles a bit when working
                    Capsule()
                        .fill(Color.gray.opacity(0.7))
                        .frame(width: 10 * unit, height: 2 * unit)
                        .offset(y: 8 * unit)
                        .rotationEffect(.degrees(state == .working ? 3 + Double(armPhase) * 2 : 0))
                }

                // Torso + arms
                ZStack {
                    // Arms (rotated rects)
                    Arm(side: .left,  state: state, phase: armPhase, accent: accent, unit: unit)
                        .offset(x: -22 * unit, y: -2 * unit)
                    Arm(side: .right, state: state, phase: -armPhase, accent: accent, unit: unit)
                        .offset(x: 22 * unit, y: -2 * unit)
                    // Torso
                    RoundedRectangle(cornerRadius: 6 * unit, style: .continuous)
                        .fill(Color(nsColor: .controlBackgroundColor))
                        .overlay(
                            RoundedRectangle(cornerRadius: 6 * unit, style: .continuous)
                                .stroke(Color.gray.opacity(0.5), lineWidth: 1)
                        )
                        .frame(width: 28 * unit, height: 22 * unit)
                    // Chest light
                    Circle()
                        .fill(accent.opacity(0.4 + 0.6 * breathe))
                        .frame(width: 6 * unit, height: 6 * unit)
                }

                // Tiny feet
                HStack(spacing: 6 * unit) {
                    Capsule().fill(Color.gray.opacity(0.55))
                        .frame(width: 8 * unit, height: 4 * unit)
                    Capsule().fill(Color.gray.opacity(0.55))
                        .frame(width: 8 * unit, height: 4 * unit)
                }
            }
            .offset(x: state == .blocked ? CGFloat(shakeOffset) * unit : 0)
        }
    }

    private func antennaColor(blink: Double, breathe: Double) -> Color {
        switch state {
        case .working:  return accent.opacity(0.5 + 0.5 * blink)
        case .thinking: return accent.opacity(0.35 + 0.35 * breathe)
        case .blocked:  return .orange
        case .idle:     return Color.gray.opacity(0.4)
        }
    }
}

// MARK: - Eye

private struct Eye: View {
    let state: RobotState
    let blink: Double
    let accent: Color
    let unit: CGFloat

    var body: some View {
        Group {
            switch state {
            case .idle:
                // Closed (line)
                Capsule()
                    .fill(Color.gray.opacity(0.7))
                    .frame(width: 8 * unit, height: 2 * unit)
            case .blocked:
                // Wide, alarmed
                Circle()
                    .fill(.orange)
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

// MARK: - Arm

private struct Arm: View {
    enum Side { case left, right }
    let side: Side
    let state: RobotState
    let phase: Double  // -1 … 1
    let accent: Color
    let unit: CGFloat

    var body: some View {
        let angle: Double = {
            switch state {
            case .working:  return phase * 35    // big swings
            case .thinking: return phase * 8     // gentle sway
            case .blocked:  return -25           // arms up in alarm
            case .idle:     return 0
            }
        }()
        let restAngle: Double = side == .left ? 20 : -20

        return Capsule()
            .fill(Color.gray.opacity(0.6))
            .frame(width: 5 * unit, height: 18 * unit)
            .overlay(
                Circle()
                    .fill(accent.opacity(state == .working ? 0.85 : 0.4))
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

#Preview("RobotMascot — small (card size)") {
    HStack(spacing: 16) {
        RobotMascot(state: .working,  size: 32)
        RobotMascot(state: .thinking, size: 32)
        RobotMascot(state: .blocked,  size: 32)
        RobotMascot(state: .idle,     size: 32)
    }
    .padding(20)
}
