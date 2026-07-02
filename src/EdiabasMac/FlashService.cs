using System;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using System.Security.Cryptography;
using EdiabasLib;

namespace EdiabasMac;

// MS45 DME flashing, STAGE 1: read/backup only, no write path.
//
// Ported from terraphantm/MS45-Flasher (GPLv3), same EdiabasNet engine. write/erase
// omitted until read + checksum/signing math is proven against a real dump.
//
// MS45 memory map (from the original tool):
//   ROMX 0x40000-0x5CFFF  : tune/calibration ("data")
//   ROMX 0x00000-0xFFFFF  : full external flash (1 MB)
//   LAR  0x00000-0x6FFFF  : MPC internal data (448 KB)
public sealed class FlashService : IDisposable
{
    public sealed record ReadRegion(string Name, string Segment, uint Start, uint End)
    {
        public uint Length => End - Start + 1;
    }

    // standard MS45 read regions
    public static readonly ReadRegion DataRegion = new("data", "ROMX", 0x40000, 0x5CFFF);
    public static readonly ReadRegion FullFlash  = new("full", "ROMX", 0x00000, 0xFFFFF);
    public static readonly ReadRegion MpcData    = new("mpc",  "LAR",  0x00000, 0x6FFFF);

    private readonly EdiabasNet _ediabas;

    public FlashService(string ecuPath, string sgbd, string comPort)
    {
        // code-page encodings are registered once in EncodingBootstrap
        _ediabas = new EdiabasNet
        {
            AbortJobFunc = () => false,
            EdInterfaceClass = new EdInterfaceObd { ComPort = comPort },
        };
        _ediabas.SetConfigProperty("EcuPath", ecuPath);
        _ediabas.ResolveSgbdFile(sgbd);
    }

    // ECU identity, read once before any flash op
    public sealed record EcuInfo(string DmeType, string Vin, string HwRef, string SwRef, string ProgrammingStatus, string DiagProtocol, bool Supported);

    public EcuInfo Identify()
    {
        string vin = RunStr("aif_lesen", "AIF_FG_NR");
        string hw = RunStr("hardware_referenz_lesen", "HARDWARE_REFERENZ");
        string sw = RunStr("daten_referenz_lesen", "DATEN_REFERENZ");
        string ps = RunStr("flash_programmier_status_lesen", "FLASH_PROGRAMMIER_STATUS_TEXT");
        string proto = "";
        if (ExecuteJob("DIAGNOSEPROTOKOLL_LESEN", string.Empty)) proto = ResultStr("DIAG_PROT_IST");

        // DME type from hardware reference
        string dmeType = hw switch
        {
            "0044560" => "MS45.0",
            "0044570" => "MS45.1",
            _ => "Unknown / unsupported",
        };
        bool supported = dmeType.StartsWith("MS45");
        return new EcuInfo(dmeType, vin, hw, sw, ps, proto, supported);
    }

    // security access (seed/key), required before reading ROMX or writing:
    // serial -> request random seed -> RSA-sign with level-3 private key ->
    // authentisierung_start -> enter ECU-programming mode @ 115200.
    // unlocks access only, does not modify the DME.
    public bool RequestSecurityAccess(string diagProtocol)
    {
        if (!ExecuteJob("seriennummer_lesen", string.Empty)) return false;
        byte[] serialReply = ResultBytes("_TEL_ANTWORT");
        if (serialReply == null || serialReply.Length < 5) return false;
        byte[] serialNumber = serialReply.Skip(serialReply.Length - 5).Take(4).ToArray();

        byte[] userId = new byte[4];
        RandomNumberGenerator.Fill(userId);

        if (!ExecuteJob("authentisierung_zufallszahl_lesen",
                "3;0x" + BitConverter.ToUInt32(userId.Reverse().ToArray(), 0).ToString("X")))
            return false;
        byte[] seed = ResultBytes("ZUFALLSZAHL");
        if (seed == null) return false;

        if (!ExecuteJobBin("authentisierung_start", GetSecurityAccessMessage(userId, serialNumber, seed)))
            return false;

        if (diagProtocol != "BMW-FAST")
        {
            if (!ExecuteJob("diagnose_mode", "ECUPM;PC115200")) return false;
            if (!ExecuteJob("SET_PARAMETER", ";115200")) return false;
            if (!ExecuteJob("ACCESS_TIMING_PARAMETER", "00;120;24;240;00")) return false;
            if (!ExecuteJob("SET_PARAMETER", ";115200;;15")) return false;
        }
        else
        {
            if (!ExecuteJob("diagnose_mode", "ECUPM")) return false;
        }
        return true;
    }

