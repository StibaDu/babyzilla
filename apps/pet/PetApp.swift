// BabyZilla Pet — a 16-bit creature that lives on the bottom of the screen and
// reacts to OpenCode.
//
// Two windows: the pet (borderless, transparent, non-activating so poking it
// never steals focus) and a speech bubble above its head. State comes from
// ~/.opencode/pet/events.jsonl, written by the plugin; this process never
// blocks opencode and works even when it starts late (it replays the tail).
//
// Build: swiftc -swift-version 5 -O PetApp.swift PixelFont.swift -o BabyZillaPet

import AppKit
import Foundation

// ── config ───────────────────────────────────────────────────────────────────

struct PetConfig: Codable {
    var scale: Int = 2
    var x: Double? = nil            // last position, in global screen coords
    var y: Double? = nil
    var chattiness: String = "normal"   // quiet | normal | chatty
    var muted: Bool = false
    var followCursor: Bool = true
    var pack: String? = nil         // nil = the built-in BabyZilla art
    /// Turned off from the menu bar. Persisted so a login start does not undo it.
    var hidden: Bool = false

    enum CodingKeys: String, CodingKey {
        case scale, x, y, chattiness, muted, followCursor, pack, hidden
    }

    /// Decode field by field. The synthesized initializer requires every
    /// non-optional key, so a hand-edited config with only `{"pack": "..."}`
    /// threw, and the loader silently fell back to defaults — losing the pack,
    /// the position and the size all at once.
    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        scale = try c.decodeIfPresent(Int.self, forKey: .scale) ?? 2
        x = try c.decodeIfPresent(Double.self, forKey: .x)
        y = try c.decodeIfPresent(Double.self, forKey: .y)
        chattiness = try c.decodeIfPresent(String.self, forKey: .chattiness) ?? "normal"
        muted = try c.decodeIfPresent(Bool.self, forKey: .muted) ?? false
        followCursor = try c.decodeIfPresent(Bool.self, forKey: .followCursor) ?? true
        pack = try c.decodeIfPresent(String.self, forKey: .pack)
        hidden = try c.decodeIfPresent(Bool.self, forKey: .hidden) ?? false
    }

    static func load(_ url: URL) -> PetConfig {
        guard let data = try? Data(contentsOf: url),
              let cfg = try? JSONDecoder().decode(PetConfig.self, from: data) else { return PetConfig() }
        return cfg
    }

    func save(_ url: URL) {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? enc.encode(self) { try? data.write(to: url) }
    }
}

struct Expression: Codable {
    let id: String
    let label: String
    let cat: String?        // idle | prompt | tools | ... (gallery grouping)
    let motion: String      // bob | pop | shake | float | still
    let lines: [String]
}

struct PetData: Codable {
    let expressions: [Expression]
    let size: Int
    var byId: [String: Expression] = [:]

    enum CodingKeys: String, CodingKey { case expressions, size }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        expressions = try c.decode([Expression].self, forKey: .expressions)
        size = try c.decode(Int.self, forKey: .size)
        byId = Dictionary(uniqueKeysWithValues: expressions.map { ($0.id, $0) })
    }
}

// ── paths ────────────────────────────────────────────────────────────────────

enum Paths {
    static let home = FileManager.default.homeDirectoryForCurrentUser
    static var state: URL {
        if let override = ProcessInfo.processInfo.environment["BABYZILLA_PET_STATE"] {
            return URL(fileURLWithPath: override)
        }
        return home.appendingPathComponent(".opencode/pet")
    }
    static var events: URL { state.appendingPathComponent("events.jsonl") }
    /// The status badge. Written by the plugin (it knows when a turn ended), only
    /// read here — one writer, so the file and the screen cannot disagree.
    static var markFile: URL { state.appendingPathComponent("mark.json") }
    static var config: URL { state.appendingPathComponent("config.json") }
    static var sprites: URL { state.appendingPathComponent("sprites") }
    static var data: URL { state.appendingPathComponent("pet-data.json") }
    static var packs: URL { state.appendingPathComponent("packs") }
    static func packDir(_ name: String) -> URL { packs.appendingPathComponent(name) }

    /// Always returns the *sprites directory* (the one holding the PNGs).
    /// Callers used to get "the assets root" here and append "/sprites" again,
    /// which made an installed pet load zero sprites and draw nothing.
    static func resolveSprites() -> URL {
        let fm = FileManager.default
        if let env = ProcessInfo.processInfo.environment["BABYZILLA_PET_DIR"] {
            let given = URL(fileURLWithPath: env)
            let nested = given.appendingPathComponent("sprites")
            return fm.fileExists(atPath: nested.path) ? nested : given
        }
        if fm.fileExists(atPath: sprites.path) { return sprites }
        // dev: a binary sitting inside the repo, or next to assets/pet
        let exe = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        var dir = exe.deletingLastPathComponent()
        for _ in 0..<7 {
            let candidate = dir.appendingPathComponent("assets/pet/sprites")
            if fm.fileExists(atPath: candidate.path) { return candidate }
            dir = dir.deletingLastPathComponent()
        }
        return sprites
    }
}

// ── sprites ──────────────────────────────────────────────────────────────────

/// Where packs live: the installed state dir, plus the repo/dev location.
enum Packs {
    static func roots() -> [URL] {
        var roots = [Paths.packs]
        if let env = ProcessInfo.processInfo.environment["BABYZILLA_PET_DIR"] {
            roots.append(URL(fileURLWithPath: env).appendingPathComponent("packs"))
        } else {
            // dev: assets/pet/packs next to the sprites directory
            roots.append(Paths.resolveSprites().deletingLastPathComponent().appendingPathComponent("packs"))
        }
        // A packs directory is often a symlink — another disk, a dotfiles repo, a
        // shared pets folder. `contentsOfDirectory` refuses a symlinked root and
        // throws, which is caught upstream and read as "this install has no pets",
        // so the Pet menu came up empty for exactly those users.
        return roots.map { $0.resolvingSymlinksInPath() }
    }

    static func directory(_ name: String) -> URL? {
        for root in roots() {
            let dir = root.appendingPathComponent(name)
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent("pack.json").path) { return dir }
        }
        return nil
    }


    /// Put the pet list in a menu. Always — a fresh install has nothing to switch
    /// to yet, and hiding the submenu behind `count > 1` meant a new user saw no
    /// pet list at all, only the built-in they could not name or change.
    static func installMenu(into menu: NSMenu, target: AnyObject, action: Selector, current: String?) {
        let pets = available()
        let active = current ?? "babyzilla"
        let petItem = NSMenuItem(title: "Pet", action: nil, keyEquivalent: "")
        let sub = NSMenu()
        for pet in pets {
            let item = NSMenuItem(title: pet.label, action: action, keyEquivalent: "")
            item.target = target
            item.representedObject = pet.id
            item.state = active == pet.id ? .on : .off
            sub.addItem(item)
        }
        if pets.count <= 1 {
            sub.addItem(.separator())
            // A disabled line, not a dead menu: says what to do about it.
            let hint = NSMenuItem(title: "No other pets — babyzilla pet catalog", action: nil, keyEquivalent: "")
            hint.isEnabled = false
            sub.addItem(hint)
        }
        petItem.submenu = sub
        menu.addItem(petItem)
    }

    /// Always offers the built-in art first; packs found on disk follow.
    static func available() -> [(id: String, label: String)] {
        var out: [(id: String, label: String)] = [("babyzilla", "BabyZilla")]
        for root in roots() {
            let dirs = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
            for dir in dirs.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
                guard let pack = PackData.load(dir: dir) else { continue }
                if !out.contains(where: { $0.id == pack.name }) { out.append((pack.name, pack.label)) }
            }
        }
        return out
    }
}

/// A pet pack: a different look for the same pet. Packs carry whole animations
/// (idle / walk / jump) instead of one sprite per expression, which is what a
/// hand-drawn or third-party sheet can actually provide.
struct PackData: Decodable {
    let kind: String?
    let name: String
    let label: String
    let size: Int
    let animations: [String: [String]]
    let fps: [String: Double]?
    /// expression id -> animation, so a pack can answer with its own faces
    let expressions: [String: String]?
    let defaultScale: Int?
    let source: String?

    /// Expressions that should use the jump animation rather than idle.
    static let energetic: Set<String> = [
        "celebrate", "party", "dance", "wave", "poke", "love", "ship-it", "success",
        "eureka", "cake", "roar", "glitch", "rubber-duck", "high-five",
    ]

    static func load(dir: URL) -> PackData? {
        guard let d = try? Data(contentsOf: dir.appendingPathComponent("pack.json")),
              let p = try? JSONDecoder().decode(PackData.self, from: d) else { return nil }
        return p
    }
}

