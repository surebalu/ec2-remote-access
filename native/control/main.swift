// ec2ra-control: what EC2 Remote Access does to other apps on this Mac, and the Mac's calendars.
//
// The app (src/main/macControl.ts) starts one and keeps it for the run. It reads one JSON request per line on stdin,
// {"id":7,"op":"front"}, and answers each with one line on stdout: {"id":7,"ok":true,"result":…} or
// {"id":7,"ok":false,"error":"…","code":"accessibility"}. Ops:
//   status                       {accessibility, calendar}: what macOS allows now, asking nothing
//   askAccessibility             macOS's own "allow EC2 Remote Access to control this computer" question
//   front                        the app in front and its focused window's frame (global points, top-left origin)
//   setFrame {pid,x,y,w,h}       moves and sizes that app's focused window
//   fullscreen {pid} / minimize {pid}
//   toggleApp {path}             opens (or brings forward) an app, or hides it when it is already in front
//   paste                        presses ⌘V in the app in front (after the app put text on the clipboard)
//   calendars / askCalendar / events {from,to,calendars}   the calendars macOS has (Google, iCloud, Exchange…)
//
// Moving windows, pressing keys and reading which window is in front need the Accessibility permission, and macOS
// gives a helper the permission of the app that started it, so System Settings lists EC2 Remote Access itself.
// Nothing here asks for a permission except askAccessibility and askCalendar, which the app sends only on a click.

import AppKit
import ApplicationServices
import EventKit
import Foundation

let output = DispatchQueue(label: "ec2ra-control.output")

func send(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object), var line = String(data: data, encoding: .utf8) else { return }
  line += "\n"
  output.sync { FileHandle.standardOutput.write(line.data(using: .utf8)!) }
}

struct Failure: Error {
  let message: String
  var code = ""
}

func reply(_ id: Any, _ result: Any) { send(["id": id, "ok": true, "result": result]) }
func reply(_ id: Any, failure: Failure) { send(["id": id, "ok": false, "error": failure.message, "code": failure.code]) }

let needAccess = Failure(message: "EC2 Remote Access needs the Accessibility permission for this: System Settings → Privacy & Security → Accessibility.", code: "accessibility")

// MARK: - Windows

func attribute(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success ? value : nil
}

func frontPid() -> pid_t? {
  // The system-wide element names the app with the keyboard focus, current even without a run loop's notifications.
  let system = AXUIElementCreateSystemWide()
  if let app = attribute(system, kAXFocusedApplicationAttribute) {
    var pid: pid_t = 0
    if AXUIElementGetPid(app as! AXUIElement, &pid) == .success, pid > 0 { return pid }
  }
  return NSWorkspace.shared.frontmostApplication?.processIdentifier
}

func focusedWindow(_ pid: pid_t) -> AXUIElement? {
  let app = AXUIElementCreateApplication(pid)
  if let w = attribute(app, kAXFocusedWindowAttribute) { return (w as! AXUIElement) }
  if let w = attribute(app, kAXMainWindowAttribute) { return (w as! AXUIElement) }
  if let list = attribute(app, kAXWindowsAttribute) as? [AXUIElement], let first = list.first { return first }
  return nil
}

func frame(_ w: AXUIElement) -> CGRect? {
  guard let p = attribute(w, kAXPositionAttribute), let s = attribute(w, kAXSizeAttribute) else { return nil }
  var point = CGPoint.zero
  var size = CGSize.zero
  AXValueGetValue(p as! AXValue, .cgPoint, &point)
  AXValueGetValue(s as! AXValue, .cgSize, &size)
  return CGRect(origin: point, size: size)
}

func rectJson(_ r: CGRect) -> [String: Any] { ["x": r.origin.x, "y": r.origin.y, "w": r.size.width, "h": r.size.height] }

func front() throws -> [String: Any] {
  guard AXIsProcessTrusted() else { throw needAccess }
  guard let pid = frontPid() else { throw Failure(message: "No app is in front.") }
  let running = NSRunningApplication(processIdentifier: pid)
  var out: [String: Any] = ["pid": pid, "name": running?.localizedName ?? "", "bundleId": running?.bundleIdentifier ?? "", "path": running?.bundleURL?.path ?? ""]
  if let w = focusedWindow(pid), let r = frame(w) {
    out["window"] = rectJson(r).merging([
      "title": (attribute(w, kAXTitleAttribute) as? String) ?? "",
      "fullscreen": (attribute(w, "AXFullScreen") as? Bool) ?? false,
      "minimized": (attribute(w, kAXMinimizedAttribute) as? Bool) ?? false
    ]) { a, _ in a }
  }
  return out
}

func setPosition(_ w: AXUIElement, _ p: CGPoint) {
  var copy = p
  if let value = AXValueCreate(.cgPoint, &copy) { AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, value) }
}

func setSize(_ w: AXUIElement, _ s: CGSize) {
  var copy = s
  if let value = AXValueCreate(.cgSize, &copy) { AXUIElementSetAttributeValue(w, kAXSizeAttribute as CFString, value) }
}

