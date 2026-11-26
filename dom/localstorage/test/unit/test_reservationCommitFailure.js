/**
 * Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

const { QuotaUtils } = ChromeUtils.importESModule(
  "resource://testing-common/dom/quota/test/modules/QuotaUtils.sys.mjs"
);

add_task(async function testCommitOutcome() {
  const principal = getPrincipal("http://example.com");
  for (const seeded of [false, true]) {
    for (const [category, committed] of [
      [Ci.nsIQuotaArtificialFailure.CATEGORY_LOCAL_STORAGE_FLUSH_COMMIT, false],
      [Ci.nsIQuotaArtificialFailure.CATEGORY_LOCAL_STORAGE_FLUSH_CLEANUP, true],
    ]) {
      await requestFinished(clear());
      let storage = getLocalStorage(principal);
      if (seeded) {
        storage.setItem("saved", "value");
        storage.close();
        await requestFinished(resetClient(principal));
        storage = getLocalStorage(principal);
      }
      storage.setItem("key", "value");
      await QuotaUtils.withArtificialFailures(
        category,
        100,
        Cr.NS_ERROR_FAILURE,
        async () => {
          storage.close();
          await requestFinished(resetClient(principal));
        }
      );

      const expectedUsage =
        (seeded ? "saved".length + "value".length : 0) +
        (committed ? "key".length + "value".length : 0);
      is(
        await requestFinished(getCachedOriginUsage(principal)),
        expectedUsage,
        "Quota follows COMMIT, independently of cleanup success"
      );
      const reopened = getLocalStorage(principal);
      is(
        reopened.getItem("saved"),
        seeded ? "value" : null,
        "Previously committed data survives"
      );
      is(
        reopened.getItem("key"),
        committed ? "value" : null,
        "Stored data matches the accounted commit outcome"
      );
      reopened.close();
      await requestFinished(resetClient(principal));
      is(
        await requestFinished(getCachedOriginUsage(principal)),
        expectedUsage,
        "Reopening does not double count the committed data"
      );
    }
  }
  await requestFinished(reset());
});