final class SpriteLibrary {
    private(set) var images: [String: NSImage] = [:]
    let base: URL

    init(base dir: URL) {
        self.base = dir
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        for file in files where file.pathExtension.lowercased() == "png" {
            let name = file.deletingPathExtension().lastPathComponent
            if name.hasPrefix("_") { continue }
            if let img = NSImage(contentsOf: file) { images[name] = img }
        }
        if images.isEmpty {
            FileHandle.standardError.write(Data("BabyZillaPet: no sprites in \(dir.path)\n".utf8))
        }
    }

    func image(_ id: String) -> NSImage? {
        images[id] ?? images["idle"] ?? images["master"]
    }

    var missing: [String] { [] }
}

// ── drawing ──────────────────────────────────────────────────────────────────

final class PetView: NSView {
    weak var controller: PetController?

    override var isFlipped: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        guard let c = controller, let img = c.currentImage else { return }
        NSGraphicsContext.current?.imageInterpolation = .none
        let scale = CGFloat(c.config.scale)
        let side = CGFloat(c.spriteSize) * scale
        let rect = NSRect(x: (bounds.width - side) / 2, y: c.renderBob, width: side, height: side)

        // Squash/flip happen here, not on the view's layer: a layer-backed view
        // owns its anchorPoint, and moving it slides the sprite half out of the
        // window (which is exactly the bug this replaced).
        NSGraphicsContext.saveGraphicsState()
        let t = NSAffineTransform()
        t.translateX(by: bounds.width / 2, yBy: 0)
        t.scaleX(by: c.renderScaleX, yBy: c.renderScaleY)
        t.translateX(by: -bounds.width / 2, yBy: 0)
        t.concat()
        img.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1.0,
                 respectFlipped: true, hints: [.interpolation: NSImageInterpolation.none.rawValue])
        NSGraphicsContext.restoreGraphicsState()
    }

    override func mouseDown(with event: NSEvent) {
        controller?.dragBegan(event)
    }

    override func mouseDragged(with event: NSEvent) {
        controller?.dragMoved(event)
    }

    override func mouseUp(with event: NSEvent) {
        controller?.dragEnded(event)
    }

    override func rightMouseDown(with event: NSEvent) {
        controller?.showMenu(at: NSEvent.mouseLocation)
    }
}

// ── speech bubble ────────────────────────────────────────────────────────────

final class BubbleView: NSView {
    var text: String = ""
    var alpha: CGFloat = 0
    /// Drawn as a thought: quieter ink, and dots instead of a tail.
    var thought = false

    // The box and the frame must agree on these: a frame one pixel short clips the
    // top stroke, and the outline reads as open along the top edge.
    static let padX: CGFloat = 11
    static let padY: CGFloat = 9
    static let tail: CGFloat = 7
    // computed, not stored: PixelFont.scale is chosen at runtime
    static var lineH: CGFloat { CGFloat(PixelFont.lineHeight) + 3 }

    static func measure(_ text: String, width: CGFloat) -> (lines: [String], height: CGFloat) {
        let lines = wrap(text, width: width - padX * 2)
        return (lines, CGFloat(lines.count) * lineH + padY * 2 + tail)
    }

    override func draw(_ dirtyRect: NSRect) {
        guard alpha > 0.01, !text.isEmpty else { return }
        // snap glyphs to this screen's pixels; a half-step scale needs it
        PixelFont.pixel = 1 / (window?.backingScaleFactor ?? 2)
        let lines = Self.wrap(text, width: bounds.width - Self.padX * 2)
        let lineH = Self.lineH
        let textH = CGFloat(lines.count) * lineH
        let padX = Self.padX
        let padY = Self.padY
        let tail = Self.tail
        let boxW = bounds.width
        let boxH = textH + padY * 2
        let box = NSRect(x: 0, y: tail, width: boxW, height: boxH)

        NSColor.clear.set()
        NSBezierPath(rect: bounds).fill()

        let path = NSBezierPath(roundedRect: box.insetBy(dx: 1, dy: 1), xRadius: 3, yRadius: 3)
        if thought {
            // Two dots instead of a tail: the shape that says "this is inside its
            // head", not something it said to you.
            for (dx, y, r) in [(-9.0, 4.0, 2.7), (-1.0, 1.5, 1.5)] as [(CGFloat, CGFloat, CGFloat)] {
                let dot = NSBezierPath(ovalIn: NSRect(x: boxW / 2 + dx - r, y: y, width: r * 2, height: r * 2))
                path.append(dot)
            }
        } else {
            // tail
            let t = NSBezierPath()
            t.move(to: NSPoint(x: boxW / 2 - 6, y: box.minY + 1))
            t.line(to: NSPoint(x: boxW / 2, y: 0))
            t.line(to: NSPoint(x: boxW / 2 + 6, y: box.minY + 1))
            t.close()
            path.append(t)
        }

        NSColor(calibratedRed: 0.06, green: 0.05, blue: 0.09, alpha: 0.94 * alpha).setFill()
        path.fill()
        let edge = thought
            ? NSColor(calibratedRed: 0.60, green: 0.68, blue: 0.86, alpha: 0.92 * alpha)
            : NSColor(calibratedRed: 0.72, green: 0.94, blue: 0.78, alpha: 0.95 * alpha)
        edge.setStroke()
        path.lineWidth = 2
        path.stroke()

        let ink = thought
            ? NSColor(calibratedRed: 0.76, green: 0.82, blue: 0.94, alpha: 1)
            : NSColor(calibratedRed: 0.90, green: 0.98, blue: 0.92, alpha: 1)
        var y = box.maxY - padY - CGFloat(PixelFont.glyphHeight)
        for line in lines {
            PixelFont.draw(line, at: NSPoint(x: padX, y: y), alpha: alpha, color: ink)
            y -= lineH
        }
    }

    static func wrap(_ text: String, width: CGFloat) -> [String] {
        let perLine = max(8, Int(width / CGFloat(PixelFont.advance)))
        var out: [String] = []
        var line = ""
        for word in text.split(separator: " ") {
            let candidate = line.isEmpty ? String(word) : line + " " + word
            if candidate.count <= perLine { line = candidate }
            else { out.append(line); line = String(word) }
            while line.count > perLine {
                out.append(String(line.prefix(perLine)))
                line = String(line.dropFirst(perLine))
            }
        }
        if !line.isEmpty { out.append(line) }
        let maxLines = 5
        if out.count > maxLines {
            var kept = Array(out.prefix(maxLines))
            // Never cut a sentence silently: mark the truncation.
            kept[maxLines - 1] = String(kept[maxLines - 1].prefix(perLine - 1)) + "…"
            out = kept
        }
        return out
    }
}

final class BubbleWindow: NSPanel {
    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 200, height: 70),
                   styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        ignoresMouseEvents = true
        isFloatingPanel = true
        hidesOnDeactivate = false
    }
}

final class PetPanel: NSPanel {
    init(size: CGFloat) {
        super.init(contentRect: NSRect(x: 0, y: 0, width: size, height: size),
                   styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        isFloatingPanel = true
        hidesOnDeactivate = false
        becomesKeyOnlyIfNeeded = true
    }
}

// ── status mark ──────────────────────────────────────────────────────────────

/// What the dino is holding up: a finished turn, a question it needs answered, or
/// something that broke. A bubble is an event and fades; this is state, and it
/// stays until the human decides something (answers, fixes, or gives a new task).
enum PetMark: String {
    case done, question, error

    var ink: NSColor {
        switch self {
        case .done: return NSColor(calibratedRed: 0.42, green: 0.90, blue: 0.56, alpha: 1)
        case .question: return NSColor(calibratedRed: 0.55, green: 0.75, blue: 1.00, alpha: 1)
        case .error: return NSColor(calibratedRed: 1.00, green: 0.44, blue: 0.42, alpha: 1)
        }
    }

    /// The check is drawn as a stroke; `?` and `!` come from the bubble font.
    var glyph: String { self == .question ? "?" : "!" }
}

final class MarkView: NSView {
    var kind: PetMark?

