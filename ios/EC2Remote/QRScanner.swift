@preconcurrency import AVFoundation
import SwiftUI
import UIKit

/// Camera view that reports the first QR code it reads.
struct QRScanner: UIViewControllerRepresentable {
    var onCode: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let c = ScannerController()
        c.onCode = onCode
        return c
    }

    func updateUIViewController(_ controller: ScannerController, context: Context) {}

    final class ScannerController: UIViewController, @preconcurrency AVCaptureMetadataOutputObjectsDelegate {
        var onCode: ((String) -> Void)?
        private let session = AVCaptureSession()
        private var preview: AVCaptureVideoPreviewLayer?
        private var done = false

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black
            guard let device = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else {
                let label = UILabel()
                label.text = "Camera unavailable. Paste the link instead."
                label.textColor = .white
                label.textAlignment = .center
                label.numberOfLines = 0
                label.frame = view.bounds.insetBy(dx: 24, dy: 0)
                label.autoresizingMask = [.flexibleWidth, .flexibleHeight]
                view.addSubview(label)
                return
            }
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { return }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
            let layer = AVCaptureVideoPreviewLayer(session: session)
            layer.videoGravity = .resizeAspectFill
            view.layer.addSublayer(layer)
            preview = layer
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            preview?.frame = view.bounds
        }

        override func viewWillAppear(_ animated: Bool) {
            super.viewWillAppear(animated)
            // startRunning blocks; AVCaptureSession is documented as safe to drive from a background queue.
            nonisolated(unsafe) let s = session
            DispatchQueue.global(qos: .userInitiated).async { if !s.isRunning { s.startRunning() } }
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            nonisolated(unsafe) let s = session
            DispatchQueue.global(qos: .userInitiated).async { if s.isRunning { s.stopRunning() } }
        }

        func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
            guard !done, let code = (objects.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
            done = true
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            onCode?(code)
        }
    }
}

/// Pair with a computer: scan the QR code from Settings → Phone access, or paste the copied link.
struct PairingView: View {
    @EnvironmentObject var store: GatewayStore
    @Environment(\.dismiss) private var dismiss
    /// Shown as a sheet from Settings (has a Cancel button) or as the first screen.
    var isSheet = false
    @State private var scanning = false
    @State private var link = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    VStack(alignment: .leading, spacing: 8) {
                        Image("Logo").resizable().frame(width: 64, height: 64).clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                        Text("Connect to your Mac").font(.largeTitle.bold())
                        Text("EC2 Remote uses the EC2 Remote Access app on your Mac (or a gateway) to reach your instances. AWS credentials stay there; this phone never sees them.")
                            .foregroundStyle(.secondary)
                    }
                    VStack(alignment: .leading, spacing: 12) {
                        step(1, "On the Mac, open EC2 Remote Access → Settings → Phone access and turn it on.")
                        step(2, "Choose \u{201C}HTTPS via Tailscale\u{201D}, and have Tailscale running on both the Mac and this iPhone.")
                        step(3, "Scan the QR code shown there.")
                    }
                    Button { scanning = true } label: {
                        Label("Scan QR code", systemImage: "qrcode.viewfinder").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent).controlSize(.large).disabled(busy)

                    VStack(alignment: .leading, spacing: 8) {
                        Text("Or paste the link (Copy link in the Mac app)").font(.footnote).foregroundStyle(.secondary)
                        HStack {
                            TextField("https://your-mac.tailnet.ts.net/#token=…", text: $link)
                                .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                                .textFieldStyle(.roundedBorder).submitLabel(.go).onSubmit { pair(link) }
                            Button("Paste") { if let s = UIPasteboard.general.string { link = s; pair(s) } }
                        }
                        Button { pair(link) } label: { Text("Connect").frame(maxWidth: .infinity) }
                            .buttonStyle(.bordered).controlSize(.large).disabled(link.isEmpty || busy)
                    }
                    if busy { ProgressView("Checking the connection…") }
                    if let error { Text(error).foregroundStyle(.red).font(.callout) }
                }
                .padding(24)
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity)
            }
            .toolbar { if isSheet { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } } }
            .sheet(isPresented: $scanning) {
                NavigationStack {
                    QRScanner { code in scanning = false; pair(code) }
                        .ignoresSafeArea()
                        .navigationTitle("Scan QR code").navigationBarTitleDisplayMode(.inline)
                        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { scanning = false } } }
                }
            }
        }
    }

    private func step(_ n: Int, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text("\(n)").font(.callout.bold()).frame(width: 26, height: 26).background(Circle().fill(Color.accentColor.opacity(0.15)))
            Text(text).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func pair(_ text: String) {
        error = nil
        let g: Gateway
        do { g = try Pairing.parse(text) } catch { self.error = error.localizedDescription; return }
        busy = true
        Task {
            do {
                try await Pairing.verify(g)
                store.add(g)
                if isSheet { dismiss() }
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }
}
