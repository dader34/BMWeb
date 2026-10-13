import Foundation
import Network
import WebKit

/// TCP sockets for the page. The page's adapter port (adapter-port.js,
/// NativePipe) calls `window.bmwebTcp.connect/send/close`, which this
/// installs as a user script forwarding to the `tcp` message handler, and
/// hears back through `window.bmwebTcpEvent(id, kind, payload)`: 'connected',
/// 'data' (base64), 'close', 'error' (message). Bytes cross as base64 both
/// ways, one message per chunk, nothing in between.
final class TcpBridge: NSObject, WKScriptMessageHandler {
    static let handlerName = "tcp"

    /// What the page gets before any of its own scripts run.
    static let userScript = """
    (() => {
      const post = (m) => window.webkit.messageHandlers.tcp.postMessage(m);
      window.bmwebTcp = {
        connect: (host, port, id) => post({ op: 'connect', id, host, port }),
        send: (id, base64) => post({ op: 'send', id, data: base64 }),
        close: (id) => post({ op: 'close', id }),
      };
      window.bmwebShell = {
        platform: 'ios',
        openSettings: () => post({ op: 'settings', id: '-' }),
      };
      // this build carries no parts catalogue or wiring: say so, rather than
      // have the Apps hub probe the internet for them on the adapter's WiFi
      window.BMWEB_NO_PARTS = true;
      // the bottom bar's LINK status opens the adapter sheet; a second
      // tap target would be foreign to the page
      document.addEventListener('DOMContentLoaded', () => {
        const status = document.getElementById('mtab-status');
        if (status) {
          status.style.cursor = 'pointer';
          status.addEventListener('click', () => window.bmwebShell.openSettings());
        }
      });
    })();
    """

    /// Opens the shell's adapter sheet (the page asked).
    var onOpenSettings: () -> Void = {}

    private weak var webView: WKWebView?
    private var connections: [String: NWConnection] = [:]
    private let queue = DispatchQueue(label: "bmweb.tcp")

    func attach(to webView: WKWebView) {
        self.webView = webView
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let op = body["op"] as? String,
              let id = body["id"] as? String else { return }
        switch op {
        case "settings":
            DispatchQueue.main.async { [weak self] in self?.onOpenSettings() }
        case "connect":
            guard let host = body["host"] as? String else { return }
            let port = (body["port"] as? Int) ?? 35000
            connect(id: id, host: host, port: port)
        case "send":
            guard let text = body["data"] as? String, let data = Data(base64Encoded: text) else { return }
            connections[id]?.send(content: data, completion: .contentProcessed { [weak self] error in
                if let error { self?.emit(id, "error", error.localizedDescription) }
            })
        case "close":
            connections[id]?.cancel()
            connections[id] = nil
        default:
            break
        }
    }

    private func connect(id: String, host: String, port: Int) {
        guard let nwPort = NWEndpoint.Port(rawValue: UInt16(clamping: port)) else {
            emit(id, "error", "bad port \(port)")
            return
        }
        let params = NWParameters.tcp
        if let tcp = params.defaultProtocolStack.transportProtocol as? NWProtocolTCP.Options {
            tcp.noDelay = true          // a telegram is small and the line waits for it
            tcp.connectionTimeout = 5
        }
        let conn = NWConnection(host: NWEndpoint.Host(host), port: nwPort, using: params)
        connections[id] = conn
        conn.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.emit(id, "connected", nil)
                self.receive(id: id, on: conn)
            case .failed(let error):
                self.emit(id, "error", error.localizedDescription)
                self.connections[id] = nil
            case .cancelled:
                self.emit(id, "close", nil)
                self.connections[id] = nil
            case .waiting(let error):
                // no route yet (the phone not on the adapter's network): say so rather than hang
                self.emit(id, "error", "no route to \(host):\(port) (\(error.localizedDescription))")
                conn.cancel()
            default:
                break
            }
        }
        conn.start(queue: queue)
    }

    private func receive(id: String, on conn: NWConnection) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data, !data.isEmpty {
                self.emit(id, "data", data.base64EncodedString())
            }
            if let error {
                self.emit(id, "error", error.localizedDescription)
                return
            }
            if isComplete {
                conn.cancel()
                return
            }
            self.receive(id: id, on: conn)
        }
    }

    private func emit(_ id: String, _ kind: String, _ payload: String?) {
        let payloadJs: String
        if let payload, let encoded = try? JSONSerialization.data(withJSONObject: [payload]),
           let text = String(data: encoded, encoding: .utf8) {
            payloadJs = String(text.dropFirst().dropLast())   // the one JSON string, quoted
        } else {
            payloadJs = "null"
        }
        let js = "window.bmwebTcpEvent && window.bmwebTcpEvent('\(id)', '\(kind)', \(payloadJs));"
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    func closeAll() {
        for (_, c) in connections { c.cancel() }
        connections.removeAll()
    }
}
