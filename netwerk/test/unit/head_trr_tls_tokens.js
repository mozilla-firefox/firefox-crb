/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Helpers for the tests of the TRR TLS tokens pref.

"use strict";

const TRR_TOKENS_PREF = "network.ssl_tokens_cache_trr";
const TRR_TOKENS_GATE_PREF = "network.trr.tls_tokens.enabled";

function dashboardRecords() {
  let dashboard = Cc["@mozilla.org/network/dashboard;1"].getService(
    Ci.nsIDashboard
  );
  return new Promise(resolve =>
    dashboard.requestSSLTokensCache(data => resolve(data.entries))
  );
}

// Calls the nsIClearDataService method aMethod and resolves when it is done.
function clearData(aMethod, ...aArgs) {
  return new Promise(resolve => Services.clearData[aMethod](...aArgs, resolve));
}
