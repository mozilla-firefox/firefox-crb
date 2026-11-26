/**
 * Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

const { QuotaUtils } = ChromeUtils.importESModule(
  "resource://testing-common/dom/quota/test/modules/QuotaUtils.sys.mjs"
);
const { waitForOriginToSettle } = ChromeUtils.importESModule(
  "resource://testing-common/dom/quota/test/modules/StorageUtils.sys.mjs"
);

add_task(async function testSteps() {
  const principalA = getPrincipal("http://example.com");
  const principalB = getPrincipal("http://example.org");
  const pendingKey = "pending";
  const pendingValue = repeatChar(2 * 1024 * 1024 - pendingKey.length, ".");
  const largeKey = "large";
  const largeValue = repeatChar(3.5 * 1024 * 1024 - largeKey.length, ".");
  const quiescentPref = "dom.quotaManager.originWriteQuiescentThresholdMs";

  setGlobalLimit(5 * 1024);
  Services.prefs.setBoolPref("dom.storage.snapshot_reusing", false);
  Services.prefs.setIntPref(quiescentPref, 100);
  registerCleanupFunction(() => {
    resetGlobalLimit();
    Services.prefs.clearUserPref("dom.storage.snapshot_reusing");
    Services.prefs.clearUserPref(quiescentPref);
  });

  for (const category of [
    Ci.nsIQuotaArtificialFailure.CATEGORY_FLAG_ORIGIN_INFO_AS_DIRTY,
    Ci.nsIQuotaArtificialFailure.CATEGORY_ACQUIRE_WRITE_LEASE_DISPATCH,
  ]) {
    for (const existingDatabase of [false, true]) {
      info(`Lease failure ${category}, existing database: ${existingDatabase}`);

      await requestFinished(clear());
      await requestFinished(initStorage());
      await requestFinished(initTemporaryStorage());
      await requestFinished(initTemporaryOrigin("default", principalA));

      const storage = getLocalStorage(principalA);
      if (existingDatabase) {
        storage.setItem("saved", "value");
      } else {
        is(storage.getItem("saved"), null, "No database yet");
      }
      await requestFinished(resetClient(principalA));

      let storageA = getLocalStorage(principalA);
      const storageB = getLocalStorage(principalB);
      storageA.setItem(pendingKey, pendingValue);
      is(
        storageA.getItem(pendingKey).length,
        pendingValue.length,
        "Write acknowledged"
      );

      await returnToEventLoop();

      Assert.throws(
        () => storageB.setItem(largeKey, largeValue),
        /QuotaExceededError/,
        "Pending writes reserve space against the global limit"
      );

      await waitForOriginToSettle(principalA);

      await QuotaUtils.withArtificialFailures(
        category,
        100,
        Cr.NS_ERROR_FAILURE,
        async () => {
          storageA.close();
          await requestFinished(resetClient(principalA));
        }
      );

      const committedUsage = existingDatabase
        ? "saved".length + "value".length
        : 0;
      is(
        await requestFinished(getCachedOriginUsage(principalA)),
        committedUsage,
        "Abandoned writes do not change committed usage"
      );

      storageA = getLocalStorage(principalA);
      is(
        storageA.getItem(pendingKey),
        null,
        "Abandoned write was not persisted"
      );
      is(
        storageA.getItem("saved"),
        existingDatabase ? "value" : null,
        "Previously committed data is preserved"
      );

      storageB.setItem(largeKey, largeValue);
      is(
        storageB.getItem(largeKey).length,
        largeValue.length,
        "Closing released the abandoned reservation"
      );
      await requestFinished(resetClient(principalB));
      is(
        await requestFinished(getCachedOriginUsage(principalB)),
        largeKey.length + largeValue.length,
        "The other origin can commit its allocation"
      );
    }
  }

  await requestFinished(clear());
});
