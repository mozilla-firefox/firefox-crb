"use strict";

// Bug 2093779: parallel cross-origin requests from a public origin that holds
// the "local-network" permission to an HTTP/2 server on a private address
// must all succeed, be sent once, and share a single HTTP/2 connection, while
// requests from origins without the permission are still blocked on it.

const { NodeHTTP2Server } = ChromeUtils.importESModule(
  "resource://testing-common/NodeServer.sys.mjs"
);

const TRIGGERING_ORIGIN = "https://public.example.com";
const DENIED_ORIGIN = "https://denied.example.com";
const NO_PERMISSION_ORIGIN = "https://unknown.example.com";
const ROUNDS = 10;
const PARALLEL = 6;

let server = new NodeHTTP2Server();

function makeChannel(url, triggeringOrigin = TRIGGERING_ORIGIN) {
  let uri = NetUtil.newURI(url);
  let principal = Services.scriptSecurityManager.createContentPrincipal(
    uri,
    {}
  );
  let triggeringPrincipal =
    Services.scriptSecurityManager.createContentPrincipalFromOrigin(
      triggeringOrigin
    );
  let chan = NetUtil.newChannel({
    uri: url,
    loadingPrincipal: principal,
    triggeringPrincipal,
    securityFlags: Ci.nsILoadInfo.SEC_REQUIRE_SAME_ORIGIN_INHERITS_SEC_CONTEXT,
    contentPolicyType: Ci.nsIContentPolicy.TYPE_OTHER,
  }).QueryInterface(Ci.nsIHttpChannel);
  chan.loadInfo.parentIpAddressSpace = Ci.nsILoadInfo.Public;
  return chan;
}

function openChannel(chan) {
  return new Promise(resolve => {
    let body = "";
    chan.asyncOpen({
      QueryInterface: ChromeUtils.generateQI(["nsIStreamListener"]),
      onStartRequest() {},
      onDataAvailable(req, stream, offset, count) {
        body += NetUtil.readInputStreamToString(stream, count);
      },
      onStopRequest(req, status) {
        resolve({ status, body });
      },
    });
  });
}

add_setup(async () => {
  Services.prefs.setBoolPref("network.lna.blocking", true);
  Services.prefs.setBoolPref("network.lna.defer_https_check", true);
  Services.prefs.setBoolPref("network.localnetwork.prompt.testing", false);

  let certdb = Cc["@mozilla.org/security/x509certdb;1"].getService(
    Ci.nsIX509CertDB
  );
  addCertFromFile(certdb, "http2-ca.pem", "CTu,u,u");

  await server.start();
  await server.registerPathHandler("/lna", (req, resp) => {
    if (!global.lnaSessions) {
      global.lnaSessions = new WeakMap();
      global.lnaSessionCount = 0;
      global.lnaRequestCount = 0;
    }
    global.lnaRequestCount++;
    let session = req.stream.session;
    if (!global.lnaSessions.has(session)) {
      global.lnaSessions.set(session, ++global.lnaSessionCount);
    }
    let content = `${global.lnaSessions.get(session)}`;
    resp.writeHead(200, {
      "Content-Type": "text/plain",
      "Content-Length": `${content.length}`,
    });
    resp.end(content);
  });

  Services.prefs.setCharPref(
    "network.lna.address_space.private.override",
    `127.0.0.1:${server.port()},::1:${server.port()}`
  );

  Services.perms.addFromPrincipal(
    Services.scriptSecurityManager.createContentPrincipalFromOrigin(
      TRIGGERING_ORIGIN
    ),
    "local-network",
    Services.perms.ALLOW_ACTION
  );
  Services.perms.addFromPrincipal(
    Services.scriptSecurityManager.createContentPrincipalFromOrigin(
      DENIED_ORIGIN
    ),
    "local-network",
    Services.perms.DENY_ACTION
  );

  registerCleanupFunction(async () => {
    Services.perms.removeAll();
    Services.prefs.clearUserPref("network.lna.blocking");
    Services.prefs.clearUserPref("network.lna.defer_https_check");
    Services.prefs.clearUserPref("network.localnetwork.prompt.testing");
    Services.prefs.clearUserPref("network.localnetwork.prompt.testing.allow");
    Services.prefs.clearUserPref("network.lna.address_space.private.override");
    await server.stop();
  });
});

