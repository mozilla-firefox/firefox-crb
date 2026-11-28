/**
 * Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

const SEC_PER_MONTH = 60 * 60 * 24 * 30;

async function testUnaccessedOrigins() {
  function getHostname(index) {
    return "www.example" + index + ".com";
  }

  function getOrigin(index) {
    return "https://" + getHostname(index);
  }

  function getOriginDir(index) {
    return getRelativeFile("storage/default/https+++" + getHostname(index));
  }

  // Access times accumulate as a maximum, so an origin only looks unaccessed
  // when it is old by every available measure. Age the stored row as well as
  // the directory the recovery scan derives its timestamp from.
  function updateOriginLastAccessTime(index, deltaSec) {
    let dbFile = getRelativeFile("storage.sqlite");
    let conn = Services.storage.openUnsharedDatabase(dbFile);

    let stmt = conn.createStatement(
      "UPDATE origin SET last_access_time = last_access_time + :delta " +
        "WHERE origin = :origin"
    );
    stmt.params.delta = deltaSec * PR_USEC_PER_SEC;
    stmt.params.origin = getOrigin(index);
    stmt.executeStep();
    stmt.finalize();

    conn.close();

    let originDir = getOriginDir(index);
    originDir.lastModifiedTime = originDir.lastModifiedTime + deltaSec * 1000;
  }

  function verifyOriginDir(index, shouldExist) {
    let originDir = getOriginDir(index);
    let exists = originDir.exists();
    if (shouldExist) {
      ok(exists, "Origin directory does exist");
    } else {
      ok(!exists, "Origin directory doesn't exist");
    }
  }

  info("Setting prefs");

  Services.prefs.setBoolPref("dom.quotaManager.loadQuotaFromCache", false);
  Services.prefs.setBoolPref("dom.quotaManager.checkQuotaInfoLoadTime", true);
  Services.prefs.setIntPref(
    "dom.quotaManager.longQuotaInfoLoadTimeThresholdMs",
    0
  );

  info("Initializing");

  request = init();
  await requestFinished(request);

  info("Initializing temporary storage");

  request = initTemporaryStorage();
  await requestFinished(request);

  info("Initializing origins");

  for (let index = 0; index < 30; index++) {
    request = initTemporaryOrigin(
      "default",
      getPrincipal(getOrigin(index)),
      /* createIfNonExistent */ true
    );
    await requestFinished(request);
  }

  info("Resetting");

  request = reset();
  await requestFinished(request);

  info("Updating last access time of selected origins");

  for (let index = 0; index < 10; index++) {
    updateOriginLastAccessTime(index, -14 * SEC_PER_MONTH);
  }

  for (let index = 10; index < 20; index++) {
    updateOriginLastAccessTime(index, -7 * SEC_PER_MONTH);
  }

  info("Setting pref");

  Services.prefs.setIntPref(
    "dom.quotaManager.unaccessedForLongTimeThresholdSec",
    13 * SEC_PER_MONTH
  );

  info("Initializing");

  request = init();
  await requestFinished(request);

  info("Initializing temporary storage");

  request = initTemporaryStorage();
  await requestFinished(request);

  info("Verifying origin directories");

  for (let index = 0; index < 10; index++) {
    verifyOriginDir(index, false);
  }
  for (let index = 10; index < 30; index++) {
    verifyOriginDir(index, true);
  }

  info("Resetting");

  request = reset();
  await requestFinished(request);

  info("Setting pref");

  Services.prefs.setIntPref(
    "dom.quotaManager.unaccessedForLongTimeThresholdSec",
    6 * SEC_PER_MONTH
  );

  info("Initializing");

  request = init();
  await requestFinished(request);

  info("Initializing temporary storage");

  request = initTemporaryStorage();
  await requestFinished(request);

  info("Verifying origin directories");

  for (let index = 0; index < 20; index++) {
    verifyOriginDir(index, false);
  }
  for (let index = 20; index < 30; index++) {
    verifyOriginDir(index, true);
  }

  info("Resetting");

  request = reset();
  await requestFinished(request);
}

async function testSteps() {
  add_task(
    {
      pref_set: [
        [
          "dom.quotaManager.temporaryStorage.clearNonPersistedZeroUsageOrigins",
          false,
        ],
      ],
    },
    testUnaccessedOrigins
  );
}
