import SwiftUI

/// Resona pastel theme for Dispatch.
///
/// Ported from the EEG-Nao "Resona" design system. Keeps the entire app on a
/// single token surface so the cottagecore vibe stays consistent across the
/// Radar, Trace, sheets, and settings. Add a token only when ≥2 views will
/// use it — local one-offs should call the palette directly.
enum Resona {

    // MARK: Palette — pastel washes from the EEG-Nao brand sheet.

    enum Palette {
        // Backgrounds — page / card / surface / divider tokens.
        static let cream      = Color(hex: 0xFDF8F2) // page bg
        static let parchment  = Color(hex: 0xFFFFFF) // card bg
        static let mist       = Color(hex: 0xF5F0E8) // soft surface
        static let stone      = Color(hex: 0xE5E0D8) // dividers
        static let border     = Color(hex: 0xEDE8DF)

        // Brand — design-system swatches.
        static let lavender   = Color(hex: 0xC4B5F4)
        static let coral      = Color(hex: 0xF4846A)
        static let apricot    = Color(hex: 0xF9B98A)
        static let butter     = Color(hex: 0xF9E07A)
        static let sky        = Color(hex: 0x93C5FD)
        static let mint       = Color(hex: 0x6EE7B7)
        static let teal       = Color(hex: 0x2DD4BF)

        // Aliases kept so call sites stay terse.
        static let peach      = apricot
        static let lilac      = Color(hex: 0xE0D4F8)
        static let blush      = Color(hex: 0xFCE7F3)

        // Ink — high contrast for legibility on pastel surfaces.
        static let ink        = Color(hex: 0x1E1B2E) // headings
        static let inkSoft    = Color(hex: 0x4A4257) // body
        static let inkFaint   = Color(hex: 0x6B6260) // captions / muted

        // Semantic — status tints.
        static let success    = Color(hex: 0x4A7C59)
        static let warning    = apricot
        static let attention  = coral
        static let info       = lavender
    }

    // MARK: Gradients

    enum Gradients {
        /// Soft cream → lilac → sky wash used as the app-wide background.
        static let appBackground = LinearGradient(
            colors: [Palette.cream, Palette.lilac.opacity(0.35), Palette.sky.opacity(0.25)],
            startPoint: .topLeading, endPoint: .bottomTrailing
        )

        /// Lavender → peach → sky wash for hero areas (Welcome, Updates).
        static let hero = LinearGradient(
            colors: [Palette.lilac.opacity(0.55), Palette.peach.opacity(0.45), Palette.sky.opacity(0.35)],
            startPoint: .topLeading, endPoint: .bottomTrailing
        )

        /// Parchment → cream — soft card surface.
        static let card = LinearGradient(
            colors: [Palette.parchment, Palette.cream],
            startPoint: .top, endPoint: .bottom
        )
    }

    // MARK: Typography — serif display + sans body.

    enum Typography {
        // Playfair Display isn't bundled — `.serif` design falls back to
        // New York on macOS, which matches the design intent.
        static let display1 = Font.system(size: 56, weight: .bold, design: .serif)
        static let display2 = Font.system(size: 40, weight: .bold, design: .serif)
        static let display  = display2
        static let title    = Font.system(size: 28, weight: .semibold, design: .serif)
        static let heading1 = title
        static let heading2 = Font.system(size: 20, weight: .semibold, design: .default)
        static let headline = heading2
        static let body     = Font.system(size: 16, weight: .regular, design: .default)
        static let body2    = Font.system(size: 14, weight: .regular, design: .default)
        static let label    = Font.system(size: 12, weight: .medium, design: .default)
        static let caption  = Font.system(size: 12, weight: .regular, design: .default)
        static let pill     = Font.system(size: 14, weight: .medium, design: .default)

        /// Eyebrow — uppercase tracked label above hero titles.
        static let eyebrow  = Font.system(size: 11, weight: .semibold, design: .default)
    }
}

// MARK: hex Color helper

extension Color {
    /// Construct a Color from a 24-bit RGB integer, e.g. `Color(hex: 0xC4B5F4)`.
    init(hex: UInt32, alpha: Double = 1) {
        let r = Double((hex >> 16) & 0xFF) / 255.0
        let g = Double((hex >> 8)  & 0xFF) / 255.0
        let b = Double( hex        & 0xFF) / 255.0
        self.init(.sRGB, red: r, green: g, blue: b, opacity: alpha)
    }
}

// MARK: Card surface

/// Soft pastel card — used for every tile, panel, and sheet body.
struct ResonaCard: ViewModifier {
    var tint: Color = Resona.Palette.parchment
    var corner: CGFloat = 18
    var padding: CGFloat = 16

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(
                RoundedRectangle(cornerRadius: corner, style: .continuous)
                    .fill(tint)
            )
            .overlay(
                RoundedRectangle(cornerRadius: corner, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.7), lineWidth: 1)
            )
            .shadow(color: Resona.Palette.lavender.opacity(0.18), radius: 12, x: 0, y: 6)
    }
}

extension View {
    /// Wrap in a Resona soft-pastel card with the given tint.
    func resonaCard(tint: Color = Resona.Palette.parchment,
                    corner: CGFloat = 18,
                    padding: CGFloat = 16) -> some View {
        modifier(ResonaCard(tint: tint, corner: corner, padding: padding))
    }
}

// MARK: Pill / chip

/// Pastel pill — used for tab strips, chips, and inline status badges.
struct ResonaPill: ViewModifier {
    var active: Bool = false
    var tint: Color = Resona.Palette.lavender

    func body(content: Content) -> some View {
        content
            .font(Resona.Typography.pill)
            .foregroundStyle(active ? Resona.Palette.ink : Resona.Palette.inkSoft)
            .padding(.horizontal, 14).padding(.vertical, 7)
            .background(
                Capsule().fill(active ? tint.opacity(0.55) : Color.white.opacity(0.6))
            )
            .overlay(
                Capsule().strokeBorder(active ? tint : Color.white.opacity(0.8), lineWidth: 1)
            )
    }
}

extension View {
    func resonaPill(active: Bool = false, tint: Color = Resona.Palette.lavender) -> some View {
        modifier(ResonaPill(active: active, tint: tint))
    }
}

// MARK: App background

/// Apply the Resona cream/lilac/sky gradient as the root background. Used by
/// the top-level shell once, so every view inherits it without restating.
struct ResonaBackground: ViewModifier {
    func body(content: Content) -> some View {
        content
            .background(Resona.Gradients.appBackground.ignoresSafeArea())
    }
}

extension View {
    func resonaBackground() -> some View {
        modifier(ResonaBackground())
    }
}

// MARK: Eyebrow label

/// Tiny uppercase tracked caption used above titles and section breaks.
struct ResonaEyebrow: View {
    let text: String
    var tint: Color = Resona.Palette.inkFaint
    var body: some View {
        Text(text.uppercased())
            .font(Resona.Typography.eyebrow)
            .tracking(0.8)
            .foregroundStyle(tint)
    }
}

// MARK: Status tints from app semantics

/// Map a Dispatch workstream / event status to a Resona palette colour.
/// Keeps the swap from "native green/orange/grey" to "Resona pastel" in
/// one place.
enum ResonaStatusTint {
    static func forWorkstreamStatus(_ raw: String) -> Color {
        switch raw {
        case "active":  return Resona.Palette.mint
        case "paused":  return Resona.Palette.butter
        case "backlog": return Resona.Palette.lavender
        case "retired": return Resona.Palette.stone
        default:        return Resona.Palette.lilac
        }
    }
}
