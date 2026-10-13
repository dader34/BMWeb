import SwiftUI

/// Where the adapter is: the THOR's own address by default, or a Mac on the
/// LAN running the emulator (`tools/kline.py --adapter 35000`) for testing.
final class AdapterSettings: ObservableObject {
    @AppStorage("adapterHost") var host: String = "192.168.4.1"
    @AppStorage("adapterPort") var port: Int = 23

    /// The `gateway` setting the page takes: adapter-port.js parses this.
    var gatewayValue: String { "adapter://\(host):\(port)" }
}

struct ContentView: View {
    @StateObject private var settings = AdapterSettings()
    @State private var showSettings = false
    @State private var reloadToken = 0

    var body: some View {
        // the page is the whole screen; its LINK status in the bottom bar
        // opens the adapter sheet (WebView wires the tap)
        WebView(gateway: settings.gatewayValue, reloadToken: reloadToken) {
            showSettings = true
        }
        .ignoresSafeArea(edges: .bottom)
        .sheet(isPresented: $showSettings) {
            AdapterSettingsView(settings: settings) {
                reloadToken += 1
            }
        }
        .onAppear {
            // a flash must not be interrupted by the screen going dark; the
            // shell is in front for the whole of it
            UIApplication.shared.isIdleTimerDisabled = true
        }
    }
}

struct AdapterSettingsView: View {
    @ObservedObject var settings: AdapterSettings
    var onApply: () -> Void
    @Environment(\.dismiss) private var dismiss

    private var isThor: Bool { settings.host == "192.168.4.1" && settings.port == 23 }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Button {
                        settings.host = "192.168.4.1"
                        settings.port = 23
                    } label: {
                        Label {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("THOR WiFi adapter").foregroundStyle(.primary)
                                Text("192.168.4.1 : 23 on THOR_WiFi — join that network first")
                                    .font(.footnote).foregroundStyle(.secondary)
                            }
                        } icon: {
                            Image(systemName: isThor ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(isThor ? Color.accentColor : .secondary)
                        }
                    }
                } header: {
                    Text("Adapter")
                }
                Section {
                    TextField("Host", text: $settings.host)
                        .keyboardType(.numbersAndPunctuation)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Port", value: $settings.port, format: .number)
                        .keyboardType(.numberPad)
                } header: {
                    Text("Or another address")
                } footer: {
                    Text("For the emulated DME on your Mac: its address on this WiFi and the port of `kline.py --adapter`.")
                }
            }
            .navigationTitle("WiFi adapter")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Apply") {
                        onApply()
                        dismiss()
                    }
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }
}
