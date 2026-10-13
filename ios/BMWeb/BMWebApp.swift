import SwiftUI

/// The iOS shell: the web app in a WKWebView, the WiFi adapter on a TCP
/// socket the page reaches through a small bridge. Nothing of the app's own
/// logic lives here; the bus, the framing and the flash sequence are the
/// web app's, unchanged (see app/renderer/core/webshim/adapter-port.js).
@main
struct BMWebApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
