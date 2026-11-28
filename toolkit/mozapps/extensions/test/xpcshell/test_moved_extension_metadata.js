/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

// This verifies that moving an extension in the filesystem without any other
// change still keeps updated compatibility information and its disabled state.

// The test extension uses an insecure update url.
Services.prefs.setBoolPref("extensions.checkUpdateSecurity", false);
// Enable loading extensions from the user and system scopes
Services.prefs.setIntPref(
  "extensions.enabledScopes",
  AddonManager.SCOPE_PROFILE + AddonManager.SCOPE_USER
);
Services.prefs.setIntPref("extensions.sideloadScopes", AddonManager.SCOPE_USER);
Services.prefs.setIntPref(
  "extensions.startupScanScopes",
  AddonManager.SCOPE_USER
);

createAppInfo("xpcshell@tests.mozilla.org", "XPCShell", "2", "2");

var testserver = AddonTestUtils.createHttpServer({ hosts: ["example.com"] });
testserver.registerDirectory("/data/", do_get_file("data"));

var userDir = gProfD.clone();
userDir.append("extensions2");
userDir.append(gAppInfo.ID);

var dirProvider = {
  getFile(aProp, aPersistent) {
    aPersistent.value = false;
    if (aProp == "XREUSysExt") {
      return userDir.parent;
    }
    return null;
  },

  QueryInterface: ChromeUtils.generateQI(["nsIDirectoryServiceProvider"]),
};
Services.dirsvc.registerProvider(dirProvider);

const ID1 = "addon1@tests.mozilla.org";
const ID2 = "addon2@tests.mozilla.org";

function moveUserDir(newName) {
  userDir.parent.moveTo(gProfD, newName);
  userDir = gProfD.clone();
  userDir.append(newName);
  userDir.append(gAppInfo.ID);
  Assert.ok(userDir.exists(), "User scope directory was moved");
}

add_task(async function test_moved_keeps_compatibility_update() {
  await promiseWriteWebManifestForExtension(
    {
      manifest_version: 2,
      name: "Test 1",
      version: "1.0",
      browser_specific_settings: {
        gecko: {
          id: ID1,
          update_url: "http://example.com/data/test_bug655254.json",
          strict_min_version: "1",
          strict_max_version: "1",
        },
      },
    },
    userDir
  );

  await manuallyInstall(
    AddonTestUtils.createTempWebExtensionFile({
      manifest: {
        name: "Test 2",
        version: "1.0",
        browser_specific_settings: {
          gecko: {
            id: ID2,
            strict_min_version: "2",
            strict_max_version: "2",
          },
        },
      },
    }),
    userDir,
    ID2
  );

  await promiseStartupManager();

  let [a1, a2] = await AddonManager.getAddonsByIDs([ID1, ID2]);
  Assert.ok(a1.appDisabled, "Add-on 1 is initially incompatible");
  Assert.ok(!a1.isActive, "Add-on 1 is initially inactive");
  Assert.ok(!isExtensionInBootstrappedList(userDir, ID1));

  Assert.ok(!a2.appDisabled, "Add-on 2 is compatible");
  Assert.ok(a2.isActive, "Add-on 2 is active");
  Assert.ok(isExtensionInBootstrappedList(userDir, ID2));

  await AddonTestUtils.promiseFindAddonUpdates(
    a1,
    AddonManager.UPDATE_WHEN_USER_REQUESTED
  );

  await promiseRestartManager();

  a1 = await AddonManager.getAddonByID(ID1);
  Assert.ok(!a1.appDisabled, "Compatibility update made add-on 1 compatible");
  Assert.ok(a1.isActive, "Add-on 1 is active after the compatibility update");
  Assert.ok(isExtensionInBootstrappedList(userDir, ID1));

  await promiseShutdownManager();
  moveUserDir("extensions3");
  await promiseStartupManager();

  [a1, a2] = await AddonManager.getAddonsByIDs([ID1, ID2]);
  Assert.ok(!a1.appDisabled, "Moved add-on 1 is still compatible");
  Assert.ok(a1.isActive, "Moved add-on 1 is still active");
  Assert.ok(isExtensionInBootstrappedList(userDir, ID1));

  Assert.ok(!a2.appDisabled, "Moved add-on 2 is still compatible");
  Assert.ok(a2.isActive, "Moved add-on 2 is still active");
  Assert.ok(isExtensionInBootstrappedList(userDir, ID2));
});

add_task(async function test_moved_keeps_user_disabled() {
  let a2 = await AddonManager.getAddonByID(ID2);
  Assert.ok(a2.isActive, "Add-on 2 is active");

  await a2.disable();
  Assert.ok(!a2.isActive, "Add-on 2 is disabled");

  await promiseShutdownManager();
  moveUserDir("extensions4");
  await promiseStartupManager();

  let a1;
  [a1, a2] = await AddonManager.getAddonsByIDs([ID1, ID2]);
  Assert.ok(!a1.appDisabled, "Moved add-on 1 is still compatible");
  Assert.ok(a1.isActive, "Moved add-on 1 is still active");
  Assert.ok(isExtensionInBootstrappedList(userDir, ID1));

  Assert.ok(a2.userDisabled, "Moved add-on 2 is still user disabled");
  Assert.ok(!a2.isActive, "Moved add-on 2 is still inactive");
  Assert.ok(!isExtensionInBootstrappedList(userDir, ID2));

  await promiseShutdownManager();
});
