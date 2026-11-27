/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/**
 * Tests that the about:privatebrowsing search bar only initializes while
 * browser.urlbar.aboutprivatebrowsing.featureGate is enabled.
 */
add_task(async function () {
  let { win, tab } = await openAboutPrivateBrowsing();

  await SpecialPowers.spawn(tab, [], () => {
    let bar = Cu.waiveXrays(content.document.querySelector("moz-urlbar"));
    Assert.ok(!bar.controller, "Not initialized while disabled");
  });

  info("Enabling the feature gate.");
  await SpecialPowers.pushPrefEnv({
    set: [["browser.urlbar.aboutprivatebrowsing.featureGate", true]],
  });
  await SpecialPowers.spawn(tab, [], async () => {
    let bar = Cu.waiveXrays(content.document.querySelector("moz-urlbar"));
    await ContentTaskUtils.waitForCondition(
      () => bar.controller && bar._observersAdded,
      "Initializes when pref is enabled"
    );
  });

  info("Disabling the feature gate.");
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.spawn(tab, [], async () => {
    let bar = Cu.waiveXrays(content.document.querySelector("moz-urlbar"));
    await ContentTaskUtils.waitForCondition(
      () => !bar._observersAdded,
      "Uninitializes when pref is disabled"
    );
  });

  await BrowserTestUtils.closeWindow(win);
});
