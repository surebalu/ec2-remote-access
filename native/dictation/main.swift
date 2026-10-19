// ec2ra-dictate: voice dictation for EC2 Remote Access, using Apple's speech recognizer.
//
// The app (src/main/voice.ts) runs one of these per dictation. It writes JSON lines to stdout:
//   {"type":"ready","onDevice":true}       listening (onDevice: the audio stays on this Mac)
//   {"type":"partial","text":"…"}          the transcript so far, replaced by the next one
//   {"type":"final","text":"…"}            the finished transcript, then the process exits 0
//   {"type":"level","level":0.42}          microphone level 0…1, about every 60 ms, for the waveform
//   {"type":"error","message":"…"}         something the user can act on, then a non-zero exit
// and reads stdin: "stop" ends the audio and sends the final text; "cancel" exits at once without one.
//
//   ec2ra-dictate --status [--locale en-US]   prints {"type":"status",…} and exits WITHOUT asking for any permission
//   ec2ra-dictate [--locale en-US]            asks for microphone and speech recognition access if needed, then listens
//
// Chromium's Web Speech API has no recognizer inside Electron, and sending audio to a cloud service would break the
// app's privacy promise, so recognition runs on the Mac (requiresOnDeviceRecognition) whenever the language supports
// it; otherwise Apple's speech service does it, and "ready" says so.

import AVFoundation
import Foundation
import Speech

let output = DispatchQueue(label: "ec2ra-dictate.output")

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object), var line = String(data: data, encoding: .utf8) else { return }
  line += "\n"
  output.sync { FileHandle.standardOutput.write(line.data(using: .utf8)!) }
}

func fail(_ message: String, code: Int32 = 1) -> Never {
  emit(["type": "error", "message": message])
  exit(code)
}

// MARK: - Arguments

var localeId: String?
var statusOnly = false
var args = CommandLine.arguments.dropFirst().makeIterator()
while let a = args.next() {
  switch a {
  case "--status": statusOnly = true
  case "--locale": localeId = args.next()
  default: break
  }
}
if let l = localeId, l.isEmpty { localeId = nil }
let locale = localeId.map { Locale(identifier: $0) } ?? Locale.current

func speechStatus() -> String {
  switch SFSpeechRecognizer.authorizationStatus() {
  case .authorized: return "authorized"
  case .denied: return "denied"
  case .restricted: return "restricted"
  case .notDetermined: return "notDetermined"
  @unknown default: return "unknown"
  }
}

func micStatus() -> String {
  switch AVCaptureDevice.authorizationStatus(for: .audio) {
  case .authorized: return "authorized"
  case .denied: return "denied"
  case .restricted: return "restricted"
  case .notDetermined: return "notDetermined"
  @unknown default: return "unknown"
  }
}

let recognizer = SFSpeechRecognizer(locale: locale)

/** en_US → en-US, the form the app stores and passes back with --locale. */
func bcp47(_ l: Locale) -> String { l.identifier.replacingOccurrences(of: "_", with: "-") }

if statusOnly {
  // Only reads the current state: nothing here may raise a permission prompt.
  emit([
    "type": "status",
    "speech": speechStatus(),
    "mic": micStatus(),
    "supported": recognizer != nil,
    "available": recognizer?.isAvailable ?? false,
    "onDevice": recognizer?.supportsOnDeviceRecognition ?? false,
    "locale": bcp47(recognizer?.locale ?? locale),
    // For the language list in Settings → Voice.
    "locales": SFSpeechRecognizer.supportedLocales().map(bcp47).sorted()
  ])
  exit(0)
}

guard let recognizer else {
  fail("Dictation is not available for \(bcp47(locale)). Pick another language in Settings → Voice.")
}

// MARK: - Listening

let engine = AVAudioEngine()
let request = SFSpeechAudioBufferRecognitionRequest()
var task: SFSpeechRecognitionTask?
var lastText = ""
var stopping = false
var finished = false

/** Sends the final text once and exits; later callbacks (an error after endAudio, the fallback timer) do nothing. */
func finish(_ text: String) {
  DispatchQueue.main.async {
    if finished { return }
    finished = true
    emit(["type": "final", "text": text])
    exit(0)
  }
}

