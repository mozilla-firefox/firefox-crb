/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from trr_common.js */

const CONFIRM_TRYING_OK = 1;
const CONFIRM_OK = 2;

// Decodes the pref format of SSLTokensCache: base64 of [1: version], then per
// record [4: key_len][key][8: expiration_time][1: overridable_error]
// [4: payload_len][payload], integers little-endian. The payload is a binary
// string, expirationTime a BigInt.
function decodeTRRTokens(value) {
  let bin = atob(value);
  let pos = 0;
  let readLE = size => {
    let v = 0n;
    for (let i = 0; i < size; i++) {
      v |= BigInt(bin.charCodeAt(pos++)) << BigInt(8 * i);
    }
    return v;
  };
  let version = bin.charCodeAt(pos++);
  let records = [];
  while (pos < bin.length) {
    let keyLen = Number(readLE(4));
    let key = bin.substr(pos, keyLen);
    pos += keyLen;
    let expirationTime = readLE(8);
    let overridableError = bin.charCodeAt(pos++);
    let payloadLen = Number(readLE(4));
    let payload = bin.substr(pos, payloadLen);
    pos += payloadLen;
    records.push({ key, expirationTime, overridableError, payload });
  }
  return { version, records };
}

let trrServer;
let trrKey;
let lookupCount = 0;

add_setup(async function setup() {
  trr_test_setup();
  Services.prefs.setBoolPref("network.dns.disableIPv6", true);
  Services.prefs.setBoolPref(TRR_TOKENS_GATE_PREF, true);
  trrServer = new TRRServer();
  await trrServer.start();
  registerCleanupFunction(async () => {
    trr_clear_prefs();
    Services.prefs.clearUserPref("network.dns.disableIPv6");
    Services.prefs.clearUserPref(TRR_TOKENS_GATE_PREF);
    Services.prefs.clearUserPref(TRR_TOKENS_PREF);
    await trrServer.stop();
  });
  await trrServer.execute(`
    global.sessionReused = [];
    global.server.on("secureConnection", socket => {
      global.sessionReused.push(socket.isSessionReused());
    });
  `);
  trrKey = `anon:trr:tlsflags0x00000000:foo.example.com:${trrServer.port()}`;
  Services.prefs.setCharPref(
    "network.trr.uri",
    `https://foo.example.com:${trrServer.port()}/dns-query`
  );
  Services.prefs.setIntPref("network.trr.mode", Ci.nsIDNSService.MODE_TRRONLY);
});

async function lookup() {
  let name = `host${++lookupCount}.example.com`;
  await trrServer.registerDoHAnswers(name, "A", {
    answers: [{ name, ttl: 55, type: "A", flush: false, data: "1.2.3.4" }],
  });
  await new TRRDNSListener(name, { expectedAnswer: "1.2.3.4" });
}

function sessionReused() {
  return trrServer.execute("global.sessionReused");
}

function prefRecords() {
  let value = Services.prefs.getCharPref(TRR_TOKENS_PREF);
  return value ? decodeTRRTokens(value).records : [];
}

// Waits for aCount pref records, since each ticket's write is dispatched.
async function waitForPrefRecords(aCount) {
  await TestUtils.waitForCondition(
    () => prefRecords().length == aCount,
    `${aCount} records in ${TRR_TOKENS_PREF}`
  );
  return prefRecords();
}

// Drops all tokens and connections, so the next lookup does a full handshake.
function resetConnections() {
  Services.obs.notifyObservers(null, "net:cancel-all-connections");
  Cc["@mozilla.org/network/ssl-tokens-cache;1"]
    .getService(Ci.nsISSLTokensCache)
    .clearSSLExternalAndInternalSessionCache();
  Services.dns.clearCache(true);
}

// A fresh TRR connection with the gate on, so the pref holds its two tickets
// (OpenSSL's default for a full TLS 1.3 handshake).
async function fillPref() {
  resetConnections();
  await lookup();
  return waitForPrefRecords(2);
}

