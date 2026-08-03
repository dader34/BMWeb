#ifndef CGIWSBRIDGE_H
#define CGIWSBRIDGE_H

#include "httpd.h"

// The CGI: registered in builtInUrls as { "/bmweb", cgiWsBridge, NULL }.
// Performs the RFC 6455 handshake and takes the connection over.
int cgiWsBridge(HttpdConnData *connData);

// Raw receive path for an upgraded connection. httpdRecvCb calls this
// INSTEAD of parsing bytes as HTTP -- see the hook in esp-link.patch.
void cgiWsBridgeRecv(HttpdConnData *connData, char *data, unsigned short len);

// True when this connection has been upgraded and its bytes belong to the
// WebSocket rather than to the HTTP parser.
bool cgiWsBridgeOwns(HttpdConnData *connData);

// Connection teardown; called from httpdDisconCb.
void cgiWsBridgeDiscon(HttpdConnData *connData);

// Wire up the UART receive callback. Call once from user_init.
void cgiWsBridgeInit(void);

#endif
