/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Tests that ELEVATED_UPDATE_HELPER_INSTALL_ERROR, which the macOS updater
 * records when it couldn't install its privileged helper for another reason
 * than a dismissed authentication dialog, is counted like a dismissed dialog.
 */

const ELEVATED_UPDATE_HELPER_INSTALL_ERROR = 115;
const PREF_APP_UPDATE_CANCELATIONS_OSX = "app.update.cancelations.osx";
const PREF_APP_UPDATE_ELEVATE_ATTEMPTS = "app.update.elevate.attempts";

add_setup(async function setup() {
  setupTestCommon();
});

add_task(async function testHelperInstallFailureIsCountedAsCancellation() {
  let patches = getLocalPatchString({ state: STATE_PENDING });
  writeUpdatesToXMLFile(
    getLocalUpdatesXMLString(
      getLocalUpdateString({ appVersion: "2" }, patches)
    ),
    true
  );
  writeFile(getUpdateDirFile(FILE_UPDATE_MAR, DIR_PATCH), "test mar contents");
  writeStatusFile(
    STATE_FAILED + STATE_FAILED_DELIMETER + ELEVATED_UPDATE_HELPER_INSTALL_ERROR
  );

  await reloadUpdateManagerData();
  await testPostUpdateProcessing();

  Assert.equal(
    Services.prefs.getIntPref(PREF_APP_UPDATE_CANCELATIONS_OSX, 0),
    1,
    "the macOS cancellation count should go up"
  );
  Assert.equal(
    Services.prefs.getIntPref(PREF_APP_UPDATE_ELEVATE_ATTEMPTS, 0),
    1,
    "the elevation attempt count should go up"
  );

  for (let pref of [
    PREF_APP_UPDATE_CANCELATIONS,
    PREF_APP_UPDATE_CANCELATIONS_OSX,
    PREF_APP_UPDATE_ELEVATE_ATTEMPTS,
  ]) {
    Services.prefs.clearUserPref(pref);
  }
  await doTestFinish();
});