let savedValue;

add_task(async function test_gate_on_writes_pref() {
  await lookup();
  let records = await waitForPrefRecords(2);
  savedValue = Services.prefs.getCharPref(TRR_TOKENS_PREF);
  Assert.equal(decodeTRRTokens(savedValue).version, 1);
  Assert.deepEqual(
    records.map(r => r.key),
    [trrKey, trrKey]
  );
  Assert.deepEqual(
    records.map(r => r.overridableError),
    [0, 0]
  );
  let now = BigInt(Date.now()) * 1000n;
  Assert.ok(records.every(r => r.expirationTime > now));
  Assert.deepEqual(await sessionReused(), [false]);
});

add_task(async function test_gate_off_clears_pref() {
  Services.prefs.setBoolPref(TRR_TOKENS_GATE_PREF, false);
  Assert.equal(Services.prefs.getCharPref(TRR_TOKENS_PREF), "");
});

add_task(async function test_gate_off_does_not_write() {
  resetConnections();
  await lookup();
  // The tickets arrive before the DoH response, so a second lookup on the
  // connection orders any write before the check.
  await lookup();
  Assert.deepEqual(
    (await dashboardRecords()).map(r => r.key),
    [trrKey, trrKey]
  );
  Assert.equal(Services.prefs.getCharPref(TRR_TOKENS_PREF), "");
  Assert.deepEqual(await sessionReused(), [false, false]);
});

// Restores the pref into an empty cache, as on a restart.
add_task(async function test_resume_from_pref() {
  resetConnections();
  Assert.equal(getCacheServices().testCache.countSSLTokens(), 0);
  Services.prefs.setCharPref(TRR_TOKENS_PREF, savedValue);
  Assert.equal(Services.prefs.getCharPref(TRR_TOKENS_PREF), savedValue);
  Services.prefs.setBoolPref(TRR_TOKENS_GATE_PREF, true);
  Assert.equal(Services.prefs.getCharPref(TRR_TOKENS_PREF), savedValue);
  Assert.deepEqual(
    (await dashboardRecords()).map(r => [r.key, r.restored]),
    [
      [trrKey, true],
      [trrKey, true],
    ]
  );

  await lookup();
  Assert.deepEqual(await sessionReused(), [false, false, true]);
  let saved = decodeTRRTokens(savedValue).records.map(r => r.payload);
  let savedLeft = () =>
    prefRecords().filter(r => saved.includes(r.payload)).length;
  // The resumption consumed one saved ticket, and the rewrite dropped it.
  await TestUtils.waitForCondition(() => savedLeft() == 1, "saved ticket used");
  Assert.ok(prefRecords().every(r => r.key == trrKey));
});

add_task(async function test_host_removal_clears_pref() {
  await fillPref();
  await clearData(
    "deleteDataFromHost",
    "foo.example.com",
    true,
    Ci.nsIClearDataService.CLEAR_TLS_TOKEN_CACHE
  );
  Assert.equal(Services.prefs.getCharPref(TRR_TOKENS_PREF), "");
});

add_task(async function test_site_removal_clears_pref() {
  await fillPref();
  await clearData(
    "deleteDataFromSite",
    "example.com",
    {},
    true,
    Ci.nsIClearDataService.CLEAR_TLS_TOKEN_CACHE
  );
  Assert.equal(Services.prefs.getCharPref(TRR_TOKENS_PREF), "");
});

add_task(async function test_clear_all_clears_pref() {
  await fillPref();
  await clearData("deleteData", Ci.nsIClearDataService.CLEAR_TLS_TOKEN_CACHE);
  Assert.equal(Services.prefs.getCharPref(TRR_TOKENS_PREF), "");
});

