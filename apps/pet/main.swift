// Entry point. Top-level code has to live in main.swift for swiftc.
import AppKit

let args = CommandLine.arguments
if args.contains("--font-test") {
    PixelFont.writeTestImage(to: "/tmp/babyzilla-font.png")
    print("wrote /tmp/babyzilla-font.png")
    exit(0)
}
if args.contains("--self-test") {
    let base = Paths.resolveSprites()
    print("sprites dir: \(base.path)")
    let lib = SpriteLibrary(base: base)
    print("loaded: \(lib.images.count) sprites")
    if let pd = PetData.load(spritesDir: base) {
        print("expressions: \(pd.expressions.count), size: \(pd.size)")
        let missing = pd.expressions.map(\.id).filter { lib.images[$0] == nil }
        print("missing sprites: \(missing.isEmpty ? "none" : missing.joined(separator: ", "))")
        exit(missing.isEmpty ? 0 : 1)
    }
    exit(1)
}

// Offscreen render of the pet + bubble. Screen capture needs permissions this
// harness does not have, so layout is verified by drawing the same views into
// a bitmap and looking at it.
if let i = args.firstIndex(of: "--snapshot"), i + 1 < args.count {
    let out = args[i + 1]
    func value(_ key: String, _ fallback: String) -> String {
        guard let j = args.firstIndex(of: key), j + 1 < args.count else { return fallback }
        return args[j + 1]
    }
    let base = Paths.resolveSprites()
    guard let pd = PetData.load(spritesDir: base) else { print("no pet-data.json"); exit(1) }
    let lib = SpriteLibrary(base: base)
    let exprId = value("--expr", "idle")
    let line = value("--say", "Compacted: 84k -> 9k tok (89% smaller).")
    let scale = Int(value("--scale", "3")) ?? 3
    let side = CGFloat(pd.size * scale)
    // the app sizes the bubble from the pet: a snapshot at any other width
    // flatters the layout and hides how tight a real one is. --bubble overrides
    // it for a pack whose pet is smaller than the built-in one.
    let bubbleW: CGFloat = CGFloat(Double(value("--bubble", "")) ?? 0) > 0
        ? CGFloat(Double(value("--bubble", "0")) ?? 0)
        : max(200, side * 1.35)
    PixelFont.scale = PixelFont.forPetScale(scale)
    PixelFont.pixel = 0.5   // the snapshot bitmap is 2×
    let bv = BubbleView(frame: NSRect(x: 0, y: 0, width: bubbleW, height: 90))
    bv.text = line
    bv.alpha = 1
    // --thought renders the quieter variant, so the two bubbles can be compared
    // without a session.
    bv.thought = args.contains("--thought")
    let bubbleH = BubbleView.measure(line, width: bubbleW).height
    bv.frame = NSRect(x: 0, y: 0, width: bubbleW, height: bubbleH)
    let W = bubbleW + 40, H = bubbleH + side + 20
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(W * 2), pixelsHigh: Int(H * 2),
                               bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                               colorSpaceName: .deviceRGB, bytesPerRow: Int(W * 2) * 4, bitsPerPixel: 32)!
    rep.size = NSSize(width: W, height: H)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSColor(calibratedRed: 0.09, green: 0.10, blue: 0.13, alpha: 1).setFill()
    NSRect(x: 0, y: 0, width: W, height: H).fill()
    if let sprite = lib.image(exprId) {
        sprite.draw(in: NSRect(x: (W - side) / 2, y: 6, width: side, height: side),
                    from: .zero, operation: .sourceOver, fraction: 1,
                    respectFlipped: true, hints: [.interpolation: NSImageInterpolation.none.rawValue])
    }
    NSGraphicsContext.saveGraphicsState()
    let t = NSAffineTransform()
    t.translateX(by: (W - bubbleW) / 2, yBy: side + 2)
    t.concat()
    bv.draw(bv.bounds)
    NSGraphicsContext.restoreGraphicsState()
    NSGraphicsContext.restoreGraphicsState()
    try? rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
    print("snapshot: \(out)  expr=\(exprId)  screen=\(NSScreen.main?.visibleFrame.debugDescription ?? "?")")
    exit(0)
}

// Single instance, per state dir. A pid file is not enough: a crashed or
// --capture instance leaves a pid behind, and a recycled pid then either blocks
// a legitimate start or lets a second pet run. An advisory lock is released by
// the kernel however the process dies.
try? FileManager.default.createDirectory(at: Paths.state, withIntermediateDirectories: true)
let lockFD = open(Paths.state.appendingPathComponent("pet.lock").path, O_CREAT | O_RDWR, 0o644)
if lockFD >= 0, flock(lockFD, LOCK_EX | LOCK_NB) != 0 {
    print("BabyZillaPet already running for \(Paths.state.path)")
    exit(0)
}
// the CLI reads this to stop the right process
try? String(getpid()).write(to: Paths.state.appendingPathComponent("pet.pid"), atomically: true, encoding: .utf8)
atexit {
    try? FileManager.default.removeItem(at: Paths.state.appendingPathComponent("pet.pid"))
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
