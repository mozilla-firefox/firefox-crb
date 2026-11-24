/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { ExperimentAPI } = ChromeUtils.importESModule(
  "resource://nimbus/ExperimentAPI.sys.mjs"
);
const { NimbusTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/NimbusTestUtils.sys.mjs"
);

const PREF_UPDATE_AT_STARTUP =
  "extensions.langpacks.updateAtStartup.featureGate";

NimbusTestUtils.init(this);

add_setup(async function () {
  const { cleanup } = await NimbusTestUtils.setupTest();
  await ExperimentAPI.ready();

  registerCleanupFunction(async () => {
    await cleanup();
    Services.prefs.clearUserPref(PREF_UPDATE_AT_STARTUP);
  });
});

add_task(async function test_enrollment_sets_and_restores_pref() {
  Assert.ok(
    Services.prefs.getBoolPref(PREF_UPDATE_AT_STARTUP),
    "The feature is on by default"
  );

  let doCleanup = await NimbusTestUtils.enrollWithFeatureConfig({
    featureId: "langpackUpdateAtStartup",
    value: { enabled: false },
  });

  Assert.ok(
    !Services.prefs.getBoolPref(PREF_UPDATE_AT_STARTUP),
    "The enrollment turns the feature off"
  );

  await doCleanup();

  Assert.ok(
    !Services.prefs.prefHasUserValue(PREF_UPDATE_AT_STARTUP),
    "Unenrolling clears the user value"
  );
  Assert.ok(
    Services.prefs.getBoolPref(PREF_UPDATE_AT_STARTUP),
    "Unenrolling restores the default"
  );
});
