import Foundation
import WebKit
import UniformTypeIdentifiers

/// Serves the packed web app (the `Web` folder in the bundle) on
/// `bmweb://app/...`. A custom scheme rather than file://: a file:// page
/// cannot fetch() its own siblings in WKWebView, and the app fetches its
/// data (chassis archives, gzipped ECU files) that way. Files are served as
/// they are; the page decompresses .gz itself, as it does on the web.
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "bmweb"
    static let host = "app"

    private let root: URL

    override init() {
        root = Bundle.main.resourceURL!.appendingPathComponent("Web", isDirectory: true)
        super.init()
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        let file = root.appendingPathComponent(String(path.dropFirst()))
        guard let data = FileManager.default.contents(atPath: file.path) else {
            let response = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/plain"])!
            task.didReceive(response)
            task.didReceive("not in this build: \(path)".data(using: .utf8)!)
            task.didFinish()
            return
        }
        let type = Self.mimeType(for: file)
        let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": type,
                "Content-Length": String(data.count),
                "Cache-Control": "no-store",
                "Access-Control-Allow-Origin": "*",
            ]
        )!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    private static func mimeType(for file: URL) -> String {
        let ext = file.pathExtension.lowercased()
        switch ext {
        case "html": return "text/html; charset=utf-8"
        case "js": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json"
        case "svg": return "image/svg+xml"
        case "webmanifest": return "application/manifest+json"
        case "gz", "chassis", "ecu": return "application/octet-stream"
        default:
            if let t = UTType(filenameExtension: ext)?.preferredMIMEType { return t }
            return "application/octet-stream"
        }
    }
}
