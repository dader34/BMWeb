using AppKit;

// BMacW as a single native binary: AppKit window + WKWebView UI + the EDIABAS
// engine and JSON API hosted in-process (see AppDelegate). No Electron, no
// spawned sidecar.
NSApplication.Init();
NSApplication.SharedApplication.Delegate = new InpaMac.App.AppDelegate();
NSApplication.SharedApplication.Run();
