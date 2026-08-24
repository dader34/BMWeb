using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using EdiabasMac;

namespace InpaMac.Cli;

// `tools` subcommand group: thin dispatch to the repo's python decompile/decode
// tooling. These take an ECU STEM (resolved by the scripts against the vendor
// SGDAT/Ecu dirs), never a path -- so we pass the name straight through. Output
// (JSON or text, per script) is streamed to our stdout unchanged. The scripts
// need only python3 + the repo's vendor/ + data/ trees; cwd is set to the repo
// root so their __file__-relative paths resolve.
internal static class ToolCommands
{
    // subcommand -> (relative script path, one-line help). The offline decompile
    // tools are the useful interactive ones; engine-backed sgbd tools need the
    // GUI running (BMACW_PORT) and are documented but not wrapped as safe.
    private static readonly (string Sub, string Script, string Help)[] Map =
    {
        ("disasm",  "tools/decompile/ipo_disasm.py",  "disassemble an IPO: tools disasm <ECU> [PROC]"),
        ("ir",      "tools/decompile/ipo_ir.py",      "full UI IR as JSON:   tools ir <ECU>"),
        ("screens", "tools/decompile/ipo_screens.py", "screen extractor:     tools screens <ECU>"),
        ("vm",      "tools/decompile/ipo_vm.py",      "run the VM on a proc: tools vm <ECU> [PROC]"),
        ("status",  "tools/decompile/ipo_status.py",  "status menu + pages:  tools status <ECU>"),
        ("memory",  "tools/decompile/ipo_memory.py",  "read-memory screen:   tools memory <ECU>"),
        ("coding",  "tools/decompile/ipo_coding.py",  "coding screen decode: tools coding <ECU>"),
        ("spec",    "tools/sgbd/sgbd_spec.py",        "lift a job to a spec: tools spec <sgbd> <JOB>"),
    };

    // tools <sub> <args...> -> python3 <script> <args...>
    public static int Run(Cli cli)
    {
        if (cli.Args.Count == 0)
        {
            cli.Line("tools <sub> <ECU> [...]  — wraps the python decompile/decode tooling:");
            foreach (var (name, _, help) in Map) cli.Line($"  {name,-8} {help}");
            cli.Line("Names are ECU/SGBD stems (e.g. GSDS2, ms450ds0), NOT file paths.");
            return 0;
        }
        string sub = cli.Args[0];
        var entry = Map.FirstOrDefault(m => string.Equals(m.Sub, sub, StringComparison.OrdinalIgnoreCase));
        if (entry.Script == null)
        {
            Cli.Err($"unknown tools subcommand '{sub}'. Try: {string.Join(", ", Map.Select(m => m.Sub))}");
            return 2;
        }

        string root = Paths.FindRepoRoot();
        // FindRepoRoot points at .../data in a packaged app; the python tree only
        // exists in the dev repo, so require it.
        string script = Path.Combine(root, entry.Script);
        if (!File.Exists(script))
        {
            Cli.Err($"script not found: {script}");
            Cli.Err("The `tools` group needs the dev repo (vendor/ + tools/), not the packaged app.");
            return 4;
        }

        var psi = new ProcessStartInfo("python3")
        {
            WorkingDirectory = root,
            UseShellExecute = false,
        };
        psi.ArgumentList.Add(script);
        foreach (var a in cli.Args.Skip(1)) psi.ArgumentList.Add(a);
        // pass --json etc. through too (the python tools ignore unknown flags)
        try
        {
            using var p = Process.Start(psi);
            if (p == null) { Cli.Err("could not start python3"); return 3; }
            p.WaitForExit();
            return p.ExitCode;
        }
        catch (Exception ex)
        {
            Cli.Err($"failed to run python3: {ex.Message}");
            return 3;
        }
    }
}
