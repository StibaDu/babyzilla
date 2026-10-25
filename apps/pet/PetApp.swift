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

    enum CodingKeys: String, CodingKey {
        case scale, x, y, chattiness, muted, followCursor, pack
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
        return roots
    }

    static func directory(_ name: String) -> URL? {
        for root in roots() {
            let dir = root.appendingPathComponent(name)
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent("pack.json").path) { return dir }
        }
        return nil
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

    static func measure(_ text: String, width: CGFloat) -> (lines: [String], height: CGFloat) {
        let lines = wrap(text, width: width - 22)
        return (lines, CGFloat(lines.count) * (PixelFont.lineHeight + 3) + 16 + 7)
    }

    override func draw(_ dirtyRect: NSRect) {
        guard alpha > 0.01, !text.isEmpty else { return }
        let lines = Self.wrap(text, width: bounds.width - 22)
        let lineH = CGFloat(PixelFont.lineHeight) + 3
        let textH = CGFloat(lines.count) * lineH
        let padX: CGFloat = 11
        let padY: CGFloat = 9
        let tail: CGFloat = 7
        let boxW = bounds.width
        let boxH = textH + padY * 2
        let box = NSRect(x: 0, y: tail, width: boxW, height: boxH)

        NSColor.clear.set()
        NSBezierPath(rect: bounds).fill()

        let path = NSBezierPath(roundedRect: box.insetBy(dx: 1, dy: 1), xRadius: 3, yRadius: 3)
        // tail
        let t = NSBezierPath()
        t.move(to: NSPoint(x: boxW / 2 - 6, y: box.minY + 1))
        t.line(to: NSPoint(x: boxW / 2, y: 0))
        t.line(to: NSPoint(x: boxW / 2 + 6, y: box.minY + 1))
        t.close()
        path.append(t)

        NSColor(calibratedRed: 0.06, green: 0.05, blue: 0.09, alpha: 0.94 * alpha).setFill()
        path.fill()
        NSColor(calibratedRed: 0.72, green: 0.94, blue: 0.78, alpha: 0.95 * alpha).setStroke()
        path.lineWidth = 2
        path.stroke()

        var y = box.maxY - padY - CGFloat(PixelFont.glyphHeight)
        for line in lines {
            PixelFont.draw(line, at: NSPoint(x: padX, y: y), alpha: alpha)
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
        let maxLines = 4
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

// ── controller ───────────────────────────────────────────────────────────────

final class PetController: NSObject {
    var config: PetConfig
    let configURL: URL
    let data: PetData
    let lib: SpriteLibrary
    let spriteSize: Int
    let pack: PackData?
    var onPackChange: (() -> Void)?
    var window: PetPanel!
    var bubble: BubbleWindow!
    var view: PetView!
    var bubbleView: BubbleView!

    // state
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
    private var lastLineAt = Date.distantPast
    private var lastBlink = Date()
    private var movingFrame: String? = nil
    private var walkClock: TimeInterval = 0
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
        PixelFont.scale = CGFloat(config.scale <= 1 ? 1 : (config.scale >= 4 ? 3 : 2))
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

    private func clampX() {
        let screen = screenForPet()
        let vf = screen.visibleFrame
        let half = CGFloat(spriteSize * config.scale) / 2
        x = min(max(x, vf.minX + half + 8), vf.maxX - half - 8)
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
    }

    private func start() {
        let t = Timer(timeInterval: 1.0 / 30.0, target: self, selector: #selector(tick), userInfo: nil, repeats: true)
        RunLoop.main.add(t, forMode: .common)
        timer = t
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

    private func stepMovement(dt: Double, now: Date) {
        guard !dragging else { return }
        // Stop and react, and stay put while a bubble is on screen: walking away
        // mid-sentence reads like the pet is not listening.
        guard Date() >= expressionUntil else { return }
        if bubbleView.alpha > 0.02, Date() < bubbleUntil { return }
        if active { return }
        if let target = targetX {
            let dx = target - x
            let speed: CGFloat = 46
            let step = min(abs(dx), speed * CGFloat(dt))
            x += dx > 0 ? step : -step
            facingRight = dx > 0
            if abs(dx) < 1.5 {
                targetX = nil
                walkPauseUntil = now.addingTimeInterval(Double.random(in: 1.2...4.0))
            }
            clampX()
        } else {
            x += vx * CGFloat(dt)
            clampX()
            vx *= 0.90
            if abs(vx) < 2 { vx = 0 }
        }
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
                    targetX = min(max(mouse.x, screen.visibleFrame.minX + 60), screen.visibleFrame.maxX - 60)
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
        if now >= bubbleUntil, !bubble.isVisible, bubbleView.alpha < 0.02, !pendingLines.isEmpty {
            let line = pendingLines.removeFirst()
            showBubble(line)
        }
        if now >= bubbleUntil, bubbleView.alpha > 0 {
            bubbleView.alpha = max(0, bubbleView.alpha - 0.08)
            if bubbleView.alpha <= 0 { bubble.orderOut(nil) }
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
        } else if targetX != nil || abs(vx) > 2 {
            // It hops, it does not walk. The art has no stride — the legs are
            // planted in every front-view sprite, so a "walk cycle" just skates.
            // A four-beat hop (crouch, rise, apex, land) keeps the feet off the
            // ground for most of each step, and the cadence follows distance so
            // the ground never slides under it.
            let side = CGFloat(spriteSize * config.scale)
            let hopTime = max(0.30, (side * 0.22) / max(25, abs(vx)))
            walkClock += dt
            switch Int(walkClock / (hopTime / 4)) % 4 {
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
            trace(["ev": "frame", "id": id])
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
        } else if targetX != nil || abs(vx) > 2 {
            anim = "walk"
        } else {
            anim = "idle"
        }
        if anim != packAnim {
            // restart on change so a walk always begins on its first frame
            packAnim = anim
            packClock = 0
        }
        packClock += dt
        let frames = pack.animations[anim] ?? pack.animations["idle"] ?? []
        guard !frames.isEmpty else { return }
        let fps = max(1.0, pack.fps?[anim] ?? 8)
        let id = frames[Int(packClock * fps) % frames.count]
        if id != lastRendered {
            lastRendered = id
            currentImage = lib.image(id)
            trace(["ev": "frame", "id": id])
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
        let limit: TimeInterval = config.chattiness == "quiet" ? 900 : config.chattiness == "chatty" ? 2 : 8
        if Date().timeIntervalSince(lastLineAt) < limit { return }
        lastLineAt = Date()
        pendingLines.append(text)
        if pendingLines.count > 3 { pendingLines.removeFirst() }
    }

    private func showBubble(_ text: String) {
        trace(["ev": "say", "text": text])
        bubbleView.text = text
        bubbleView.alpha = 0
        bubble.orderFrontRegardless()
        bubbleUntil = Date().addingTimeInterval(max(2.6, Double(text.count) * 0.055))
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.18
            bubbleView.animator().alpha = 1
        }
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

        for scale in [1, 2, 3] {
            let item = NSMenuItem(title: "Size \(scale)×", action: #selector(setScale(_:)), keyEquivalent: "")
            item.target = self
            item.tag = scale
            item.state = config.scale == scale ? .on : .off
            menu.addItem(item)
        }
        menu.addItem(.separator())
        let pets = Packs.available()
        if pets.count > 1 {
            let petItem = NSMenuItem(title: "Pet", action: nil, keyEquivalent: "")
            let sub = NSMenu()
            for pet in pets {
                let item = NSMenuItem(title: pet.label, action: #selector(choosePack(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = pet.id
                item.state = (config.pack ?? "babyzilla") == pet.id ? .on : .off
                sub.addItem(item)
            }
            petItem.submenu = sub
            menu.addItem(petItem)
        }
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

    @objc private func setScale(_ item: NSMenuItem) {
        config.scale = item.tag
        let side = CGFloat(spriteSize * config.scale)
        window.setFrame(NSRect(x: x - side / 2, y: floorY, width: side, height: side), display: true)
        persist()
    }

    @objc private func toggleMute() {
        config.muted.toggle()
        persist()
    }

    @objc private func choosePack(_ item: NSMenuItem) {
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

    @objc private func openGallery() {
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
        lastEventAt = Date()
        let kind = ev["kind"] as? String ?? ""
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
        case "busy":
            busy = (ev["on"] as? Bool) ?? false
            if busy { setExpression("typing", hold: 0) }
        case "walk":
            if let to = ev["x"] as? Double { targetX = CGFloat(to) }
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
    }

    /// Switching pet swaps art and scale, which means new windows and a new
    /// sprite library; cheaper than relaunching and it keeps the position.
    func rebuildPet() {
        controller?.shutdown()
        controller = nil
        startPet()
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
        if let i = CommandLine.arguments.firstIndex(of: "--capture"), i + 1 < CommandLine.arguments.count {
            captureAndExit(CommandLine.arguments[i + 1], after: 2.0)
        }
    }

    private func installStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = item.button {
            let img = (controller?.lib.image("idle")?.copy() as? NSImage)
            img?.size = NSSize(width: 18, height: 18)
            button.image = img
            button.imageScaling = .scaleProportionallyUpOrDown
        }
        let menu = NSMenu()
        let show = NSMenuItem(title: "Show pet", action: #selector(showPet), keyEquivalent: "")
        show.target = self
        menu.addItem(show)
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        item.menu = menu
        statusItem = item
    }

    @objc private func showPet() {
        controller?.window.orderFrontRegardless()
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

