// A binary WebSocket bridged to the UART, for esp-link.
//
// Why this exists: BMWeb runs in a browser, and a browser cannot open a raw
// TCP socket -- so stock esp-link's telnet bridge on port 23 is unreachable
// from a web page. Its microcontroller console is not an alternative: that
// is HTTP polling of a TEXT endpoint, and a BMW telegram is full of bytes
// >= 0x80 that do not survive being treated as text. A binary WebSocket is
// the one transport every browser can open, on desktop AND on iOS/Android,
// so this is what makes the app work everywhere with nothing else running.
//
// The whole feature is: handshake, RFC 6455 framing, and a pipe to
// uart0_tx_buffer / uart_add_recv_cb. esp-link's own HTTP server does the
// listening; see esp-link.patch for the three lines that let an upgraded
// connection keep its bytes instead of handing them to the HTTP parser.

#include <esp8266.h>
#include <osapi.h>
#include "cgiwsbridge.h"
#include "uart.h"
#include "config.h"

#define WS_GUID       "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

#define WS_OP_CONT    0x0
#define WS_OP_TEXT    0x1
#define WS_OP_BIN     0x2
#define WS_OP_CLOSE   0x8
#define WS_OP_PING    0x9
#define WS_OP_PONG    0xA

// A BMW telegram is tens of bytes. This is a sanity bound, not a target:
// anything larger is a malformed length field, and following it would walk
// off into memory. The ESP8266 has ~40 KB of usable heap; be modest.
#define WS_MAX_FRAME  1024

// UART bytes trickle in a few at a time. One frame per chunk would hammer
// the radio and the heap, so coalesce and flush on a short idle -- long
// enough to gather a whole answer, far shorter than any job timeout.
#define WS_RX_BUF     512
#define WS_FLUSH_MS   8

// ONE client. Two diagnostic sessions sharing one K-line would corrupt
// each other's telegrams, so a second connection is refused, not queued.
static HttpdConnData *wsConn;
static bool wsUpgraded;

static char wsRxBuf[WS_RX_BUF];
static uint16 wsRxLen;
static ETSTimer wsFlushTimer;

// Partial inbound frame carried across TCP segments: a WebSocket frame can
// be split anywhere, including mid-header.
static char wsIn[WS_MAX_FRAME + 16];
static uint16 wsInLen;

// ---------------------------------------------------------------- sha1
// esp-link ships no SHA-1 and no base64 ENCODE (only decode), and the
// handshake needs both. Small enough to carry here rather than pull in a
// crypto library for one hash of one 60-byte string.

typedef struct {
  uint32 state[5];
  uint32 count[2];
  uint8 buffer[64];
} Sha1Ctx;

#define ROL(v, b) (((v) << (b)) | ((v) >> (32 - (b))))

static void ICACHE_FLASH_ATTR sha1Transform(uint32 state[5], const uint8 buffer[64]) {
  uint32 a, b, c, d, e, w[80];
  int i;
  for (i = 0; i < 16; i++) {
    w[i] = (buffer[i * 4] << 24) | (buffer[i * 4 + 1] << 16)
         | (buffer[i * 4 + 2] << 8) | buffer[i * 4 + 3];
  }
  for (i = 16; i < 80; i++) w[i] = ROL(w[i-3] ^ w[i-8] ^ w[i-14] ^ w[i-16], 1);
  a = state[0]; b = state[1]; c = state[2]; d = state[3]; e = state[4];
  for (i = 0; i < 80; i++) {
    uint32 f, k;
    if (i < 20)      { f = (b & c) | (~b & d);            k = 0x5A827999; }
    else if (i < 40) { f = b ^ c ^ d;                     k = 0x6ED9EBA1; }
    else if (i < 60) { f = (b & c) | (b & d) | (c & d);   k = 0x8F1BBCDC; }
    else             { f = b ^ c ^ d;                     k = 0xCA62C1D6; }
    uint32 t = ROL(a, 5) + f + e + k + w[i];
    e = d; d = c; c = ROL(b, 30); b = a; a = t;
  }
  state[0] += a; state[1] += b; state[2] += c; state[3] += d; state[4] += e;
}

static void ICACHE_FLASH_ATTR sha1Init(Sha1Ctx *ctx) {
  ctx->state[0] = 0x67452301; ctx->state[1] = 0xEFCDAB89;
  ctx->state[2] = 0x98BADCFE; ctx->state[3] = 0x10325476;
  ctx->state[4] = 0xC3D2E1F0;
  ctx->count[0] = ctx->count[1] = 0;
}