    override func draw(_ dirtyRect: NSRect) {
        guard let kind else { return }
        let side = min(bounds.width, bounds.height)
        let box = NSRect(x: (bounds.width - side) / 2, y: (bounds.height - side) / 2, width: side, height: side)
        let plate = NSBezierPath(roundedRect: box.insetBy(dx: 1, dy: 1), xRadius: side * 0.30, yRadius: side * 0.30)
        // Same plate as the bubble: the badge belongs to the pet, not the desktop.
        NSColor(calibratedRed: 0.06, green: 0.05, blue: 0.09, alpha: 0.94).setFill()
        plate.fill()
        kind.ink.setStroke()
        plate.lineWidth = max(1.5, side * 0.10)
        plate.stroke()

        if kind == .done {
            let check = NSBezierPath()
            check.move(to: NSPoint(x: box.minX + side * 0.26, y: box.minY + side * 0.53))
            check.line(to: NSPoint(x: box.minX + side * 0.44, y: box.minY + side * 0.33))
            check.line(to: NSPoint(x: box.minX + side * 0.76, y: box.minY + side * 0.71))
            check.lineWidth = max(1.5, side * 0.15)
            check.lineCapStyle = .round
            check.lineJoinStyle = .round
            kind.ink.setStroke()
            check.stroke()
            return
        }

        // ? and ! are font glyphs so the badge reads as part of the pet. The font
        // scale is global (the bubble owns it), so it is borrowed and given back.
        let saved = PixelFont.scale
        PixelFont.scale = max(0.9, (side * 0.62) / 7)
        PixelFont.pixel = 1 / (window?.backingScaleFactor ?? 2)
        let glyphW = 5 * PixelFont.scale
        let glyphH = 7 * PixelFont.scale
        // `?`/`!` carry their ink high in the cell; a hair up keeps them optically
        // centred next to the check, which is a stroke and has no such bias.
        PixelFont.draw(kind.glyph, at: NSPoint(x: (bounds.width - glyphW) / 2, y: (bounds.height - glyphH) / 2 + side * 0.03),
                       alpha: 1, color: kind.ink)
        PixelFont.scale = saved
    }
}

final class MarkWindow: NSPanel {
    init(size: CGFloat) {
        super.init(contentRect: NSRect(x: 0, y: 0, width: size, height: size),
                   styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        isFloatingPanel = true
        hidesOnDeactivate = false
        becomesKeyOnlyIfNeeded = true
        // A sign, not a button: clicking the badge must hit whatever is behind it.
        ignoresMouseEvents = true
    }
}

// ── controller ───────────────────────────────────────────────────────────────

final class PetController: NSObject {
    var config: PetConfig
    let configURL: URL
    let data: PetData
    let lib: SpriteLibrary
    let spriteSize: Int
    let pack: PackData?
    var onPackChange: (() -> Void)?
    var onVisibilityChange: (() -> Void)?
    var window: PetPanel!
    var bubble: BubbleWindow!
    var markWindow: MarkWindow!
    var markView: MarkView!
    var view: PetView!
    var bubbleView: BubbleView!

    // state
    /// The badge currently held up, if any. Never expires on its own.
    private(set) var mark: PetMark?
    var currentImage: NSImage?
    private(set) var expressionId = "idle"
    private var expressionUntil: Date = .distantPast
    private var baseExpression = "idle"

    // position & motion
    private var x: CGFloat = 0
    private var floorY: CGFloat = 0
    private var lift: CGFloat = 0        // extra height above the floor (0 = standing)
    private var vx: CGFloat = 0
    private var vy: CGFloat = 0
    private var facingRight = true
    private var targetX: CGFloat? = nil
    private var nextWander = Date()
    private var walkPauseUntil = Date()
    private var busy = false
    /// Off from the menu bar: no window, no timer, and events are skipped rather
    /// than queued (a backlog would replay as a burst of bubbles on show).
    private(set) var hidden = false
    /// For the headless switch test: a hidden pet must have stopped ticking.
    var isTicking: Bool { timer != nil }
    /// Headless hook: send the pet at a point, past the edge if need be.
    func walkHeadless(toX target: CGFloat) {
        expressionUntil = .distantPast
        bubbleUntil = .distantPast
        bubbleView.alpha = 0
        bubbleVisible = false
        walkPauseUntil = .distantPast
        targetX = target
    }
    var facing: Bool { facingRight }

    /// Headless hooks for the wall test: put the pet near an edge, then let the
    /// normal movement code walk it into the wall.
    func placeHeadless(near edge: String) {
        let (lo, hi) = boundsX()
        x = edge == "right" ? hi - 24 : lo + 24
        targetX = nil
        vx = 0
    }

    func probeHeadless() -> String {
        let (lo, hi) = boundsX()
        return String(format: "x=%.1f facing=%@ atRight=%@ atLeft=%@ target=%@",
                      x, facingRight ? "right" : "left",
                      x >= hi - 0.5 ? "yes" : "no", x <= lo + 0.5 ? "yes" : "no",
                      targetX == nil ? "none" : "set")
    }
    private var lastEventAt = Date.distantPast
    /// The model is working if events keep arriving; no event for 8s = idle again.
    private var active: Bool { busy || Date().timeIntervalSince(lastEventAt) < 8 }
    private var dragging = false
    private var dragGrab = NSPoint.zero
    private var dragMoved = false
    private var squash: CGFloat = 0
    /// Read by PetView when drawing (never applied to the layer).
    private(set) var renderBob: CGFloat = 0
    private(set) var renderScaleX: CGFloat = 1
    private(set) var renderScaleY: CGFloat = 1
    private var time: TimeInterval = 0
    private var lastTick = Date()
    private var lastInteract = Date()
    private var bubbleUntil = Date.distantPast
    private var pendingLines: [String] = []
    /// A thought is held separately: it must never displace something the pet is
    /// actually saying, and only the newest one is worth showing.
    private var pendingThought: String?
    private var lastBubbleDebug = Date.distantPast
    /// Whether a bubble is on screen. Not `bubble.isVisible`: that stayed true once
    /// alpha stopped being animated, which stalled every queued line behind it.
    private var bubbleVisible = false
    private var lastLineAt = Date.distantPast
    private var lastBlink = Date()
    private var movingFrame: String? = nil
    /// True only while the pet actually moved this tick. Walking in the air is a
    /// bug: a bubble freezes the body, so the feet must freeze with it.
    private var isWalking = false
    /// Position inside one walk cycle, advanced by distance rather than time.
    private var walkPhase: Double = 0
    private var walkLift: CGFloat = 0
    private var walkSquash: CGFloat = 0
    private var lastRendered = ""
    private var packClock: TimeInterval = 0
    private var packAnim = "idle"
    private var lastExprAt = Date.distantPast
    private var lastWatchPoll = Date.distantPast

    private var timer: Timer?
    private var eventSource: DispatchSourceFileSystemObject?
    private var eventHandle: FileHandle?
    private var eventOffset: UInt64 = 0

    /// Headless verification: every expression/bubble lands in a JSONL trace.
    private let traceURL: URL? = ProcessInfo.processInfo.environment["BABYZILLA_PET_TRACE"].map { URL(fileURLWithPath: $0) }

    private func trace(_ event: [String: Any]) {
        guard let url = traceURL else { return }
        var line = event
        line["t"] = Date().timeIntervalSince1970
        line["x"] = Double(x)
        line["y"] = Double(floorY + lift)
        guard let data = try? JSONSerialization.data(withJSONObject: line),
              var text = String(data: data, encoding: .utf8) else { return }
        text += "\n"
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(Data(text.utf8))
            try? handle.close()
        } else {
            try? text.write(to: url, atomically: true, encoding: .utf8)
        }
    }

    init(config: PetConfig, configURL: URL, data: PetData, lib: SpriteLibrary, pack: PackData? = nil) {
        self.config = config
        self.configURL = configURL
        self.data = data
        self.lib = lib
        self.pack = pack
        self.spriteSize = pack?.size ?? data.size
        PixelFont.scale = PixelFont.forPetScale(config.scale)
        super.init()
        buildWindows()
        observeEvents()
        start()
    }

    private func buildWindows() {
        let side = CGFloat(spriteSize * config.scale)
        window = PetPanel(size: side)
        view = PetView(frame: NSRect(x: 0, y: 0, width: side, height: side))
        view.wantsLayer = true
        view.controller = self
        window.contentView = view

        bubble = BubbleWindow()
        bubbleView = BubbleView(frame: bubble.contentView!.bounds)
        bubbleView.autoresizingMask = [.width, .height]
        bubble.contentView = bubbleView

        // the badge is its own tiny window, like the bubble: the pet window is
        // exactly sprite-sized and cannot draw outside itself
        let badge = max(15, side * 0.30)
        markWindow = MarkWindow(size: badge)
        markView = MarkView(frame: NSRect(x: 0, y: 0, width: badge, height: badge))
        markWindow.contentView = markView
        // a mark set while the pet was not running is still waiting
        loadMark()

        placeOnFloor(initial: true)
        window.orderFrontRegardless()
        setExpression("wave", hold: 1.6)
    }

