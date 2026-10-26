// The macOS menu bar indicator (computer-use.md §6): stdin {"state"} lines in, stdout {"action"} lines out, EOF quits.
import AppKit

struct TrayState: Decodable {
  let tone: String
  let status: String
  let canStop: Bool
  let canResume: Bool
  let hotkeyLabel: String?
}

struct Update: Decodable {
  let state: TrayState?
}

func send(_ action: String) {
  FileHandle.standardOutput.write(Data("{\"action\":\"\(action)\"}\n".utf8))
}

// The AgentConnect mark (packages/web/src/app/icon.svg), with a badge for agent control or a pause and greyed without authority.
func icon(_ tone: String) -> NSImage {
  let image = NSImage(size: NSSize(width: 18, height: 18), flipped: true) { _ in
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
      (tone == "online" || tone == "busy" || tone == "paused" ? color : NSColor.systemGray).setFill()
      path.fill()
    }
    let badge: NSColor? = tone == "busy" ? .systemOrange : tone == "paused" ? .systemRed : nil
    if let badge {
      // A transparent ring cuts the badge out of the mark, readable on light and dark menu bars.
      NSGraphicsContext.current?.compositingOperation = .clear
      NSBezierPath(ovalIn: NSRect(x: 9.5, y: 9.5, width: 9, height: 9)).fill()
      NSGraphicsContext.current?.compositingOperation = .sourceOver
      badge.setFill()
      NSBezierPath(ovalIn: NSRect(x: 11, y: 11, width: 6.5, height: 6.5)).fill()
    }
    return true
  }
  return image
}

final class Indicator: NSObject {
  private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
  private let statusLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
  private let stop = NSMenuItem(title: "Stop all agent input", action: #selector(stopClicked), keyEquivalent: "")
  private let resume = NSMenuItem(title: "Resume agent input", action: #selector(resumeClicked), keyEquivalent: "")

  override init() {
    super.init()
    let menu = NSMenu()
    menu.autoenablesItems = false
    statusLine.isEnabled = false
    stop.target = self
    resume.target = self
    menu.addItem(NSMenuItem(title: "AgentConnect Computer", action: nil, keyEquivalent: ""))
    menu.addItem(statusLine)
    menu.addItem(.separator())
    menu.addItem(stop)
    menu.addItem(resume)
    menu.items[0].isEnabled = false
    item.menu = menu
    apply(TrayState(tone: "unavailable", status: "starting", canStop: false, canResume: false, hotkeyLabel: nil))
  }

  func apply(_ state: TrayState) {
    let title = "AgentConnect Computer: \(state.status)"
    item.button?.image = icon(state.tone)
    item.button?.setAccessibilityLabel(title)
    item.button?.toolTip = title
    statusLine.title = "Agents: \(state.status)"
    stop.title = "Stop all agent input" + (state.hotkeyLabel.map { " (\($0))" } ?? "")
    stop.isEnabled = state.canStop
    resume.isHidden = !state.canResume
  }

  @objc private func stopClicked() { send("stop") }
  @objc private func resumeClicked() { send("resume") }
}

// macOS quits the whole app after a grant change ("Quit & Reopen", tccutil reset); only a daemon restart applies it.
final class Delegate: NSObject, NSApplicationDelegate {
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    send("restart")
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
    guard let update = try? JSONDecoder().decode(Update.self, from: Data(line.utf8)), let state = update.state else { continue }
    DispatchQueue.main.async { indicator.apply(state) }
  }
  // The daemon is gone, so its indicator must go too.
  DispatchQueue.main.async { exit(0) }
}.start()
app.run()
