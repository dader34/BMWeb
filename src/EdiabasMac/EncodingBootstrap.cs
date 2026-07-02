using System.Runtime.CompilerServices;
using System.Text;

namespace EdiabasMac;

// single, central CodePages registration (Windows-1252 for the INPA text files
// and the EDIABAS engine's string handling). a module initializer runs once
// when this assembly loads, before any Diag / FlashService / InpaConfig /
// EdiabasNet code executes, so no per-call or per-instance re-registration is
// needed anywhere else.
internal static class EncodingBootstrap
{
    [ModuleInitializer]
    [System.Diagnostics.CodeAnalysis.SuppressMessage("Usage", "CA2255",
        Justification = "intentional: register CodePages once at assembly load, before any Diag/InpaConfig/EdiabasNet code runs")]
    internal static void Init() => Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
}
