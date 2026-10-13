import XCTest

/// The shell against the emulated DME: `tools/kline.py --adapter 35000` on
/// this Mac (the simulator shares its network). Identify must come back
/// with the MS45.1 through the adapter port and the TCP bridge.
final class SmokeTests: XCTestCase {
    func testIdentifyOverTheAdapterBridge() throws {
        let app = XCUIApplication()
        app.launchArguments += ["-adapterHost", "127.0.0.1", "-adapterPort", "35000"]
        app.launch()
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 20), "the web app did not come up")
        let picker = web.buttons["Control unit..."]
        XCTAssertTrue(picker.waitForExistence(timeout: 20), "no control unit picker")
        picker.tap()
        let dme = web.buttons["DME (engine)"]
        XCTAssertTrue(dme.waitForExistence(timeout: 10))
        dme.tap()
        let identify = web.buttons["Identify ECU"].exists ? web.buttons["Identify ECU"] : web.buttons["Identify"]
        XCTAssertTrue(identify.waitForExistence(timeout: 10))
        identify.tap()
        let found = web.staticTexts.containing(NSPredicate(format: "label CONTAINS 'MS45.1'")).firstMatch
        XCTAssertTrue(found.waitForExistence(timeout: 60), "the DME was not identified: \(web.staticTexts.allElementsBoundByIndex.suffix(6).map(\.label))")
        let status = web.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Programming status'")).firstMatch
        XCTAssertTrue(status.waitForExistence(timeout: 30))
    }
}