    private func screenForPet() -> NSScreen {
        let point = NSPoint(x: x, y: floorY)
        return NSScreen.screens.first { $0.frame.contains(point) } ?? NSScreen.main ?? NSScreen.screens[0]
    }

    private func placeOnFloor(initial: Bool) {
        let screen = NSScreen.main ?? NSScreen.screens[0]
        let vf = screen.visibleFrame
        floorY = vf.minY + 2
        let side = CGFloat(spriteSize * config.scale)
        if let cx = config.x, let cy = config.y, !initial {
            x = CGFloat(cx)
            floorY = CGFloat(cy)
        } else if let cx = config.x, initial {
            x = CGFloat(cx)
        } else {
            x = vf.midX
        }
        clampX()
        window.setFrameOrigin(NSPoint(x: x - side / 2, y: floorY))
    }

    /// The furthest left and right the pet's centre may go.
    private func boundsX() -> (lo: CGFloat, hi: CGFloat) {
        let vf = screenForPet().visibleFrame
        let half = CGFloat(spriteSize * config.scale) / 2
        return (vf.minX + half + 8, vf.maxX - half - 8)
    }

    /// Pulls the pet back onto the floor. Returns true when an edge stopped it —
    /// the caller needs that to turn it around instead of letting it march into
    /// the wall with its nose against the screen.
    @discardableResult
    private func clampX() -> Bool {
        let (lo, hi) = boundsX()
        let before = x
        x = min(max(x, lo), hi)
        return x != before
    }

    // ── ticking ──────────────────────────────────────────────────────────────

    func shutdown() {
        timer?.invalidate()
        timer = nil
        eventSource?.cancel()
        eventSource = nil
        eventHandle = nil
        window?.close()
        bubble?.close()
        markWindow?.close()
    }

    private func start() {
        timer?.invalidate()
        let t = Timer(timeInterval: 1.0 / 30.0, target: self, selector: #selector(tick), userInfo: nil, repeats: true)
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    /// Menu-bar switch. Hiding is a real stop (no timer, no window), not an alpha:
    /// a hidden pet should cost nothing and should not talk to itself.
    func setVisible(_ visible: Bool) {
        hidden = !visible
        if visible {
            skipBacklog()
            window.orderFrontRegardless()
            bubble.orderOut(nil)
            bubbleVisible = false
            pendingLines.removeAll()
            pendingThought = nil
            lastEventAt = .distantPast
            lastTick = Date()
            start()
            // events are skipped while hidden, so the file is the truth on show
            loadMark()
        } else {
            timer?.invalidate()
            timer = nil
            window.orderOut(nil)
            bubble.orderOut(nil)
            markWindow?.orderOut(nil)
            bubbleVisible = false
            pendingLines.removeAll()
            pendingThought = nil
        }
        config.hidden = !visible
        persist()
    }

    /// Jump to the end of the events file: what happened while the pet was off is
    /// none of its business, and replaying it would bury the human in bubbles.
    private func skipBacklog() {
        if let attrs = try? FileManager.default.attributesOfItem(atPath: Paths.events.path),
           let size = attrs[.size] as? UInt64 {
            eventOffset = size
        }
        lastWatchPoll = Date()
    }

    /// The DispatchSource can miss an append when the pet created the events file
    /// itself; a size check costs nothing and makes the bridge reliable.
    private func pollEventsFile() {
        guard Date().timeIntervalSince(lastWatchPoll) > 0.5 else { return }
        lastWatchPoll = Date()
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: Paths.events.path),
              let size = attrs[.size] as? UInt64 else { return }
        if size > eventOffset { drainEvents() }
    }

    @objc private func tick() {
        let now = Date()
        let dt = min(0.1, now.timeIntervalSince(lastTick))
        lastTick = now
        time += dt

        if !dragging {
            stepMovement(dt: dt, now: now)
            stepFall(dt: dt)
        }
        pollEventsFile()
        stepAI(now: now)
        stepExpression(now: now)
        stepBlink(now: now)
        stepBubble(now: now)
        stepFrames(dt: dt)
        layout()
        view.needsDisplay = true
        bubbleView.needsDisplay = true
    }

    /// One walk cycle carries the pet this far. Tied to the sprite size, so the
    /// cadence reads the same at any scale: a stride is half a body wide.
    private var stride: CGFloat { max(8, CGFloat(spriteSize * config.scale) * 0.5) }

    private func stepMovement(dt: Double, now: Date) {
        let wasWalking = isWalking
        isWalking = false
        guard !dragging else { return }
        // Stop and react, and stay put while a bubble is on screen: walking away
        // mid-sentence reads like the pet is not listening.
        guard Date() >= expressionUntil else { return }
        if bubbleView.alpha > 0.02, Date() < bubbleUntil { return }
        if active { return }
        let before = x
        if let target = targetX {
            let dx = target - x
            let towardRight = dx > 0
            let speed: CGFloat = 74
            let step = min(abs(dx), speed * CGFloat(dt))
            x += towardRight ? step : -step
            facingRight = towardRight
            let hitEdge = clampX()
            if hitEdge || abs(target - x) < 1.5 {
                targetX = nil
                if hitEdge {
                    // The wall ended the walk, not the target: turn around, face
                    // the room and take a breather before choosing somewhere new.
                    facingRight = !towardRight
                    walkPauseUntil = now.addingTimeInterval(Double.random(in: 0.9...2.0))
                } else {
                    walkPauseUntil = now.addingTimeInterval(Double.random(in: 1.2...4.0))
                }
            }
        } else {
            x += vx * CGFloat(dt)
            if clampX() {
                // thrown into a wall: bounce, do not stick to it
                vx = -vx * 0.45
                facingRight = vx > 0
            }
            vx *= 0.90
            if abs(vx) < 2 { vx = 0 }
        }
        // Standing at an edge with nowhere to go (after a drag, a throw or a pause):
        // face the room, so it never idles staring into the screen edge.
        if targetX == nil, abs(vx) < 2 {
            let (lo, hi) = boundsX()
            if x >= hi - 0.5, facingRight { facingRight = false }
            else if x <= lo + 0.5, !facingRight { facingRight = true }
        }
        // The animation is a consequence of the displacement, never an intention:
        // blocked movement means a still pet, not a dino running on the spot.
        let moved = abs(x - before)
        isWalking = moved > 0.02
        guard isWalking else { return }
        if !wasWalking { walkPhase = 0 }
        walkPhase += Double(moved / stride)
        walkPhase -= floor(walkPhase)
    }

    private func stepFall(dt: Double) {
        if lift > 0.01 || vy != 0 {
            vy -= 900 * CGFloat(dt)
            lift += vy * CGFloat(dt)
            if lift <= 0 {
                lift = 0
                if abs(vy) > 120 { squash = 0.55 } else { squash = 0.3 }
                vy = 0
            }
        }
        if squash > 0 { squash = max(0, squash - CGFloat(dt) * 2.2) }
    }

    private func stepAI(now: Date) {
        guard !dragging, !active else { return }
        if now < walkPauseUntil { return }
        if targetX == nil, now >= nextWander {
            let roll = Double.random(in: 0...1)
            let screen = screenForPet()
            if roll < 0.45 {
                // wander
                let vf = screen.visibleFrame
                let half = CGFloat(spriteSize * config.scale) / 2
                targetX = CGFloat.random(in: (vf.minX + half + 20)...(vf.maxX - half - 20))
                // no expression here: stepFrames() owns the walk cycle, and a
                // pseudo-id would hide the real frames and fall back to idle.
            } else if roll < 0.62, config.followCursor {
                // amble toward the pointer, but only if it is on this screen
                let mouse = NSEvent.mouseLocation
                if screenForPet().visibleFrame.contains(mouse) {
                    let (lo, hi) = boundsX()
                    targetX = min(max(mouse.x, lo), hi)
                }
            } else if roll < 0.74 {
                // likewise: the hop frames come from vy/lift, not an expression
                vy = 210
                lift = 0.5
            } else if roll < 0.86 {
                setExpression(now.timeIntervalSince(lastInteract) > 180 ? "sleep" : "tilt-head", hold: 1.8)
            } else {
                // look toward the pointer when it is around, otherwise fidget
                let dx = NSEvent.mouseLocation.x - x
                let toward = dx > 0 ? "look-right" : "look-left"
                let opts = abs(dx) > 40 ? [toward, toward, "breathe", "blink"]
                                         : ["blink", "breathe", "look-left", "look-right", "stretch"]
                setExpression(opts.randomElement()!, hold: 1.2)
            }
            nextWander = now.addingTimeInterval(Double.random(in: 3.0...9.0))
        }
    }

    private func stepExpression(now: Date) {
        guard now >= expressionUntil else { return }
        let next = active ? "typing" : "idle"
        if expressionId != next {
            expressionId = next
            applySprite()
        }
    }

    private func stepBlink(now: Date) {
        guard expressionId == "idle" || expressionId == "typing" else { return }
        if now.timeIntervalSince(lastBlink) > Double.random(in: 2.5...6.0) {
            lastBlink = now
            let prev = expressionId
            expressionId = "blink"
            applySprite()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.11) { [weak self] in
                guard let self, self.expressionId == "blink" else { return }
                self.expressionId = prev
                self.applySprite()
            }
        }
    }

