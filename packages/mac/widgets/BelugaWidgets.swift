// Beluga's desktop widgets (BLG-309): one board tile per widget, small, medium or large.
// Beluga's daemon writes ~/.beluga/widgets/tiles.json (src/core/sentinel/widgets.ts), already in
// words; this only reads it and draws. Built with plain swiftc by scripts/build-widgets.mjs.
import AppIntents
import Charts
import Foundation
import SwiftUI
import WidgetKit

// MARK: - The snapshot

struct Tile: Codable, Identifiable, Hashable {
    let id: String
    let board: String
    let title: String
    let kind: String          // number | chart | text
    let value: String?
    let change: String?
    let tone: String          // good | bad | none
    let vs: String?
    let points: [Double]?
    let from: String?
    let to: String?
    let text: String?
    let note: String?
    let project: String?
    let icon: String?
    let tint: String?
    let url: String
    let at: Double?
}

struct Snapshot: Codable {
    let version: Int
    let tiles: [Tile]
}

enum Store {
    /// The real home (inside the sandbox, NSHomeDirectory() is the extension's container).
    static let dir: URL = {
        let home = getpwuid(getuid()).map { String(cString: $0.pointee.pw_dir) } ?? NSHomeDirectory()
        return URL(fileURLWithPath: home).appendingPathComponent(".beluga/widgets", isDirectory: true)
    }()

    static func read() -> Snapshot? {
        guard let data = try? Data(contentsOf: dir.appendingPathComponent("tiles.json")) else { return nil }
        return try? JSONDecoder().decode(Snapshot.self, from: data)
    }

    static func image(_ rel: String?) -> NSImage? {
        guard let rel, !rel.contains("..") else { return nil }
        return NSImage(contentsOf: dir.appendingPathComponent(rel))
    }
}

// MARK: - Picking a tile (the widget's Edit menu)

/// The tile is kept as its id, a plain string, never an AppEntity: macOS hands a picked entity back
/// only if it finds the entity's type registered, which it doesn't for this swiftc-built extension
/// ("not a registered AppEntity identifier"). Each widget then got no tile and drew the first one,
/// whatever was picked (BLG-371). A string comes back as it was saved.
struct TileOptions: DynamicOptionsProvider {
    func results() async throws -> IntentItemCollection<String> {
        let tiles = Store.read()?.tiles ?? []
        let boards = tiles.reduce(into: [String]()) { if !$0.contains($1.board) { $0.append($1.board) } }
        return IntentItemCollection(sections: boards.map { board in
            IntentItemSection("\(board)", items: tiles.filter { $0.board == board }.map { t in
                IntentItem(t.id, title: "\(t.title)", subtitle: t.project.map { "\($0)" })
            })
        })
    }
}

struct PickTile: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Choose a Tile"
    static var description = IntentDescription("Which tile of your Beluga boards this widget shows.")
    @Parameter(title: "Tile", optionsProvider: TileOptions()) var tile: String?
}

// MARK: - Timeline

struct Entry: TimelineEntry {
    let date: Date
    let tile: Tile?
    let empty: Bool
}

struct Provider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> Entry {
        Entry(date: .now, tile: Tile(id: "-", board: "Overview", title: "Revenue", kind: "number", value: "$3,412", change: "+$232 (+7.3%)", tone: "good", vs: "vs the run before",
                                     points: [3020, 3110, 3060, 3200, 3150, 3290, 3412], from: nil, to: nil, text: nil, note: nil, project: "Beluga", icon: nil, tint: "#5b8def", url: "beluga://", at: nil),
              empty: false)
    }
    func snapshot(for configuration: PickTile, in context: Context) async -> Entry { entry(configuration) }
    func timeline(for configuration: PickTile, in context: Context) async -> Timeline<Entry> {
        // Beluga asks for a redraw as soon as a tile changes; this is only the fallback.
        Timeline(entries: [entry(configuration)], policy: .after(.now.addingTimeInterval(30 * 60)))
    }
    private func entry(_ c: PickTile) -> Entry {
        let s = Store.read()
        let tile = s?.tiles.first { $0.id == c.tile } ?? s?.tiles.first
        return Entry(date: .now, tile: tile, empty: s == nil || s?.tiles.isEmpty == true)
    }
}