static void ICACHE_FLASH_ATTR sha1Update(Sha1Ctx *ctx, const uint8 *data, uint32 len) {
  uint32 i, j = ctx->count[0];
  if ((ctx->count[0] += len << 3) < j) ctx->count[1]++;
  ctx->count[1] += (len >> 29);
  j = (j >> 3) & 63;
  if ((j + len) > 63) {
    i = 64 - j;
    os_memcpy(&ctx->buffer[j], data, i);
    sha1Transform(ctx->state, ctx->buffer);
    for (; i + 63 < len; i += 64) sha1Transform(ctx->state, &data[i]);
    j = 0;
  } else {
    i = 0;
  }
  os_memcpy(&ctx->buffer[j], &data[i], len - i);
}

static void ICACHE_FLASH_ATTR sha1Final(Sha1Ctx *ctx, uint8 digest[20]) {
  uint8 finalcount[8];
  int i;
  for (i = 0; i < 8; i++) {
    finalcount[i] = (uint8)((ctx->count[(i >= 4 ? 0 : 1)] >> ((3 - (i & 3)) * 8)) & 255);
  }
  uint8 c = 0200;
  sha1Update(ctx, &c, 1);
  while ((ctx->count[0] & 504) != 448) { c = 0000; sha1Update(ctx, &c, 1); }
  sha1Update(ctx, finalcount, 8);
  for (i = 0; i < 20; i++) {
    digest[i] = (uint8)((ctx->state[i >> 2] >> ((3 - (i & 3)) * 8)) & 255);
  }
}

static const char *b64chars =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// 20-byte digest -> 28 base64 chars + NUL. Fixed size, so no length games.
static void ICACHE_FLASH_ATTR b64Encode20(const uint8 *in, char *out) {
  int i, o = 0;
  for (i = 0; i < 18; i += 3) {
    uint32 v = (in[i] << 16) | (in[i+1] << 8) | in[i+2];
    out[o++] = b64chars[(v >> 18) & 63];
    out[o++] = b64chars[(v >> 12) & 63];
    out[o++] = b64chars[(v >> 6) & 63];
    out[o++] = b64chars[v & 63];
  }
  // 20 % 3 == 2 leftover bytes -> three chars plus one '='
  uint32 v = (in[18] << 16) | (in[19] << 8);
  out[o++] = b64chars[(v >> 18) & 63];
  out[o++] = b64chars[(v >> 12) & 63];
  out[o++] = b64chars[(v >> 6) & 63];
  out[o++] = '=';
  out[o] = 0;
}

// ---------------------------------------------------------------- sending

// Frame and send. Server->client frames are NEVER masked (RFC 6455 5.1),
// and always binary: a text frame is UTF-8, which would corrupt every byte
// >= 0x80 -- i.e. most of a BMW telegram.
static void ICACHE_FLASH_ATTR wsSend(const char *data, uint16 len, uint8 opcode) {
  if (!wsConn || !wsUpgraded) return;
  uint8 hdr[4];
  uint8 hlen = 0;
  hdr[hlen++] = 0x80 | opcode;            // FIN + opcode
  if (len < 126) {
    hdr[hlen++] = (uint8)len;
  } else {
    hdr[hlen++] = 126;
    hdr[hlen++] = (uint8)(len >> 8);
    hdr[hlen++] = (uint8)(len & 0xff);
  }
  // espconn_sent takes one buffer, so header and payload go together.
  static char out[WS_MAX_FRAME + 4];
  if (len > WS_MAX_FRAME) return;
  os_memcpy(out, hdr, hlen);
  if (len) os_memcpy(out + hlen, data, len);
  espconn_sent(wsConn->conn, (uint8 *)out, hlen + len);
}

// Flush whatever the UART has handed us since the last flush.
static void ICACHE_FLASH_ATTR wsFlush(void *arg) {
  if (wsRxLen == 0) return;
  wsSend(wsRxBuf, wsRxLen, WS_OP_BIN);
  wsRxLen = 0;
}

// UART -> browser. Runs in the UART task; keep it short. Bytes are
// buffered and flushed on a short idle so an answer arrives as one frame
// instead of a dozen.
static void ICACHE_FLASH_ATTR wsUartRecv(char *buf, short len) {
  if (!wsConn || !wsUpgraded) return;        // nobody listening; drop
  for (short i = 0; i < len; i++) {
    if (wsRxLen >= WS_RX_BUF) { wsFlush(NULL); }
    wsRxBuf[wsRxLen++] = buf[i];
  }
  os_timer_disarm(&wsFlushTimer);
  os_timer_setfn(&wsFlushTimer, wsFlush, NULL);
  os_timer_arm(&wsFlushTimer, WS_FLUSH_MS, 0);
}