    private func stepBubble(now: Date) {
        if ProcessInfo.processInfo.environment["BABYZILLA_PET_DEBUG"] != nil,
           now.timeIntervalSince(lastBubbleDebug) > 0.4 {
            lastBubbleDebug = now
            trace(["ev": "bubble", "alpha": Double(bubbleView.alpha), "visible": bubbleVisible,
                   "queued": pendingLines.count, "thoughtQueued": pendingThought != nil,
                   "until": bubbleUntil.timeIntervalSince1970])
        }
        if bubbleVisible {
            if now < bubbleUntil {
                // fade in over a few ticks; the animator proxy proved unreliable
                // here and left alpha pinned at 0, which deadlocked the queue
                if bubbleView.alpha < 1 {
                    bubbleView.alpha = min(1, bubbleView.alpha + 0.3)
                    bubbleView.needsDisplay = true
                }
            } else {
                bubbleView.alpha = max(0, bubbleView.alpha - 0.12)
                bubbleView.needsDisplay = true
                if bubbleView.alpha <= 0 {
                    bubble.orderOut(nil)
                    bubbleVisible = false
                    bubbleView.thought = false
                }
            }
        } else if !pendingLines.isEmpty {
            showBubble(pendingLines.removeFirst())
        } else if let thought = pendingThought {
            pendingThought = nil
            showBubble(thought, thought: true)
        }
    }

    /// Locomotion frames are separate from expressions: a reaction plays the
    /// face sprite standing still, otherwise walking/hopping cycles its own set.
    private func stepFrames(dt: Double) {
        if pack != nil { stepPack(dt: dt); return }
        let reacting = Date() < expressionUntil
        if reacting {
            // a reaction plays standing still, on the ground
            movingFrame = nil
            walkLift = 0
            walkSquash = 0
        } else if lift > 0.5 || vy > 40 {
            movingFrame = vy > 120 ? "loco-hop-1" : "loco-hop-2"
        } else if isWalking {
            // It hops, it does not walk. The art has no stride — the legs are
            // planted in every front-view sprite, so a "walk cycle" just skates.
            // A four-beat hop (crouch, rise, apex, land) keeps the feet off the
            // ground for most of each step, and the beat is driven by the distance
            // covered, so the ground never slides under it.
            let side = CGFloat(spriteSize * config.scale)
            switch Int(walkPhase * 4) % 4 {
            case 0: // crouch, loaded
                movingFrame = "loco-hop-1"; walkLift = 0; walkSquash = 0.5
            case 1: // push off, standing tall
                movingFrame = "loco-walk-4"; walkLift = side * 0.04; walkSquash = 0
            case 2: // apex — the only beat with the arms-up pose
                movingFrame = "loco-hop-2"; walkLift = side * 0.065; walkSquash = 0
            default: // land, knees bent
                movingFrame = "loco-walk-2"; walkLift = 0; walkSquash = 0
            }
        } else {
            movingFrame = nil
            walkLift = 0
            walkSquash = 0
        }
        let id = renderId
        if id != lastRendered {
            lastRendered = id
            currentImage = lib.image(id)
            trace(["ev": "frame", "id": id, "facing": facingRight])
            view.needsDisplay = true
        }
    }

    /// Packs animate by state, not by expression: idle / walk / jump.
    private func stepPack(dt: Double) {
        guard let pack else { return }
        let anim: String
        if lift > 0.5 || vy > 40 {
            // the physics hop uses the sheet's own jump
            anim = "jump"
        } else if Date() < expressionUntil {
            // the pack's own expression map wins; then its jump for excitement
            anim = pack.expressions?[expressionId]
                ?? (PackData.energetic.contains(expressionId) ? "jump" : "idle")
        } else if isWalking {
            anim = "walk"
        } else {
            anim = "idle"
        }
        if anim != packAnim {
            // restart on change so a walk always begins on its first frame
            packAnim = anim
            packClock = 0
            if anim == "walk" { walkPhase = 0 }
        }
        packClock += dt
        let frames = pack.animations[anim] ?? pack.animations["idle"] ?? []
        guard !frames.isEmpty else { return }
        let id: String
        if anim == "walk" {
            // One cycle per stride of floor covered, not per second of wall clock:
            // this is what stops the legs outrunning the ground.
            id = frames[Int(walkPhase * Double(frames.count)) % frames.count]
        } else {
            let fps = max(1.0, pack.fps?[anim] ?? 8)
            id = frames[Int(packClock * fps) % frames.count]
        }
        if id != lastRendered {
            lastRendered = id
            currentImage = lib.image(id)
            trace(["ev": "frame", "id": id, "facing": facingRight])
            view.needsDisplay = true
        }
    }

    private var renderId: String {
        if Date() < expressionUntil { return expressionId }
        return movingFrame ?? expressionId
    }

    private func layout() {
        let side = CGFloat(spriteSize * config.scale)
        var bob: CGFloat = 0
        var sx: CGFloat = 1
        var sy: CGFloat = 1
        switch currentMotion {
        case "bob": bob = sin(CGFloat(time) * 2.2) * CGFloat(config.scale)
        case "float": bob = sin(CGFloat(time) * 1.1) * CGFloat(config.scale) * 1.6
        case "shake": bob = 0
        case "pop": break
        default: break
        }
        // while a locomotion frame is showing, the art already carries the
        // vertical motion — an extra breathing bob would double it
        if movingFrame != nil || pack != nil { bob = 0 }
        if walkSquash > 0 {
            sy = min(sy, 1 - walkSquash * 0.10)
            sx = max(sx, 1 + walkSquash * 0.08)
        }
        if squash > 0 {
            sy = 1 - squash * 0.28
            sx = 1 + squash * 0.22
        }
        var jitter: CGFloat = 0
        if currentMotion == "shake" { jitter = sin(CGFloat(time) * 40) * CGFloat(config.scale) * 0.7 }

        let feetY = floorY + lift + walkLift
        window.setFrameOrigin(NSPoint(x: x - side / 2 + jitter, y: feetY))
        if view.frame.size.width != side {
            view.frame = NSRect(x: 0, y: 0, width: side, height: side)
        }
        renderBob = bob
        renderScaleX = sx * (facingRight ? 1 : -1)
        renderScaleY = sy

        // bubble follows the head, sized from the text it actually holds
        let bubbleW: CGFloat = max(200, side * 1.35)
        let bubbleH = max(40, BubbleView.measure(bubbleView.text, width: bubbleW).height)
        bubble.setFrame(NSRect(x: x - bubbleW / 2, y: feetY + side + bob - 6, width: bubbleW, height: bubbleH), display: false)
        bubbleView.frame = NSRect(x: 0, y: 0, width: bubbleW, height: bubbleH)

        // The badge rides beside the head, below the bubble's tail: it must not be
        // mistaken for part of a sentence, and it must survive the sentence ending.
        if mark != nil, !hidden {
            let badge = max(15, side * 0.30)
            markWindow.setFrame(NSRect(x: x + side * 0.34, y: feetY + side * 0.56 + bob, width: badge, height: badge),
                                display: false)
            if markView.frame.width != badge {
                markView.frame = NSRect(x: 0, y: 0, width: badge, height: badge)
            }
        }
    }

    private var currentMotion: String {
        data.byId[expressionId]?.motion ?? "bob"
    }

    private func applySprite() {
        guard pack == nil else { return }
        lastRendered = renderId
        currentImage = lib.image(lastRendered)
        view.needsDisplay = true
        bubbleView.needsDisplay = true
    }

    // ── public actions ───────────────────────────────────────────────────────

    func setExpression(_ id: String, hold: TimeInterval) {
        // A pack has no sprite per expression — its expression map answers for the
        // id, so the id has to survive. Collapsing to "idle" here made every
        // reaction in a pack play the same face.
        let resolved = (pack != nil || lib.image(id) != nil) ? id : "idle"
        if resolved != expressionId { trace(["ev": "expr", "id": resolved, "hold": hold]) }
        expressionId = resolved
        expressionUntil = Date().addingTimeInterval(hold)
        applySprite()
    }

