// ── pet browser ──────────────────────────────────────────────────────────────
//
// The Pet menu can only list what is already on disk, which on a fresh install
// was one legacy pet: there was no way to *choose* from OpenPets without a
// terminal. This is that way — a list of every pet in the cached catalog plus the
// packs already installed, with search, and an install that happens when you pick
// one.
//
// The app is a login item, not a shell: it has no PATH, so it cannot call `node`
// or the CLI by name. `pet install` pins both in cli.json and this reads them back
// — the same lesson as the lowfat report, one layer down.

import AppKit

/// Where the CLI is, and how to run it without a shell.
enum PetCLI {
    static func locate() -> (node: String, script: String)? {
        let file = Paths.state.appendingPathComponent("cli.json")
        guard let data = try? Data(contentsOf: file),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let node = obj["node"] as? String,
              let script = obj["cli"] as? String,
              FileManager.default.isExecutableFile(atPath: node),
              FileManager.default.fileExists(atPath: script) else { return nil }
        return (node, script)
    }

    /// Run the CLI off the main thread and come back on it with status + output.
    static func run(_ args: [String], then done: @escaping (Int32, String) -> Void) {
        guard let paths = locate() else {
            done(127, "cli.json is missing or stale — run: babyzilla pet install")
            return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: paths.node)
        p.arguments = [paths.script] + args
        var env = ProcessInfo.processInfo.environment
        // launchd's PATH has neither node's directory nor the user's bin. Keep it
        // short and explicit instead of hoping a profile ran.
        env["PATH"] = "\(URL(fileURLWithPath: paths.node).deletingLastPathComponent().path):/usr/bin:/bin:/usr/sbin:/sbin"
        env["BABYZILLA_NO_UPDATE_CHECK"] = "1"
        p.environment = env
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        p.terminationHandler = { proc in
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let text = String(data: data, encoding: .utf8) ?? ""
            DispatchQueue.main.async { done(proc.terminationStatus, text) }
        }
        do {
            try p.run()
        } catch {
            done(126, "could not run \(paths.node): \(error.localizedDescription)")
        }
    }
}

/// One row of the browser.
struct BrowserPet {
    let id: String
    let label: String
    let category: String
    let installed: Bool
    let featured: Bool
}

/// The cached OpenPets index. Fetched by the CLI (`pet catalog`), read here.
enum CatalogCache {
    static var file: URL { Paths.state.appendingPathComponent("catalog.v3.json") }

    static func load() -> [[String: Any]] {
        guard let data = try? Data(contentsOf: file),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let pets = obj["pets"] as? [[String: Any]] else { return [] }
        return pets
    }
}

final class PetBrowserWindow: NSPanel {
    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 460, height: 430),
                   styleMask: [.titled, .closable, .resizable],
                   backing: .buffered, defer: false)
        title = "Pets"
        isReleasedWhenClosed = false
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        hidesOnDeactivate = false
    }

    override var canBecomeKey: Bool { true }

    override func cancelOperation(_ sender: Any?) { orderOut(nil) }
}

final class PetBrowser: NSObject, NSTableViewDataSource, NSTableViewDelegate, NSSearchFieldDelegate {
    static let shared = PetBrowser()

    private var window: PetBrowserWindow!
    private var search: NSSearchField!
    private var table: NSTableView!
    private var status: NSTextField!
    private var useButton: NSButton!
    private var spinner: NSProgressIndicator!

    private var installed: [(id: String, label: String)] = []
    private var catalog: [[String: Any]] = []
    private var rows: [BrowserPet] = []
    private var shown: [BrowserPet] = []
    private var active: String?
    private var busy = false
    private var fetchedOnce = false
    /// Called with a pack id; returns false when the pack is not there to switch to.
    private var onUse: ((String) -> Bool)?
    private var l10n = L10n("en")
    /// Only used by `--browse-install`: reports the outcome and lets the test exit.
    private var onInstalled: ((String, Bool) -> Void)?

    var isOpen: Bool { window?.isVisible ?? false }

    func show(installed: [(id: String, label: String)], active: String?, prefill: String = "",
              l10n: L10n = L10n("en"), onUse: @escaping (String) -> Bool) {
        self.installed = installed
        self.active = active
        self.onUse = onUse
        self.l10n = l10n
        build()
        reload()
        if !prefill.isEmpty {
            search.stringValue = prefill
            applyFilter()
        }
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        if catalog.isEmpty { fetchCatalogIfNeeded() }
        window.makeFirstResponder(search)
    }

