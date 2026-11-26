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
const { isOriginDirty, waitForCondition, waitForOriginToSettle } =
  ChromeUtils.importESModule(
    "resource://testing-common/dom/quota/test/modules/StorageUtils.sys.mjs"
  );

function requestSucceeded(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error);
  });
}

/* exported testSteps */
async function testSteps() {
  const quiescentPref = "dom.quotaManager.originWriteQuiescentThresholdMs";
  const pausePref = "dom.quotaManager.originOperations.pauseOnIOThreadMs";
  Services.prefs.setIntPref(quiescentPref, 100);
  registerCleanupFunction(() => {
    Services.prefs.clearUserPref(quiescentPref);
    Services.prefs.clearUserPref(pausePref);
  });

  for (const category of [
    Ci.nsIQuotaArtificialFailure.CATEGORY_FLAG_ORIGIN_INFO_AS_DIRTY,
    Ci.nsIQuotaArtificialFailure.CATEGORY_ACQUIRE_WRITE_LEASE_DISPATCH,
  ]) {
    const principal = PrincipalUtils.createPrincipal(
      `https://idle${category}.example.com`
    );
    const open = indexedDB.openForPrincipal(principal, "idle-maintenance", 1);
    open.onupgradeneeded = () => {
      const store = open.result.createObjectStore("store");
      for (let i = 0; i < 1000; ++i) {
        store.put("data to reclaim".repeat(20), i);
      }
      store.clear();
      store.put("retained", "value");
    };
    const db = await requestSucceeded(open);

    await waitForOriginToSettle(principal);

    const directory = PathUtils.join(
      PathUtils.profileDir,
      "storage",
      "default",
      `https+++idle${category}.example.com`,
      "idb"
    );
    const files = await IOUtils.getChildren(directory);
    const databaseFile = files.find(path => path.endsWith(".sqlite"));
    ok(databaseFile, "Database file exists");
    const walFile = `${databaseFile}-wal`;
    Assert.greater(
      (await IOUtils.stat(walFile)).size,
      32,
      "WAL has committed frames"
    );
    const databaseHash = await IOUtils.computeHexDigest(databaseFile, "sha256");
    const walHash = await IOUtils.computeHexDigest(walFile, "sha256");

    await QuotaUtils.withArtificialFailures(
      category,
      100,
      Cr.NS_ERROR_FAILURE,
      async () => {
        let maintenanceStarted = false;
        const observer = () => {
          maintenanceStarted = true;
        };
        Services.obs.addObserver(observer, "IndexedDB::IdleMaintenanceStarted");
        registerCleanupFunction(() =>
          Services.obs.removeObserver(
            observer,
            "IndexedDB::IdleMaintenanceStarted"
          )
        );
        Services.prefs.setIntPref(pausePref, 5000);
        const pausedIO = requestFinished(
          Services.qms.getFullOriginMetadata("default", principal)
        );

        // Wait for the idle timer to fire rather than guessing when it ran.
        await waitForCondition(
          () => maintenanceStarted,
          "idle maintenance to start"
        );
        const transaction = db.transaction("store", "readonly");
        const done = transactionDone(transaction);
        const value = requestSucceeded(
          transaction.objectStore("store").get("value")
        );

        await pausedIO;
        Services.prefs.clearUserPref(pausePref);
        is(
          await value,
          "retained",
          "A transaction arriving during close succeeds"
        );
        await done;

        is(
          await IOUtils.computeHexDigest(databaseFile, "sha256"),
          databaseHash,
          "Idle maintenance without a lease does not vacuum or checkpoint"
        );
        is(
          await IOUtils.computeHexDigest(walFile, "sha256"),
          walHash,
          "Closing without a lease preserves the WAL"
        );
        ok(
          !(await isOriginDirty(principal)),
          "No unprotected maintenance writes"
        );
      }
    );

    const transaction = db.transaction("store", "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore("store").put("new value", "value");
    await done;
    db.close();
    await requestFinished(Services.qms.reset());
  }
}
