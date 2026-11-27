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

  selectDefaultProtection();
  await ensureTRRMode(2);
});

add_task(async function testOverlappingEnable() {
  await DoHController.disableHeuristics("manuallyDisabled");
  Services.fog.testResetFOG();
  await Promise.all([
    DoHController.maybeEnableHeuristics(),
    DoHController.maybeEnableHeuristics(),
  ]);
  is(Glean.networking.dohHeuristicsAttempts.testGetValue(), 1);
  await ensureTRRMode(2);

  await DoHController.disableHeuristics("manuallyDisabled");
  let enablePromise = DoHController.maybeEnableHeuristics();
  Services.prefs.setBoolPref(prefs.DISABLED_PREF, true);
  await enablePromise;
  ok(!DoHController._heuristicsAreEnabled, "Manual disable wins.");
});