    // ── layout ─────────────────────────────────────────────────────────────
    private func build() {
        guard window == nil else { return }
        let win = PetBrowserWindow()
        win.title = l10n.t("Pets")
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 460, height: 430))
        content.autoresizingMask = [.width, .height]

        let field = NSSearchField(frame: NSRect(x: 14, y: 386, width: 432, height: 26))
        field.autoresizingMask = [.width, .minYMargin]
        field.placeholderString = l10n.t("search 1300+ pets")
        field.delegate = self
        field.sendsSearchStringImmediately = true
        content.addSubview(field)

        let scroll = NSScrollView(frame: NSRect(x: 14, y: 56, width: 432, height: 320))
        scroll.autoresizingMask = [.width, .height]
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        scroll.drawsBackground = true

        let tv = NSTableView()
        tv.headerView = nil
        tv.rowHeight = 22
        tv.usesAlternatingRowBackgroundColors = true
        tv.allowsMultipleSelection = false
        tv.target = self
        tv.doubleAction = #selector(useSelected)
        let col = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("pet"))
        col.width = 400
        tv.addTableColumn(col)
        tv.dataSource = self
        tv.delegate = self
        scroll.documentView = tv
        content.addSubview(scroll)

        let label = NSTextField(labelWithString: "")
        label.frame = NSRect(x: 14, y: 20, width: 306, height: 18)
        label.autoresizingMask = [.width, .maxYMargin]
        label.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        label.textColor = .secondaryLabelColor
        label.lineBreakMode = .byTruncatingTail
        content.addSubview(label)

        let spin = NSProgressIndicator(frame: NSRect(x: 312, y: 19, width: 16, height: 16))
        spin.style = .spinning
        spin.controlSize = .small
        spin.isDisplayedWhenStopped = false
        spin.autoresizingMask = [.minXMargin, .maxYMargin]
        content.addSubview(spin)

        let use = NSButton(title: l10n.t("Use pet"), target: self, action: #selector(useSelected))
        // wide enough for "Pet nehmen": a truncated button is a broken button
        use.frame = NSRect(x: 332, y: 14, width: 114, height: 26)
        use.bezelStyle = .rounded
        use.autoresizingMask = [.minXMargin, .maxYMargin]
        use.keyEquivalent = "\r"
        content.addSubview(use)

        win.contentView = content
        window = win
        search = field
        table = tv
        status = label
        useButton = use
        spinner = spin
    }

    // ── data ───────────────────────────────────────────────────────────────
    private func reload() {
        installed = Packs.available()
        catalog = CatalogCache.load()

        let installedIds = Set(installed.map(\.id))
        var list: [BrowserPet] = installed.map {
            BrowserPet(id: $0.id, label: $0.label, category: "installed", installed: true, featured: false)
        }
        var seen = installedIds
        for entry in catalog {
            guard let id = entry["id"] as? String, !id.isEmpty, !seen.contains(id) else { continue }
            seen.insert(id)
            list.append(BrowserPet(
                id: id,
                label: (entry["displayName"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? id,
                category: (entry["category"] as? String) ?? "",
                installed: false,
                featured: entry["featured"] as? Bool ?? false
            ))
        }
        // installed first, then the featured shelf, then alphabetical — the same
        // order the catalog uses for a reason
        list.sort { a, b in
            if a.installed != b.installed { return a.installed }
            if a.featured != b.featured { return a.featured }
            return a.label.localizedCaseInsensitiveCompare(b.label) == .orderedAscending
        }
        rows = list
        applyFilter()
        updateStatus()
    }

    private func applyFilter() {
        let needle = search?.stringValue.trimmingCharacters(in: .whitespaces).lowercased() ?? ""
        shown = needle.isEmpty ? rows : rows.filter {
            $0.id.lowercased().contains(needle) || $0.label.lowercased().contains(needle)
        }
        table?.reloadData()
        if !shown.isEmpty, (table?.selectedRow ?? -1) < 0 {
            table?.selectRowIndexes([0], byExtendingSelection: false)
        }
        updateStatus()
    }

    private func updateStatus() {
        guard let label = status else { return }
        if busy { return }
        if catalog.isEmpty {
            label.stringValue = l10n.t("no catalog yet — fetching once…")
            return
        }
        label.stringValue = shown.isEmpty
            ? l10n.t("nothing matches")
            : l10n.count(shown.count, rows.count, installed.count)
    }

    private func fetchCatalogIfNeeded() {
        guard !busy, catalog.isEmpty else { return }
        busy = true
        spinner.startAnimation(nil)
        status.stringValue = l10n.t("fetching the catalog (once)…")
        PetCLI.run(["pet", "catalog"]) { [weak self] code, text in
            guard let self else { return }
            self.busy = false
            self.spinner.stopAnimation(nil)
            if code != 0 {
                self.status.stringValue = self.l10n.t("catalog fetch failed — is the network up?")
                self.noteLast(text)
                return
            }
            self.fetchedOnce = true
            self.reload()
        }
    }

    private func noteLast(_ text: String) {
        let last = text.split(separator: "\n").map(String.init).last { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        if let last { status.toolTip = last }
    }

    private func choose(row: Int) {
        guard !busy, row >= 0, row < shown.count else { return }
        let pet = shown[row]
        if pet.installed {
            let switched = onUse?(pet.id) == true
            onInstalled?(pet.id, switched)
            if switched { close() }
            else { status.stringValue = "\(pet.label) \(l10n.t("could not be loaded"))" }
            return
        }
        install(pet)
    }

    private func install(_ pet: BrowserPet) {
        busy = true
        spinner.startAnimation(nil)
        useButton.isEnabled = false
        status.stringValue = l10n.installing(pet.label)
        PetCLI.run(["pet", "add", pet.id]) { [weak self] code, text in
            guard let self else { return }
            self.spinner.stopAnimation(nil)
            self.useButton.isEnabled = true
            self.busy = false
            guard code == 0, Packs.directory(pet.id) != nil else {
                self.status.stringValue = "\(self.l10n.t("install failed")) — \(pet.id)"
                self.noteLast(text)
                self.onInstalled?(pet.id, false)
                return
            }
            let switched = self.onUse?(pet.id) == true
            self.onInstalled?(pet.id, switched)
            if switched { self.close() }
            else { self.reload(); self.status.stringValue = self.l10n.installedNote(pet.label) }
        }
    }

    /// Headless probe: choose a row exactly as a click would, so the download +
    /// convert + switch path can be verified without a mouse.
    func chooseById(_ id: String, then done: @escaping (String, Bool) -> Void) {
        onInstalled = done
        guard let index = shown.firstIndex(where: { $0.id == id }) else {
            print("browse: no pet \(id) in the list")
            done(id, false)
            return
        }
        choose(row: index)
    }

    @objc private func useSelected() {
        let row = table.selectedRow
        choose(row: row)
    }

    @objc private func close() {
        window?.orderOut(nil)
    }

    // ── table ──────────────────────────────────────────────────────────────
    func numberOfRows(in tableView: NSTableView) -> Int { shown.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard row < shown.count else { return nil }
        let pet = shown[row]
        let id = NSUserInterfaceItemIdentifier("cell")
        let cell: NSTableCellView
        if let reused = tableView.makeView(withIdentifier: id, owner: self) as? NSTableCellView {
            cell = reused
        } else {
            cell = NSTableCellView()
            cell.identifier = id
            let text = NSTextField(labelWithString: "")
            text.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
            text.lineBreakMode = .byTruncatingTail
            text.frame = NSRect(x: 6, y: 2, width: 380, height: 18)
            text.autoresizingMask = [.width]
            cell.addSubview(text)
            cell.textField = text
        }
        let mark = pet.id == active ? "● " : (pet.installed ? "· " : "  ")
        let tail = pet.installed ? "" : "   \(pet.category)"
        cell.textField?.stringValue = "\(mark)\(pet.label)\(tail)"
        cell.textField?.toolTip = pet.installed ? l10n.t("installed") : l10n.t("Use pet")
        return cell
    }

    /// Draw the window into a PNG. A screenshot needs a screen permission this
    /// setup does not have; `cacheDisplay` renders the same hierarchy without one.
    func snapshot(to path: String) -> Bool {
        guard let view = window?.contentView else { return false }
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return false }
        view.cacheDisplay(in: view.bounds, to: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else { return false }
        do { try png.write(to: URL(fileURLWithPath: path)); return true } catch { return false }
    }

    // ── search ─────────────────────────────────────────────────────────────
    func controlTextDidChange(_ obj: Notification) {
        applyFilter()
    }
}
