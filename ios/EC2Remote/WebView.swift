import SwiftUI
import UIKit
import WebKit

/// Owns the WKWebView that shows the gateway's UI, and reports load state to SwiftUI.
@MainActor
final class WebController: NSObject, ObservableObject {
    enum Phase: Equatable { case loading, ready, failed(String) }

    @Published var phase: Phase = .loading
    /// Open terminals / desktops / file browsers, as reported by the page (keeps the screen awake while > 0).
    @Published var sessionCount = 0
    @Published var shareURL: URL?
    var onOpenSettings: () -> Void = {}
    @AppStorage("keepAwake") var keepAwake = true

    let webView: WKWebView
    private(set) var gateway: Gateway?
    private var pendingDownloads: [ObjectIdentifier: URL] = [:]
    /// Last fold sent to the page, as JSON ("null" when there is none), so layout passes don't resend it.
    private var sentFold = ""

    override init() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.preferences.javaScriptCanOpenWindowsAutomatically = true
        config.defaultWebpagePreferences.preferredContentMode = .mobile
        config.dataDetectorTypes = []
        webView = FoldAwareWebView(frame: .zero, configuration: config)
        super.init()
        (webView as? FoldAwareWebView)?.onLayout = { [weak self] in self?.reportFold() }
        config.userContentController.add(WeakScriptHandler(self), name: "ec2ra")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.backgroundColor = .systemBackground
        webView.scrollView.bounces = false
        // The page lays itself out around the notch and home indicator with env(safe-area-inset-*).
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        #if DEBUG
        webView.isInspectable = true
        #endif
        KeyboardAccessory.hide(in: webView)
    }

    func open(_ g: Gateway) {
        guard g != gateway else { return }
        gateway = g
        reload()
    }

    func reload() {
        guard let g = gateway else { return }
        phase = .loading
        webView.load(URLRequest(url: g.appURL, cachePolicy: .reloadRevalidatingCacheData, timeoutInterval: 15))
    }

    /// Tells the page where the screen folds (iPhone Duo in the book or tabletop pose), in its CSS pixels, which match
    /// the web view's points because the page is laid out at device width with no zoom.
    func reportFold(force: Bool = false) {
        var json = "null"
        if #available(iOS 27.1, *), let fold = webView.reservedRegions(kind: .division).first(where: { $0.isActive }) {
            let f = fold.frame
            json = String(format: "{\"x\":%.1f,\"y\":%.1f,\"width\":%.1f,\"height\":%.1f}", f.minX, f.minY, f.width, f.height)
        }
        guard force || json != sentFold, phase == .ready else { return }
        sentFold = json
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('ec2ra:fold', { detail: \(json) }))")
    }

    fileprivate func receive(_ body: Any) {
        guard let m = body as? [String: Any], let type = m["type"] as? String else { return }
        switch type {
        case "settings":
            onOpenSettings()
        case "sessions":
            sessionCount = m["count"] as? Int ?? 0
            updateIdleTimer()
        default:
            break
        }
    }

    func updateIdleTimer() {
        UIApplication.shared.isIdleTimerDisabled = keepAwake && sessionCount > 0
    }

    private func isGatewayURL(_ url: URL?) -> Bool {
        guard let url, let g = gateway else { return false }
        if url.scheme == "blob" || url.scheme == "about" || url.scheme == "data" { return true }
        return url.host == g.baseURL.host && url.port == g.baseURL.port
    }

    private static func describe(_ error: Error) -> String {
        let e = error as NSError
        switch (e.domain, e.code) {
        case (NSURLErrorDomain, NSURLErrorTimedOut), (NSURLErrorDomain, NSURLErrorCannotConnectToHost), (NSURLErrorDomain, NSURLErrorCannotFindHost),
             (NSURLErrorDomain, NSURLErrorNetworkConnectionLost), (NSURLErrorDomain, NSURLErrorDNSLookupFailed):
            return "The computer didn't answer. Make sure EC2 Remote Access is running and the Mac is awake, and that Tailscale is connected on this \(Device.name)."
        case (NSURLErrorDomain, NSURLErrorNotConnectedToInternet):
            return "This \(Device.name) is offline."
        case (NSURLErrorDomain, NSURLErrorSecureConnectionFailed), (NSURLErrorDomain, NSURLErrorServerCertificateUntrusted):
            return "The secure connection failed. In the Mac app, check Settings → Phone access shows an https:// link."
        default:
            return e.localizedDescription
        }
    }
}

