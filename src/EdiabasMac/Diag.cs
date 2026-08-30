using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using EdiabasLib;

namespace EdiabasMac;

// wraps the native EDIABAS engine: EcuPath + interface wiring.
// (code-page encodings are registered once in EncodingBootstrap.)
public sealed class Diag : IDisposable
{
    private readonly EdiabasNet _ediabas;

    public Diag(string ecuPath)
    {
        _ediabas = new EdiabasNet();
        _ediabas.AbortJobFunc = () => false;
        _ediabas.NoInitForVJobs = true; // offline _JOBS/_RESULTS, no cable
        _ediabas.SetConfigProperty("EcuPath", ecuPath);
    }

    // wired K+DCAN serial transport, e.g. /dev/tty.usbserial-XXXX. live jobs only.
    public void AttachSerial(string comPort)
    {
        var obd = new EdInterfaceObd { ComPort = comPort };
        _ediabas.EdInterfaceClass = obd;
    }

    // Run jobs against recorded telegrams instead of a car: EDIABAS answers
    // from <simPath>/<sgbd>.sim, whose [REQUEST]/[RESPONSE] pairs are matched
    // by request bytes. This is what makes the jobs-to-JSON differential
    // (tools/sgbd_value_diff.py) runnable with nothing plugged in -- the same
    // response bytes go to the engine and to the lifted spec, and the decoded
    // values must agree.
    public void AttachSimulation(string simPath)
    {
        // Order matters: EdInterfaceObd decides at attach time whether it is in
        // simulation mode (IsSimulationMode() wants Simulation=1 AND an
        // existing SimulationPath), so both properties must be set before the
        // interface is wired up -- otherwise it tries to open a real serial
        // port and fails with IFH-0056 ILLEGAL CHANNEL.
        _ediabas.SetConfigProperty("Simulation", "1");
        _ediabas.SetConfigProperty("SimulationPath", simPath);
        _ediabas.EdInterfaceClass = new EdInterfaceObd { ComPort = "SIM" };
    }

    // Interface-level trace (the telegrams EDIABAS sends and receives) into
    // <dir>/ifh.trc. Building a .sim by hand needs to know what the SGBD's
    // INITIALISIERUNG asks for before any job can answer; this is how that
    // request is captured rather than guessed.
    public void TraceTo(string dir)
    {
        _ediabas.SetConfigProperty("TracePath", dir);
        _ediabas.SetConfigProperty("IfhTrace", "3");
        _ediabas.SetConfigProperty("AppendTrace", "0");
        _ediabas.SetConfigProperty("IfhTraceBuffering", "0");
    }

    public void Load(string sgbd) => _ediabas.ResolveSgbdFile(sgbd);

    public string LoadedSgbd => _ediabas.SgbdFileName;

    // run a job, return its result sets
    public List<Dictionary<string, EdiabasNet.ResultData>> Run(string job, string arg = null)
    {
        _ediabas.ArgString = arg ?? string.Empty;
        _ediabas.ExecuteJob(job);
        return _ediabas.ResultSets ?? new List<Dictionary<string, EdiabasNet.ResultData>>();
    }

    // every job in the loaded SGBD (offline)
    public List<string> Jobs()
    {
        var jobs = new List<string>();
        foreach (var set in Run("_JOBS"))
        {
            if (set.TryGetValue("JOBNAME", out var jn) && jn.OpData is string name)
                jobs.Add(name);
        }
        return jobs;
    }

    // an SGBD lookup table's rows (offline), as column->value maps.
    //
    // Actuator jobs name a component through a table rather than a number:
    // STEUERN_DIGITAL's ORT argument is documented "table BITS NAME TEXT",
    // meaning the legal values are the NAME column of the BITS table and TEXT
    // is the human label.
    //
    // _TABLE returns the whole table at once as COLUMN0..COLUMNn per set, and
    // the FIRST set is the header naming each column. Keying the rows by those
    // header names is what lets a caller ask for "NAME" and "TEXT" as the
    // argument's documentation describes, rather than positional columns.
    public List<Dictionary<string, string>> TableRows(string table)
    {
        var sets = Run("_TABLE", table);
        if (sets.Count == 0) return new List<Dictionary<string, string>>();

        static List<string> Cells(Dictionary<string, EdiabasNet.ResultData> set)
        {
            var cells = new List<string>();
            for (int i = 0; set.TryGetValue("COLUMN" + i, out var c); i++)
                cells.Add(c.OpData as string ?? string.Empty);
            return cells;
        }

        // EDIABAS has no heuristic: the first row IS the header
        // (EdiabasNet.IndexTable, j == 0). Some SGBDs emit a blank set ahead
        // of it, so the header is the first set with a non-empty cell. It
        // was "the first row with no digits" here, which refused real headers
        // such as ORT, UW1_NR, UW2_NR -- 1,656 tables in 211 SGBDs then shipped
        // with COLUMNn names and their header as data row 0
        // (tools/sgbd/repair_table_headers.py undid that in the dump).
        int head = 0;
        for (int i = 0; i < sets.Count && i < 4; i++)
        {
            var c = Cells(sets[i]);
            if (c.Count > 0 && c.Any(x => x.Length > 0))
            {
                head = i;
                break;
            }
        }

        var header = Cells(sets[head]);
        var rows = new List<Dictionary<string, string>>();
        foreach (var set in sets.Skip(head + 1))
        {
            var cells = Cells(set);
            var row = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (int i = 0; i < cells.Count; i++)
            {
                string name = i < header.Count && header[i].Length > 0
                    ? header[i] : "COLUMN" + i;
                row[name] = cells[i];
            }
            if (row.Count > 0) rows.Add(row);
        }
        return rows;
    }

    // every table the SGBD declares (offline)
    public List<string> Tables()
    {
        var names = new List<string>();
        foreach (var set in Run("_TABLES"))
            if (set.TryGetValue("TABLE", out var t) && t.OpData is string n)
                names.Add(n);
        return names;
    }

    // job result schema (offline) as "NAME : comment" lines. the _RESULTS
    // pseudo-job emits RESULT/RESULTTYPE/RESULTCOMMENT0..n per set.
    public List<string> ResultsOf(string job)
    {
        var lines = new List<string>();
        foreach (var set in Run("_RESULTS", job))
        {
            string name = set.TryGetValue("RESULT", out var r) && r.OpData is string s ? s : null;
            if (name == null) continue;
            string info = set.TryGetValue("RESULTCOMMENT0", out var i) && i.OpData is string si ? si : "";
            lines.Add(info.Length > 0 ? $"{name} : {info}" : name);
        }
        return lines;
    }

    // format a result value for any EDIABAS type
    public static string Format(EdiabasNet.ResultData rd)
    {
        object d = rd.OpData;
        return d switch
        {
            null => "(null)",
            byte[] bytes => BitConverter.ToString(bytes),
            _ => Convert.ToString(d, System.Globalization.CultureInfo.InvariantCulture)
        };
    }

    public void Dispose() => _ediabas?.Dispose();
}
