// The app's own words, in the pet's language.
//
// Menus, the chat window and the browser are the *app* talking, not the pet — but
// a German pet with an English menu is half a feature. Every string here is keyed
// by its English form: a missing translation falls back to the key, so the menu can
// never come up blank, and a new string only needs adding to this table to be
// translated.

import AppKit

struct L10n {
    let id: String

    init(_ raw: String?) {
        // Unknown or absent means English: config files are hand-edited, and a
        // typo must not produce a menu of untranslated keys.
        id = (raw == "de") ? "de" : "en"
    }

    var isGerman: Bool { id == "de" }

    func t(_ en: String) -> String {
        id == "de" ? (L10n.de[en] ?? en) : en
    }

    /// A line with a value in it, where word order differs between languages.
    func level(_ chatty: String) -> String {
        guard id == "de" else { return chatty }
        switch chatty {
        case "quiet": return "still"
        case "chatty": return "gesprächig"
        default: return "normal"
        }
    }

    private static let de: [String: String] = [
        // pet + menu bar
        "Pet": "Pet",
        "More pets…": "Mehr Pets…",
        // The action is about *any* pet, not the dino: a pack is a second look,
        // and a menu that keeps saying "Dino" after switching is a lie.
        "Show Pet": "Pet zeigen",
        "Hide Pet": "Pet verstecken",
        "Stay put": "Stehen bleiben",
        "Mute speech": "Sprache stumm",
        "Size": "Größe",
        "Wear": "Tragen",
        "Nothing": "Nichts",
        "Hats": "Hüte",
        "Heads": "Köpfe",
        "Hair": "Haare",
        "Faces": "Gesichter",
        "Masks": "Masken",
        "Back": "Rücken",
        "Main hand": "Rechte Hand",
        "Off hand": "Linke Hand",
        "Chairs": "Stühle",
        "Items": "Dinge",
        "Chattiness": "Gesprächigkeit",        "Language": "Sprache",
        "Open chat…": "Chat öffnen…",
        "Close chat": "Chat schließen",
        "Gallery…": "Galerie…",
        "Quit": "Beenden",

        // chat window
        "chat": "chat",
        "esc / click pet": "esc / Pet klicken",
        "nothing yet.": "noch nichts.",
        "nothing to do yet — babyzilla pet chat": "noch nichts — babyzilla pet chat",

        // language names stay in their own language: that is how a person finds
        // the one they read
        "English": "English",
        "Deutsch": "Deutsch",
        "English, then.": "Deutsch, bitte.",

        // the pet's own canned lines
        "Hey!": "Hey!",
        "Careful!": "Vorsicht!",
        "Put me down!": "Lass mich runter!",

        // browser
        "Pets": "Pets",
        "search 1300+ pets": "1300+ Pets durchsuchen",
        "Use pet": "Pet nehmen",
        "no catalog yet — fetching once…": "noch kein Katalog — wird einmal geholt…",
        "fetching the catalog (once)…": "Katalog wird geholt (einmal)…",
        "catalog fetch failed — is the network up?": "Katalog fehlgeschlagen — ist das Netz da?",
        "nothing matches": "nichts gefunden",
        "installed": "installiert",
        "double-click to install": "Doppelklick zum Installieren",
        "could not be loaded": "konnte nicht geladen werden",
        "install failed": "Installation fehlgeschlagen",
    ]

    /// "3 of 1312 pets · 2 installed"
    func count(_ shown: Int, _ total: Int, _ installed: Int) -> String {
        isGerman
            ? "\(shown) von \(total) Pets · \(installed) installiert"
            : "\(shown) of \(total) pets · \(installed) installed"
    }

    func installing(_ label: String) -> String {
        isGerman ? "\(label) wird von openpets.dev installiert…" : "installing \(label) from openpets.dev…"
    }

    func installedNote(_ label: String) -> String {
        isGerman ? "\(label) installiert — nochmal wählen" : "\(label) installed — pick it again"
    }
}

/// The language submenu. Both menus (the pet's own and the menu bar's) build it, so
/// a new language is one entry in `ids` and one row in the table above.
enum LanguageMenu {    /// In display order, with the names a person recognises without translating.
    static let ids = ["en", "de"]

    static func item(l10n: L10n, target: AnyObject, action: Selector,
                     current: String?) -> NSMenuItem {
        let active = current ?? "en"
        let title = NSMenuItem(title: l10n.t("Language"), action: nil, keyEquivalent: "")
        let sub = NSMenu()
        for id in ids {
            let item = NSMenuItem(title: l10n.t(id == "de" ? "Deutsch" : "English"),
                                  action: action, keyEquivalent: "")
            item.target = target
            item.representedObject = id
            item.state = active == id ? .on : .off
            sub.addItem(item)
        }
        title.submenu = sub
        return title
    }
}

/// The dress-up submenu: one entry per gear layer the active pack carries.
///
/// A pack only gets this menu when its sheet came with gear art, so the pet that
/// shipped with the plugin (and every OpenPets sheet) is unchanged. Groups are the
/// sheet's own folders — hats, masks, held items — because that is how the artist
/// organised them.
enum WearMenu {
    static func item(pack: PackData?, worn: [String: String], l10n: L10n, target: AnyObject,
                     action: Selector) -> NSMenuItem? {
        guard let gear = pack?.gear, !gear.items.isEmpty else { return nil }
        let title = NSMenuItem(title: l10n.t("Wear"), action: nil, keyEquivalent: "")
        let sub = NSMenu()

        // One "nothing" that takes every layer off, and one per group below: a pet
        // with a hat and a backpack needs to be able to keep the hat.
        let none = NSMenuItem(title: l10n.t("Nothing"), action: action, keyEquivalent: "")
        none.target = target
        none.representedObject = ""
        none.isEnabled = !worn.isEmpty
        sub.addItem(none)
        sub.addItem(.separator())

        var groups: [String] = []
        for item in gear.items where !groups.contains(item.group) { groups.append(item.group) }
        for group in groups {
            let groupItem = NSMenuItem(title: l10n.t(group), action: nil, keyEquivalent: "")
            let items = NSMenu()
            // A group in these packs is exactly one gear set: that is the slot.
            let set = gear.items.first { $0.group == group }?.set ?? ""
            let off = NSMenuItem(title: l10n.t("Nothing"), action: action, keyEquivalent: "")
            off.target = target
            off.representedObject = "\(set)|"
            off.state = worn[set] == nil ? .on : .off
            items.addItem(off)
            items.addItem(.separator())
            for wearItem in gear.items where wearItem.group == group {
                let row = NSMenuItem(title: wearItem.label, action: action, keyEquivalent: "")
                row.target = target
                row.representedObject = wearItem.id
                row.state = worn[set] == wearItem.id ? .on : .off
                items.addItem(row)
            }
            groupItem.submenu = items
            sub.addItem(groupItem)
        }
        title.submenu = sub
        return title
    }
}