func stop() {
  if stopping || finished { return }
  stopping = true
  engine.stop()
  engine.inputNode.removeTap(onBus: 0)
  request.endAudio()
  // The recognizer usually answers within a few hundred milliseconds; if it does not, keep what was heard.
  DispatchQueue.main.asyncAfter(deadline: .now() + 2) { finish(lastText) }
}

func describe(_ error: Error) -> String {
  let e = error as NSError
  // kAFAssistantErrorDomain 1110: nothing was said; 1700/1101: the on-device model or service is unavailable.
  if e.code == 1110 { return "No speech was heard. Check the microphone in System Settings → Sound → Input." }
  if e.code == 1700 || e.code == 1101 { return "Speech recognition is unavailable right now. Turn on Dictation in System Settings → Keyboard to download the language, or try again in a moment." }
  return "Speech recognition stopped: \(e.localizedDescription)"
}

func listen() {
  request.shouldReportPartialResults = true
  if #available(macOS 13.0, *) { request.addsPunctuation = true }
  let onDevice = recognizer.supportsOnDeviceRecognition
  if onDevice { request.requiresOnDeviceRecognition = true }

  let input = engine.inputNode
  let format = input.outputFormat(forBus: 0)
  guard format.sampleRate > 0, format.channelCount > 0 else {
    fail("No microphone found. Connect one or pick it in System Settings → Sound → Input.", code: 3)
  }
  var lastLevel = CFAbsoluteTimeGetCurrent()
  input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
    request.append(buffer)
    let now = CFAbsoluteTimeGetCurrent()
    guard now - lastLevel >= 0.06, let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
    lastLevel = now
    var sum: Float = 0
    for i in 0..<Int(buffer.frameLength) { sum += samples[i] * samples[i] }
    let rms = (sum / Float(buffer.frameLength)).squareRoot()
    // -55 dB (a quiet room) … -10 dB (speaking up close) onto 0…1.
    let db = 20 * log10(max(rms, 0.000_001))
    let level = min(1, max(0, (db + 55) / 45))
    emit(["type": "level", "level": (Double(level) * 100).rounded() / 100])
  }
  engine.prepare()
  do {
    try engine.start()
  } catch {
    fail("The microphone could not be started: \(error.localizedDescription)", code: 3)
  }

  task = recognizer.recognitionTask(with: request) { result, error in
    if let result {
      let text = result.bestTranscription.formattedString
      DispatchQueue.main.async {
        lastText = text
        if result.isFinal { finish(text) } else if !finished { emit(["type": "partial", "text": text]) }
      }
    }
    if let error {
      DispatchQueue.main.async {
        if finished { return }
        // After "stop" an error just means the recognizer is done; keep what it heard.
        if stopping || !lastText.isEmpty { finish(lastText); return }
        fail(describe(error))
      }
    }
  }
  emit(["type": "ready", "onDevice": onDevice])
}

// Commands from the app. End of input means the app went away: stop listening rather than linger.
Thread.detachNewThread {
  while let line = readLine() {
    switch line.trimmingCharacters(in: .whitespacesAndNewlines) {
    case "stop": DispatchQueue.main.async { stop() }
    case "cancel": exit(0)
    default: break
    }
  }
  exit(0)
}

AVCaptureDevice.requestAccess(for: .audio) { micAllowed in
  guard micAllowed else {
    fail("Microphone access is off for EC2 Remote Access. Turn it on in System Settings → Privacy & Security → Microphone.", code: 2)
  }
  SFSpeechRecognizer.requestAuthorization { status in
    guard status == .authorized else {
      fail("Speech recognition is off for EC2 Remote Access. Turn it on in System Settings → Privacy & Security → Speech Recognition.", code: 2)
    }
    DispatchQueue.main.async {
      // Released before the permissions came back: nothing was recorded.
      if stopping { finish(""); return }
      guard recognizer.isAvailable else {
        fail("Speech recognition is unavailable right now. Check your internet connection or turn on Dictation in System Settings → Keyboard.")
      }
      listen()
    }
  }
}

dispatchMain()
