/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Bug 2098400: an HTTP/2 response advertising Alt-Svc h3 starts an h3-only
// validation that Happy Eyeballs races over every resolved address. When a
// transparent proxy drops UDP/443, those attempts only end at the QUIC idle
// timeout. On macOS with a content filter, closing each of those sockets takes
// about a second, and the socket thread closes them synchronously, so
// unrelated HTTP/2 loads stall until the last one is closed.
//
// blockUDPAddrIO drops the UDP flows like the proxy, and
// setBlockedUDPCloseDelay makes their close slow like the content filter.
//
// The first validation still stalls unrelated loads once. A failed validation
// must exclude HTTP/3 for the alternate, so that later responses carrying the
// same Alt-Svc don't start another round of dead UDP attempts.

const { NodeHTTP2Server } = ChromeUtils.importESModule(
  "resource://testing-common/NodeServer.sys.mjs"
);

const { setTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);

const override = Cc["@mozilla.org/network/native-dns-override;1"].getService(
  Ci.nsINativeDNSResolverOverride
);

const mockController = Cc[
  "@mozilla.org/network/mock-network-controller;1"
].getService(Ci.nsIMockNetworkLayerController);

const ALT_HOST = "alt1.example.com";
const PROBE_HOST = "foo.example.com";
// The report saw four addresses for github.githubassets.com.
const ALT_IPS = ["127.0.0.1", "127.0.0.2", "127.0.0.3", "127.0.0.4"];
// How long the content filter makes each close take.
const CLOSE_DELAY_MS = 1000;
// Seconds; the default of 30 is what the report waited for.
const IDLE_TIMEOUT_S = 2;
const PROBE_INTERVAL_MS = 200;

let h2Server;

function sleep(ms) {
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  return new Promise(resolve => setTimeout(resolve, ms));
}

add_setup(async function () {
  let certdb = Cc["@mozilla.org/security/x509certdb;1"].getService(
    Ci.nsIX509CertDB
  );
  addCertFromFile(certdb, "http2-ca.pem", "CTu,u,u");

  Services.prefs.setBoolPref("network.http.happy_eyeballs_enabled", true);
  Services.prefs.setBoolPref("network.http.http3.enable", true);
  Services.prefs.setBoolPref("network.socket.attach_mock_network_layer", true);
  // The mock network layer only sees UDP that goes through NSPR.
  Services.prefs.setBoolPref("network.http.http3.use_nspr_for_io", true);
  Services.prefs.setIntPref("network.http.http3.idle_timeout", IDLE_TIMEOUT_S);
  // Alt-Svc validation goes through SpeculativeConnect.
  Services.prefs.setIntPref("network.http.speculative-parallel-limit", 20);

  h2Server = new NodeHTTP2Server();
  await h2Server.start();
  // Serialized into the node process, so the advertised alternate arrives in
  // a request header.
  await h2Server.registerPathHandler("/altsvc", (req, resp) => {
    resp.setHeader("Alt-Svc", "h3=" + req.headers["x-altsvc"]);
    resp.writeHead(200, { "Content-Type": "text/plain" });
    resp.end("altsvc");
  });
  await h2Server.registerPathHandler("/", (_req, resp) => {
    resp.writeHead(200, { "Content-Type": "text/plain" });
    resp.end("ok");
  });

  registerCleanupFunction(async () => {
    Services.prefs.clearUserPref("network.http.happy_eyeballs_enabled");
    Services.prefs.clearUserPref("network.http.http3.enable");
    Services.prefs.clearUserPref("network.socket.attach_mock_network_layer");
    Services.prefs.clearUserPref("network.http.http3.use_nspr_for_io");
    Services.prefs.clearUserPref("network.http.http3.idle_timeout");
    Services.prefs.clearUserPref("network.http.speculative-parallel-limit");
    override.clearOverrides();
    mockController.clearBlockedUDPAddr();
    mockController.clearBlockedTCPConnect();
    mockController.setBlockedUDPCloseDelay(0);
    await h2Server.stop();
  });
});