add_task(async function test_trr_off_clears_pref() {
  await fillPref();
  Services.prefs.setIntPref("network.trr.mode", Ci.nsIDNSService.MODE_TRROFF);
  Assert.equal(Services.prefs.getCharPref(TRR_TOKENS_PREF), "");
  Services.prefs.setIntPref("network.trr.mode", Ci.nsIDNSService.MODE_TRRONLY);
});

add_task(async function test_persistence_off_clears_pref() {
  const kPersistencePref = "network.ssl_tokens_cache_persistence";
  registerCleanupFunction(() => Services.prefs.clearUserPref(kPersistencePref));
  Services.prefs.setBoolPref(kPersistencePref, true);
  Services.obs.notifyObservers(null, "profile-after-change", "xpcshell-test");
  await fillPref();
  Services.prefs.setBoolPref(kPersistencePref, false);
  Assert.deepEqual(await dashboardRecords(), []);
  Assert.equal(Services.prefs.getCharPref(TRR_TOKENS_PREF), "");
});

// A network.trr.* pref change would restart TRR confirmation.
add_task(async function test_pref_write_keeps_confirmation() {
  let confirmAnswer = {
    answers: [
      {
        name: "confirm.example.com",
        ttl: 55,
        type: "NS",
        flush: false,
        data: "test.com",
      },
    ],
  };
  await trrServer.registerDoHAnswers(
    "confirm.example.com",
    "NS",
    confirmAnswer
  );
  resetConnections();
  Services.prefs.setCharPref(
    "network.trr.confirmationNS",
    "confirm.example.com"
  );
  Services.prefs.setIntPref("network.trr.mode", Ci.nsIDNSService.MODE_TRRFIRST);
  await TestUtils.waitForCondition(
    () => Services.dns.currentTrrConfirmationState == CONFIRM_OK,
    "TRR confirmation succeeded"
  );
  let confirmRequests = await trrServer.requestCount(
    "confirm.example.com",
    "NS"
  );
  // A restarted confirmation stays in CONFIRM_TRYING_OK until the test ends.
  await trrServer.registerDoHAnswers("confirm.example.com", "NS", {
    ...confirmAnswer,
    delay: 10000,
  });
  await fillPref();
  Assert.equal(Services.dns.currentTrrConfirmationState, CONFIRM_OK);
  Assert.equal(
    await trrServer.requestCount("confirm.example.com", "NS"),
    confirmRequests
  );
  Services.prefs.setCharPref("network.trr.tls_tokens_test", "x");
  Assert.equal(Services.dns.currentTrrConfirmationState, CONFIRM_TRYING_OK);
  Services.prefs.clearUserPref("network.trr.tls_tokens_test");
  Services.prefs.setCharPref("network.trr.confirmationNS", "skip");
  Services.prefs.setIntPref("network.trr.mode", Ci.nsIDNSService.MODE_TRRONLY);
});

// Decapsulates an OHTTP request, fetches it from the TRR server and returns
// the encapsulated response.
async function forwardToTRR(ohttpServer, request, response) {
  let inputStream = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
    Ci.nsIScriptableInputStream
  );
  inputStream.init(request.bodyInputStream);
  let ohttpRequest = ohttpServer.decapsulate(
    stringToBytes(inputStream.readBytes(inputStream.available()))
  );
  let bhttp = Cc["@mozilla.org/network/binary-http;1"].getService(
    Ci.nsIBinaryHttp
  );
  let decoded = bhttp.decodeRequest(ohttpRequest.request);
  let headers = {};
  for (let i = 0; i < decoded.headerNames.length; i++) {
    headers[decoded.headerNames[i]] = decoded.headerValues[i];
  }
  let trrResponse = await fetch(
    `${decoded.scheme}://${decoded.authority}${decoded.path}`,
    {
      method: decoded.method,
      headers,
      body: decoded.method == "POST" ? new Uint8Array(decoded.content) : null,
      credentials: "omit",
    }
  );
  let binaryResponse = new BinaryHttpResponse(
    trrResponse.status,
    [...trrResponse.headers.keys()],
    [...trrResponse.headers.values()],
    [...new Uint8Array(await trrResponse.arrayBuffer())]
  );
  let encResponse = ohttpRequest.encapsulate(
    bhttp.encodeResponse(binaryResponse)
  );
  response.setStatusLine(request.httpVersion, 200, "OK");
  response.setHeader("Content-Type", "message/ohttp-res", false);
  response.write(bytesToString(encResponse));
}

