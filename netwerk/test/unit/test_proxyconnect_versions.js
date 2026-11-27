/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Connect-only (nsIHttpChannelInternal.setConnectOnly, i.e. what WebRTC's
// WebrtcTCPSocket does) through a proxy, for every proxy HTTP version.
//
// How the tunnel is built differs per version. On HTTP/1 the proxy connection
// carries the CONNECT itself and TakeTransport hands its socket over. On
// HTTP/2 and HTTP/3 the tunnel is one stream on the proxy connection: the
// wildcard proxy connection hands the transaction a stream tunnel wrapped in an
// nsHttpConnection (nsHttpConnectionMgr's "About to create new tunnel conn"
// path), that connection issues the CONNECT, and TakeTransport hands the stream
// over. The consumer sees the same thing either way, which is what this pins.
//
// Every case runs end to end against a TCP echo server behind the proxy, with a
// payload larger than one pipe segment so it crosses several read/write windows
// in each direction. The outer proxy connection always goes through Happy
// Eyeballs; each case is repeated along two more dimensions:
//
//   - the inner-connection Happy Eyeballs pref on and off, since that changes
//     how the tunnel is established;
//   - a cold vs warm proxy connection. Warm means an ordinary request has
//     already gone through the same proxy, so the proxy connection (and, for
//     h2/h3, its wildcard connection entry) exists before the connect-only
//     channel is dispatched. That is the state a browser is normally in, and
//     it is the case where an h2 proxy connection has already run StartSpdy
//     -- which used to retire the tunnel state and drop the CONNECT.
//
// Note that a connect-only channel never triggers a *speculative* connection
// to the proxy: nsHttpChannel::SpeculativeConnect() bails out when an upgrade
// callback is set and when NS_HTTP_ALLOW_KEEPALIVE is clear, both of which are
// true here, and nsIIOService.speculativeConnect builds its connection info
// with no proxy info at all. A prior real request is the only way the proxy
// connection can already exist, which is what "warm" does.
//
// test_proxyconnect.js additionally checks the shape of the HTTP/1 CONNECT
// request itself (request line, ALPN header) against a hand-rolled proxy.

"use strict";

/* import-globals-from head_cache.js */
/* import-globals-from head_cookies.js */
/* import-globals-from head_channels.js */
/* import-globals-from head_http3.js */

const {
  Http3ProxyFilter,
  NodeHTTP2ProxyServer,
  NodeHTTPProxyServer,
  NodeHTTPSServer,
  NodeHTTPSProxyServer,
  NodeTCPEchoServer,
} = ChromeUtils.importESModule("resource://testing-common/NodeServer.sys.mjs");

const pps = Cc["@mozilla.org/network/protocol-proxy-service;1"].getService();

// We don't normally allow localhost channels to be proxied, but this
// is easier than updating all the certs and/or domains.
Services.prefs.setBoolPref("network.proxy.allow_hijacking_localhost", true);
const certdb = Cc["@mozilla.org/security/x509certdb;1"].getService(
  Ci.nsIX509CertDB
);
addCertFromFile(certdb, "http2-ca.pem", "CTu,u,u");
addCertFromFile(certdb, "proxy-ca.pem", "CTu,u,u");
registerCleanupFunction(() => {
  Services.prefs.clearUserPref("network.proxy.allow_hijacking_localhost");
  Services.prefs.clearUserPref("network.http.happy_eyeballs_proxy_enabled");
  Services.prefs.clearUserPref("network.http.happy_eyeballs_tunnel_enabled");
});

function makeChan(aUri) {
  let chan = NetUtil.newChannel({
    uri: aUri,
    loadUsingSystemPrincipal: true,
  }).QueryInterface(Ci.nsIHttpChannel);
  chan.loadFlags = Ci.nsIChannel.LOAD_INITIAL_DOCUMENT_URI;
  return chan;
}

// A request through the already-registered proxy that leaves a live proxy
// connection behind for the connect-only channel to reuse. Two details are
// what make it reusable:
//   - the origin is https, so this request is tunneled too and its proxy
//     connection ends up in the same (wildcard, for h2/h3) entry the
//     connect-only channel looks in; a plain http:// forward hashes elsewhere.
//   - it is anonymous, because setConnectOnly() forces LOAD_ANONYMOUS and an
//     anonymous connection info never shares a connection with regular
//     traffic.
async function warmProxyConnection() {
  let origin = new NodeHTTPSServer();
  await origin.start();
  await origin.registerPathHandler("/warm", (req, resp) => {
    resp.writeHead(200);
    resp.end("warm");
  });
  let chan = makeChan(`https://localhost:${origin.port()}/warm`);
  chan.loadFlags |= Ci.nsIChannel.LOAD_ANONYMOUS;
  let [req, buf] = await channelOpenPromise(chan, CL_ALLOW_UNKNOWN_CL);
  Assert.equal(req.status, Cr.NS_OK, "warm-up request succeeded");
  Assert.equal(buf, "warm", "warm-up request went through the proxy");
  await origin.stop();
}

// Each case gets a fresh proxy on a fresh port, but a connection left over from
// the previous one can still be sitting in the connection manager (and an
// h2/h3 proxy connection lives in a wildcard entry, which is not
// port-specific). Close everything so a case can't be influenced by the one
// before it.
//
// Both notifications land on the socket thread (nsHttpConnectionMgr::
// AbortAndCloseAllConnections and friends post to it), as does the connection
// work the next case is about to start, so the queue ordering alone guarantees
// the close runs first -- no need to wait for it here.
function resetConnections() {
  Services.obs.notifyObservers(null, "net:cancel-all-connections");
  Services.obs.notifyObservers(null, "net:prune-all-connections");
  Services.dns.clearCache(true);
}

const BinaryInputStream = Components.Constructor(
  "@mozilla.org/binaryinputstream;1",
  "nsIBinaryInputStream",
  "setInputStream"
);
const BinaryOutputStream = Components.Constructor(
  "@mozilla.org/binaryoutputstream;1",
  "nsIBinaryOutputStream",
  "setOutputStream"
);

// Larger than one pipe segment, so the payload crosses several read/write
// windows in each direction.
const TEST_DATA = "HelloWorld".repeat(2000);

// Writes TEST_DATA into the tunnel as soon as it is handed over and resolves
// waitForData() with everything that comes back.
function createUpgradeHandlers() {
  const handler = {
    _resolve: null,
    _read: "",
    transportAvailable: false,

    waitForData() {
      return new Promise(resolve => {
        this._resolve = resolve;
      });
    },

    onInputStreamReady(input) {
      const n = input.available();
      if (n) {
        const data = new BinaryInputStream(input).readByteArray(n);
        this._read += String.fromCharCode.apply(String, data);
      }
      if (this._read.length >= TEST_DATA.length) {
        this._resolve(this._read);
        this._resolve = null;
        return;
      }
      input.asyncWait(this, 0, 0, Services.tm.mainThread);
    },

    onOutputStreamReady(output) {
      new BinaryOutputStream(output).writeByteArray(
        new TextEncoder().encode(TEST_DATA)
      );
    },

    QueryInterface: ChromeUtils.generateQI([
      "nsIInputStreamCallback",
      "nsIOutputStreamCallback",
    ]),
  };

  const listener = {
    onTransportAvailable(transport, socketIn, socketOut) {
      Assert.ok(
        transport && socketIn && socketOut,
        "transport and streams present"
      );
      handler.transportAvailable = true;
      socketIn.asyncWait(handler, 0, 0, Services.tm.mainThread);
      socketOut.asyncWait(handler, 0, 0, Services.tm.mainThread);
    },
    QueryInterface: ChromeUtils.generateQI(["nsIHttpUpgradeListener"]),
  };

  return { upgradeListener: listener, connectHandler: handler };
}

async function connectOnlyThroughProxy(aVersion, aHeTunnel, aWarmProxy) {
  // Both prefs default to nightly-only, so set them explicitly.
  Services.prefs.setBoolPref("network.http.happy_eyeballs_proxy_enabled", true);
  Services.prefs.setBoolPref(
    "network.http.happy_eyeballs_tunnel_enabled",
    aHeTunnel
  );

  if (aWarmProxy) {
    await warmProxyConnection();
  }

  let echo = new NodeTCPEchoServer();
  await echo.start();

  const { upgradeListener, connectHandler } = createUpgradeHandlers();
  const dataPromise = connectHandler.waitForData();

  let chan = makeChan(`http://localhost:${echo.port()}/`);
  let internal = chan.QueryInterface(Ci.nsIHttpChannelInternal);
  internal.HTTPUpgrade("webrtc", upgradeListener);
  internal.setConnectOnly(true);

  let [req] = await channelOpenPromise(
    chan,
    CL_IGNORE_CL | CL_ALLOW_UNKNOWN_CL
  );

  Assert.equal(req.status, Cr.NS_OK, "channel succeeded");
  Assert.equal(req.responseStatus, 200, "CONNECT was accepted");
  // The handover is posted to the socket thread and back, so it lands after
  // onStopRequest.
  const data = await dataPromise;
  Assert.ok(connectHandler.transportAvailable, "transport handed over");
  Assert.strictEqual(
    data,
    TEST_DATA,
    `${data.length} of ${TEST_DATA.length} bytes round-tripped through the ` +
      `${aVersion} tunnel intact`
  );

  await echo.stop();
}

// start() registers a proxy filter routing everything through the proxy, and
// stop() unregisters it.
async function withNodeProxy(aServerClass, aBody) {
  let proxy = new aServerClass();
  await proxy.start();
  try {
    await aBody();
  } finally {
    await proxy.stop();
  }
}

async function withHttp3Proxy(aBody) {
  Services.prefs.setBoolPref("network.dns.disableIPv6", true);
  Services.prefs.setCharPref("network.dns.localDomains", "foo.example.com");
  Services.prefs.setBoolPref("network.http.http3.enable", true);
  Services.prefs.setCharPref(
    "network.http.http3.alt-svc-mapping-for-testing",
    ""
  );

  let { masqueProxyPort } = await create_masque_proxy_server();
  Assert.ok(!!masqueProxyPort, "masque proxy started");

  // A dummy request so AltSvcCache::mStorage is ready.
  await channelOpenPromise(
    NetUtil.newChannel({
      uri: "https://localhost",
      loadUsingSystemPrincipal: true,
    }).QueryInterface(Ci.nsIHttpChannel),
    CL_EXPECT_FAILURE
  );

  let filter = new Http3ProxyFilter(
    "foo.example.com",
    masqueProxyPort,
    0,
    "/.well-known/masque/udp/{target_host}/{target_port}/",
    ""
  );
  pps.registerFilter(filter, 10);
  try {
    await aBody();
  } finally {
    pps.unregisterFilter(filter);
    Services.prefs.clearUserPref("network.dns.disableIPv6");
    Services.prefs.clearUserPref("network.dns.localDomains");
    Services.prefs.clearUserPref(
      "network.http.http3.alt-svc-mapping-for-testing"
    );
  }
}

// Same conditions as test_http3_proxy.js: we can't start the http3server on
// Android, and these configurations can't carry the proxy's QUIC connection
// (see the comment on that test for the MacOS dontfragment/PMTUD failure).
function h3ProxyUnavailable() {
  return (
    mozinfo.os == "android" ||
    (mozinfo.os == "mac" &&
      mozinfo.os_version == "10.15" &&
      mozinfo.processor == "x86_64") ||
    (mozinfo.os == "win" && mozinfo.msix) // Bug 1808049
  );
}

// [label, runner, skip predicate]; the Happy Eyeballs pref pairs are applied
// per case below.
const PROXIES = [
  ["h1", aBody => withNodeProxy(NodeHTTPProxyServer, aBody)],
  ["h1_tls", aBody => withNodeProxy(NodeHTTPSProxyServer, aBody)],
  ["h2", aBody => withNodeProxy(NodeHTTP2ProxyServer, aBody)],
  ["h3", withHttp3Proxy, h3ProxyUnavailable],
];

// [label, network.http.happy_eyeballs_tunnel_enabled]
const HE_TUNNEL_MODES = [
  ["he", true],
  ["he_outer_only", false],
];

// [label, a proxy connection already exists]
const PROXY_CONN_MODES = [
  ["cold", false],
  ["warm", true],
];

for (let [version, withProxy, skipIf] of PROXIES) {
  for (let [mode, heTunnel] of HE_TUNNEL_MODES) {
    for (let [connMode, warmProxy] of PROXY_CONN_MODES) {
      const name = `test_connect_only_${version}_proxy_${mode}_${connMode}`;
      add_task(
        { skip_if: skipIf ?? (() => false) },
        {
          [name]: async () => {
            resetConnections();
            await withProxy(() =>
              connectOnlyThroughProxy(version, heTunnel, warmProxy)
            );
          },
        }[name]
      );
    }
  }
}
