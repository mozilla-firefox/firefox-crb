/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

"use strict";

add_task(setup);

add_task(async function testDefaultAfterManual() {
  setPassingHeuristics();
  let prefPromise = TestUtils.waitForPrefChange(prefs.BREADCRUMB_PREF);
  Services.prefs.setBoolPref(prefs.ENABLED_PREF, true);
  await prefPromise;
  await ensureTRRMode(2);

  Services.prefs.setIntPref(prefs.NETWORK_TRR_MODE_PREF, 3);
  Services.prefs.setStringPref(
    prefs.NETWORK_TRR_URI_PREF,
    "https://example.com/dns-query"
  );
  await ensureTRRMode(undefined);
  is(
    Services.prefs.getBoolPref(prefs.DISABLED_PREF),
    true,
    "Manual disable recorded."
  );

  // Mirror the pref writes of the Default radio in about:preferences.
  Services.prefs.setIntPref(prefs.NETWORK_TRR_MODE_PREF, 0);
  Services.prefs.clearUserPref(prefs.NETWORK_TRR_URI_PREF);
  Services.prefs.clearUserPref(prefs.DISABLED_PREF);

  await ensureTRRMode(2);
});
