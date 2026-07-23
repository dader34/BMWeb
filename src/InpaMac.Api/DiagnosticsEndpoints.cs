using EdiabasMac;

namespace InpaMac.Server;

// per-ECU endpoints: offline metadata (jobs/results/arguments/activations/menu)
// on the dedicated offline engine, and live bus ops (state/read/clear/run) on
// the cached live engine, serialized through ServerState.OnBus.
internal static class DiagnosticsEndpoints
{
    public static void MapDiagnosticsEndpoints(this WebApplication app, ServerState state)
    {
        // ---- offline (no cable) ----

        app.MapGet("/api/ecu/{sgbd}/jobs", (string sgbd) =>
            Offline(state, sgbd, diag => Results.Json(diag.Jobs())));

        app.MapGet("/api/ecu/{sgbd}/results/{job}", (string sgbd, string job) =>
            Offline(state, sgbd, diag => Results.Json(diag.ResultsOf(job))));

        // a job's declared arguments (offline, via the _ARGUMENTS pseudo-job). lets the
        // UI know which jobs need input (flash address/parameter, etc.) and their types.
        app.MapGet("/api/ecu/{sgbd}/arguments/{job}", (string sgbd, string job) =>
            Offline(state, sgbd, diag =>
            {
                var args = new List<Dictionary<string, string>>();
                foreach (var set in diag.Run("_ARGUMENTS", job))
                    args.Add(set.Where(kv => !kv.Key.StartsWith("_"))
                                .ToDictionary(kv => kv.Key, kv => Diag.Format(kv.Value)));
                return Results.Json(new { job, arguments = args });
            }));

        // actuator tests (INPA F6 'Steuern'): STEUERN_X paired with STEUERN_X_ENDE
        app.MapGet("/api/ecu/{sgbd}/activations", (string sgbd) =>
            Offline(state, sgbd, diag =>
            {
                var acts = MenuGen.Activations(diag);
                return Results.Json(acts.Select(a => new
                {
                    label = a.Label, start = a.Start, stop = a.Stop, momentary = a.Momentary, critical = a.Critical
                }).ToList());
            }));

        // English INPA-style grouped functional menu for an ECU (offline)
        app.MapGet("/api/ecu/{sgbd}/menu", (string sgbd) =>
            Offline(state, sgbd, diag =>
            {
                var sections = MenuGen.Build(diag.Jobs());
                return Results.Json(new
                {
                    sgbd,
                    sections = sections.Select(s => new
                    {
                        section = s.Section,
                        items = s.Items.Select(i => new { job = i.Job, label = i.Label, danger = i.Danger }).ToList()
                    }).ToList()
                });
            }));

        // ---- live (bus) ----

        // battery + ignition (KL15) state, INPA's top "Battery / Ignition" lights.
        // plain K+DCAN can't report line voltage to EDIABAS, so read from the DME:
        // STATUS_UBATT (battery volts) + STATUS_DIGITAL_1 (KL15 input).
        // real bus transaction: renderer polls on demand, not a fast timer. never
        // throws; connected:false carries a `detail` saying whether the cable/port
        // is missing or the ECU didn't answer.
        app.MapGet("/api/state", (HttpContext ctx, string? port, string? sgbd) =>
        {
            string ecu = string.IsNullOrEmpty(sgbd) ? "ms450ds0" : sgbd;
            return state.OnBus(ctx, () =>
            {
                var diag = state.Engines.AcquireLive(port);
                if (diag == null)
                    return Results.Json(new
                    {
                        battery = (double?)null, ignition = (bool?)null, connected = false,
                        detail = "no K+DCAN cable detected (no usbserial port)"
                    });
                try
                {
                    diag.Load(ecu);

                    double? bat = null; bool? ign = null;
                    Exception? firstErr = null;
                    // battery voltage
                    try
                    {
                        foreach (var s in diag.Run("STATUS_UBATT"))
                            foreach (var kv in s)
                                if (kv.Key.Contains("UBAT") && kv.Key.EndsWith("WERT") &&
                                    double.TryParse(Diag.Format(kv.Value), System.Globalization.NumberStyles.Any,
                                        System.Globalization.CultureInfo.InvariantCulture, out var v)) bat = v;
                    }
                    catch (Exception ex) { firstErr = ex; }
                    // ignition = terminal 15 input (STAT_KL15_EIN_WERT in STATUS_DIGITAL_1)
                    try
                    {
                        foreach (var s in diag.Run("STATUS_DIGITAL_1"))
                            foreach (var kv in s)
                                if (kv.Key.Contains("KL15"))
                                {
                                    var t = Diag.Format(kv.Value).Trim().ToLowerInvariant();
                                    ign = t is "1" or "ein" or "on" or "true" || t.StartsWith("ein");
                                }
                    }
                    catch (Exception ex) { firstErr ??= ex; }
                    // if KL15 couldn't be read, leave ignition unknown. don't infer from
                    // voltage: the DME reports >6V with the key off too, so it would lie.

                    // both reads failed -> the port is there but the ECU never answered
                    if (bat == null && ign == null && firstErr != null)
                    {
                        if (DiagManager.IsInterfaceError(firstErr)) state.Engines.DisposeLive();
                        return Results.Json(new
                        {
                            battery = (double?)null, ignition = (bool?)null, connected = false,
                            detail = "ECU didn't answer: " + ServerState.Explain(firstErr)
                        });
                    }

                    return Results.Json(new { battery = bat, ignition = ign, connected = true });
                }
                catch (Exception ex)
                {
                    if (DiagManager.IsInterfaceError(ex)) state.Engines.DisposeLive();
                    return Results.Json(new
                    {
                        battery = (double?)null, ignition = (bool?)null, connected = false,
                        detail = ServerState.Explain(ex)
                    });
                }
            });
        });

        app.MapPost("/api/ecu/{sgbd}/read", (HttpContext ctx, string sgbd, string? port, string? group) => state.OnBus(ctx, () =>
        {
            var diag = state.Engines.AcquireLive(port);
            if (diag == null) return Results.BadRequest(new { error = "no interface: plug in the K+DCAN cable" });
            // prefer the diagnostic-address group (D_00xx.grp) so EDIABAS identifies the
            // exact variant itself; falls back to the concrete SGBD + sibling-variant
            // merge (which fills "unknown location" faults from siblings like
            // zke5 -> zke5_s12) when there's no group or it can't identify.
            var codes = FaultReader.ReadFaultsAuto(diag, sgbd, group, state.Config.SgbdVariants(sgbd));
            return Results.Json(new { port, count = codes.Count, codes });
        }));

        app.MapPost("/api/ecu/{sgbd}/clear", (HttpContext ctx, string sgbd, string? port, string? group) => state.OnBus(ctx, () =>
        {
            var diag = state.Engines.AcquireLive(port);
            if (diag == null) return Results.BadRequest(new { error = "no interface: plug in the K+DCAN cable" });
            LoadForJob(diag, sgbd, group, "FS_LOESCHEN");
            diag.Run("FS_LOESCHEN");
            return Results.Json(new { ok = true });
        }));

        // run any job live, return every result set as key/value strings
        app.MapPost("/api/ecu/{sgbd}/run/{job}", (HttpContext ctx, string sgbd, string job, string? port, string? arg, string? group) => state.OnBus(ctx, () =>
        {
            var diag = state.Engines.AcquireLive(port);
            if (diag == null) return Results.BadRequest(new { error = "no interface: plug in the K+DCAN cable" });
            LoadForJob(diag, sgbd, group, job);
            var sets = diag.Run(job, string.IsNullOrEmpty(arg) ? null : arg);
            var rows = sets.Select(s => s.ToDictionary(kv => kv.Key, kv => Diag.Format(kv.Value))).ToList();
            return Results.Json(new { port, job, sets = rows });
        }));
    }