func setFrame(_ pid: pid_t, _ r: CGRect) throws -> [String: Any] {
  guard AXIsProcessTrusted() else { throw needAccess }
  guard let w = focusedWindow(pid) else { throw Failure(message: "That app has no window to move.") }
  let app = AXUIElementCreateApplication(pid)
  // With AXEnhancedUserInterface on (set by assistive apps), some apps animate every change and land elsewhere.
  let enhanced = (attribute(app, "AXEnhancedUserInterface") as? Bool) ?? false
  if enhanced { AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanFalse) }
  // Size, then position, then size again: a window moving to another screen may be clamped to the old screen's size
  // first, and one growing at the old position may be pushed back inside the screen.
  setSize(w, r.size)
  setPosition(w, r.origin)
  setSize(w, r.size)
  if enhanced { AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue) }
  return frame(w).map(rectJson) ?? [:]
}

func toggleFullScreen(_ pid: pid_t) throws -> Bool {
  guard AXIsProcessTrusted() else { throw needAccess }
  guard let w = focusedWindow(pid) else { throw Failure(message: "That app has no window.") }
  let on = !((attribute(w, "AXFullScreen") as? Bool) ?? false)
  AXUIElementSetAttributeValue(w, "AXFullScreen" as CFString, on ? kCFBooleanTrue : kCFBooleanFalse)
  return on
}

func minimize(_ pid: pid_t) throws {
  guard AXIsProcessTrusted() else { throw needAccess }
  guard let w = focusedWindow(pid) else { throw Failure(message: "That app has no window.") }
  AXUIElementSetAttributeValue(w, kAXMinimizedAttribute as CFString, kCFBooleanTrue)
}

// MARK: - Apps and keys

func toggleApp(_ path: String, _ done: @escaping (Result<String, Failure>) -> Void) {
  let url = URL(fileURLWithPath: path)
  guard FileManager.default.fileExists(atPath: path) else { return done(.failure(Failure(message: "\(url.lastPathComponent) is no longer at \(path)."))) }
  let wanted = url.resolvingSymlinksInPath().standardizedFileURL.path
  if let pid = frontPid(), let running = NSRunningApplication(processIdentifier: pid),
     running.bundleURL?.resolvingSymlinksInPath().standardizedFileURL.path == wanted {
    running.hide()
    return done(.success("hidden"))
  }
  let config = NSWorkspace.OpenConfiguration()
  config.activates = true
  NSWorkspace.shared.openApplication(at: url, configuration: config) { app, error in
    if let error { done(.failure(Failure(message: "Could not open \(url.deletingPathExtension().lastPathComponent): \(error.localizedDescription)"))) }
    else {
      // Running already: opening it brings it forward, but its windows may stay behind until it is activated.
      app?.activate(options: [.activateAllWindows])
      done(.success("shown"))
    }
  }
}

func paste() throws {
  guard AXIsProcessTrusted() else { throw needAccess }
  let source = CGEventSource(stateID: .combinedSessionState)
  // kVK_ANSI_V. Posted at the HID level, as a real key press, so the app in front handles ⌘V its own way.
  let down = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: true)
  let up = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: false)
  down?.flags = .maskCommand
  up?.flags = .maskCommand
  down?.post(tap: .cghidEventTap)
  up?.post(tap: .cghidEventTap)
}

// MARK: - Calendars

var store: EKEventStore?

func calendarStatus() -> String {
  let s = EKEventStore.authorizationStatus(for: .event)
  if #available(macOS 14.0, *) {
    if s == .fullAccess { return "authorized" }
    if s == .writeOnly { return "writeOnly" }
  }
  switch s {
  case .authorized: return "authorized"
  case .denied: return "denied"
  case .restricted: return "restricted"
  case .notDetermined: return "notDetermined"
  default: return "unknown"
  }
}

func eventStore() throws -> EKEventStore {
  guard calendarStatus() == "authorized" else { throw Failure(message: "EC2 Remote Access may not read your calendars yet.", code: "calendar") }
  if let s = store { return s }
  let s = EKEventStore()
  store = s
  return s
}

func askCalendar(_ done: @escaping (String) -> Void) {
  let s = EKEventStore()
  let finish: (Bool, Error?) -> Void = { _, _ in
    // A store made before access was given sees nothing; the next read makes a new one.
    store = nil
    done(calendarStatus())
  }
  if #available(macOS 14.0, *) { s.requestFullAccessToEvents(completion: finish) }
  else { s.requestAccess(to: .event, completion: finish) }
}

func hex(_ color: NSColor?) -> String {
  guard let c = color?.usingColorSpace(.sRGB) else { return "" }
  return String(format: "#%02x%02x%02x", Int(round(c.redComponent * 255)), Int(round(c.greenComponent * 255)), Int(round(c.blueComponent * 255)))
}

