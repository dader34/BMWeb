using InpaMac.Server;

// sidecar: local JSON API bridging the Electron UI to the native EDIABAS engine.
// Electron spawns this and talks to it over HTTP on 127.0.0.1:8777.
//
//   GET  /api/health
//   GET  /api/chassis                       -> ["E36","E46",...]
//   GET  /api/chassis/{id}                  -> { id, description, sections:[...] }
//   GET  /api/ecu/{sgbd}/jobs               -> ["FS_LESEN", ...]            (offline)
//   GET  /api/ecu/{sgbd}/results/{job}      -> ["F_ORT_TEXT : ...", ...]    (offline)
//   GET  /api/port                          -> { port } | { port:null }
//   POST /api/ecu/{sgbd}/read?port=DEV      -> { codes:[ {F_ORT_TEXT,...} ] } (live)
//   POST /api/ecu/{sgbd}/clear?port=DEV     -> { ok:true }                    (live)
//
// route handlers live in {Config,Diagnostics,Flash}Endpoints.cs; all shared
// state (bus lock, engine cache, config, active flash) is in ServerState.

var (app, state) = ServerHost.Build(args);

// a raw SIGTERM from Electron (ServerHost wires ApplicationStopping and
// ProcessExit).
using var sigterm = System.Runtime.InteropServices.PosixSignalRegistration.Create(
    System.Runtime.InteropServices.PosixSignal.SIGTERM, _ => state.Shutdown());

// fixed loopback port the Electron app expects
app.Run("http://127.0.0.1:8777");
