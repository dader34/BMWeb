// stubs so EdInterfaceObd's adapter-hook block compiles without the BLE
// (InTheHand) and ELM Bluetooth-serial stacks. the app is cable-only.
//
// EdInterfaceObd selects an adapter by ComPort prefix:
//   "BLUETOOTH" -> EdBluetoothInterface    (stub below)
//   "ELM327BT"  -> EdElmSerialInterface     (stub below)
//   "DEEPOBDWIFI" -> EdCustomWiFiInterface  (stub below)
//
// stubs expose only what the hook block references (PortId + static delegates).
// their PortId never matches the configured ComPort, so never selected. the
// wired K+DCAN cable takes the plain serial branch instead.

using System;
using System.Collections.Generic;
using EdiabasLib;

namespace EdiabasLib
{
    internal static class EdElmSerialInterface
    {
        public const string PortId = "__ELMBT_DISABLED__";  // never matches a real port
        public static EdiabasNet Ediabas { get; set; }

        public static bool InterfaceConnect(string port, object parameter) => false;
        public static bool InterfaceDisconnect() => true;
        public static bool InterfaceTransmitCancel(bool cancel) => true;
        public static EdInterfaceObd.InterfaceErrorResult InterfaceSetConfig(
            EdInterfaceObd.Protocol protocol, int baudRate, int dataBits,
            EdInterfaceObd.SerialParity parity, bool allowBitBang)
            => EdInterfaceObd.InterfaceErrorResult.ConfigError;
        public static bool InterfaceSetDtr(bool dtr) => false;
        public static bool InterfaceSetRts(bool rts) => false;
        public static bool InterfaceGetDsr(out bool dsr) { dsr = false; return false; }
        public static bool InterfaceSetBreak(bool enable) => false;
        public static bool InterfaceSetInterByteTime(int time) => false;
        public static bool InterfaceSetCanIds(int canTxId, int canRxId, EdInterfaceObd.CanFlags canFlags) => false;
        public static bool InterfacePurgeInBuffer() => false;
        public static bool InterfaceAdapterEcho() => false;
        public static bool InterfaceHasPreciseTimeout() => false;
        public static bool InterfaceHasAutoBaudRate() => false;
        public static bool InterfaceHasAutoKwp1281() => false;
        public static int? InterfaceAdapterVersion() => null;
        public static byte[] InterfaceAdapterSerial() => null;
        public static double? InterfaceAdapterVoltage() => null;
        public static bool InterfaceHasIgnitionStatus() => false;
        public static bool InterfaceSendData(byte[] sendData, int length, bool setDtr, double dtrTimeCorr) => false;
        public static bool InterfaceReceiveData(byte[] receiveData, int offset, int length, int timeout, int timeoutTelEnd, EdiabasNet ediabasLog) => false;
        public static bool InterfaceSendPulse(UInt64 dataBits, int length, int pulseWidth, bool setDtr, bool bothLines, int autoKeyByteDelay) => false;
    }

    internal static class EdBluetoothInterface
    {
        public const string PortId = "__BT_DISABLED__";  // never matches a real port
        public static EdiabasNet Ediabas { get; set; }

        public static bool InterfaceConnect(string port, object parameter) => false;
        public static bool InterfaceDisconnect() => true;
        public static bool InterfaceTransmitCancel(bool cancel) => true;
        public static EdInterfaceObd.InterfaceErrorResult InterfaceSetConfig(
            EdInterfaceObd.Protocol protocol, int baudRate, int dataBits,
            EdInterfaceObd.SerialParity parity, bool allowBitBang)
            => EdInterfaceObd.InterfaceErrorResult.ConfigError;
        public static bool InterfaceSetDtr(bool dtr) => false;
        public static bool InterfaceSetRts(bool rts) => false;
        public static bool InterfaceGetDsr(out bool dsr) { dsr = false; return false; }
        public static bool InterfaceSetBreak(bool enable) => false;
        public static bool InterfaceSetInterByteTime(int time) => false;
        public static bool InterfaceSetCanIds(int canTxId, int canRxId, EdInterfaceObd.CanFlags canFlags) => false;
        public static bool InterfacePurgeInBuffer() => false;
        public static bool InterfaceAdapterEcho() => false;
        public static bool InterfaceHasPreciseTimeout() => false;
        public static bool InterfaceHasAutoBaudRate() => false;
        public static bool InterfaceHasAutoKwp1281() => false;
        public static int? InterfaceAdapterVersion() => null;
        public static byte[] InterfaceAdapterSerial() => null;
        public static double? InterfaceAdapterVoltage() => null;
        public static bool InterfaceHasIgnitionStatus() => false;
        public static bool InterfaceSendData(byte[] sendData, int length, bool setDtr, double dtrTimeCorr) => false;
        public static bool InterfaceReceiveData(byte[] receiveData, int offset, int length, int timeout, int timeoutTelEnd, EdiabasNet ediabasLog) => false;
        public static bool InterfaceSendPulse(UInt64 dataBits, int length, int pulseWidth, bool setDtr, bool bothLines, int autoKeyByteDelay) => false;
    }

    internal static class EdCustomWiFiInterface
    {
        public const string PortId = "__CUSTOMWIFI_DISABLED__";
        public static EdiabasNet Ediabas { get; set; }

        public static bool InterfaceConnect(string port, object parameter) => false;
        public static bool InterfaceDisconnect() => true;
        public static bool InterfaceTransmitCancel(bool cancel) => true;
        public static EdInterfaceObd.InterfaceErrorResult InterfaceSetConfig(
            EdInterfaceObd.Protocol protocol, int baudRate, int dataBits,
            EdInterfaceObd.SerialParity parity, bool allowBitBang)
            => EdInterfaceObd.InterfaceErrorResult.ConfigError;
        public static bool InterfaceSetDtr(bool dtr) => false;
        public static bool InterfaceSetRts(bool rts) => false;
        public static bool InterfaceGetDsr(out bool dsr) { dsr = false; return false; }
        public static bool InterfaceSetBreak(bool enable) => false;
        public static bool InterfaceSetInterByteTime(int time) => false;
        public static bool InterfaceSetCanIds(int canTxId, int canRxId, EdInterfaceObd.CanFlags canFlags) => false;
        public static bool InterfacePurgeInBuffer() => false;
        public static bool InterfaceAdapterEcho() => false;
        public static bool InterfaceHasPreciseTimeout() => false;
        public static bool InterfaceHasAutoBaudRate() => false;
        public static bool InterfaceHasAutoKwp1281() => false;
        public static int? InterfaceAdapterVersion() => null;
        public static byte[] InterfaceAdapterSerial() => null;
        public static double? InterfaceAdapterVoltage() => null;
        public static bool InterfaceHasIgnitionStatus() => false;
        public static bool InterfaceSendData(byte[] sendData, int length, bool setDtr, double dtrTimeCorr) => false;
        public static bool InterfaceReceiveData(byte[] receiveData, int offset, int length, int timeout, int timeoutTelEnd, EdiabasNet ediabasLog) => false;
        public static bool InterfaceSendPulse(UInt64 dataBits, int length, int pulseWidth, bool setDtr, bool bothLines, int autoKeyByteDelay) => false;
    }
}
