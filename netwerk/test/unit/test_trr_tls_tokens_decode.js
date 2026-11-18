/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

function appendLE(bytes, value, size) {
  let v = BigInt(value);
  for (let i = 0; i < size; i++) {
    bytes.push(Number((v >> BigInt(8 * i)) & 0xffn));
  }
}

// Mirrors the pref format of SSLTokensCache: base64 of [1: version], then per
// record [4: key_len][key][8: expiration_time][1: overridable_error]
// [4: payload_len][payload], integers little-endian.
function encodeTRRTokens(records, version = 1) {
  let bytes = [version];
  for (let rec of records) {
    let key = new TextEncoder().encode(rec.key);
    appendLE(bytes, key.length, 4);
    bytes.push(...key);
    appendLE(bytes, rec.expirationTime, 8);
    bytes.push(rec.overridableError);
    appendLE(bytes, rec.payload.length, 4);
    bytes.push(...rec.payload);
  }
  return btoa(String.fromCharCode(...bytes));
}

// A record that DecodeTRRTokens accepts; the payload is never decoded.
function dummyTRRRecord(overrides = {}) {
  return {
    key: "anon:trr:tlsflags0x00000000:foo.example.com:443",
    expirationTime: BigInt(Date.now() + 3600 * 1000) * 1000n,
    overridableError: 0,
    payload: [1, 2, 3, 4],
    ...overrides,
  };
}

function countSSLTokens() {
  return Cc["@mozilla.org/network/ssl-tokens-cache;1"]
    .getService(Ci.nsISSLTokensCacheTest)
    .countSSLTokens();
}

// Sets aValue with the gate off, which keeps it, then turns the gate on.
function setValueThenGateOn(aValue) {
  Services.prefs.setBoolPref(TRR_TOKENS_GATE_PREF, false);
  Services.prefs.setCharPref(TRR_TOKENS_PREF, aValue);
  Assert.equal(Services.prefs.getCharPref(TRR_TOKENS_PREF), aValue);
  Services.prefs.setBoolPref(TRR_TOKENS_GATE_PREF, true);
}

const kValid = dummyTRRRecord();
const kRejected = {
  bad_base64: "not base64!",
  version: encodeTRRTokens([kValid], 2),
  truncated: btoa(atob(encodeTRRTokens([kValid])).slice(0, -1)),
  non_trr: encodeTRRTokens([
    dummyTRRRecord({ key: "anon:tlsflags0x00000000:foo.example.com:443" }),
  ]),
  private: encodeTRRTokens([
    dummyTRRRecord({
      key: "anon:private:trr:tlsflags0x00000000:foo.example.com:443",
    }),
  ]),
  pbm: encodeTRRTokens([
    dummyTRRRecord({
      key: "anon:trr:tlsflags0x00000000:foo.example.com:443^privateBrowsingId=1",
    }),
  ]),
  overridable: encodeTRRTokens([dummyTRRRecord({ overridableError: 1 })]),
  mixed: encodeTRRTokens([
    kValid,
    dummyTRRRecord({ key: "anon:trr:tlsflags0x00000000:foo.example.com:444" }),
  ]),
  expired: encodeTRRTokens([dummyTRRRecord({ expirationTime: 1000000n })]),
};

add_task(async function test_rejected_values_cleared() {
  Assert.equal(Services.prefs.getBoolPref(TRR_TOKENS_GATE_PREF), false);
  for (let [name, value] of Object.entries(kRejected)) {
    info(`Rejecting ${name}`);
    setValueThenGateOn(value);
    Assert.equal(Services.prefs.getCharPref(TRR_TOKENS_PREF), "");
    Assert.equal(countSSLTokens(), 0);
  }
});

// With the gate on, a rejected value doesn't block a later load.
add_task(async function test_valid_value_after_rejected_loads() {
  Assert.equal(Services.prefs.getBoolPref(TRR_TOKENS_GATE_PREF), true);
  Services.prefs.setCharPref(TRR_TOKENS_PREF, kRejected.version);
  Assert.equal(Services.prefs.getCharPref(TRR_TOKENS_PREF), "");
  let value = encodeTRRTokens([kValid]);
  Services.prefs.setCharPref(TRR_TOKENS_PREF, value);
  Assert.equal(Services.prefs.getCharPref(TRR_TOKENS_PREF), value);
  Assert.deepEqual(
    (await dashboardRecords()).map(r => [r.key, r.restored, r.expirationTime]),
    [[kValid.key, true, Number(kValid.expirationTime)]]
  );
});

add_task(async function test_host_removal_clears_loaded_pref() {
  await clearData(
    "deleteDataFromHost",
    "foo.example.com",
    true,
    Ci.nsIClearDataService.CLEAR_TLS_TOKEN_CACHE
  );
  Assert.equal(Services.prefs.getCharPref(TRR_TOKENS_PREF), "");
  Assert.equal(countSSLTokens(), 0);
});
