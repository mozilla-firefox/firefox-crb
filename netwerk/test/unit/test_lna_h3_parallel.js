"use strict";

// Bug 2093779: parallel cross-origin requests from a public origin that holds
// the "local-network" permission to an HTTP/3 server on a private address
// must all succeed and share a single HTTP/3 connection, while requests from
// origins without the permission are still blocked on it.

/* import-globals-from head_http3.js */

const TRIGGERING_ORIGIN = "https://public.example.com";
const DENIED_ORIGIN = "https://denied.example.com";
const NO_PERMISSION_ORIGIN = "https://unknown.example.com";
const ROUNDS = 10;
const PARALLEL = 6;

let h3Port;

function makeChannel(path, triggeringOrigin = TRIGGERING_ORIGIN) {
  let url = `https://foo.example.com${path}`;
  let principal = Services.scriptSecurityManager.createContentPrincipal(
    NetUtil.newURI(url),
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
    chan.asyncOpen({
      QueryInterface: ChromeUtils.generateQI(["nsIStreamListener"]),
      onStartRequest() {},
      onDataAvailable(req, stream, offset, count) {
        read_stream(stream, count);
      },
      onStopRequest(req, status) {
        let protocol = "";
        let localPort = 0;
        try {
          protocol = req.protocolVersion;
          localPort = req.QueryInterface(Ci.nsIHttpChannelInternal).localPort;
        } catch (e) {}
        resolve({ status, protocol, localPort });
      },
    });
  });
}

add_setup(async () => {
  await http3_setup_tests("h3", true);
  h3Port = Services.prefs
    .getCharPref("network.http.http3.alt-svc-mapping-for-testing")
    .split(":")
    .pop();

  Services.prefs.setBoolPref("network.lna.blocking", true);
  Services.prefs.setBoolPref("network.lna.defer_https_check", true);
  Services.prefs.setBoolPref("network.localnetwork.prompt.testing", false);
  Services.prefs.setCharPref(
    "network.lna.address_space.private.override",
    `127.0.0.1:${h3Port}`
  );

  for (let [origin, action] of [
    [TRIGGERING_ORIGIN, Services.perms.ALLOW_ACTION],
    [DENIED_ORIGIN, Services.perms.DENY_ACTION],
  ]) {
    Services.perms.addFromPrincipal(
      Services.scriptSecurityManager.createContentPrincipalFromOrigin(origin),
      "local-network",
      action
    );
  }

  registerCleanupFunction(() => {
    Services.perms.removeAll();
    Services.prefs.clearUserPref("network.lna.blocking");
    Services.prefs.clearUserPref("network.lna.defer_https_check");
    Services.prefs.clearUserPref("network.localnetwork.prompt.testing");
    Services.prefs.clearUserPref("network.localnetwork.prompt.testing.allow");
    Services.prefs.clearUserPref("network.lna.address_space.private.override");
    http3_clear_prefs();
  });
});

add_task(async function lna_parallel_h3_requests_with_permission() {
  let failures = [];
  let connections = new Set();

  for (let round = 1; round <= ROUNDS; round++) {
    let results = await Promise.all(
      Array.from({ length: PARALLEL }, (_, i) =>
        openChannel(makeChannel(`/success?${round}-${i}`))
      )
    );
    for (let { status, protocol, localPort } of results) {
      if (status === Cr.NS_OK && protocol === "h3") {
        connections.add(localPort);
      } else {
        failures.push(`0x${status.toString(16)}/${protocol}`);
      }
    }
    info(
      `round ${round}: ${results
        .map(r => (r.status ? `0x${r.status.toString(16)}` : r.localPort))
        .join(" ")}`
    );
  }

  info(
    `failed=${failures.length} [${failures}] connections=${connections.size}`
  );
  Assert.equal(failures.length, 0, "Every request succeeds over HTTP/3");
  Assert.lessOrEqual(
    connections.size,
    2,
    "Requests share an HTTP/3 connection"
  );
});

add_task(async function lna_kept_alive_h3_session_still_enforces_lna() {
  let warm = await openChannel(makeChannel("/success?warm"));
  Assert.equal(warm.status, Cr.NS_OK, "Allowed request succeeds");
  Assert.equal(warm.protocol, "h3", "Allowed request uses HTTP/3");

  let denied = await openChannel(makeChannel("/success?deny", DENIED_ORIGIN));
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
    makeChannel("/success?prompt-deny", NO_PERMISSION_ORIGIN)
  );
  Services.prefs.setBoolPref("network.localnetwork.prompt.testing", false);
  Assert.equal(
    prompted.status,
    Cr.NS_ERROR_LOCAL_NETWORK_ACCESS_DENIED,
    "Request from an origin without permission is blocked when the prompt is denied"
  );

  let after = await openChannel(makeChannel("/success?after"));
  Assert.equal(after.status, Cr.NS_OK, "Allowed request still succeeds");
  Assert.equal(
    after.localPort,
    warm.localPort,
    "The HTTP/3 connection survived the denied requests"
  );
});

add_task(async function lna_mixed_parallel_requests_on_kept_alive_h3_session() {
  let warm = await openChannel(makeChannel("/success?mixed-warm"));
  Assert.equal(warm.status, Cr.NS_OK, "Allowed request succeeds");

  for (let round = 1; round <= ROUNDS; round++) {
    let origins = Array.from({ length: PARALLEL }, (_, i) =>
      i % 2 ? DENIED_ORIGIN : TRIGGERING_ORIGIN
    );
    let results = await Promise.all(
      origins.map((origin, i) =>
        openChannel(makeChannel(`/success?mixed-${round}-${i}`, origin))
      )
    );
    results.forEach(({ status, localPort }, i) => {
      if (origins[i] === DENIED_ORIGIN) {
        Assert.equal(
          status,
          Cr.NS_ERROR_LOCAL_NETWORK_ACCESS_DENIED,
          `Denied request ${round}-${i} is blocked`
        );
      } else {
        Assert.equal(status, Cr.NS_OK, `Allowed request ${round}-${i} works`);
        Assert.equal(
          localPort,
          warm.localPort,
          `Allowed request ${round}-${i} reuses the HTTP/3 connection`
        );
      }
    });
  }
});
