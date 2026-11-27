/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_channels.js */

// Two requests to one HTTPS/1.1 origin through an HTTP/2 proxy each start an
// InnerConnectionAttempt over the shared proxy connection. The first CONNECT is
// accepted, its request is answered at once, and the idle tunnel goes back to
// the origin's entry, whose pending queue hands it the second transaction
// while that transaction's own attempt is still waiting on its CONNECT. That
// second attempt has lost a transaction that is live elsewhere, and whatever
// the proxy finally answers must not reach it.
//
// (An HTTP/2 origin cannot show this: once the first inner connection goes h2
// the entry abandons every other attempt before it can finish.)

const { NodeHTTP2ProxyServer, NodeHTTPSServer } = ChromeUtils.importESModule(
  "resource://testing-common/NodeServer.sys.mjs"
);

let proxy;

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

  proxy = new NodeHTTP2ProxyServer();
  await proxy.start();
  // The second CONNECT of a task is held back for a second, long enough for
  // the first tunnel to be up and to have taken the second transaction over,
  // and then either refused or let through (global.secondConnect).
  await proxy.execute(`(() => {
    const listeners = global.proxy.listeners("stream");
    global.proxy.removeAllListeners("stream");
    global.connects = 0;
    global.secondConnect = "refuse";
    global.proxy.on("stream", (stream, headers) => {
      const pass = () => {
        for (const listener of listeners) {
          listener(stream, headers);
        }
      };
      if (headers[":method"] !== "CONNECT" || ++global.connects !== 2) {
        pass();
        return;
      }
      setTimeout(() => {
        if (global.secondConnect === "refuse") {
          try {
            stream.respond({ ":status": 503 });
            stream.end();
          } catch (e) {}
        } else {
          pass();
        }
      }, 1000);
    });
    return true;
  })()`);

  registerCleanupFunction(async () => {
    Services.prefs.clearUserPref("network.proxy.allow_hijacking_localhost");
    Services.prefs.clearUserPref("network.http.happy_eyeballs_enabled");
    Services.prefs.clearUserPref("network.http.happy_eyeballs_proxy_enabled");
    Services.prefs.clearUserPref("network.http.happy_eyeballs_tunnel_enabled");
    Services.prefs.clearUserPref(
      "network.http.max-persistent-connections-per-server"
    );
    await proxy.stop();
  });
});

// A fresh origin per task, so a task starts with no inner connection to reuse
// and both of its transactions need an attempt. The first request is answered
// at once, later ones slowly.
async function startOrigin() {
  let origin = new NodeHTTPSServer();
  await origin.start();
  await origin.registerPathHandler("/r", (req, resp) => {
    global.hits = (global.hits || 0) + 1;
    if (global.hits === 1) {
      resp.writeHead(200);
      resp.end("ok");
      return;
    }
    // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
    setTimeout(() => {
      resp.writeHead(200);
      resp.end("ok");
    }, 2000);
  });
  // Answers with a number identifying the connection the request came in on.
  await origin.registerPathHandler("/who", (req, resp) => {
    if (!req.socket.testId) {
      global.sockets = (global.sockets || 0) + 1;
      req.socket.testId = global.sockets;
    }
    // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
    setTimeout(() => {
      resp.writeHead(200);
      resp.end(String(req.socket.testId));
    }, 500);
  });
  registerCleanupFunction(() => origin.stop());
  return origin;
}

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

// Two concurrent requests for aPath; both must succeed with a 200.
async function loadTwo(origin, aPath) {
  let results = await Promise.all(
    [1, 2].map(i =>
      channelOpenPromise(
        makeChan(`https://localhost:${origin.port()}${aPath}?${i}`),
        CL_ALLOW_UNKNOWN_CL
      )
    )
  );
  for (let [req] of results) {
    Assert.equal(
      req.status,
      Cr.NS_OK,
      `request succeeded (status=0x${req.status.toString(16)})`
    );
    Assert.equal(
      req.QueryInterface(Ci.nsIHttpChannel).responseStatus,
      200,
      "the origin's response"
    );
  }
  return results.map(([, buf]) => buf);
}

// The losing attempt's CONNECT is refused: the refusal must not be delivered to
// (or close) the transaction that is by then running on the first tunnel.
add_task(async function test_refused_connect_leaves_dispatched_transaction() {
  let origin = await startOrigin();
  await proxy.execute(`global.connects = 0; global.secondConnect = "refuse";`);

  let bodies = await loadTwo(origin, "/r");
  Assert.deepEqual(bodies, ["ok", "ok"], "both bodies arrived intact");
  Assert.equal(
    await proxy.execute(`global.connects`),
    2,
    "both transactions started their own CONNECT"
  );
});

// The losing attempt's CONNECT is accepted late: its tunnel has no transaction
// to carry, and must go back to the pool rather than sit in the entry's active
// list for good. With the per-origin limit at two, a parked connection would
// leave room for only one more, forcing two concurrent requests through a
// single tunnel; a reclaimed one lets them use two.
add_task(async function test_late_connect_returns_the_connection_to_the_pool() {
  let origin = await startOrigin();
  await proxy.execute(`global.connects = 0; global.secondConnect = "accept";`);

  let bodies = await loadTwo(origin, "/r");
  Assert.deepEqual(bodies, ["ok", "ok"], "both bodies arrived intact");
  Assert.equal(
    await proxy.execute(`global.connects`),
    2,
    "both transactions started their own CONNECT"
  );

  // Only now: during the race above the limit would also count the attempts.
  Services.prefs.setIntPref(
    "network.http.max-persistent-connections-per-server",
    2
  );
  let ids = await loadTwo(origin, "/who");
  Assert.notEqual(
    ids[0],
    ids[1],
    "two concurrent requests ran on two inner connections"
  );
  Services.prefs.clearUserPref(
    "network.http.max-persistent-connections-per-server"
  );
});