    // RSA level-3 security-access message
    private static byte[] GetSecurityAccessMessage(byte[] userId, byte[] serialNumber, byte[] seed)
    {
        BigInteger n = BigInteger.Parse("8972339025878534711764289273376673716657892103603163846525142300863027035823902824753024958104010374518577719658056297243325957293507856591918471309133927");
        BigInteger d = BigInteger.Parse("3845288153947943447898981117161431592853382330115641648510775271798440158210161294390718397115404567798616968157688687573437683643982238798574542074351303");

        byte[] toHash = userId.Concat(serialNumber).Concat(seed).ToArray();
        byte[] hash = MD5.HashData(toHash);

        var toEncrypt = new BigInteger(Append0(hash));
        var encrypted = BigInteger.ModPow(toEncrypt, d, n);
        byte[] enc = encrypted.ToByteArray();
        // ensure 64 bytes
        if (enc.Length < 64) enc = enc.Concat(new byte[64 - enc.Length]).ToArray();

        byte[] payload = new byte[65];
        payload[64] = 3;
        for (int i = 0; i < 16; ++i)
        {
            payload[0 + 4 * i] = enc[3 + 4 * i];
            payload[1 + 4 * i] = enc[2 + 4 * i];
            payload[2 + 4 * i] = enc[1 + 4 * i];
            payload[3 + 4 * i] = enc[0 + 4 * i];
        }
        byte[] header = { 01, 00, 00, 00, 0x0A, 00, 00, 00, 00, 00, 00, 00, 00, 0x44, 00, 00, 00, 00, 00, 00, 00, 00, 00, 00, 0x10 };
        return header.Concat(payload).ToArray();
    }

    private static byte[] Append0(byte[] a)
    {
        byte[] r = new byte[a.Length + 1];
        Array.Copy(a, r, a.Length);
        return r;
    }

    // read a region in 254-byte chunks (speicher_lesen_ascii), progress 0..100
    public byte[] ReadMemory(ReadRegion region, Action<int> progress = null)
    {
        var dump = new List<byte>((int)region.Length);
        uint start = region.Start;
        uint length = region.Length;
        uint remaining = length;
        uint bytesRead = 0;
        const uint chunk = 254;

        while (bytesRead < length)
        {
            uint seg = remaining < chunk ? remaining : chunk;
            if (!ExecuteJob("speicher_lesen_ascii", $"{region.Segment};{start};{seg}"))
                throw new FlashException($"read failed at 0x{start:X} ({region.Segment})");

            byte[] part = ResultBytes("DATEN");
            if (part == null) throw new FlashException($"no data at 0x{start:X}");
            dump.AddRange(part);

            bytesRead += seg;
            start += seg;
            remaining -= seg;
            progress?.Invoke((int)(bytesRead * 100 / length));
        }
        return dump.ToArray();
    }

    // EDIABAS helpers
    private bool ExecuteJob(string job, string arg)
    {
        _ediabas.ArgString = arg;
        try { _ediabas.ExecuteJob(job); }
        catch { return false; }
        return ResultStr("JOB_STATUS") == "OKAY";
    }

    private bool ExecuteJobBin(string job, byte[] arg)
    {
        _ediabas.ArgBinary = arg;
        try { _ediabas.ExecuteJob(job); }
        catch { return false; }
        return ResultStr("JOB_STATUS") == "OKAY";
    }

    private string RunStr(string job, string resultName)
    {
        _ediabas.ArgString = string.Empty;
        _ediabas.ExecuteJob(job);
        return ResultStr(resultName);
    }

    private string ResultStr(string name)
    {
        foreach (var set in _ediabas.ResultSets ?? new())
            foreach (var key in set.Keys.OrderBy(x => x))
                if (set[key].Name == name && set[key].OpData is string s)
                    return s;
        return string.Empty;
    }

    private byte[] ResultBytes(string name)
    {
        byte[] result = null;
        foreach (var set in _ediabas.ResultSets ?? new())
            foreach (var key in set.Keys.OrderBy(x => x))
                if (set[key].Name == name && set[key].OpData is byte[] b)
                    result = b;
        return result;
    }

    // return the DME to normal diagnostic mode, undoing the 115200/ECU-programming
    // state security access left. best-effort, failures ignored.
    public void ResetSession()
    {
        try { ExecuteJob("diagnose_mode", "DEFAULT"); } catch { }
        try { ExecuteJob("SET_PARAMETER", ";9600"); } catch { }
        try { ExecuteJob("STEUERGERAETE_RESET", string.Empty); } catch { }
    }

    public void Dispose()
    {
        try { ResetSession(); } catch { }
        _ediabas?.Dispose();
    }
}

public sealed class FlashException : Exception
{
    public FlashException(string message) : base(message) { }
}
