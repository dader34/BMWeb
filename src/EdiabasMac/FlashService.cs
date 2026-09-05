using System;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using System.Security.Cryptography;
using EdiabasLib;

namespace EdiabasMac;

// MS45 DME flashing.
//
// STAGE 1 (proven): read/backup — Identify, RequestSecurityAccess, ReadMemory, ResetSession.
// STAGE 2 (UNVERIFIED — bench-test on real hardware required before trusting): an erase ->
//   write -> readback-verify path (FlashTune / FlashProgram) plus offline BIN validation
//   (CRC-32/MPEG-2 + RSA firmware-signature) in the Ms45Bin helper below.
//
// Ported from terraphantm/MS45-Flasher (GPLv3), same EdiabasNet engine.
//
// SAFETY GATE: the erase/write telegrams are DISABLED BY DEFAULT. They fire only when BOTH
//   (a) the environment variable BMACW_ALLOW_FLASH_WRITE == "1", AND
//   (b) the caller passes confirm: true.
// With the gate off, FlashTune/FlashProgram validate the BIN and run a full dry-run (every
// step logged, best-effort readback comparison against the intended image) but send NO
// erase/write telegrams to the ECU. Offline BIN validation MUST pass before any write.
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

    // Interface-level trace of every telegram sent and received, into
    // <dir>/ifh.trc. Used to prove on a real car whether a step (the
    // RSA authentisierung_start in particular) is accepted or ignored.
    public void TraceTo(string dir)
    {
        _ediabas.SetConfigProperty("TracePath", dir);
        _ediabas.SetConfigProperty("IfhTrace", "3");
        _ediabas.SetConfigProperty("AppendTrace", "0");
        _ediabas.SetConfigProperty("IfhTraceBuffering", "0");
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

    // ==================================================================================
    // MS45 WRITE PATH — UNVERIFIED. Bench-test on real hardware required before trusting.
    //
    // Ported from terraphantm/MS45-Flasher (FlashDME_Data / Flashfull / FlashBlock / EraseECU).
    // The actual erase/write telegrams are gated: WriteAllowed(confirm) must be true, otherwise every step
    // is logged and a best-effort readback comparison runs, but NO erase/write is sent.
    // ==================================================================================

    // flash/erase target addresses (ECU-space command addresses, from the reference flasher)
    private const uint EraseTuneStart    = 0x2040000, EraseTuneLen    = 0x20000;
    private const uint FlashTuneStart    = 0x2040000, FlashTuneEnd    = 0x205CFFF;   // len 0x1D000
    private const uint EraseProgramStart = 0x2060000, EraseProgramLen = 0xA0000;
    private const uint FlashProgramStart = 0x2060000, FlashProgramEnd = 0x20FFF3F;   // len 0x9FF40
    private const uint FlashMpcStart     = 0x0000000, FlashMpcEnd     = 0x6FFFF;     // len 0x70000

    // Gate: the ONLY thing that lets an erase/write telegram reach the ECU.
    public static bool WriteAllowed(bool confirm) =>
        confirm && Environment.GetEnvironmentVariable("BMACW_ALLOW_FLASH_WRITE") == "1";

    public sealed record FlashOutcome(
        bool Validated,
        bool WriteAttempted,
        bool Success,
        bool? ReadbackMatch,
        IReadOnlyList<string> Log)
    {
        // dry-run means the gate was closed: BIN validated, steps logged, nothing written.
        public bool DryRun => Validated && !WriteAttempted;
    }

    // Flash the tune/calibration ("data") blob (0x1D000 bytes at ROMX 0x40000).
    //   rawTune : either the 0x1D000 tune blob, or a >0x40000 image we slice it out of.
    //   confirm : half of the write gate (env var is the other half).
    // Returns a full outcome; throws FlashException only on offline-validation failure.
    public FlashOutcome FlashTune(byte[] rawTune, string diagProtocol, bool confirm,
                                  Action<string> log = null, Action<int> progress = null)
    {
        var lines = new List<string>();
        void L(string s) { lines.Add(s); log?.Invoke(s); }

        // --- offline BIN validation (MUST pass before any write) ---
        byte[] blob = Ms45Bin.ExtractTuneBlob(rawTune);
        Ms45Bin.PrepareTune(blob);                                  // correct CRC + re-sign, in place
        var v = Ms45Bin.ValidateTune(blob);
        L($"tune: size 0x{blob.Length:X}, CRC {(v.CrcOk ? "OK" : "FAIL")} " +
          $"(stored 0x{v.CrcStored:X8} computed 0x{v.CrcComputed:X8}), " +
          $"signature {(v.SignatureOk ? "OK" : "FAIL")}");
        if (!v.Ok)
            throw new FlashException("tune BIN failed offline validation; refusing to flash");

        bool allowed = WriteAllowed(confirm);
        if (!allowed)
        {
            L("WRITE GATE CLOSED (need BMACW_ALLOW_FLASH_WRITE=1 and confirm:true) — DRY RUN.");
            L($"would erase  ROMX @0x{EraseTuneStart:X} len 0x{EraseTuneLen:X}");
            L($"would write  ROMX @0x{FlashTuneStart:X}..0x{FlashTuneEnd:X} ({blob.Length} bytes)");
            bool? m = DryRunReadback(DataRegion, blob, diagProtocol, L);
            return new FlashOutcome(true, false, false, m, lines);
        }

        // --- REAL WRITE (UNVERIFIED) ---
        L("WRITE GATE OPEN — sending erase/write telegrams. UNVERIFIED path.");
        if (!RequestSecurityAccess(diagProtocol)) throw new FlashException("security access denied");
        if (diagProtocol == "BMW-FAST")
        {
            ExecuteJob("normaler_datenverkehr", "nein;nein;ja");
            ExecuteJob("normaler_datenverkehr", "ja;nein;nein");
        }
        bool ok = EraseEcu(EraseTuneLen, EraseTuneStart, L)
               && FlashBlock(blob, FlashTuneStart, FlashTuneEnd, progress, L)
               && FinishFlash("Daten", diagProtocol, L);
        bool? match = ok ? VerifyReadback(DataRegion, blob, L) : (bool?)null;
        try { ExecuteJob("STEUERGERAETE_RESET", string.Empty); } catch { }
        return new FlashOutcome(true, true, ok && match == true, match, lines);
    }

    // Flash the full program: external flash (1 MB, program blob at 0x60000) + MPC (0x70000).
    public FlashOutcome FlashProgram(byte[] external, byte[] mpc, string diagProtocol, bool confirm,
                                     Action<string> log = null, Action<int> progress = null)
    {
        var lines = new List<string>();
        void L(string s) { lines.Add(s); log?.Invoke(s); }

        Ms45Bin.CheckProgramSizes(external, mpc);
        Ms45Bin.PrepareProgram(external, mpc);                      // correct dual CRC + re-sign, in place
        var v = Ms45Bin.ValidateProgram(external, mpc);
        L($"program: ext 0x{external.Length:X} mpc 0x{mpc.Length:X}, " +
          $"CRC primary {(v.CrcPrimaryOk ? "OK" : "FAIL")} secondary {(v.CrcSecondaryOk ? "OK" : "FAIL")}, " +
          $"signature {(v.SignatureOk ? "OK" : "FAIL")}");
        if (!v.Ok)
            throw new FlashException("program BIN failed offline validation; refusing to flash");

        byte[] progBlob = new byte[Ms45Bin.ProgramBlobSize];
        Array.Copy(external, Ms45Bin.ProgramBlobHostOffset, progBlob, 0, progBlob.Length);

        bool allowed = WriteAllowed(confirm);
        if (!allowed)
        {
            L("WRITE GATE CLOSED (need BMACW_ALLOW_FLASH_WRITE=1 and confirm:true) — DRY RUN.");
            L($"would erase   ROMX @0x{EraseProgramStart:X} len 0x{EraseProgramLen:X}");
            L($"would write   ROMX @0x{FlashProgramStart:X}..0x{FlashProgramEnd:X} ({progBlob.Length} bytes)");
            L($"would write   LAR  @0x{FlashMpcStart:X}..0x{FlashMpcEnd:X} ({mpc.Length} bytes)");
            bool? me = DryRunReadback(FullFlash, external, diagProtocol, L, ProgramBlobCompareOnly: true);
            bool? mm = DryRunReadback(MpcData, mpc, diagProtocol, L, alreadyUnlocked: true);
            bool? m = (me, mm) switch { (true, true) => true, (null, _) or (_, null) => (bool?)null, _ => false };
            return new FlashOutcome(true, false, false, m, lines);
        }

        L("WRITE GATE OPEN — sending erase/write telegrams. UNVERIFIED path.");
        if (!RequestSecurityAccess(diagProtocol)) throw new FlashException("security access denied");
        if (diagProtocol == "BMW-FAST")
        {
            ExecuteJob("normaler_datenverkehr", "nein;nein;ja");
            ExecuteJob("normaler_datenverkehr", "ja;nein;nein");
        }
        bool ok = EraseEcu(EraseProgramLen, EraseProgramStart, L)
               && FlashBlock(progBlob, FlashProgramStart, FlashProgramEnd, progress, L)
               && FlashBlock(mpc, FlashMpcStart, FlashMpcEnd, progress, L)
               && FinishFlash("Programm", diagProtocol, L);
        bool? match = null;
        if (ok)
        {
            bool? me = VerifyReadback(FullFlash, external, L, ProgramBlobCompareOnly: true);
            bool? mm = VerifyReadback(MpcData, mpc, L);
            match = (me, mm) switch { (true, true) => true, (null, _) or (_, null) => (bool?)null, _ => false };
        }
        try { ExecuteJob("STEUERGERAETE_RESET", string.Empty); } catch { }
        return new FlashOutcome(true, true, ok && match == true, match, lines);
    }

    // --- erase / write / finish telegrams (only reached when the gate is OPEN) ---

    // UNVERIFIED. flash_loeschen: 22-byte arg, [0]=1 [4]=0xFE, len@13 (LE u32), start@17 (LE u32).
    private bool EraseEcu(uint blockLen, uint blockStart, Action<string> log)
    {
        byte[] cmd = new byte[22];
        cmd[0] = 1;
        cmd[4] = 0xFE;
        BitConverter.GetBytes(blockLen).CopyTo(cmd, 13);
        BitConverter.GetBytes(blockStart).CopyTo(cmd, 17);
        log?.Invoke($"erase @0x{blockStart:X} len 0x{blockLen:X}");
        if (!ExecuteJobBin("flash_loeschen", cmd)) { log?.Invoke("erase FAILED"); return false; }
        return true;
    }

    // UNVERIFIED. flash_schreiben_adresse -> flash_schreiben (0xFD-byte chunks) -> flash_schreiben_ende.
    private bool FlashBlock(byte[] payload, uint blockStart, uint blockEnd,
                            Action<int> progress, Action<string> log)
    {
        uint blockStartOrig = blockStart;
        uint blockLen = blockEnd - blockStart + 1;
        if (payload.Length != blockLen)
        {
            log?.Invoke($"payload length 0x{payload.Length:X} != target 0x{blockLen:X}");
            return false;
        }

        byte[] addr = new byte[22];
        addr[0] = 1;
        addr[21] = 3;
        BitConverter.GetBytes(blockLen).CopyTo(addr, 13);
        BitConverter.GetBytes(blockStart).CopyTo(addr, 17);
        if (!ExecuteJobBin("flash_schreiben_adresse", addr)) { log?.Invoke("set flash address FAILED"); return false; }

        int seg = 0xFD;
        byte[] three = { 3 };
        while (blockLen > 0)
        {
            if (blockLen < seg) seg = (int)blockLen;
            byte[] header = new byte[21];
            header[0] = 1;
            header[13] = (byte)seg;
            BitConverter.GetBytes(blockStart).CopyTo(header, 17);
            byte[] chunk = payload.Skip((int)(blockStart - blockStartOrig)).Take(seg).ToArray();
            if (!ExecuteJobBin("flash_schreiben", header.Concat(chunk).Concat(three).ToArray()))
            {
                log?.Invoke($"flash FAILED at 0x{blockStart:X}");
                return false;
            }
            blockStart += (uint)seg;
            blockLen -= (uint)seg;
            progress?.Invoke((int)((blockStart - blockStartOrig) * 100 / (blockEnd - blockStartOrig)));
        }
        if (!ExecuteJobBin("flash_schreiben_ende", addr)) { log?.Invoke("end flash job FAILED"); return false; }
        return true;
    }

    // UNVERIFIED. post-write: return to normal traffic, ask the DME to check its own signature.
    private bool FinishFlash(string kind, string diagProtocol, Action<string> log)
    {
        if (diagProtocol != "BMW-FAST")
        {
            if (!ExecuteJob("diagnose_mode", "DEFAULT;PC9600")) return false;
            if (!ExecuteJob("SET_PARAMETER", ";9600")) return false;
        }
        else
        {
            if (!ExecuteJob("diagnose_mode", "DEFAULT")) return false;
            if (!ExecuteJob("normaler_datenverkehr", "ja;nein;ja")) return false;
        }
        ExecuteJob("FLASH_PROGRAMMIER_STATUS_LESEN", string.Empty);
        log?.Invoke($"checking DME signature ({kind})");
        if (!ExecuteJob("FLASH_SIGNATUR_PRUEFEN", kind + ";64"))
        {
            log?.Invoke("DME signature check FAILED");
            return false;
        }
        ExecuteJob("FLASH_PROGRAMMIER_STATUS_LESEN", string.Empty);
        return true;
    }

    // Read a region back and compare to the intended image; returns match/mismatch, or null if
    // the readback could not run (no device / read error). Non-destructive.
    private bool? VerifyReadback(ReadRegion region, byte[] intended, Action<string> log,
                                 bool ProgramBlobCompareOnly = false)
    {
        try
        {
            byte[] got = ReadMemory(region);
            return CompareImages(region, got, intended, log, ProgramBlobCompareOnly);
        }
        catch (Exception ex)
        {
            log?.Invoke($"readback of {region.Name} skipped: {ex.Message}");
            return null;
        }
    }

    // Dry-run readback: best-effort. Unlock (safe, reversible) then read + compare, without ever
    // erasing or writing. Used to show what a real flash WOULD change.
    private bool? DryRunReadback(ReadRegion region, byte[] intended, string diagProtocol,
                                 Action<string> log, bool ProgramBlobCompareOnly = false,
                                 bool alreadyUnlocked = false)
    {
        try
        {
            if (!alreadyUnlocked && !RequestSecurityAccess(diagProtocol))
            {
                log?.Invoke($"dry-run readback of {region.Name} skipped: security access denied");
                return null;
            }
            byte[] got = ReadMemory(region);
            return CompareImages(region, got, intended, log, ProgramBlobCompareOnly);
        }
        catch (Exception ex)
        {
            log?.Invoke($"dry-run readback of {region.Name} skipped: {ex.Message}");
            return null;
        }
    }

    private static bool CompareImages(ReadRegion region, byte[] got, byte[] intended,
                                      Action<string> log, bool ProgramBlobCompareOnly)
    {
        int start = 0, len;
        if (ProgramBlobCompareOnly)
        {
            start = Ms45Bin.ProgramBlobHostOffset;
            len = Ms45Bin.ProgramBlobSize;
        }
        else
        {
            len = Math.Min(got.Length, intended.Length);
        }
        int diffs = 0, first = -1;
        for (int i = start; i < start + len && i < got.Length && i < intended.Length; i++)
        {
            if (got[i] != intended[i]) { if (first < 0) first = i; diffs++; }
        }
        if (diffs == 0) { log?.Invoke($"readback {region.Name}: MATCH ({len} bytes)"); return true; }
        log?.Invoke($"readback {region.Name}: MISMATCH, {diffs} byte(s), first at 0x{first:X}");
        return false;
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

// ======================================================================================
// Ms45Bin — offline MS45 firmware-image math: CRC-32/MPEG-2 + RSA firmware signature.
//
// Pure functions, no ECU I/O. Used by FlashService's write path as the mandatory
// pre-write validation, and covered by tools/verify/test_ms45_bin.js.
//
// Ported from terraphantm/MS45-Flasher (Checksums_Signatures.cs — the RSA constants were
// reverse-engineered by hassmaschine and published there under GPL-3.0).
//
// Address model (all header multi-byte fields are BIG-ENDIAN u32; flash command
// addresses/lengths are LITTLE-ENDIAN u32):
//   external flash mapped @ 0xFFF00000, MPC flash mapped @ 0x00000000.
//   parameter (tune) blob: 0x1D000 bytes, host offset 0x40000 in a full external image.
//   program blob:          0x9FF40 bytes, host offset 0x60000 in a full external image.
//
// NOTE ON KEY SIZE: the modulus below is 512-bit (64-byte RSA), which is what the real
// MS45 firmware uses. The task brief called this "RSA-1024"; the implementation matches
// the actual ECU (512-bit) rather than the brief's nominal figure.
// ======================================================================================
public static class Ms45Bin
{
    // ---- sizes / host offsets ----
    public const int TuneBlobSize        = 0x1D000;
    public const int ExternalFlashSize   = 0x100000;
    public const int MpcFlashSize        = 0x70000;
    public const int TuneBlobHostOffset  = 0x40000;
    public const int ProgramBlobHostOffset = 0x60000;
    public const int ProgramBlobSize     = 0x9FF40;

    // ---- ECU-space base addresses ----
    public const uint ExternalFlashBase = 0xFFF00000;
    public const uint ParamCrcSegmentBase = 0xFFE40000; // CRC segment window (mirror)
    public const uint ParamSigSegmentBase = 0xFFF40000; // signature segment window

    // ---- parameter-blob header field offsets (relative to the 0x1D000 blob) ----
    public const int ParamCrcStored       = 0x100;
    public const int ParamCrcSegTable     = 0x104; // count, then (start,end) BE pairs, stride 8
    public const int ParamCrcInitial      = 0x110;
    public const int ParamSigSegCount     = 0x130;
    public const int ParamSigSegStarts    = 0x134; // stride 8
    public const int ParamSigSegLengths   = 0x144; // stride 4
    public const int ParamSigStored       = 0x174;
    public const int SigLength            = 64;

    // ---- program-blob header field offsets (absolute in a full external image) ----
    public const int ProgCrcPrimaryStored   = 0x60000;
    public const int ProgCrcPrimaryInitial  = 0x60004;
    public const int ProgCrcPrimarySeg1Start = 0x60008;
    public const int ProgCrcPrimarySeg2Start = 0x6000C;
    public const int ProgCrcPrimarySeg1End   = 0x60010;
    public const int ProgCrcPrimarySeg2End   = 0x60014;
    public const int ProgCrcSecondaryStored   = 0x60340;
    public const int ProgCrcSecondarySeg1Start = 0x60348;
    public const int ProgCrcSecondarySeg1End   = 0x6034C;
    public const int ProgCrcSecondarySeg2Start = 0x60350;
    public const int ProgCrcSecondarySeg2End   = 0x60354;
    public const int ProgCrcSecondaryInitial   = 0x60358;
    public const int ProgSigSegCount   = 0x60030;
    public const int ProgSigSegStarts  = 0x60034; // stride 8
    public const int ProgSigSegLengths = 0x6004C; // stride 4
    public const int ProgSigStored     = 0x60074;

    // ---- RSA firmware-signing key (512-bit). Public modulus + private exponent. ----
    public static readonly BigInteger FirmwareModulus = BigInteger.Parse(
        "8470472580328006956677424405159809178175955696534718361218518906571634405286747173565502454089691240931470915432212928785673566143706092135925769557255439");
    public static readonly BigInteger FirmwarePrivateExponent = BigInteger.Parse(
        "7260405068852577391437792347279836438436533454172615738187301919918543775959908116508429649500721130520546364846625732843778800986047617824899475327781303");

    // ---- endian helpers ----
    public static uint ReadU32BE(byte[] b, int off)
    {
        if (off < 0 || off + 4 > b.Length) throw new FlashException($"ReadU32BE out of bounds at 0x{off:X}");
        return (uint)((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]);
    }

    public static void WriteU32BE(byte[] b, uint v, int off)
    {
        if (off < 0 || off + 4 > b.Length) throw new FlashException($"WriteU32BE out of bounds at 0x{off:X}");
        b[off]     = (byte)(v >> 24);
        b[off + 1] = (byte)(v >> 16);
        b[off + 2] = (byte)(v >> 8);
        b[off + 3] = (byte)v;
    }

    // ---- CRC-32/MPEG-2 (poly 0x04C11DB7, non-reflected, no final XOR, caller-supplied seed) ----
    private static readonly uint[] Crc32Table = BuildCrc32Table();

    private static uint[] BuildCrc32Table()
    {
        var t = new uint[256];
        for (uint i = 0; i < 256; i++)
        {
            uint c = i << 24;
            for (int bit = 0; bit < 8; bit++)
                c = (c & 0x80000000) != 0 ? (c << 1) ^ 0x04C11DB7 : c << 1;
            t[i] = c;
        }
        return t;
    }

    public static uint Crc32(byte[] buffer, int start, int length, uint initial)
    {
        uint crc = initial;
        for (int i = start; i < start + length; i++)
            crc = ((crc << 8) & 0xFFFFFF00) ^ Crc32Table[((crc >> 24) & 0xFF) ^ buffer[i]];
        return crc;
    }

    // ---- RSA signing primitives ----
    // C# BigInteger(byte[]) is little-endian and needs a trailing 0x00 to stay positive.
    private static byte[] Append0(byte[] a)
    {
        byte[] r = new byte[a.Length + 1];
        Array.Copy(a, r, a.Length);
        return r;
    }

    // Sign an already-MD5-hashed message: C = M^d mod n (M = digest as LE int), then store as
    // 16 words, least-significant word first, each word byte-reversed (BE within the word).
    public static byte[] SignHashedFirmware(byte[] md5Hash)
    {
        if (md5Hash.Length != 16) throw new FlashException("SignHashedFirmware expects a 16-byte MD5");
        BigInteger m = new BigInteger(Append0(md5Hash));
        BigInteger c = BigInteger.ModPow(m, FirmwarePrivateExponent, FirmwareModulus);
        byte[] le = c.ToByteArray();                        // little-endian, possibly < 64 or with sign byte
        if (le.Length < 64) le = le.Concat(new byte[64 - le.Length]).ToArray();
        byte[] outp = new byte[64];
        for (int i = 0; i < 16; i++)
        {
            outp[4 * i + 0] = le[4 * i + 3];
            outp[4 * i + 1] = le[4 * i + 2];
            outp[4 * i + 2] = le[4 * i + 1];
            outp[4 * i + 3] = le[4 * i + 0];
        }
        return outp;
    }

    private static byte[] Md5(byte[] data) => MD5.HashData(data);

    private static bool BytesEqual(byte[] a, int aoff, byte[] b, int boff, int len)
    {
        for (int i = 0; i < len; i++) if (a[aoff + i] != b[boff + i]) return false;
        return true;
    }

    // ==================== parameter (tune) blob ====================

    public static byte[] ExtractTuneBlob(byte[] raw)
    {
        if (raw == null) throw new FlashException("tune image is null");
        // Full external image or any image larger than 0x40000: slice the 0x1D000 blob out.
        if (raw.Length > TuneBlobHostOffset)
        {
            if (raw.Length < TuneBlobHostOffset + TuneBlobSize)
                throw new FlashException($"image 0x{raw.Length:X} too small to hold a tune blob at 0x{TuneBlobHostOffset:X}");
            byte[] blob = new byte[TuneBlobSize];
            Array.Copy(raw, TuneBlobHostOffset, blob, 0, TuneBlobSize);
            return blob;
        }
        if (raw.Length != TuneBlobSize)
            throw new FlashException($"invalid tune length 0x{raw.Length:X} (expected 0x{TuneBlobSize:X})");
        return (byte[])raw.Clone();
    }

    private static uint ComputeParameterCrc(byte[] blob)
    {
        uint crc = ReadU32BE(blob, ParamCrcInitial);
        uint count = ReadU32BE(blob, ParamCrcSegTable);
        for (int i = 0; i < count; i++)
        {
            long start = (long)ReadU32BE(blob, ParamCrcSegTable + 4 + i * 8) - ParamCrcSegmentBase;
            long end   = (long)ReadU32BE(blob, ParamCrcSegTable + 8 + i * 8) - ParamCrcSegmentBase;
            if (start < 0 || end < start || end >= blob.Length)
                throw new FlashException($"tune CRC segment [0x{start:X}..0x{end:X}] out of blob bounds");
            crc = Crc32(blob, (int)start, (int)(end - start + 1), crc);
        }
        return crc;
    }

    private static byte[] ComputeParameterSignature(byte[] blob)
    {
        uint count = ReadU32BE(blob, ParamSigSegCount);
        var buf = new List<byte>();
        for (int i = 0; i < count; i++)
        {
            long start = (long)ReadU32BE(blob, ParamSigSegStarts + i * 8) - ParamSigSegmentBase;
            int len    = (int)ReadU32BE(blob, ParamSigSegLengths + i * 4);
            if (start < 0 || len < 0 || start + len > blob.Length)
                throw new FlashException($"tune signed segment [0x{start:X} +{len}] out of blob bounds");
            for (int j = 0; j < len; j++) buf.Add(blob[start + j]);
        }
        return SignHashedFirmware(Md5(buf.ToArray()));
    }

    // Correct the parameter CRC + re-sign in place (matches the reference flasher before a write).
    public static void PrepareTune(byte[] blob)
    {
        WriteU32BE(blob, ComputeParameterCrc(blob), ParamCrcStored);
        byte[] sig = ComputeParameterSignature(blob);
        Array.Copy(sig, 0, blob, ParamSigStored, SigLength);
    }

    public sealed record TuneValidation(uint CrcStored, uint CrcComputed, bool CrcOk, bool SignatureOk)
    {
        public bool Ok => CrcOk && SignatureOk;
    }

    public static TuneValidation ValidateTune(byte[] blob)
    {
        uint stored = ReadU32BE(blob, ParamCrcStored);
        uint computed = ComputeParameterCrc(blob);
        byte[] sig = ComputeParameterSignature(blob);
        bool sigOk = BytesEqual(blob, ParamSigStored, sig, 0, SigLength);
        return new TuneValidation(stored, computed, stored == computed, sigOk);
    }

    // ==================== program blob (external + MPC) ====================

    public static void CheckProgramSizes(byte[] external, byte[] mpc)
    {
        if (external == null || external.Length != ExternalFlashSize)
            throw new FlashException($"invalid external flash length 0x{external?.Length ?? 0:X} (expected 0x{ExternalFlashSize:X})");
        if (mpc == null || mpc.Length != MpcFlashSize)
            throw new FlashException($"invalid MPC flash length 0x{mpc?.Length ?? 0:X} (expected 0x{MpcFlashSize:X})");
    }

    // Slice an ECU-space [start,length] range out of whichever flash space it maps into.
    private static void AppendEcuRange(List<byte> dst, uint ecuStart, int length, byte[] external, byte[] mpc)
    {
        if (length < 0) throw new FlashException("negative program segment length");
        if (ecuStart >= ExternalFlashBase)
        {
            long off = (long)ecuStart - ExternalFlashBase;
            if (off < 0 || off + length > external.Length)
                throw new FlashException($"external segment [0x{ecuStart:X} +{length}] out of bounds");
            for (int i = 0; i < length; i++) dst.Add(external[off + i]);
        }
        else
        {
            long off = ecuStart;
            if (off + length > mpc.Length)
                throw new FlashException($"MPC segment [0x{ecuStart:X} +{length}] out of bounds");
            for (int i = 0; i < length; i++) dst.Add(mpc[off + i]);
        }
    }

    private static uint ComputeProgramCrc(byte[] external, byte[] mpc,
        int initialOff, int seg1Start, int seg1End, int seg2Start, int seg2End)
    {
        uint crc = ReadU32BE(external, initialOff);
        var pairs = new (int s, int e)[] { (seg1Start, seg1End), (seg2Start, seg2End) };
        foreach (var (sOff, eOff) in pairs)
        {
            uint s = ReadU32BE(external, sOff);
            uint e = ReadU32BE(external, eOff);
            long len = (long)e - s + 1;
            if (len <= 0) throw new FlashException($"program CRC segment [0x{s:X}..0x{e:X}] non-positive length");
            var buf = new List<byte>();
            AppendEcuRange(buf, s, (int)len, external, mpc);
            crc = Crc32(buf.ToArray(), 0, buf.Count, crc);
        }
        return crc;
    }

    private static byte[] ComputeProgramSignature(byte[] external, byte[] mpc)
    {
        uint count = ReadU32BE(external, ProgSigSegCount);
        var buf = new List<byte>();
        for (int i = 0; i < count; i++)
        {
            uint start = ReadU32BE(external, ProgSigSegStarts + i * 8);
            int len    = (int)ReadU32BE(external, ProgSigSegLengths + i * 4);
            AppendEcuRange(buf, start, len, external, mpc);
        }
        return SignHashedFirmware(Md5(buf.ToArray()));
    }

    // Correct both program CRCs + re-sign in place (mirrors CorrectProgramChecksums + SignMS45Program).
    public static void PrepareProgram(byte[] external, byte[] mpc)
    {
        WriteU32BE(external, ComputeProgramCrc(external, mpc,
            ProgCrcPrimaryInitial, ProgCrcPrimarySeg1Start, ProgCrcPrimarySeg1End,
            ProgCrcPrimarySeg2Start, ProgCrcPrimarySeg2End), ProgCrcPrimaryStored);
        WriteU32BE(external, ComputeProgramCrc(external, mpc,
            ProgCrcSecondaryInitial, ProgCrcSecondarySeg1Start, ProgCrcSecondarySeg1End,
            ProgCrcSecondarySeg2Start, ProgCrcSecondarySeg2End), ProgCrcSecondaryStored);
        byte[] sig = ComputeProgramSignature(external, mpc);
        Array.Copy(sig, 0, external, ProgSigStored, SigLength);
    }

    public sealed record ProgramValidation(bool CrcPrimaryOk, bool CrcSecondaryOk, bool SignatureOk)
    {
        public bool Ok => CrcPrimaryOk && CrcSecondaryOk && SignatureOk;
    }

    public static ProgramValidation ValidateProgram(byte[] external, byte[] mpc)
    {
        uint p = ComputeProgramCrc(external, mpc,
            ProgCrcPrimaryInitial, ProgCrcPrimarySeg1Start, ProgCrcPrimarySeg1End,
            ProgCrcPrimarySeg2Start, ProgCrcPrimarySeg2End);
        uint s = ComputeProgramCrc(external, mpc,
            ProgCrcSecondaryInitial, ProgCrcSecondarySeg1Start, ProgCrcSecondarySeg1End,
            ProgCrcSecondarySeg2Start, ProgCrcSecondarySeg2End);
        bool pOk = ReadU32BE(external, ProgCrcPrimaryStored) == p;
        bool sOk = ReadU32BE(external, ProgCrcSecondaryStored) == s;
        byte[] sig = ComputeProgramSignature(external, mpc);
        bool sigOk = BytesEqual(external, ProgSigStored, sig, 0, SigLength);
        return new ProgramValidation(pOk, sOk, sigOk);
    }
}