add_task(async function lna_parallel_h2_requests_with_permission() {
  let ok = 0;
  let failures = [];
  let sessions = new Set();

  for (let round = 1; round <= ROUNDS; round++) {
    let results = await Promise.all(
      Array.from({ length: PARALLEL }, (_, i) =>
        openChannel(
          makeChannel(`https://localhost:${server.port()}/lna?${round}-${i}`)
        )
      )
    );
    for (let { status, body } of results) {
      if (status === Cr.NS_OK) {
        ok++;
        sessions.add(body);
      } else {
        failures.push(`0x${status.toString(16)}`);
      }
    }
    info(`round ${round}: ${results.map(r => r.body || r.status).join(" ")}`);
  }

  let requestCount = await server.execute("global.lnaRequestCount");
  let sessionCount = await server.execute("global.lnaSessionCount");
  info(
    `ok=${ok} failed=${failures.length} [${failures.join(",")}] ` +
      `requestsAtServer=${requestCount} h2Sessions=${sessionCount}`
  );

  Assert.equal(failures.length, 0, "No request should fail");
  Assert.equal(
    requestCount,
    ROUNDS * PARALLEL,
    "Each request should reach the server exactly once"
  );
  Assert.lessOrEqual(
    sessionCount,
    2,
    "Requests should share an HTTP/2 connection"
  );
});

function lnaUrl(tag) {
  return `https://localhost:${server.port()}/lna?${tag}`;
}

// The kept-alive HTTP/2 session must not let requests from origins without
// the permission through, and denying them must not tear the session down.
add_task(async function lna_kept_alive_h2_session_still_enforces_lna() {
  let warm = await openChannel(makeChannel(lnaUrl("warm")));
  Assert.equal(warm.status, Cr.NS_OK, "Allowed request succeeds");
  let sessionId = warm.body;
  let requestsBefore = await server.execute("global.lnaRequestCount");

  let denied = await openChannel(makeChannel(lnaUrl("deny"), DENIED_ORIGIN));
  Assert.equal(
    denied.status,
    Cr.NS_ERROR_LOCAL_NETWORK_ACCESS_DENIED,
    "Request from an origin with a DENY permission is blocked"
  );

  Services.prefs.setBoolPref("network.localnetwork.prompt.testing", true);
  Services.prefs.setBoolPref(
    "network.localnetwork.prompt.testing.allow",
    false
  );
  let prompted = await openChannel(
    makeChannel(lnaUrl("prompt-deny"), NO_PERMISSION_ORIGIN)
  );
  Services.prefs.setBoolPref("network.localnetwork.prompt.testing", false);
  Assert.equal(
    prompted.status,
    Cr.NS_ERROR_LOCAL_NETWORK_ACCESS_DENIED,
    "Request from an origin without permission is blocked when the prompt is denied"
  );

  Assert.equal(
    await server.execute("global.lnaRequestCount"),
    requestsBefore,
    "Denied requests never reach the server"
  );

  let after = await openChannel(makeChannel(lnaUrl("after")));
  Assert.equal(after.status, Cr.NS_OK, "Allowed request still succeeds");
  Assert.equal(after.body, sessionId, "The HTTP/2 session survived");
});

add_task(async function lna_mixed_parallel_requests_on_kept_alive_session() {
  let requestsBefore = await server.execute("global.lnaRequestCount");
  let sessionsBefore = await server.execute("global.lnaSessionCount");
  let allowedCount = 0;

  for (let round = 1; round <= ROUNDS; round++) {
    let origins = Array.from({ length: PARALLEL }, (_, i) =>
      i % 2 ? DENIED_ORIGIN : TRIGGERING_ORIGIN
    );
    let results = await Promise.all(
      origins.map((origin, i) =>
        openChannel(makeChannel(lnaUrl(`mixed-${round}-${i}`), origin))
      )
    );
    results.forEach(({ status }, i) => {
      if (origins[i] === DENIED_ORIGIN) {
        Assert.equal(
          status,
          Cr.NS_ERROR_LOCAL_NETWORK_ACCESS_DENIED,
          `Denied request ${round}-${i} is blocked`
        );
      } else {
        allowedCount++;
        Assert.equal(status, Cr.NS_OK, `Allowed request ${round}-${i} works`);
      }
    });
  }

  Assert.equal(
    await server.execute("global.lnaRequestCount"),
    requestsBefore + allowedCount,
    "Only allowed requests reach the server, each exactly once"
  );
  Assert.equal(
    await server.execute("global.lnaSessionCount"),
    sessionsBefore,
    "No new HTTP/2 session was needed"
  );
});