// ---------------------------------------------------------------- receiving

// Decode as many complete frames as wsIn holds. A frame can be split across
// TCP segments -- including mid-header -- so anything incomplete stays
// buffered for the next callback.
static void ICACHE_FLASH_ATTR wsProcess(void) {
  while (wsInLen >= 2) {
    uint8 b0 = (uint8)wsIn[0];
    uint8 b1 = (uint8)wsIn[1];
    uint8 opcode = b0 & 0x0f;
    bool masked = (b1 & 0x80) != 0;
    uint32 plen = b1 & 0x7f;
    uint16 pos = 2;

    if (plen == 126) {
      if (wsInLen < 4) return;
      plen = ((uint8)wsIn[2] << 8) | (uint8)wsIn[3];
      pos = 4;
    } else if (plen == 127) {
      // 64-bit lengths mean megabytes; this device has ~40 KB of heap.
      // Nothing legitimate sends one, so close rather than try.
      wsSend(NULL, 0, WS_OP_CLOSE);
      if (wsConn) espconn_disconnect(wsConn->conn);
      wsInLen = 0;
      return;
    }

    if (plen > WS_MAX_FRAME) {              // malformed or hostile
      wsSend(NULL, 0, WS_OP_CLOSE);
      if (wsConn) espconn_disconnect(wsConn->conn);
      wsInLen = 0;
      return;
    }

    uint8 mask[4];
    if (masked) {
      if (wsInLen < pos + 4) return;
      os_memcpy(mask, wsIn + pos, 4);
      pos += 4;
    }
    if (wsInLen < pos + plen) return;       // frame not all here yet

    char *payload = wsIn + pos;
    if (masked) {                            // client frames always are
      for (uint32 i = 0; i < plen; i++) payload[i] ^= mask[i & 3];
    }

    if (opcode == WS_OP_BIN || opcode == WS_OP_TEXT || opcode == WS_OP_CONT) {
      // Straight to the wire. The adapter MCU, not this code, interprets
      // them -- BMWeb has already built the full adapter telegram.
      if (plen) uart0_tx_buffer(payload, plen);
    } else if (opcode == WS_OP_PING) {
      wsSend(payload, plen, WS_OP_PONG);
    } else if (opcode == WS_OP_CLOSE) {
      wsSend(NULL, 0, WS_OP_CLOSE);
      if (wsConn) espconn_disconnect(wsConn->conn);
      wsInLen = 0;
      return;
    }
    // opcode == PONG: nothing to do

    uint16 used = pos + plen;
    if (wsInLen > used) os_memmove(wsIn, wsIn + used, wsInLen - used);
    wsInLen -= used;
  }
}

void ICACHE_FLASH_ATTR cgiWsBridgeRecv(HttpdConnData *connData, char *data,
                                       unsigned short len) {
  if (connData != wsConn || !wsUpgraded) return;
  for (unsigned short i = 0; i < len; i++) {
    if (wsInLen >= sizeof(wsIn)) {           // desync; drop the connection
      wsInLen = 0;
      espconn_disconnect(connData->conn);
      return;
    }
    wsIn[wsInLen++] = data[i];
  }
  wsProcess();
}

bool ICACHE_FLASH_ATTR cgiWsBridgeOwns(HttpdConnData *connData) {
  return wsUpgraded && connData == wsConn;
}

void ICACHE_FLASH_ATTR cgiWsBridgeDiscon(HttpdConnData *connData) {
  if (connData != wsConn) return;
  os_timer_disarm(&wsFlushTimer);
  wsConn = NULL;
  wsUpgraded = false;
  wsInLen = 0;
  wsRxLen = 0;
}

// ---------------------------------------------------------------- handshake