    // load the ECU for a job, preferring the diagnostic-address group (D_00xx.grp)
    // for fault jobs (FS_*) so EDIABAS identifies the exact variant. Non-fault jobs
    // (status/live views bound to the concrete SGBD's layout) keep the SGBD. Falls
    // back to the SGBD if the group can't identify, so it never regresses.
    private static void LoadForJob(Diag diag, string sgbd, string group, string job)
    {
        if (!string.IsNullOrEmpty(group) && job != null &&
            job.StartsWith("FS_", StringComparison.OrdinalIgnoreCase))
        {
            try { diag.Load(group); return; }
            catch { /* no cable / no identify / unsupported: fall back */ }
        }
        diag.Load(sgbd);
    }

    // run offline work with friendly errors: missing/unloadable SGBD -> 404,
    // anything else -> 500, both via Explain.
    private static IResult Offline(ServerState state, string sgbd, Func<Diag, IResult> work)
    {
        try
        {
            return state.Engines.RunOffline(sgbd, work);
        }
        catch (SgbdLoadException ex)
        {
            return Results.NotFound(new { error = ServerState.Explain(ex), raw = ex.Message });
        }
        catch (Exception ex)
        {
            return Results.Json(new { error = ServerState.Explain(ex), raw = ex.Message },
                statusCode: StatusCodes.Status500InternalServerError);
        }
    }
}