func sourceKind(_ t: EKSourceType) -> String {
  switch t {
  case .local: return "local"
  case .exchange: return "exchange"
  case .calDAV: return "caldav"
  case .mobileMe: return "icloud"
  case .subscribed: return "subscribed"
  case .birthdays: return "birthdays"
  default: return "other"
  }
}

func calendars() throws -> [[String: Any]] {
  try eventStore().calendars(for: .event).map { c in
    ["id": c.calendarIdentifier, "title": c.title, "account": c.source?.title ?? "", "kind": sourceKind(c.source?.sourceType ?? .local), "color": hex(c.color), "writable": c.allowsContentModifications]
  }
}

func events(from: Double, to: Double, ids: [String]) throws -> [[String: Any]] {
  let s = try eventStore()
  let wanted = Set(ids)
  let cals = s.calendars(for: .event).filter { wanted.contains($0.calendarIdentifier) }
  if cals.isEmpty { return [] }
  let start = Date(timeIntervalSince1970: from / 1000)
  // EventKit answers at most four years at a time; the Calendar asks for weeks.
  let end = min(Date(timeIntervalSince1970: to / 1000), start.addingTimeInterval(4 * 365 * 86400))
  let found = s.events(matching: s.predicateForEvents(withStart: start, end: end, calendars: cals))
  return found.prefix(5000).map { e in
    var out: [String: Any] = [
      // A repeating event's occurrences share one identifier; its start tells them apart.
      "id": "\(e.calendarItemIdentifier)@\(Int64(e.startDate.timeIntervalSince1970))",
      "calendarId": e.calendar.calendarIdentifier,
      "title": e.title ?? "",
      "start": e.startDate.timeIntervalSince1970 * 1000,
      "end": e.endDate.timeIntervalSince1970 * 1000,
      "allDay": e.isAllDay
    ]
    if let l = e.location, !l.isEmpty { out["location"] = l }
    if let n = e.notes, !n.isEmpty { out["notes"] = String(n.prefix(4000)) }
    if let u = e.url { out["url"] = u.absoluteString }
    if e.status == .canceled { out["cancelled"] = true }
    return out
  }
}

// MARK: - Requests

func number(_ v: Any?) -> Double? { (v as? NSNumber)?.doubleValue }

func handle(_ req: [String: Any]) {
  let id = req["id"] ?? NSNull()
  let op = req["op"] as? String ?? ""
  do {
    switch op {
    case "status":
      reply(id, ["accessibility": AXIsProcessTrusted(), "calendar": calendarStatus()])
    case "askAccessibility":
      let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
      reply(id, AXIsProcessTrustedWithOptions(options))
    case "front":
      reply(id, try front())
    case "setFrame":
      guard let pid = number(req["pid"]), let x = number(req["x"]), let y = number(req["y"]), let w = number(req["w"]), let h = number(req["h"]) else { throw Failure(message: "setFrame needs pid, x, y, w and h.") }
      reply(id, try setFrame(pid_t(pid), CGRect(x: x, y: y, width: w, height: h)))
    case "fullscreen":
      guard let pid = number(req["pid"]) else { throw Failure(message: "fullscreen needs pid.") }
      reply(id, try toggleFullScreen(pid_t(pid)))
    case "minimize":
      guard let pid = number(req["pid"]) else { throw Failure(message: "minimize needs pid.") }
      try minimize(pid_t(pid))
      reply(id, true)
    case "toggleApp":
      guard let path = req["path"] as? String, path.hasPrefix("/") else { throw Failure(message: "toggleApp needs an app's path.") }
      toggleApp(path) { r in
        switch r {
        case .success(let v): reply(id, v)
        case .failure(let f): reply(id, failure: f)
        }
      }
    case "paste":
      try paste()
      reply(id, true)
    case "calendars":
      reply(id, try calendars())
    case "askCalendar":
      askCalendar { status in reply(id, status) }
    case "events":
      guard let from = number(req["from"]), let to = number(req["to"]) else { throw Failure(message: "events needs from and to.") }
      reply(id, try events(from: from, to: to, ids: req["calendars"] as? [String] ?? []))
    default:
      throw Failure(message: "Unknown request: \(op)")
    }
  } catch let f as Failure {
    reply(id, failure: f)
  } catch {
    reply(id, failure: Failure(message: error.localizedDescription))
  }
}

if CommandLine.arguments.contains("--status") {
  // For a quick look from a terminal: only reads, never asks.
  send(["accessibility": AXIsProcessTrusted(), "calendar": calendarStatus()])
  exit(0)
}

// Requests are read off the main thread and handled on it, where AppKit and the accessibility calls belong.
Thread.detachNewThread {
  while let line = readLine() {
    guard let data = line.data(using: .utf8), let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
    DispatchQueue.main.async { handle(req) }
  }
  // The app went away (or closed stdin): so does the helper, once what was asked before has been answered.
  DispatchQueue.main.async { exit(0) }
}
RunLoop.main.run()
