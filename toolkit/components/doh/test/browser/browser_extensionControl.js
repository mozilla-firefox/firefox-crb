/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

"use strict";

/* global browser */

add_task(setup);

async function loadDoHExtension() {
  let extension = ExtensionTestUtils.loadExtension({
    manifest: {
      permissions: ["dns", "proxy"],
      browser_specific_settings: { gecko: { id: "doh@tests.mozilla.org" } },
    },
    incognitoOverride: "spanning",
    useAddonManager: "temporary",
    background() {
      browser.test.onMessage.addListener(async value => {
        let result = await browser.dns.dohSettings.set({ value });
        browser.test.sendMessage("set:done", result);
      });
    },
  });
  await extension.startup();
  return extension;
}

async function setDoHSettings(extension, value) {
  extension.sendMessage(value);
  is(await extension.awaitMessage("set:done"), true, "dohSettings.set worked");
}

add_task(async function testExtensionControl() {
  setPassingHeuristics();
  let prefPromise = TestUtils.waitForPrefChange(prefs.BREADCRUMB_PREF);
  Services.prefs.setBoolPref(prefs.ENABLED_PREF, true);
  await prefPromise;
  await ensureTRRMode(2);

  let extension = await loadDoHExtension();

  // Settings that keep the default mode don't take DoH away from the rollout.
  await setDoHSettings(extension, { excludedDomains: ["example.org"] });
  await ensureNoTRRModeChange(2);
  ok(
    !Services.prefs.prefHasUserValue(prefs.DISABLED_PREF),
    "Heuristics are not disabled by the default mode"
  );

  await setDoHSettings(extension, {
    mode: "doh-only",
    url: "https://example.com/dns-query",
  });
  await ensureTRRMode(undefined);
  is(
    Services.prefs.getBoolPref(prefs.DISABLED_PREF),
    true,
    "Heuristics are disabled while the extension controls DoH"
  );

  await extension.unload();
  ok(
    !Services.prefs.prefHasUserValue(prefs.DISABLED_PREF),
    "Heuristics are no longer disabled after the extension is removed"
  );

  await restartDoHController();
  await ensureTRRMode(2);
});
