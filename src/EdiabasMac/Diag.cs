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

        // the header is the first row whose cells look like column names
        // (all non-empty, no digits) — some SGBDs emit a blank row ahead of it,
        // and taking set 0 blindly turns the real header into a data row.
        int head = 0;
        for (int i = 0; i < sets.Count && i < 4; i++)
        {
            var c = Cells(sets[i]);
            if (c.Count > 0 && c.All(x => x.Length > 0 && !x.Any(char.IsDigit)))
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
