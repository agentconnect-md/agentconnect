// The macOS menu bar indicator (computer-use.md §6): draws the menu the daemon sends on stdin, reports clicks on stdout.
import AppKit

struct Confirm: Decodable {
  let title: String
  let message: String
  let button: String
}

struct Item: Decodable {
  let id: String?
  let title: String
  let mark: String?
  let checked: Bool?
  let enabled: Bool?
  let separator: Bool?
  let confirm: Confirm?
}

struct Menu: Decodable {
  let tone: String
  let badge: String?
  let tooltip: String
  let items: [Item]
}

struct Update: Decodable {
  let menu: Menu?
}

func send(_ message: [String: String]) {
  guard var line = try? JSONSerialization.data(withJSONObject: message) else { return }
  line.append(0x0A)
  FileHandle.standardOutput.write(line)
}

// The AgentConnect mark (packages/web/src/app/icon.svg), greyed without authority, with the daemon's badge in its corner.
func icon(_ tone: String, badge: String? = nil, size: CGFloat = 18) -> NSImage {
  NSImage(size: NSSize(width: size, height: size), flipped: true) { _ in
    // Drawn on an 18-point grid, the menu bar's size, and scaled for the dialogs.
    let scale = NSAffineTransform()
    scale.scale(by: size / 18)
    scale.concat()
    let quadrants: [(NSPoint, NSPoint, NSColor)] = [
      (NSPoint(x: 9, y: 1), NSPoint(x: 17, y: 9), NSColor(red: 0.949, green: 0.776, blue: 0.290, alpha: 1)),
      (NSPoint(x: 17, y: 9), NSPoint(x: 9, y: 17), NSColor(red: 0.957, green: 0.475, blue: 0.227, alpha: 1)),
      (NSPoint(x: 9, y: 17), NSPoint(x: 1, y: 9), NSColor(red: 0.486, green: 0.235, blue: 0.635, alpha: 1)),
      (NSPoint(x: 1, y: 9), NSPoint(x: 9, y: 1), NSColor(red: 0.847, green: 0.247, blue: 0.588, alpha: 1)),
    ]
    for (from, to, color) in quadrants {
      let path = NSBezierPath()
      path.move(to: from)
      path.line(to: to)
      path.line(to: NSPoint(x: 9, y: 9))
      path.close()
      (tone == "unavailable" ? NSColor.systemGray : color).setFill()
      path.fill()
    }
    let fill: NSColor? =
      switch badge {
      case "busy": .systemOrange
      case "paused": .systemGray
      case "error": .systemRed
      default: nil
      }
    if let fill {
      // A transparent ring cuts the badge out of the mark, readable on light and dark menu bars.
      NSGraphicsContext.current?.compositingOperation = .clear
      NSBezierPath(ovalIn: NSRect(x: 8.5, y: 8.5, width: 10, height: 10)).fill()
      NSGraphicsContext.current?.compositingOperation = .sourceOver
      fill.setFill()
      NSBezierPath(ovalIn: NSRect(x: 10, y: 10, width: 8, height: 8)).fill()
      NSColor.white.setFill()
      if badge == "paused" {
        NSBezierPath(rect: NSRect(x: 12.3, y: 11.9, width: 1.2, height: 4.2)).fill()
        NSBezierPath(rect: NSRect(x: 14.5, y: 11.9, width: 1.2, height: 4.2)).fill()
      } else if badge == "error" {
        NSBezierPath(rect: NSRect(x: 13.4, y: 11.4, width: 1.2, height: 3.3)).fill()
        NSBezierPath(rect: NSRect(x: 13.4, y: 15.3, width: 1.2, height: 1.2)).fill()
      }
    }
    return true
  }
}

func markImage(_ mark: String) -> NSImage? {
  let (symbol, color): (String, NSColor) =
    switch mark {
    case "ok": ("checkmark.circle.fill", .systemGreen)
    case "fail": ("xmark.circle.fill", .systemRed)
    case "warn": ("exclamationmark.triangle.fill", .systemOrange)
    default: ("arrow.triangle.2.circlepath", .systemGray)
    }
  // A filled symbol takes two colours, its glyph then its shape; one colour would fill both into a plain dot.
  let config = NSImage.SymbolConfiguration(pointSize: 13, weight: .regular)
    .applying(NSImage.SymbolConfiguration(paletteColors: symbol.hasSuffix(".fill") ? [.white, color] : [color]))
  return NSImage(systemSymbolName: symbol, accessibilityDescription: mark)?.withSymbolConfiguration(config)
}

