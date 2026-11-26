/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_channels.js */

// An HTTP/2 proxy that resets the CONNECT stream with HTTP_1_1_REQUIRED is
// asking for the tunnel to be set up over an HTTP/1.1 connection instead. The
// transaction has to be restarted with HTTP/2 to the proxy disallowed, so that
// its retry opens a fresh outer connection negotiating HTTP/1.1 and sends the
// CONNECT there. Checked with the inner connection established via Happy
// Eyeballs and via the legacy path.

const { NodeHTTP2ProxyServer, NodeHTTPSServer } = ChromeUtils.importESModule(
  "resource://testing-common/NodeServer.sys.mjs"
);
const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

let proxy;
let origin;

add_setup(async function setup() {
  Services.prefs.setBoolPref("network.proxy.allow_hijacking_localhost", true);
  Services.prefs.setBoolPref("network.http.happy_eyeballs_enabled", true);
  Services.prefs.setBoolPref("network.http.happy_eyeballs_proxy_enabled", true);
  let certdb = Cc["@mozilla.org/security/x509certdb;1"].getService(
    Ci.nsIX509CertDB
  );
  addCertFromFile(certdb, "http2-ca.pem", "CTu,u,u");
  addCertFromFile(certdb, "proxy-ca.pem", "CTu,u,u");

  origin = new NodeHTTPSServer();
  await origin.start();
  await origin.registerPathHandler("/r", (req, resp) => {
    resp.writeHead(200);
    resp.end("ok");
  });

  proxy = new NodeHTTP2ProxyServer();
  await proxy.start();
  // Rebuild the proxy on its port so it also speaks HTTP/1.1, as a proxy that
  // demands HTTP/1.1 must, and make it reset the first CONNECT stream of each
  // task with HTTP_1_1_REQUIRED. Counts what it sees on each protocol.
  await proxy.execute(`(async () => {
    const http2 = require("http2");
    const fs = require("fs");
    const port = ${proxy.port()};
    await new Promise(r => global.proxy.close(r));
    global.proxy = http2.createSecureServer({
      key: global.tlsKey || fs.readFileSync(__dirname + "/proxy-cert.key"),
      cert: global.tlsCert || fs.readFileSync(__dirname + "/proxy-cert.pem"),
      allowHTTP1: true,
    });
    HTTP2ProxyCode.setupProxy(undefined);
    global.h2Connects = 0;
    global.h1Connects = 0;
    global.resetNext = true;
    global.clientSockets = new Set();
    global.proxy.on("secureConnection", socket => {
      global.clientSockets.add(socket);
      socket.on("close", () => global.clientSockets.delete(socket));
    });
    const listeners = global.proxy.listeners("stream");
    global.proxy.removeAllListeners("stream");
    global.proxy.on("stream", (stream, headers) => {
      if (headers[":method"] === "CONNECT") {
        global.h2Connects++;
        if (global.resetNext) {
          global.resetNext = false;
          // Closing with an error code emits "error" on the stream; unhandled,
          // it would take the proxy process down.
          stream.on("error", () => {});
          stream.close(http2.constants.NGHTTP2_HTTP_1_1_REQUIRED);
          return;
        }
      }
      for (const listener of listeners) {
        listener(stream, headers);
      }
    });
    global.proxy.on("connect", (req, socket, head) => {
      global.h1Connects++;
      BaseProxyCode.onConnect(req, socket, head);
    });
    await new Promise(r => global.proxy.listen(port, r));
    return global.proxy.address().port;
  })()`);

  registerCleanupFunction(async () => {
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

function channelOpenPromise(chan, flags) {
  return new Promise(resolve => {
    chan.asyncOpen(
      new ChannelListener((req, buffer) => resolve([req, buffer]), null, flags)
    );
  });
}

// Start each task without a proxy connection left over from the previous one,
// so the first CONNECT goes over a new HTTP/2 outer connection.
async function resetConnections() {
  Services.obs.notifyObservers(null, "net:cancel-all-connections");
  Services.obs.notifyObservers(null, "net:prune-all-connections");
  await TestUtils.waitForCondition(
    async () => (await proxy.execute(`global.clientSockets.size`)) === 0,
    "the proxy has no client connection left"
  );
}

async function checkHttp11Required(tunnelViaHappyEyeballs) {
  Services.prefs.setBoolPref(
    "network.http.happy_eyeballs_tunnel_enabled",
    tunnelViaHappyEyeballs
  );
  await resetConnections();
  await proxy.execute(
    `global.h2Connects = 0; global.h1Connects = 0; global.resetNext = true;`
  );

  let [req, buf] = await channelOpenPromise(
    makeChan(`https://localhost:${origin.port()}/r`),
    CL_ALLOW_UNKNOWN_CL
  );

  Assert.equal(
    req.status,
    Cr.NS_OK,
    `request succeeded (status=0x${req.status.toString(16)})`
  );
  Assert.equal(
    req.QueryInterface(Ci.nsIHttpChannel).responseStatus,
    200,
    "the origin answered"
  );
  Assert.equal(buf, "ok", "the body arrived");
  Assert.equal(
    await proxy.execute(`global.h2Connects`),
    1,
    "exactly one CONNECT was tried over HTTP/2 and reset"
  );
  Assert.equal(
    await proxy.execute(`global.h1Connects`),
    1,
    "the retry sent its CONNECT over an HTTP/1.1 proxy connection"
  );
}

add_task(async function test_http11_required_inner_via_happy_eyeballs() {
  await checkHttp11Required(true);
});

add_task(async function test_http11_required_legacy_inner() {
  await checkHttp11Required(false);
});
