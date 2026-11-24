/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const ID = "langpack-und@test.mozilla.org";

Services.prefs.setIntPref(
  "extensions.enabledScopes",
  AddonManager.SCOPE_PROFILE | AddonManager.SCOPE_USER
);
Services.prefs.setIntPref("extensions.sideloadScopes", AddonManager.SCOPE_USER);

createAppInfo("xpcshell@tests.mozilla.org", "XPCShell", "58", "58");

const userDir = gProfD.clone();
userDir.append("app-system-user");
userDir.append(gAppInfo.ID);
registerDirectory("XREUSysExt", userDir.parent);

add_task(async function test_locked_langpack_is_not_updated() {
  let xpi = AddonTestUtils.createTempXPIFile({
    "browser/localization/und/browser.ftl": "message-browser = Value\n",
    "manifest.json": {
      name: "und Language Pack",
      version: "58.0.1",
      manifest_version: 2,
      browser_specific_settings: {
        gecko: {
          id: ID,
          strict_min_version: "58.0",
          strict_max_version: "58.*",
        },
      },
      sources: { browser: { base_path: "browser/" } },
      langpack_id: "und",
      languages: { und: { chrome_resources: {}, version: "20171001190118" } },
    },
  });
  await AddonTestUtils.manuallyInstall(xpi, userDir);

  await promiseStartupManager();
  let addon = await promiseAddonByID(ID);
  Assert.equal(addon.scope, AddonManager.SCOPE_USER);
  Assert.ok(addon.isActive);

  await promiseRestartManager("60");
  addon = await promiseAddonByID(ID);
  Assert.ok(addon.appDisabled, "The langpack is incompatible");
  Assert.ok(
    !(addon.permissions & AddonManager.PERM_CAN_UPGRADE),
    "The langpack can't be updated"
  );
  Assert.deepEqual(
    await AddonManager.getIncompatibleLangpacks(["und"]),
    [],
    "A langpack that can't be updated isn't returned"
  );

  await promiseShutdownManager();
});