extension WebController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload { decisionHandler(.download); return }
        if isGatewayURL(action.request.url) || action.request.url == nil { decisionHandler(.allow); return }
        // AWS sign-in pages, docs and anything else off the gateway open in Safari, never inside the app.
        if let url = action.request.url { UIApplication.shared.open(url) }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        phase = .ready
        reportFold(force: true)
        #if DEBUG
        // UI automation for simulator runs: SIMCTL_CHILD_EC2R_EVAL="<js>" xcrun simctl launch … runs it after load.
        if let js = ProcessInfo.processInfo.environment["EC2R_EVAL"] { webView.evaluateJavaScript(js) }
        #endif
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail(error) }

    private func fail(_ error: Error) {
        let e = error as NSError
        if e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled { return }
        if e.domain == "WebKitErrorDomain" && e.code == 102 { return } // frame load interrupted by a download
        phase = .failed(Self.describe(error))
    }

    /// iOS may kill the web content process in the background to free memory; start the page again.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { reload() }
}

extension WebController: WKDownloadDelegate {
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping @MainActor (URL?) -> Void) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(suggestedFilename.isEmpty ? "download" : suggestedFilename)
        pendingDownloads[ObjectIdentifier(download)] = url
        completionHandler(url)
    }

    func downloadDidFinish(_ download: WKDownload) {
        shareURL = pendingDownloads.removeValue(forKey: ObjectIdentifier(download))
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        pendingDownloads.removeValue(forKey: ObjectIdentifier(download))
    }
}

extension WebController: WKUIDelegate {
    /// `window.open` (e.g. the AWS SSO verification page): hand it to Safari.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { UIApplication.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor () -> Void) {
        present(UIAlertController(title: nil, message: message, preferredStyle: .alert), actions: [UIAlertAction(title: "OK", style: .default) { _ in completionHandler() }])
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (Bool) -> Void) {
        present(UIAlertController(title: nil, message: message, preferredStyle: .alert), actions: [
            UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) },
            UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) }
        ])
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (String?) -> Void) {
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText; $0.autocapitalizationType = .none; $0.autocorrectionType = .no }
        present(alert, actions: [
            UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) },
            UIAlertAction(title: "OK", style: .default) { _ in completionHandler(alert.textFields?.first?.text) }
        ])
    }

    private func present(_ alert: UIAlertController, actions: [UIAlertAction]) {
        actions.forEach(alert.addAction)
        var top = webView.window?.rootViewController
        while let next = top?.presentedViewController { top = next }
        top?.present(alert, animated: true)
    }
}

/// WKUserContentController retains its handlers; this breaks the cycle with WebController.
private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: WebController?
    init(_ t: WebController) { target = t }
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        let body = message.body
        MainActor.assumeIsolated { target?.receive(body) }
    }
}

/// Removes the "‹ › Done" bar WKWebView puts above the keyboard. The page has its own key bar there, and the extra
/// row costs a terminal two lines. WebKit has no switch for it, so the content view gets a subclass whose
/// `inputAccessoryView` is nil (the approach used by most web-view based terminal apps).
@MainActor
enum KeyboardAccessory {
    static func hide(in webView: WKWebView) {
        guard let content = webView.scrollView.subviews.first(where: { String(describing: type(of: $0)).hasPrefix("WKContent") }) else { return }
        let base: AnyClass = type(of: content)
        let name = "\(NSStringFromClass(base))_NoAccessory"
        var cls: AnyClass? = NSClassFromString(name)
        if cls == nil, let made = objc_allocateClassPair(base, name, 0) {
            let block: @convention(block) (AnyObject) -> UIView? = { _ in nil }
            if let m = class_getInstanceMethod(UIView.self, #selector(getter: UIResponder.inputAccessoryView)) {
                class_addMethod(made, #selector(getter: UIResponder.inputAccessoryView), imp_implementationWithBlock(block), method_getTypeEncoding(m))
            }
            objc_registerClassPair(made)
            cls = made
        }
        if let cls { object_setClass(content, cls) }
    }
}

/// Reports every layout pass; folding, unfolding and changing pose all relayout the view.
final class FoldAwareWebView: WKWebView {
    var onLayout: (() -> Void)?
    override func layoutSubviews() {
        super.layoutSubviews()
        onLayout?()
    }
}

struct WebViewHost: UIViewRepresentable {
    let controller: WebController
    func makeUIView(context: Context) -> WKWebView { controller.webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}

/// Share sheet for files the page downloads (terminal output, diagnostics).
struct ShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: [url], applicationActivities: nil) }
    func updateUIViewController(_ c: UIActivityViewController, context: Context) {}
}
