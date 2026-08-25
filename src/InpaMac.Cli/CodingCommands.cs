using System;
using System.Collections.Generic;
using System.Linq;
using EdiabasMac;

namespace InpaMac.Cli;

// coding: read the coding block (always safe), and a HARD-GATED write. The
// write mirrors the renderer's coding-write.js: pick the strategy from the jobs
// the SGBD exposes, transmit, then prove-by-re-read. It is disabled unless BOTH
//   (a) BMACW_ALLOW_CODING_WRITE=1  AND  (b) --confirm
// are present, and it prints exactly what it will do first. The binary
// checksum ("cfg-chunked", C_S_AUFTRAG/C_CHECKSUM) and file-based strategies are
// NOT implemented here -- synthesizing their checksums natively is unproven, so
// the CLI refuses rather than guess. See notes in Write().
internal static class CodingCommands
{
    // read-job names by preference (matches coding-write.js readJobFor + the
    // COD_LESEN family seen on E36/E46 body modules).
    private static readonly string[] ReadJobs =
        { "CODIERDATEN_LESEN", "CODIERUNG_LESEN", "COD_LESEN", "CODIER_LESEN" };

    // the field the coding bytes come back in, by preference (coding-write.js
    // NETTO_FIELDS). Falls back to any hex-looking string result.
    private static readonly string[] NettoFields =
        { "CODIERDATEN", "CODIERDATENSATZ", "CODIERUNG", "CODIERSTRING", "NETTODATEN", "COD_DATEN", "DATEN" };

    // read the coding block and the coding index (from the read, else IDENT /
    // C_CI_LESEN). All reads.
    //   coding read [SGBD] [--port DEV]      (default subcommand if omitted)
    public static int Read(Cli cli, Diag diag)
    {
        string sgbd = cli.Sgbd(1); // first positional is the subcommand
        string port = cli.Port();
        if (port == null) { Cli.Err("No cable found. Plug in the K+DCAN cable, or pass --port."); return 4; }
        cli.Line($"Port : {port}");
        cli.Line($"SGBD : {sgbd}");
        diag.AttachSerial(port);
        diag.Load(sgbd);

        var jobs = diag.Jobs();
        string? readJob = ReadJobs.FirstOrDefault(j => jobs.Contains(j, StringComparer.OrdinalIgnoreCase));
        if (readJob == null)
        {
            Cli.Err($"{diag.LoadedSgbd} exposes no coding-read job ({string.Join("/", ReadJobs)}).");
            return 4;
        }

        var flat = IdentCommands.Flatten(diag.Run(readJob));
        string? netto = NettoFields
            .Select(f => flat.TryGetValue(f, out var v) ? v : (string?)null)
            .FirstOrDefault(v => !string.IsNullOrEmpty(v))
            ?? flat.FirstOrDefault(k => LooksHex(k.Value)).Value;

        string? codingIndex = CodingIndex(diag, jobs, flat);

        cli.Line($"Read job     : {readJob}");
        cli.Line($"Coding bytes : {netto ?? "(not found)"}");
        cli.Line($"Coding index : {codingIndex ?? "(unknown)"}");
        // also surface the decoded named fields (COD_MIT_* etc.) the read returns
        var fields = flat.Where(k => !k.Key.StartsWith("_") && k.Key != "JOB_STATUS"
                                     && !NettoFields.Contains(k.Key, StringComparer.OrdinalIgnoreCase))
                         .ToDictionary(k => k.Key, k => k.Value);
        if (fields.Count > 0 && !cli.Json)
        {
            cli.Line("Fields:");
            foreach (var kv in fields) cli.Line($"  {kv.Key,-24} = {kv.Value}");
        }
        cli.Emit(new { sgbd = diag.LoadedSgbd, read_job = readJob, coding = netto, coding_index = codingIndex, fields });
        return 0;
    }

    // the coding index: from the read's own results, else IDENT's ID_COD_INDEX,
    // else C_CI_LESEN (coding-hub.js does exactly this fallback).
    private static string? CodingIndex(Diag diag, List<string> jobs, Dictionary<string, string> readFlat)
    {
        foreach (var k in new[] { "CODIERINDEX", "COD_INDEX", "ID_COD_INDEX" })
            if (readFlat.TryGetValue(k, out var v) && !string.IsNullOrEmpty(v)) return v;
        foreach (var (job, key) in new[] { ("IDENT", "ID_COD_INDEX"), ("C_CI_LESEN", "CI") })
        {
            if (!jobs.Contains(job, StringComparer.OrdinalIgnoreCase)) continue;
            try
            {
                var f = IdentCommands.Flatten(diag.Run(job));
                var hit = f.FirstOrDefault(kv => kv.Key.Contains(key, StringComparison.OrdinalIgnoreCase)
                                                 || kv.Key.Contains("COD_INDEX", StringComparison.OrdinalIgnoreCase));
                if (!string.IsNullOrEmpty(hit.Value)) return hit.Value;
            }
            catch { /* try the next source */ }
        }
        return null;
    }

