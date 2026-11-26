/**
 * Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

const { PrincipalUtils } = ChromeUtils.importESModule(
  "resource://testing-common/dom/quota/test/modules/PrincipalUtils.sys.mjs"
);
const { QuotaUtils } = ChromeUtils.importESModule(
  "resource://testing-common/dom/quota/test/modules/QuotaUtils.sys.mjs"
);
const { flushDirtyOriginInfos, isOriginDirty, waitForOriginToSettle } =
  ChromeUtils.importESModule(
    "resource://testing-common/dom/quota/test/modules/StorageUtils.sys.mjs"
  );

/**
 * IndexedDB maintenance vacuums databases from a maintenance thread, so it
 * holds a quota write lease on every origin it processes. The lease records
 * the dirty flag and is balanced, so the origin settles once maintenance is
 * done. An origin that has not been accessed since its last maintenance is
 * skipped and takes no lease.
 */

const kQuiescentThresholdPref =
  "dom.quotaManager.originWriteQuiescentThresholdMs";
const kAccessTimeOffsetPref =
  "dom.quotaManager.temporaryStorage.initialOriginAccessTimeOffsetSec";

function requestSucceeded(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = event => resolve(event.target.result);
    request.onerror = event => reject(event.target.error);
  });
}

// Wait for the origin to settle, including any asynchronous close or maintenance.
async function settle(principal) {
  await waitForOriginToSettle(principal);
}

/* exported testSteps */
async function testSteps() {
  const principal = PrincipalUtils.createPrincipal("https://example.com");
  const name = "test_maintenance_writeLease.js";
  const storeName = "store";

  Services.prefs.setIntPref(kQuiescentThresholdPref, 100);
  registerCleanupFunction(() => {
    Services.prefs.clearUserPref(kQuiescentThresholdPref);
    Services.prefs.clearUserPref(kAccessTimeOffsetPref);
  });

  info("Creating a database with some space to reclaim");

  // A new origin gets today as its last maintenance date and maintenance
  // skips origins not accessed since then, so backdate the creation; closing
  // the database then records a newer access time.
  Services.prefs.setIntPref(kAccessTimeOffsetPref, 2 * 24 * 60 * 60);

  for (let i = 0; i < 3; ++i) {
    const openRequest = indexedDB.openForPrincipal(
      principal,
      `${name}-${i}`,
      1
    );
    openRequest.onupgradeneeded = event => {
      const store = event.target.result.createObjectStore(storeName);
      for (let i = 0; i < 100; i++) {
        store.add("abcdefghijklmnopqrstuvwxyz0123456789", i);
      }
      store.clear();
    };
    const db = await requestSucceeded(openRequest);
    db.close();
  }

  Services.prefs.clearUserPref(kAccessTimeOffsetPref);

  await settle(principal);

  const indexedDatabaseManager = Cc[
    "@mozilla.org/dom/indexeddb/manager;1"
  ].getService(Ci.nsIIndexedDatabaseManager);

  info("An error after acquiring the preparation lease releases it");

  await QuotaUtils.withArtificialFailures(
    Ci.nsIQuotaArtificialFailure.CATEGORY_CREATE_DIRECTORY_METADATA2,
    100,
    Cr.NS_ERROR_FAILURE,
    async () => {
      let rejected = false;
      try {
        await indexedDatabaseManager.doMaintenance();
      } catch (error) {
        rejected = true;
      }
      ok(rejected, "Metadata failure terminates maintenance");
    }
  );
  await settle(principal);

  info("Maintenance without a lease leaves the database files unchanged");

  const directory = PathUtils.join(
    PathUtils.profileDir,
    "storage",
    "default",
    "https+++example.com",
    "idb"
  );
  const files = (await IOUtils.getChildren(directory)).filter(path =>
    /\.sqlite(?:-wal)?$/.test(path)
  );
  is(
    files.filter(path => path.endsWith(".sqlite")).length,
    3,
    "Three databases"
  );
  const hashes = await Promise.all(
    files.map(path => IOUtils.computeHexDigest(path, "sha256"))
  );

  await QuotaUtils.withArtificialFailures(
    Ci.nsIQuotaArtificialFailure.CATEGORY_FLAG_ORIGIN_INFO_AS_DIRTY,
    100,
    Cr.NS_ERROR_FAILURE,
    async () => {
      await indexedDatabaseManager.doMaintenance();
      ok(
        !(await isOriginDirty(principal)),
        "Rejected lease leaves origin settled"
      );
      for (let i = 0; i < files.length; ++i) {
        is(
          await IOUtils.computeHexDigest(files[i], "sha256"),
          hashes[i],
          "Skipped maintenance neither vacuums nor checkpoints"
        );
      }
    }
  );

  info("Retrying maintenance acquires and releases all database leases");

  await indexedDatabaseManager.doMaintenance();

  ok(await isOriginDirty(principal), "Maintenance recorded the dirty flag");

  for (const databaseFile of files.filter(path => path.endsWith(".sqlite"))) {
    const walFile = `${databaseFile}-wal`;
    if (await IOUtils.exists(walFile)) {
      is(
        (await IOUtils.stat(walFile)).size,
        0,
        "Maintenance truncated the WAL"
      );
    }
  }

  await settle(principal);

  info("Running maintenance again the same day skips the origin");

  await indexedDatabaseManager.doMaintenance();

  await flushDirtyOriginInfos();
  ok(!(await isOriginDirty(principal)), "Origin still settled");

  const request = Services.qms.reset();
  await requestFinished(request);
}