function openChan(uri, altSvc) {
  let chan = NetUtil.newChannel({
    uri,
    loadUsingSystemPrincipal: true,
  }).QueryInterface(Ci.nsIHttpChannel);
  chan.loadFlags = Ci.nsIChannel.LOAD_INITIAL_DOCUMENT_URI;
  if (altSvc) {
    chan.setRequestHeader("x-altsvc", altSvc, false);
  }
  return new Promise(resolve => {
    chan.asyncOpen(
      new ChannelListener(
        (req, buffer) =>
          resolve({
            status: req.QueryInterface(Ci.nsIHttpChannel).responseStatus,
            httpVersion: req.protocolVersion,
            buffer,
          }),
        null,
        CL_ALLOW_UNKNOWN_CL
      )
    );
  });
}

// Loads the unrelated origin until any h3-only attempts that the last Alt-Svc
// load started have timed out and been closed. Returns the slowest load, in ms.
async function probeUnrelatedLoads(aH2Port) {
  let deadline =
    Date.now() + IDLE_TIMEOUT_S * 1000 + ALT_IPS.length * CLOSE_DELAY_MS + 3000;
  let slowest = 0;
  while (Date.now() < deadline) {
    let start = Date.now();
    let { status } = await openChan(`https://${PROBE_HOST}:${aH2Port}/`);
    Assert.equal(status, 200);
    let elapsed = Date.now() - start;
    slowest = Math.max(slowest, elapsed);
    info(`unrelated load took ${elapsed} ms`);
    await sleep(PROBE_INTERVAL_MS);
  }
  return slowest;
}

async function loadWithAltSvc(aH2Port, aUdpPort) {
  let { status, httpVersion } = await openChan(
    `https://${ALT_HOST}:${aH2Port}/altsvc`,
    `":${aUdpPort}"`
  );
  Assert.equal(status, 200);
  Assert.equal(httpVersion, "h2");
}

add_task(async function test_failed_validation_is_not_retried() {
  let h2Port = h2Server.port();
  // Nothing listens on UDP here, and every datagram is dropped anyway.
  let udpPort = h2Port;

  for (let ip of ALT_IPS) {
    override.addIPOverride(ALT_HOST, ip);
    mockController.blockUDPAddrIO(
      mockController.createScriptableNetAddr(ip, udpPort)
    );
  }
  // Only 127.0.0.1 is reachable over TCP; refuse the others quickly so the
  // HTTP/2 load that advertises Alt-Svc doesn't wait on them.
  for (let ip of ALT_IPS.slice(1)) {
    mockController.blockTCPConnect(
      mockController.createScriptableNetAddr(ip, h2Port)
    );
  }
  override.addIPOverride(PROBE_HOST, "127.0.0.1");
  mockController.setBlockedUDPCloseDelay(CLOSE_DELAY_MS);

  // Warm up the unrelated origin so later loads reuse its HTTP/2 connection.
  let probe = await openChan(`https://${PROBE_HOST}:${h2Port}/`);
  Assert.equal(probe.status, 200);
  Assert.equal(probe.httpVersion, "h2");

  await loadWithAltSvc(h2Port, udpPort);
  let slowest = await probeUnrelatedLoads(h2Port);
  let closes = mockController.delayedUDPCloseCount;
  info(`first validation: ${closes} dead UDP socket(s), slowest ${slowest} ms`);
  Assert.greater(closes, 0, "the h3-only validation sent dropped UDP");

  // A failed validation is retried after 2 seconds, which probing has already
  // waited for.
  await loadWithAltSvc(h2Port, udpPort);
  slowest = await probeUnrelatedLoads(h2Port);
  info(`second Alt-Svc: slowest ${slowest} ms`);
  Assert.equal(
    mockController.delayedUDPCloseCount,
    closes,
    "no UDP attempts after a failed validation"
  );
  Assert.less(slowest, CLOSE_DELAY_MS, "no stall after a failed validation");
});
