using System;
using System.Collections.Generic;
using System.IO;
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