    // GATED coding write. Sends a full coding-byte string via the SGBD's own
    // write job, then re-reads to prove it took. Refuses unless the env gate AND
    // --confirm are set, and refuses strategies whose checksums we can't
    // reproduce natively (C_S_AUFTRAG binary / file-based) rather than guessing.
    //   coding write <SGBD> --data <HEX> --confirm   (needs BMACW_ALLOW_CODING_WRITE=1)
    public static int Write(Cli cli, Diag diag)
    {
        string sgbd = cli.Args.Count > 1 ? cli.Args[1] : cli.Sgbd(1);
        string? hex = cli.Opt("--data") ?? cli.Opt("--arg");
        if (string.IsNullOrEmpty(hex))
        {
            Cli.Err("usage: coding write <SGBD> --data <HEX-CODING-BYTES> --confirm");
            return 2;
        }
        // load + inspect jobs OFFLINE first so the strategy check and the gate
        // refusal work with no cable; the cable is only required to transmit.
        diag.Load(sgbd);
        var jobs = diag.Jobs();

        // strategy by exposed jobs (coding-write.js codingWriteStrategy). Only the
        // plain full-hex write jobs are supported natively.
        string? writeJob = new[] { "CODIERDATEN_SCHREIBEN", "CODIERUNG_SCHREIBEN" }
            .FirstOrDefault(j => jobs.Contains(j, StringComparer.OrdinalIgnoreCase));
        if (jobs.Contains("C_S_AUFTRAG", StringComparer.OrdinalIgnoreCase) && writeJob == null)
        {
            Cli.Err($"{diag.LoadedSgbd} uses the C_S_AUFTRAG/C_CHECKSUM (cfg-chunked) coding path.");
            Cli.Err("Its checksum is computed by the module's own flow and is NOT reproduced natively here.");
            Cli.Err("Use the GUI's coding screen for this module. Refusing to write.");
            return 7;
        }
        if (writeJob == null)
        {
            Cli.Err($"{diag.LoadedSgbd} exposes no supported coding-write job. Refusing to write.");
            return 7;
        }

        // the hard gate: env var AND --confirm, exactly like FlashService.WriteAllowed
        bool envOk = Environment.GetEnvironmentVariable("BMACW_ALLOW_CODING_WRITE") == "1";
        string? readJob = ReadJobs.FirstOrDefault(j => jobs.Contains(j, StringComparer.OrdinalIgnoreCase));

        // show exactly what would happen, always
        Cli.Err("CODING WRITE — this permanently changes how the module behaves.");
        Cli.Err($"  SGBD      : {diag.LoadedSgbd}");
        Cli.Err($"  Write job : {writeJob} {hex}");
        Cli.Err($"  Verify    : re-read via {readJob ?? "(none available)"}");

        if (!(envOk && cli.Confirm))
        {
            Cli.Err("WRITE GATE CLOSED. To proceed you must set BMACW_ALLOW_CODING_WRITE=1 AND pass --confirm.");
            Cli.Err("Nothing was written.");
            return 5;
        }

        // gate is open: now the cable is required to actually transmit.
        string? port = cli.Port();
        if (port == null) { Cli.Err("No cable found. Plug in the K+DCAN cable, or pass --port."); return 4; }
        Cli.Err($"  Port      : {port}");
        diag.AttachSerial(port);

        // capture the pre-write value so the user can restore it
        string? before = null;
        if (readJob != null)
        {
            try
            {
                var f = IdentCommands.Flatten(diag.Run(readJob));
                before = NettoFields.Select(x => f.TryGetValue(x, out var v) ? v : (string?)null)
                                    .FirstOrDefault(v => !string.IsNullOrEmpty(v));
                Cli.Err($"  Backup    : previous coding was {before ?? "(unread)"}");
            }
            catch { /* backup is best-effort */ }
        }

        // transmit
        Cli.Err("WRITE GATE OPEN — sending coding write.");
        var writeSets = diag.Run(writeJob, hex);
        bool ok = IdentCommands.Flatten(writeSets)
            .TryGetValue("JOB_STATUS", out var st) && st == "OKAY";
        Cli.Err($"  {writeJob} JOB_STATUS = {(ok ? "OKAY" : "not OKAY")}");

        // prove-by-re-read
        bool verified = false;
        string? after = null;
        if (readJob != null)
        {
            var f = IdentCommands.Flatten(diag.Run(readJob));
            after = NettoFields.Select(x => f.TryGetValue(x, out var v) ? v : (string?)null)
                               .FirstOrDefault(v => !string.IsNullOrEmpty(v));
            verified = after != null && HexEq(after, hex);
            Cli.Err($"  Re-read   : {after ?? "(unread)"}  -> {(verified ? "MATCH" : "MISMATCH")}");
        }

        cli.Emit(new
        {
            sgbd = diag.LoadedSgbd, write_job = writeJob, requested = hex,
            before, after, job_status_ok = ok, verified,
        });
        return ok && verified ? 0 : 6;
    }

    private static bool LooksHex(string s) =>
        !string.IsNullOrEmpty(s) && s.Replace("-", "").Replace(" ", "")
            .All(c => Uri.IsHexDigit(c)) && s.Replace("-", "").Replace(" ", "").Length >= 4;

    // compare two coding-byte strings ignoring separators/case (AA-BB vs aabb).
    private static bool HexEq(string a, string b)
    {
        static string N(string s) => new string((s ?? "").Where(Uri.IsHexDigit).ToArray()).ToUpperInvariant();
        return N(a) == N(b);
    }
}
