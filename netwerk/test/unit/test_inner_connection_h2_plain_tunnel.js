/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_channels.js */

// Origins reached through an HTTP/2 proxy with a CONNECT tunnel, with the inner
// connection established via Happy Eyeballs. The proxy is forced to tunnel with
// ALWAYS_TUNNEL_VIA_PROXY, so a plain-http origin gets a tunnel without TLS of
// its own, which the usual https origins never do.

const { NodeHTTP2ProxyServer, NodeHTTPServer, NodeProxyFilter } =
  ChromeUtils.importESModule("resource://testing-common/NodeServer.sys.mjs");

const pps = Cc["@mozilla.org/network/protocol-proxy-service;1"].getService();

let proxy;
let origin;
let filter;

add_setup(async function setup() {
  Services.prefs.setBoolPref("network.proxy.allow_hijacking_localhost", true);
  Services.prefs.setBoolPref("network.http.happy_eyeballs_enabled", true);
  Services.prefs.setBoolPref("network.http.happy_eyeballs_proxy_enabled", true);
  Services.prefs.setBoolPref(
    "network.http.happy_eyeballs_tunnel_enabled",
    true
  );
  let certdb = Cc["@mozilla.org/security/x509certdb;1"].getService(
    Ci.nsIX509CertDB
  );
  addCertFromFile(certdb, "http2-ca.pem", "CTu,u,u");
  addCertFromFile(certdb, "proxy-ca.pem", "CTu,u,u");

  origin = new NodeHTTPServer();
  await origin.start();
  await origin.registerPathHandler("/r", (_req, resp) => {
    resp.writeHead(200);
    resp.end("ok");
  });

  proxy = new NodeHTTP2ProxyServer();
  await proxy.start();
  // Record the authority of every CONNECT the proxy is asked for.
  await proxy.execute(`(() => {
    const listeners = global.proxy.listeners("stream");
    global.proxy.removeAllListeners("stream");
    global.authorities = [];
    global.proxy.on("stream", (stream, headers) => {
      if (headers[":method"] === "CONNECT") {
        global.authorities.push(headers[":authority"]);
      }
      for (const listener of listeners) {
        listener(stream, headers);
      }
    });
    return true;
  })()`);

  // Replace the proxy's own filter: same proxy, but forced to tunnel.
  proxy.unregisterFilter();
  filter = new NodeProxyFilter(
    proxy.protocol(),
    "localhost",
    proxy.port(),
    Ci.nsIProxyInfo.ALWAYS_TUNNEL_VIA_PROXY
  );
  pps.registerFilter(filter, 10);

  registerCleanupFunction(async () => {
    pps.unregisterFilter(filter);
    Services.prefs.clearUserPref("network.proxy.allow_hijacking_localhost");
    Services.prefs.clearUserPref("network.http.happy_eyeballs_enabled");
    Services.prefs.clearUserPref("network.http.happy_eyeballs_proxy_enabled");
    Services.prefs.clearUserPref("network.http.happy_eyeballs_tunnel_enabled");
    await proxy.stop();
    await origin.stop();
  });
});

function makeChan(uri) {
  let chan = NetUtil.newChannel({
    uri,
    loadUsingSystemPrincipal: true,
  }).QueryInterface(Ci.nsIHttpChannel);
  chan.loadFlags = Ci.nsIChannel.LOAD_INITIAL_DOCUMENT_URI;
  return chan;
}

function load(chan, flags = CL_ALLOW_UNKNOWN_CL) {
  return new Promise(resolve =>
    chan.asyncOpen(
      new ChannelListener((req, buf) => resolve([req, buf]), null, flags)
    )
  );
}

async function loadOk(path, host = "localhost") {
  let [req, buf] = await load(
    makeChan(`http://${host}:${origin.port()}${path}`)
  );
  Assert.equal(req.status, Cr.NS_OK, `status 0x${req.status.toString(16)}`);
  Assert.equal(buf, "ok");
}

// The CONNECT is accepted and the transaction takes the tunnel over, so both
// requests, the second one on the idle tunnel, get the origin's answer.
add_task(async function test_plain_http_tunnel() {
  await loadOk("/r?1");
  await loadOk("/r?2");
});

// The CONNECT is accepted but the inner TLS handshake then fails: the origin
// answers the ClientHello as a plain-HTTP server. The channel must fail with
// the connection's TLS error and carry the failed handshake's security info,
// which is what lets the error page be shown, as it does without the tunnel.
add_task(async function test_inner_tls_handshake_failure() {
  let [req] = await load(
    makeChan(`https://localhost:${origin.port()}/r`),
    CL_EXPECT_FAILURE
  );
  Assert.notEqual(
    req.status,
    Cr.NS_ERROR_FAILURE,
    "the TLS error is what the channel fails with, not a generic failure"
  );
  Assert.ok(
    req.securityInfo,
    "the failed handshake's security info reaches the channel"
  );
});

// An IP-literal origin needs no resolution, so the inner connection is started
// for its address; the proxy has to be asked to connect to that same literal.
add_task(async function test_ip_literal_origin() {
  // Drop the idle tunnel the earlier tasks left, so this request needs a CONNECT.
  Services.obs.notifyObservers(null, "net:prune-all-connections");
  await proxy.execute(`global.authorities = [];`);
  await loadOk("/r?ip", "127.0.0.1");
  Assert.deepEqual(
    JSON.parse(await proxy.execute(`JSON.stringify(global.authorities)`)),
    [`127.0.0.1:${origin.port()}`],
    "the proxy was asked to connect to the IP literal"
  );
});
