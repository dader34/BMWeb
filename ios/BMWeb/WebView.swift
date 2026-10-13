import SwiftUI
import WebKit

/// The web app, from the bundle, with the TCP bridge installed and the
/// adapter's address handed to the page as its `gateway` setting (the page
/// persists it in its own storage; a changed address reloads the page).
struct WebView: UIViewRepresentable {
    let gateway: String
    let reloadToken: Int
    var onOpenSettings: () -> Void = {}

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(BundleSchemeHandler(), forURLScheme: BundleSchemeHandler.scheme)
        config.allowsInlineMediaPlayback = true
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        let controller = WKUserContentController()
        controller.add(context.coordinator.bridge, name: TcpBridge.handlerName)
        controller.addUserScript(WKUserScript(source: TcpBridge.userScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController = controller
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        webView.isInspectable = true   // Safari's Web Inspector, for the console
        webView.navigationDelegate = context.coordinator
        context.coordinator.webView = webView
        context.coordinator.bridge.attach(to: webView)
        context.coordinator.bridge.onOpenSettings = onOpenSettings
        context.coordinator.load(webView, gateway: gateway)
        context.coordinator.lastToken = reloadToken
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.bridge.onOpenSettings = onOpenSettings
        if context.coordinator.lastToken != reloadToken {
            context.coordinator.lastToken = reloadToken
            context.coordinator.bridge.closeAll()
            context.coordinator.load(webView, gateway: gateway)
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKDownloadDelegate {
        let bridge = TcpBridge()
        var lastToken = 0
        weak var webView: WKWebView?
        private var destinations: [ObjectIdentifier: URL] = [:]

        func load(_ webView: WKWebView, gateway: String) {
            var parts = URLComponents()
            parts.scheme = BundleSchemeHandler.scheme
            parts.host = BundleSchemeHandler.host
            parts.path = "/index.html"
            parts.queryItems = [URLQueryItem(name: "gateway", value: gateway)]
            parts.fragment = "apps/flashing"
            webView.load(URLRequest(url: parts.url!))
        }

        // MARK: downloads
        // The page saves a read (fbSaveBytes) the browser way: it clicks an
        // <a download> on a blob URL. A WKWebView drops that unless the
        // navigation is turned into a WKDownload here, so a read "saved" and
        // went nowhere. The file lands in the app's Documents folder, which
        // Info.plist shares with the Files app (On My iPhone › BMWeb), and the
        // share sheet offers it on; the page's log says where it went.
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     preferences: WKWebpagePreferences,
                     decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void) {
            decisionHandler(navigationAction.shouldPerformDownload ? .download : .allow, preferences)
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                     decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
        }

        func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
            download.delegate = self
        }

        func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
            download.delegate = self
        }

        func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                      suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
            let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            let name = suggestedFilename.isEmpty ? "download.bin" : suggestedFilename
            var url = dir.appendingPathComponent(name)
            // an earlier read with the same name is kept, not overwritten
            let stem = url.deletingPathExtension().lastPathComponent
            let ext = url.pathExtension
            var n = 1
            while FileManager.default.fileExists(atPath: url.path) {
                n += 1
                url = dir.appendingPathComponent("\(stem) \(n)")
                if !ext.isEmpty { url = url.appendingPathExtension(ext) }
            }
            destinations[ObjectIdentifier(download)] = url
            completionHandler(url)
        }

        func downloadDidFinish(_ download: WKDownload) {
            guard let url = destinations.removeValue(forKey: ObjectIdentifier(download)) else { return }
            tellPage("Saved to Files › On My iPhone › BMWeb › \(url.lastPathComponent)")
            share(url)
        }

        func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
            destinations.removeValue(forKey: ObjectIdentifier(download))
            tellPage("Could not save the file: \(error.localizedDescription)")
        }

        /// A line in the flashing screen's log, when that screen is up.
        private func tellPage(_ text: String) {
            guard let webView, let json = try? JSONSerialization.data(withJSONObject: [text]),
                  let arg = String(data: json, encoding: .utf8) else { return }
            webView.evaluateJavaScript("typeof fbLog === 'function' && fbLog(\(arg)[0])", completionHandler: nil)
        }

        private func share(_ url: URL) {
            guard let webView, let root = webView.window?.rootViewController else { return }
            let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            if let pop = sheet.popoverPresentationController {   // iPad anchors it
                pop.sourceView = webView
                pop.sourceRect = CGRect(x: webView.bounds.midX, y: webView.bounds.maxY - 80, width: 1, height: 1)
            }
            var top = root
            while let presented = top.presentedViewController { top = presented }
            top.present(sheet, animated: true)
        }
    }
}