// The mark rides in the title, since macOS 26 and later menus do not draw an item's image beside its title.
func titled(_ title: String, mark: String, enabled: Bool) -> NSAttributedString {
  let font = NSFont.menuFont(ofSize: 0)
  let text = NSMutableAttributedString()
  if let image = markImage(mark) {
    let attachment = NSTextAttachment()
    attachment.image = image
    attachment.bounds = NSRect(x: 0, y: (font.capHeight - image.size.height) / 2, width: image.size.width, height: image.size.height)
    text.append(NSAttributedString(attachment: attachment))
  }
  let color: NSColor = enabled ? .labelColor : .secondaryLabelColor
  text.append(NSAttributedString(string: "  \(title)", attributes: [.font: font, .foregroundColor: color]))
  return text
}

final class Indicator: NSObject, NSMenuDelegate {
  private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
  private let menu = NSMenu()
  private var items: [Item] = []

  override init() {
    super.init()
    menu.autoenablesItems = false
    menu.delegate = self
    item.menu = menu
    apply(Menu(tone: "unavailable", badge: nil, tooltip: "AgentConnect Computer: starting", items: []))
  }

  func apply(_ update: Menu) {
    item.button?.image = icon(update.tone, badge: update.badge)
    item.button?.toolTip = update.tooltip
    item.button?.setAccessibilityLabel(update.tooltip)
    // An open menu is updated in place when its shape holds, so a refresh never closes it under the pointer.
    let sameShape =
      menu.items.count == update.items.count
      && zip(menu.items, update.items).allSatisfy { $0.isSeparatorItem == ($1.separator ?? false) }
    if !sameShape {
      menu.removeAllItems()
      for entry in update.items {
        menu.addItem(entry.separator == true ? .separator() : NSMenuItem(title: "", action: nil, keyEquivalent: ""))
      }
    }
    for (index, entry) in update.items.enumerated() where entry.separator != true {
      let row = menu.items[index]
      row.title = entry.title
      row.tag = index
      row.target = self
      row.action = entry.id == nil ? nil : #selector(clicked(_:))
      row.isEnabled = entry.id != nil && (entry.enabled ?? true)
      row.state = entry.checked == true ? .on : .off
      row.attributedTitle = entry.mark.map { titled(entry.title, mark: $0, enabled: row.isEnabled) }
    }
    items = update.items
  }

  func menuWillOpen(_ menu: NSMenu) {
    send(["action": "menu-open"])
  }

  @objc private func clicked(_ sender: NSMenuItem) {
    guard sender.tag < items.count, let id = items[sender.tag].id else { return }
    if let confirm = items[sender.tag].confirm {
      NSApp.activate(ignoringOtherApps: true)
      let alert = NSAlert()
      alert.icon = icon("online", size: 64)
      alert.messageText = confirm.title
      alert.informativeText = confirm.message
      alert.addButton(withTitle: confirm.button)
      alert.addButton(withTitle: "Cancel")
      guard alert.runModal() == .alertFirstButtonReturn else { return }
    }
    send(["action": "click", "id": id])
  }
}

// macOS quits the whole app after a grant change ("Quit & Reopen", tccutil reset); only a daemon restart applies it.
final class Delegate: NSObject, NSApplicationDelegate {
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    send(["action": "restart"])
    return .terminateNow
  }
}

let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
let indicator = Indicator()
Thread {
  while let line = readLine() {
    guard let update = try? JSONDecoder().decode(Update.self, from: Data(line.utf8)), let menu = update.menu else { continue }
    DispatchQueue.main.async { indicator.apply(menu) }
  }
  // The daemon is gone, so its indicator must go too.
  DispatchQueue.main.async { exit(0) }
}.start()
app.run()
