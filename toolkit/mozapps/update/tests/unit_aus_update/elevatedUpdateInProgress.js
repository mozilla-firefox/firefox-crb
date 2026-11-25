/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Tests that ELEVATED_UPDATE_IN_PROGRESS_ERROR, which the macOS elevated
 * updater records when its privileged helper is already handling another
 * update, asks the user to try again without counting an elevation attempt or
 * a cancellation, however often it happens. Also tests that
 * ELEVATED_UPDATE_HELPER_LOST_ERROR, recorded when the helper went away before
 * it replied, counts as a cancellation.
 */

const ELEVATED_UPDATE_IN_PROGRESS_ERROR = 107;
const ELEVATED_UPDATE_HELPER_LOST_ERROR = 116;
const PREF_APP_UPDATE_CANCELATIONS_OSX = "app.update.cancelations.osx";
const PREF_APP_UPDATE_ELEVATE_ATTEMPTS = "app.update.elevate.attempts";

add_setup(async function setup() {
  setupTestCommon();
});

async function processElevatedFailure(aErrorCode) {
  let patches = getLocalPatchString({ state: STATE_PENDING });
  writeUpdatesToXMLFile(
    getLocalUpdatesXMLString(
      getLocalUpdateString({ appVersion: "2" }, patches)
    ),
    true
  );
  writeFile(getUpdateDirFile(FILE_UPDATE_MAR, DIR_PATCH), "test mar contents");
  writeStatusFile(STATE_FAILED + STATE_FAILED_DELIMETER + aErrorCode);

  let updateError = TestUtils.topicObserved(
    "update-error",
    (subject, data) => data == "elevation-attempt-failed"
  );

  await reloadUpdateManagerData();
  await testPostUpdateProcessing();
  await updateError;
}

add_task(async function testInProgressIsNotCountedAsCancellation() {
  // However often the helper is busy, it should never count.
  for (let i = 0; i < 12; i++) {
    await processElevatedFailure(ELEVATED_UPDATE_IN_PROGRESS_ERROR);

    Assert.equal(
      readStatusFile(),
      STATE_PENDING_ELEVATE,
      "the update should be pending elevation again"
    );
    Assert.equal(
      Services.prefs.getIntPref(PREF_APP_UPDATE_CANCELATIONS, 0),
      0,
      "the cancellation count should not change"
    );
    Assert.equal(
      Services.prefs.getIntPref(PREF_APP_UPDATE_CANCELATIONS_OSX, 0),
      0,
      "the macOS cancellation count should not change"
    );
    Assert.equal(
      Services.prefs.getIntPref(PREF_APP_UPDATE_ELEVATE_ATTEMPTS, 0),
      0,
      "the elevation attempt count should not change"
    );
  }
});

add_task(async function testHelperLostIsCountedAsCancellation() {
  await processElevatedFailure(ELEVATED_UPDATE_HELPER_LOST_ERROR);

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