int ICACHE_FLASH_ATTR cgiWsBridge(HttpdConnData *connData) {
  if (connData->conn == NULL) {              // connection aborted
    cgiWsBridgeDiscon(connData);
    return HTTPD_CGI_DONE;
  }

  // RE-ENTRY. Returning HTTPD_CGI_MORE below keeps the connection open --
  // but esp-link reads that as "this handler has more to send" and calls it
  // again from httpdSentCb after EVERY successful send. Without this guard
  // the handshake is retransmitted in a loop: the client sees a valid 101,
  // then a second copy arriving as its first "frame", and every telegram
  // answer is buried behind an endless replay of the response header.
  // Once upgraded there is nothing more to send from here; the UART
  // callback does the sending.
  if (wsUpgraded && connData == wsConn) return HTTPD_CGI_MORE;

  char upgrade[64];
  char key[64];
  // Case-insensitive CONTAINS, not equals. Header values are not
  // case-normalised ("WebSocket" is common) and some clients send a list
  // ("websocket, foo"), so an exact lowercase match rejects legitimate
  // clients. Lowercase in place, then substring.
  bool isWs = false;
  if (httpdGetHeader(connData, "Upgrade", upgrade, sizeof(upgrade))) {
    for (char *p = upgrade; *p; p++) {
      if (*p >= 'A' && *p <= 'Z') *p += 32;
    }
    isWs = os_strstr(upgrade, "websocket") != NULL;
  }
  if (!isWs) {
    httpdStartResponse(connData, 426);       // Upgrade Required
    httpdHeader(connData, "Content-Type", "text/plain");
    httpdEndHeaders(connData);
    httpdSend(connData, "This endpoint is a WebSocket.\r\n", -1);
    return HTTPD_CGI_DONE;
  }
  if (httpdGetHeader(connData, "Sec-WebSocket-Key", key, sizeof(key)) == 0) {
    httpdStartResponse(connData, 400);
    httpdEndHeaders(connData);
    return HTTPD_CGI_DONE;
  }

  // One client only: a second session on the same K-line would interleave
  // telegrams and corrupt both.
  if (wsConn != NULL && wsConn != connData) {
    httpdStartResponse(connData, 503);
    httpdHeader(connData, "Content-Type", "text/plain");
    httpdEndHeaders(connData);
    httpdSend(connData, "Adapter already in use by another client.\r\n", -1);
    return HTTPD_CGI_DONE;
  }

  // accept = base64(sha1(key + GUID))
  Sha1Ctx ctx;
  uint8 digest[20];
  char accept[32];
  sha1Init(&ctx);
  sha1Update(&ctx, (uint8 *)key, os_strlen(key));
  sha1Update(&ctx, (uint8 *)WS_GUID, os_strlen(WS_GUID));
  sha1Final(&ctx, digest);
  b64Encode20(digest, accept);

  // Write the 101 BY HAND rather than through httpdStartResponse, which
  // hardcodes "HTTP/1.0" and "Connection: close". Both are wrong here:
  // RFC 6455 requires HTTP/1.1, and a duplicate Connection header whose
  // first value is "close" makes browsers abandon the upgrade -- the
  // handshake completes for a raw client and fails in Chrome, which is
  // exactly the confusing shape this hit in testing.
  char resp[220];
  int rl = os_sprintf(resp,
    "HTTP/1.1 101 Switching Protocols\r\n"
    "Server: esp-link\r\n"
    "Upgrade: websocket\r\n"
    "Connection: Upgrade\r\n"
    "Sec-WebSocket-Accept: %s\r\n"
    "\r\n", accept);
  httpdSend(connData, resp, rl);
  httpdFlush(connData);

  wsConn = connData;
  wsUpgraded = true;
  wsInLen = 0;
  wsRxLen = 0;

  // DISARM THE SDK's INACTIVITY TIMER. espconn defaults to closing a TCP
  // connection after 10 seconds of silence, and esp-link's httpd never
  // overrides it -- reasonably, since an HTTP request is short-lived.
  // (serbridge.c does override it, via espconn_regist_time, precisely
  // because its connections are long-lived. Same problem, same cure.)
  //
  // A diagnostic session is idle most of the time: the user reads a
  // screen, thinks, then acts. Without this the socket dies ten seconds
  // after the last telegram, mid-session, with the app showing live
  // values right up until it vanishes. 0 = never time out.
  espconn_regist_time(connData->conn, 0, 1);

  // HTTPD_CGI_MORE keeps the connection (and this handler) alive. The
  // bytes that follow are WebSocket frames, not HTTP -- the hook in
  // httpdRecvCb is what routes them to cgiWsBridgeRecv.
  return HTTPD_CGI_MORE;
}

void ICACHE_FLASH_ATTR cgiWsBridgeInit(void) {
  wsConn = NULL;
  wsUpgraded = false;
  wsInLen = 0;
  wsRxLen = 0;
  uart_add_recv_cb(wsUartRecv);
}