    func say(_ text: String, hold: TimeInterval = 4.5) {
        guard !config.muted else { return }
        // Real speech outranks a thought: fade whatever it was muttering.
        if bubbleVisible, bubbleView.thought { bubbleUntil = Date.distantPast }
        let limit: TimeInterval = config.chattiness == "quiet" ? 900 : config.chattiness == "chatty" ? 2 : 8
        if Date().timeIntervalSince(lastLineAt) < limit { return }
        lastLineAt = Date()
        pendingLines.append(text)
        if pendingLines.count > 3 { pendingLines.removeFirst() }
    }

    /// One line of the model's reasoning, in the quieter bubble.
    ///
    /// Deliberately not routed through `say()`: its chattiness rules exist to stop
    /// the pet interrupting *itself*, and a thought is already rate-limited at the
    /// source. It also never displaces speech — if the pet is mid-sentence, the
    /// thought is simply dropped, because a stale thought is worth less than a
    /// sentence someone is reading.
    func think(_ text: String) {
        guard !config.muted, !text.isEmpty else { return }
        // never while the pet is mid-sentence, never the same line twice
        if bubbleVisible, !bubbleView.thought { return }
        if bubbleVisible, bubbleView.text == text { return }
        pendingThought = text
        if bubbleVisible, bubbleView.thought { bubbleUntil = Date.distantPast }
    }

    /// Raise (or clear) the status badge. There is no timer here on purpose: a
    /// mark means "your turn", and only the human's next prompt takes it down —
    /// the plugin sends that as `mark: null`.
    func setMark(_ kind: PetMark?) {
        mark = kind
        markView?.kind = kind
        markView?.needsDisplay = true
        guard let kind, !hidden else {
            markWindow?.orderOut(nil)
            if let data = try? JSONSerialization.data(withJSONObject: ["mark": NSNull(), "shown": false,
                                                                      "t": Date().timeIntervalSince1970 * 1000]) {
                try? data.write(to: Paths.state.appendingPathComponent("last-mark.json"))
            }
            return
        }
        trace(["ev": "mark", "mark": kind.rawValue])
        layout()
        markWindow.orderFrontRegardless()
        // Observation, not faith: the CLI asks the app what it is holding up, so
        // "nothing happened" can be diagnosed without screen access.
        let ack: [String: Any] = ["mark": kind.rawValue, "shown": markWindow.isVisible,
                                  "t": Date().timeIntervalSince1970 * 1000]
        if let data = try? JSONSerialization.data(withJSONObject: ack) {
            try? data.write(to: Paths.state.appendingPathComponent("last-mark.json"))
        }
    }

    /// A restart must not swallow an unanswered question: the plugin owns the
    /// file, so this is a read, never a write.
    private func loadMark() {
        guard let data = try? Data(contentsOf: Paths.markFile),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            setMark(nil)
            return
        }
        setMark((obj["mark"] as? String).flatMap(PetMark.init(rawValue:)))
    }