// The relay is on the TRR server, so its TLS session is a TRR channel's.
add_task(
  { skip_if: () => mozinfo.os == "android" },
  async function test_ohttp_does_not_write() {
    let ohttpServer = Cc["@mozilla.org/network/oblivious-http;1"]
      .getService(Ci.nsIObliviousHttp)
      .server();
    let httpServer = new HttpServer();
    httpServer.registerPathHandler("/relay", (request, response) => {
      response.processAsync();
      forwardToTRR(ohttpServer, request, response).then(() =>
        response.finish()
      );
    });
    httpServer.registerPathHandler("/config", (request, response) => {
      response.setStatusLine(request.httpVersion, 200, "OK");
      response.setHeader("Content-Type", "application/ohttp-keys", false);
      response.write(bytesToString(ohttpServer.encodedConfig));
    });
    httpServer.start(-1);
    await trrServer.execute(`global.relayPort = ${httpServer.identity.primaryPort};
    global.relayCount = 0;`);
    await trrServer.registerPathHandler("/relay", (req, res) => {
      global.relayCount++;
      let chunks = [];
      req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => {
        let preq = require("http").request(
          {
            host: "127.0.0.1",
            port: global.relayPort,
            path: "/relay",
            method: "POST",
            headers: { "content-type": req.headers["content-type"] },
          },
          pres => {
            let body = [];
            pres.on("data", chunk => body.push(chunk));
            pres.on("end", () => {
              res.writeHead(pres.statusCode, {
                "content-type": pres.headers["content-type"],
              });
              res.end(Buffer.concat(body));
            });
          }
        );
        preq.end(Buffer.concat(chunks));
      });
    });

    resetConnections();
    let configPromise = TestUtils.topicObserved("ohttp-service-config-loaded");
    Services.prefs.setCharPref(
      "network.trr.ohttp.relay_uri",
      `https://foo.example.com:${trrServer.port()}/relay`
    );
    Services.prefs.setCharPref(
      "network.trr.ohttp.config_uri",
      `http://localhost:${httpServer.identity.primaryPort}/config`
    );
    Services.prefs.setCharPref(
      "network.trr.ohttp.uri",
      `https://foo.example.com:${trrServer.port()}/dns-query`
    );
    Services.prefs.setBoolPref("network.trr.use_ohttp", true);
    Cc["@mozilla.org/network/oblivious-http-service;1"].getService(
      Ci.nsIObliviousHttpService
    );
    let [, status] = await configPromise;
    Assert.equal(status, "success");
    registerCleanupFunction(async () => {
      Services.prefs.clearUserPref("network.trr.use_ohttp");
      Services.prefs.clearUserPref("network.trr.ohttp.relay_uri");
      Services.prefs.clearUserPref("network.trr.ohttp.config_uri");
      Services.prefs.clearUserPref("network.trr.ohttp.uri");
      await httpServer.stop();
    });

    await lookup();
    await lookup();
    Assert.equal(await trrServer.execute("global.relayCount"), 2);
    let nonTRRKey = `anon:tlsflags0x00000000:foo.example.com:${trrServer.port()}`;
    Assert.deepEqual(
      [...new Set((await dashboardRecords()).map(r => r.key))],
      [nonTRRKey]
    );
    Assert.equal(Services.prefs.getCharPref(TRR_TOKENS_PREF), "");
  }
);