// MARK: - Look

extension Color {
    init(hex: String?, fallback: Color) {
        guard let hex, hex.count == 7, let v = Int(hex.dropFirst(), radix: 16) else { self = fallback; return }
        self = Color(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }
}

/// Soft colours, as Beluga draws them: a change that's good in mint, a bad one in rose.
enum Tone {
    static let good = Color(red: 0.18, green: 0.54, blue: 0.30)
    static let bad = Color(red: 0.77, green: 0.21, blue: 0.18)
    static func of(_ tone: String) -> Color { tone == "good" ? good : tone == "bad" ? bad : .secondary }
}

/// The project's logo (its icon, or its first letter on its tint), top left like the board's tiles.
struct Mark: View {
    let tile: Tile
    var size: CGFloat = 16
    var body: some View {
        let tint = Color(hex: tile.tint, fallback: .accentColor)
        if let img = Store.image(tile.icon) {
            Image(nsImage: img).resizable().interpolation(.high).frame(width: size, height: size)
                .clipShape(RoundedRectangle(cornerRadius: size * 0.24, style: .continuous))
        } else if let p = tile.project, let ch = p.first {
            Text(String(ch).uppercased()).font(.system(size: size * 0.58, weight: .semibold, design: .rounded))
                .foregroundStyle(tint).frame(width: size, height: size)
                .background(tint.opacity(0.16), in: RoundedRectangle(cornerRadius: size * 0.24, style: .continuous))
        } else {
            Image(systemName: "laptopcomputer").font(.system(size: size * 0.7)).foregroundStyle(.secondary).frame(width: size, height: size)
        }
    }
}

struct Head: View {
    let tile: Tile
    var body: some View {
        HStack(spacing: 6) {
            Mark(tile: tile)
            Text(tile.title).font(.system(size: 12, weight: .semibold)).lineLimit(1)
            Spacer(minLength: 4)
            if let note = tile.note {
                Text(note).font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(.quaternary.opacity(0.6), in: Capsule())
                    .lineLimit(1)
            }
        }
    }
}

struct ChangePill: View {
    let tile: Tile
    var body: some View {
        if let change = tile.change {
            let c = Tone.of(tile.tone)
            Text(change).font(.system(size: 11, weight: .semibold, design: .rounded)).foregroundStyle(c)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(c.opacity(0.12), in: Capsule())
                .lineLimit(1).minimumScaleFactor(0.8)
        }
    }
}

/// The points as a soft area with its line, in the tile's tint (no axes: the widget's room is small).
struct Area: View {
    let points: [Double]
    let tint: Color
    var axes = false
    var body: some View {
        let lo = points.min() ?? 0, hi = points.max() ?? 1
        let pad = max((hi - lo) * 0.12, 0.0001)
        Chart(Array(points.enumerated()), id: \.offset) { i, v in
            AreaMark(x: .value("i", i), yStart: .value("lo", lo - pad), yEnd: .value("v", v))
                .foregroundStyle(tint.opacity(0.14)).interpolationMethod(.monotone)
            LineMark(x: .value("i", i), y: .value("v", v))
                .foregroundStyle(tint).lineStyle(StrokeStyle(lineWidth: 1.8, lineCap: .round, lineJoin: .round)).interpolationMethod(.monotone)
        }
        .chartXAxis(.hidden)
        .chartYAxis(axes ? .automatic : .hidden)
        .chartYScale(domain: (lo - pad)...(hi + pad))
        .chartLegend(.hidden)
    }
}

struct Updated: View {
    let at: Double?
    var body: some View {
        if let at {
            Text(Date(timeIntervalSince1970: at / 1000), style: .relative).font(.system(size: 10)).foregroundStyle(.tertiary) + Text(" ago").font(.system(size: 10)).foregroundStyle(.tertiary)
        }
    }
}

struct Value: View {
    let tile: Tile
    let size: CGFloat
    var body: some View {
        Text(tile.value ?? "—").font(.system(size: size, weight: .semibold, design: .rounded))
            .monospacedDigit().lineLimit(1).minimumScaleFactor(0.5)
            .contentTransition(.numericText())
    }
}

struct TileView: View {
    @Environment(\.widgetFamily) var family
    let tile: Tile
    var body: some View {
        let tint = Color(hex: tile.tint, fallback: .accentColor)
        let pts = tile.points ?? []
        VStack(alignment: .leading, spacing: 6) {
            Head(tile: tile)
            switch tile.kind {
            case "text":
                if let v = tile.value { Text(v).font(.system(size: 12, weight: .medium)).foregroundStyle(.secondary) }
                Text(tile.text ?? "Nothing yet: it shows after its sentinel runs.")
                    .font(.system(size: family == .systemSmall ? 12 : 13))
                    .foregroundStyle(tile.text == nil ? .secondary : .primary)
                    .lineLimit(family == .systemLarge ? 18 : family == .systemMedium ? 6 : 5)
                Spacer(minLength: 0)
                Updated(at: tile.at)
            default:
                if family == .systemMedium && pts.count > 1 {
                    // Wide: the number on the left, its points beside it.
                    HStack(alignment: .bottom, spacing: 12) {
                        VStack(alignment: .leading, spacing: 5) {
                            Spacer(minLength: 0)
                            Value(tile: tile, size: 30)
                            ChangePill(tile: tile)
                            Text(tile.vs ?? tile.board).font(.system(size: 10)).foregroundStyle(.tertiary).lineLimit(1)
                        }
                        .frame(maxWidth: 150, alignment: .leading)
                        Area(points: pts, tint: tint)
                    }
                } else {
                    Value(tile: tile, size: family == .systemLarge ? 44 : 30)
                    HStack(spacing: 6) {
                        ChangePill(tile: tile)
                        if family != .systemSmall, let vs = tile.vs { Text(vs).font(.system(size: 10)).foregroundStyle(.tertiary).lineLimit(1) }
                    }
                    if pts.count > 1 {
                        Area(points: pts, tint: tint, axes: family == .systemLarge).frame(maxHeight: .infinity)
                        if family == .systemLarge, let from = tile.from, let to = tile.to {
                            HStack { Text(from); Spacer(); Text(to) }.font(.system(size: 10)).foregroundStyle(.tertiary)
                        }
                    } else {
                        Spacer(minLength: 0)
                    }
                    if family == .systemLarge { Updated(at: tile.at) }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

struct EmptyView2: View {
    let empty: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Image(systemName: "shield.lefthalf.filled").font(.system(size: 18)).foregroundStyle(.secondary)
            Text(empty ? "No tiles yet" : "Choose a tile").font(.system(size: 13, weight: .semibold))
            Text(empty ? "Put a number on a board in Beluga › Sentinel, then pick it here." : "Right-click › Edit Widget to pick one of your board's tiles.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

struct TileWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "tile", intent: PickTile.self, provider: Provider()) { entry in
            Group {
                if let tile = entry.tile { TileView(tile: tile) } else { EmptyView2(empty: entry.empty) }
            }
            .containerBackground(for: .widget) {
                // A soft wash of the project's colour over the window's own (like the board's tiles); no glow.
                ZStack {
                    Color(nsColor: .windowBackgroundColor)
                    Color(hex: entry.tile?.tint, fallback: .clear).opacity(0.07)
                }
            }
            .widgetURL(URL(string: entry.tile?.url ?? "beluga://sentinel"))
        }
        .configurationDisplayName("Board tile")
        .description("A number, a chart or what a sentinel said, from your Beluga boards.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

@main
struct BelugaWidgets: WidgetBundle {
    var body: some Widget { TileWidget() }
}