    /// Headless proof for the badge: set it, report it, and draw it to a file.
    func markHeadless(_ name: String?, to path: String?) -> String {
        setMark(name.flatMap(PetMark.init(rawValue:)))
        if let path, let kind = mark, let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: 64, pixelsHigh: 64, bitsPerSample: 8,
            samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
            bytesPerRow: 64 * 4, bitsPerPixel: 32) {
            rep.size = NSSize(width: 32, height: 32)
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
            NSColor(calibratedRed: 0.09, green: 0.10, blue: 0.13, alpha: 1).setFill()
            NSRect(x: 0, y: 0, width: 32, height: 32).fill()
            markView.frame = NSRect(x: 4, y: 4, width: 24, height: 24)
            markView.draw(markView.bounds)
            NSGraphicsContext.restoreGraphicsState()
            _ = kind
            try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
        }
        let f = markWindow.frame
        return "mark=\(mark?.rawValue ?? "none") badge=\(markWindow.isVisible) "
            + "at=\(Int(f.minX)),\(Int(f.minY)) size=\(Int(f.width)) "
            + "file=\(Paths.markFile.lastPathComponent)"
    }

    private func showBubble(_ text: String, thought: Bool = false) {
        var rec: [String: Any] = ["ev": "say", "text": text]
        if thought { rec["thought"] = true }
        trace(rec)
        // Observation, not faith: the CLI reports what the pet actually displayed,
        // so "nothing happened" can be diagnosed without screen access.
        let ack: [String: Any] = [
            "kind": thought ? "think" : "say",
            "text": text,
            "thought": thought,
            "t": Date().timeIntervalSince1970 * 1000,
        ]
        if let data = try? JSONSerialization.data(withJSONObject: ack) {
            try? data.write(to: Paths.state.appendingPathComponent("last-bubble.json"))
        }
        bubbleView.thought = thought
        bubbleView.text = text
        bubbleView.alpha = 0
        bubbleView.needsDisplay = true
        bubbleVisible = true
        bubble.orderFrontRegardless()
        // A thought is a glance, not a reading matter.
        let perChar: Double = thought ? 0.045 : 0.055
        let floor: Double = thought ? 1.8 : 2.6
        bubbleUntil = Date().addingTimeInterval(max(floor, Double(text.count) * perChar))
    }

    // ── mouse ────────────────────────────────────────────────────────────────

    func dragBegan(_ event: NSEvent) {
        dragging = true
        dragMoved = false
        dragGrab = event.locationInWindow
        lastInteract = Date()
    }

    func dragMoved(_ event: NSEvent) {
        let mouse = NSEvent.mouseLocation
        if !dragMoved {
            dragMoved = true
            setExpression("poke", hold: 0.9)
            say(pick(["Hey!", "Careful!", "Put me down!"]), hold: 2.0)
        }
        let side = CGFloat(spriteSize * config.scale)
        x = mouse.x - dragGrab.x + side / 2
        floorY = mouse.y - dragGrab.y
        vx = 0
        window.setFrameOrigin(NSPoint(x: x - side / 2, y: floorY))
    }

    func dragEnded(_ event: NSEvent) {
        dragging = false
        if !dragMoved {
            // click = poke
            setExpression("poke", hold: 1.0)
            say(pick(["That tickles.", "Boop.", "I felt that."]), hold: 2.0)
            lastInteract = Date()
            return
        }
        let screen = screenForPet()
        let floor = screen.visibleFrame.minY + 2
        if floorY > floor + 4 {
            lift = floorY - floor
            vy = 0
            floorY = floor
        }
        clampX()
        persist()
    }

    func showMenu(at point: NSPoint) {
        let menu = NSMenu()
        let title = NSMenuItem(title: "BabyZilla", action: nil, keyEquivalent: "")
        title.isEnabled = false
        menu.addItem(title)
        menu.addItem(.separator())
        let hide = NSMenuItem(title: hidden ? "Show Dino" : "Hide Dino",
                              action: #selector(toggleVisibility), keyEquivalent: "")
        hide.target = self
        menu.addItem(hide)
        menu.addItem(.separator())

        for scale in [1, 2, 3] {
            let item = NSMenuItem(title: "Size \(scale)×", action: #selector(setScale(_:)), keyEquivalent: "")
            item.target = self
            item.tag = scale
            item.state = config.scale == scale ? .on : .off
            menu.addItem(item)
        }
        menu.addItem(.separator())
        Packs.installMenu(into: menu, target: self, action: #selector(choosePack(_:)), current: config.pack)
        let mute = NSMenuItem(title: "Mute speech", action: #selector(toggleMute), keyEquivalent: "")
        mute.target = self
        mute.state = config.muted ? .on : .off
        menu.addItem(mute)
        for level in ["quiet", "normal", "chatty"] {
            let item = NSMenuItem(title: "Chattiness: \(level)", action: #selector(setChattiness(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = level
            item.state = config.chattiness == level ? .on : .off
            menu.addItem(item)
        }
        menu.addItem(.separator())
        let gallery = NSMenuItem(title: "Gallery…", action: #selector(openGallery), keyEquivalent: "")
        gallery.target = self
        menu.addItem(gallery)
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        menu.popUp(positioning: nil, at: point, in: nil)
    }

    @objc private func toggleVisibility() {
        setVisible(hidden)
        onVisibilityChange?()
    }

    @objc func setScale(_ item: NSMenuItem) {
        config.scale = item.tag
        let side = CGFloat(spriteSize * config.scale)
        window.setFrame(NSRect(x: x - side / 2, y: floorY, width: side, height: side), display: true)
        persist()
    }

    @objc func toggleMute() {
        config.muted.toggle()
        persist()
    }

    @objc func choosePack(_ item: NSMenuItem) {
        let id = item.representedObject as? String ?? "babyzilla"
        config.pack = id == "babyzilla" ? nil : id
        // a pack knows how big it wants to be: its art is not the same density
        if id != "babyzilla", let dir = Packs.directory(id), let pack = PackData.load(dir: dir),
           let scale = pack.defaultScale {
            config.scale = scale
        }
        persist()
        onPackChange?()
    }

    @objc private func setChattiness(_ item: NSMenuItem) {
        config.chattiness = (item.representedObject as? String) ?? "normal"
        persist()
    }

    @objc func openGallery() {
        let gallery = Paths.state.appendingPathComponent("gallery.html")
        if FileManager.default.fileExists(atPath: gallery.path) {
            NSWorkspace.shared.open(gallery)
        } else if let base = ProcessInfo.processInfo.environment["BABYZILLA_PET_DIR"] {
            NSWorkspace.shared.open(URL(fileURLWithPath: base).appendingPathComponent("gallery.html"))
        }
    }

    private func persist() {
        config.x = Double(x)
        config.y = Double(floorY)
        config.save(configURL)
    }

    private func pick(_ options: [String]) -> String {
        options.randomElement() ?? ""
    }

    // ── events ───────────────────────────────────────────────────────────────

    private func observeEvents() {
        try? FileManager.default.createDirectory(at: Paths.state, withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: Paths.events.path) {
            FileManager.default.createFile(atPath: Paths.events.path, contents: nil)
        }
        guard let handle = try? FileHandle(forReadingFrom: Paths.events) else { return }
        eventHandle = handle
        let fd = handle.fileDescriptor
        eventOffset = (try? handle.seekToEnd()) ?? 0
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.extend, .write, .rename], queue: .main)
        source.setEventHandler { [weak self] in self?.drainEvents() }
        source.setCancelHandler { try? handle.close() }
        source.resume()
        eventSource = source
    }

    private func drainEvents() {
        guard let handle = eventHandle else { return }
        let end = (try? handle.seekToEnd()) ?? 0
        if end < eventOffset { eventOffset = 0 }   // rotated
        guard end > eventOffset else { return }
        try? handle.seek(toOffset: eventOffset)
        let data = handle.readData(ofLength: Int(end - eventOffset))
        eventOffset = end
        guard let text = String(data: data, encoding: .utf8) else { return }
        for line in text.split(separator: "\n") {
            guard let d = line.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { continue }
            handleEvent(obj)
        }
    }

    private func handleEvent(_ ev: [String: Any]) {
        let kind = ev["kind"] as? String ?? ""
        // A mark is a state, not a poke: it must not stop the pet wandering for
        // the next eight seconds the way real activity does.
        if kind != "mark" { lastEventAt = Date() }
        switch kind {
        case "expr":
            if let id = ev["id"] as? String {
                // Minimum dwell: a burst of tool calls should read as "busy",
                // not as a strobing face. Long holds and real news always cut in.
                let hold = (ev["hold"] as? Double) ?? 1.6
                let urgent = hold >= 8 || ["compressing", "pack-created", "update-available",
                                           "error", "shell-fail", "budget-full", "budget-low"].contains(id)
                if urgent || Date().timeIntervalSince(lastExprAt) > 0.45 {
                    lastExprAt = Date()
                    setExpression(id, hold: hold)
                }
            }
        case "say":
            if let text = ev["text"] as? String { say(text) }
        case "think":
            if let text = ev["text"] as? String { think(text) }
        case "busy":
            busy = (ev["on"] as? Bool) ?? false
            if busy { setExpression("typing", hold: 0) }
        case "walk":
            if let to = ev["x"] as? Double { targetX = CGFloat(to) }
        case "mark":
            // null clears it: the human decided something
            setMark((ev["mark"] as? String).flatMap(PetMark.init(rawValue:)))
        case "ping":
            setExpression("wave", hold: 1.2)
        default:
            if let id = ev["id"] as? String { setExpression(id, hold: 1.6) }
        }
    }
}

// ── app ──────────────────────────────────────────────────────────────────────

final class AppDelegate: NSObject, NSApplicationDelegate {
    var controller: PetController?
    var statusItem: NSStatusItem?

    private func startPet() {
        var cfg = PetConfig.load(Paths.config)
        cfg.scale = max(1, min(6, cfg.scale))
        let base = Paths.resolveSprites()
        var pack: PackData?
        var packDir: URL?
        if let name = cfg.pack, let dir = Packs.directory(name), let loaded = PackData.load(dir: dir) {
            pack = loaded
            packDir = dir
        }
        let petData = PetData.load(spritesDir: base) ?? PetData.fallback
        // a pack dir holds sprites/ — the library wants the directory with the PNGs
        let lib = SpriteLibrary(base: packDir.map { $0.appendingPathComponent("sprites") } ?? base)
        let pet = PetController(config: cfg, configURL: Paths.config, data: petData, lib: lib, pack: pack)
        pet.onPackChange = { [weak self] in self?.rebuildPet() }
        controller = pet
        if cfg.hidden { pet.setVisible(false) }
    }

    /// Switching pet swaps art and scale, which means new windows and a new
    /// sprite library; cheaper than relaunching and it keeps the position.
    func rebuildPet() {
        controller?.shutdown()
        controller = nil
        startPet()
        refreshStatusItem()
        controller?.onVisibilityChange = { [weak self] in self?.refreshStatusItem() }
    }

    func captureAndExit(_ path: String, after delay: TimeInterval) {
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, let c = self.controller,
                  let pet: PetPanel = c.window, let bubble: BubbleWindow = c.bubble else { exit(1) }
            let petRect = pet.frame
            let bubbleRect = bubble.frame
            let union = petRect.union(bubbleRect)
            let W = union.width + 20, H = union.height + 20
            let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(W), pixelsHigh: Int(H),
                                       bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                       colorSpaceName: .deviceRGB, bytesPerRow: Int(W) * 4, bitsPerPixel: 32)!
            rep.size = NSSize(width: W, height: H)
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
            NSColor(calibratedRed: 0.10, green: 0.11, blue: 0.14, alpha: 1).setFill()
            NSRect(x: 0, y: 0, width: W, height: H).fill()
            if let v = pet.contentView {
                let r = NSRect(x: petRect.minX - union.minX + 10, y: petRect.minY - union.minY + 10, width: petRect.width, height: petRect.height)
                NSGraphicsContext.saveGraphicsState()
                let t = NSAffineTransform(); t.translateX(by: r.minX, yBy: r.minY); t.concat()
                v.draw(v.bounds)
                NSGraphicsContext.restoreGraphicsState()
            }
            if bubble.isVisible, let bv = bubble.contentView {
                NSGraphicsContext.saveGraphicsState()
                let t = NSAffineTransform()
                t.translateX(by: bubbleRect.minX - union.minX + 10, yBy: bubbleRect.minY - union.minY + 10)
                t.concat()
                bv.draw(bv.bounds)
                NSGraphicsContext.restoreGraphicsState()
            }
            NSGraphicsContext.restoreGraphicsState()
            try? rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
            print("captured \(path) window=\(pet.frame.size) view=\(pet.contentView?.frame.size ?? .zero)")
            exit(0)
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        try? FileManager.default.createDirectory(at: Paths.state, withIntermediateDirectories: true)
        startPet()
        installStatusItem()
        controller?.onVisibilityChange = { [weak self] in self?.refreshStatusItem() }
        // A pet turned off from the menu bar stays off across logins: the login
        // item runs this binary, so it is the process that has to remember.
        if controller?.hidden == true { refreshStatusItem() }
        if CommandLine.arguments.contains("--edge-test") {
            // The wall turn cannot be seen without the screen, so the pet is put
            // next to each edge and asked to walk through it.
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.6) { [weak self] in
                guard let self, let c = self.controller else { print("no controller"); exit(1) }
                c.placeHeadless(near: "right")
                c.walkHeadless(toX: 99_999)
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                    print("right edge: \(c.probeHeadless())")
                    c.placeHeadless(near: "left")
                    c.walkHeadless(toX: -99_999)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                        print("left edge:  \(c.probeHeadless())")
                        exit(0)
                    }
                }
            }
        }
        if CommandLine.arguments.contains("--mark-test") {
            // The badge cannot be seen without screen access, so it is set, reported,
            // drawn to a PNG, and checked against hiding the pet: a mark must survive
            // the pet being switched off, and must come back with it.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
                guard let self, let c = self.controller else { print("no controller"); exit(1) }
                let png = ProcessInfo.processInfo.environment["BABYZILLA_PET_MARK_PNG"]
                for kind in ["done", "question", "error"] {
                    print(c.markHeadless(kind, to: kind == "done" ? png : nil))
                }
                // What the plugin does: the badge outlives the pet being switched
                // off, and comes back from the file rather than from memory.
                try? Data("{\"mark\":\"error\"}".utf8).write(to: Paths.markFile)
                c.setVisible(false)
                print("hidden: badge=\(c.markWindow.isVisible) pet=\(c.window.isVisible)")
                c.setVisible(true)
                print("shown:  badge=\(c.markWindow.isVisible) mark=\(c.mark?.rawValue ?? "none")")
                print(c.markHeadless(nil, to: nil))
                exit(0)
            }
        }
        if CommandLine.arguments.contains("--toggle-test") {
            // Headless proof that the switch is wired to the windows, not just to
            // a menu title: the menu bar itself cannot be read without permissions.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
                guard let self, let c = self.controller else { print("no controller"); exit(1) }
                print("icon=\(self.statusIconId() ?? "none") hidden=\(c.hidden) window=\(c.window.isVisible)")
                // The menu bar cannot be inspected without permissions; the icon it
                // is given can, so the test writes exactly that bitmap out.
                if let img = self.statusImage(),
                   let path = ProcessInfo.processInfo.environment["BABYZILLA_PET_ICON"],
                   let tiff = img.tiffRepresentation,
                   let rep = NSBitmapImageRep(data: tiff),
                   let png = rep.representation(using: .png, properties: [:]) {
                    try? png.write(to: URL(fileURLWithPath: path))
                    print("icon written: \(path) \(Int(img.size.width))x\(Int(img.size.height))")
                }
                self.togglePet()
                print("after hide: hidden=\(c.hidden) window=\(c.window.isVisible) timer=\(c.isTicking)")
                self.togglePet()
                print("after show: hidden=\(c.hidden) window=\(c.window.isVisible) timer=\(c.isTicking)")
                self.statusItem?.menu?.delegate = nil
                exit(0)
            }
        }
        // What this install can see in its Pet menu. Printed, not photographed:
        // menus are the one surface a screenshot cannot reach, and "no pet list"
        // is exactly the kind of report where the list itself is the evidence.
        if CommandLine.arguments.contains("--pets") {
            let pets = Packs.available()
            for pet in pets { print("pet\t\(pet.id)\t\(pet.label)") }
            if pets.count <= 1 { print("hint\tNo other pets — babyzilla pet catalog") }
            print("roots\t" + Packs.roots().map(\.path).joined(separator: ","))
            exit(0)
        }
        if let i = CommandLine.arguments.firstIndex(of: "--capture"), i + 1 < CommandLine.arguments.count {
            captureAndExit(CommandLine.arguments[i + 1], after: 2.0)
        }
    }

    /// The menu bar is the only way to reach a pet with no Dock icon, so its icon
    /// is the pet's face: the pack's own idle frame, nearest-neighbour, not a
    /// generic glyph. It used to be blank for packs, whose idle is `idle-1`.
    private func statusIconId() -> String? {
        guard let c = controller else { return nil }
        if let first = c.pack?.animations["idle"]?.first, c.lib.images[first] != nil { return first }
        if c.lib.images["idle"] != nil { return "idle" }
        return c.lib.images.keys.sorted().first
    }

    /// Crop away the empty canvas around the character. Pack sprites are 48×48 with
    /// a small dino in one corner; drawn whole, the menu bar showed a corner of air.
    private func trimmed(_ src: NSImage) -> NSImage {
        guard let tiff = src.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else { return src }
        let w = rep.pixelsWide, h = rep.pixelsHigh
        var minX = w, minY = h, maxX = -1, maxY = -1
        for y in 0..<h {
            for x in 0..<w {
                guard let c = rep.colorAt(x: x, y: y), c.alphaComponent > 0.05 else { continue }
                minX = min(minX, x); maxX = max(maxX, x)
                minY = min(minY, y); maxY = max(maxY, y)
            }
        }
        guard maxX >= minX, maxY >= minY else { return src }
        let cw = CGFloat(maxX - minX + 1), ch = CGFloat(maxY - minY + 1)
        let out = NSImage(size: NSSize(width: cw, height: ch))
        out.lockFocus()
        NSGraphicsContext.current?.imageInterpolation = .none
        src.draw(in: NSRect(x: 0, y: 0, width: cw, height: ch),
                 from: NSRect(x: CGFloat(minX), y: CGFloat(h - maxY - 1), width: cw, height: ch),
                 operation: .sourceOver, fraction: 1)
        out.unlockFocus()
        return out
    }

    private func statusImage() -> NSImage? {
        guard let id = statusIconId(), let raw = controller?.lib.images[id] else { return nil }
        let src = trimmed(raw)
        let side: CGFloat = 18
        let out = NSImage(size: NSSize(width: side, height: side))
        out.lockFocus()
        NSGraphicsContext.current?.imageInterpolation = .none
        NSGraphicsContext.current?.shouldAntialias = false
        let scale = min((side - 2) / src.size.width, (side - 2) / src.size.height)
        let w = src.size.width * scale
        let h = src.size.height * scale
        src.draw(in: NSRect(x: (side - w) / 2, y: (side - h) / 2, width: w, height: h),
                 from: .zero, operation: .sourceOver, fraction: 1)
        out.unlockFocus()
        out.isTemplate = false
        return out
    }

    private func installStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.imageScaling = .scaleProportionallyUpOrDown
        let menu = NSMenu()
        menu.delegate = self
        menu.autoenablesItems = false
        item.menu = menu
        statusItem = item
        refreshStatusItem()
    }

    /// Icon and dimming follow the switch, so the menu bar says whether the pet
    /// is on without opening anything.
    private func refreshStatusItem() {
        guard let button = statusItem?.button else { return }
        button.image = statusImage()
        button.appearsDisabled = controller?.hidden == true
        statusItem?.menu?.delegate = nil
        statusItem?.menu?.delegate = self
    }

    @objc func togglePet() {
        guard let c = controller else { return }
        c.setVisible(c.hidden)
        refreshStatusItem()
    }
}

extension AppDelegate: NSMenuDelegate {
    /// Rebuilt on open: the pet can be switched, resized or muted between clicks,
    /// and a stale checkmark is a lie.
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        guard let c = controller else {
            menu.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
            return
        }
        let toggle = NSMenuItem(title: c.hidden ? "Show Dino" : "Hide Dino",
                                action: #selector(togglePet), keyEquivalent: "")
        toggle.target = self
        toggle.state = c.hidden ? .off : .on
        menu.addItem(toggle)
        menu.addItem(.separator())

        let sizeItem = NSMenuItem(title: "Size", action: nil, keyEquivalent: "")
        let sizes = NSMenu()
        for scale in [1, 2, 3] {
            let item = NSMenuItem(title: "\(scale)×", action: #selector(PetController.setScale(_:)), keyEquivalent: "")
            item.target = c
            item.tag = scale
            item.state = c.config.scale == scale ? .on : .off
            sizes.addItem(item)
        }
        sizeItem.submenu = sizes
        menu.addItem(sizeItem)

        let mute = NSMenuItem(title: "Mute speech", action: #selector(PetController.toggleMute), keyEquivalent: "")
        mute.target = c
        mute.state = c.config.muted ? .on : .off
        menu.addItem(mute)

        Packs.installMenu(into: menu, target: c, action: #selector(PetController.choosePack(_:)), current: c.config.pack)

        menu.addItem(.separator())
        let gallery = NSMenuItem(title: "Gallery…", action: #selector(PetController.openGallery), keyEquivalent: "")
        gallery.target = c
        menu.addItem(gallery)
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    }
}

extension PetData {
    static func load(spritesDir: URL, state: URL = Paths.data) -> PetData? {
        if let d = try? Data(contentsOf: state), let p = try? JSONDecoder().decode(PetData.self, from: d) { return p }
        let siblings = [spritesDir.appendingPathComponent("pet-data.json"),
                        spritesDir.deletingLastPathComponent().appendingPathComponent("pet-data.json")]
        for url in siblings {
            if let d = try? Data(contentsOf: url), let p = try? JSONDecoder().decode(PetData.self, from: d) { return p }
        }
        return nil
    }

    static var fallback: PetData {
        let json = """
        {"size":64,"expressions":[{"id":"idle","label":"Idle","motion":"bob","lines":["Hi."]}]}
        """
        return try! JSONDecoder().decode(PetData.self, from: Data(json.utf8))
    }
}

// ── main ─────────────────────────────────────────────────────────────────────

