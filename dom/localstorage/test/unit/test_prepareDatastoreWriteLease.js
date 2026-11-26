/**
 * Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

const { QuotaUtils } = ChromeUtils.importESModule(
  "resource://testing-common/dom/quota/test/modules/QuotaUtils.sys.mjs"
);
const { isOriginDirty, waitForOriginToSettle: settleOrigin } =
  ChromeUtils.importESModule(
    "resource://testing-common/dom/quota/test/modules/StorageUtils.sys.mjs"
  );

add_task(async function ordinaryOpenAndRecovery() {
  await requestFinished(clear());
  const principal = getPrincipal("http://example.com");
  const keeper = getSimpleDatabase(principal, "default");
  await requestFinished(keeper.open("keeper"));
  Services.prefs.setIntPref(
    "dom.quotaManager.originWriteQuiescentThresholdMs",
    0
  );
  registerCleanupFunction(() =>
    Services.prefs.clearUserPref(
      "dom.quotaManager.originWriteQuiescentThresholdMs"
    )
  );

  let storage = getLocalStorage(principal);
  storage.setItem("key", "value");
  storage.close();
  await requestFinished(resetClient(principal));
  await settleOrigin(principal);
  ok(
    !(await isOriginDirty(principal)),
    "Origin settled with another client open"
  );
  await QuotaUtils.withArtificialFailures(
    Ci.nsIQuotaArtificialFailure.CATEGORY_FLAG_ORIGIN_INFO_AS_DIRTY,
    100,
    Cr.NS_ERROR_FAILURE,
    async () => {
      storage = getLocalStorage(principal);
      is(storage.getItem("key"), "value", "Ordinary open needs no write lease");
      ok(
        !(await isOriginDirty(principal)),
        "Ordinary read leaves the origin settled"
      );
      storage.close();
      await requestFinished(resetClient(principal));
    }
  );

  const directory = getRelativeFile(
    "storage/default/http+++example.com/ls"
  ).path;
  const database = PathUtils.join(directory, "data.sqlite");
  const usage = PathUtils.join(directory, "usage");
  await IOUtils.write(database, new TextEncoder().encode("corrupt database"));
  const databaseHash = await IOUtils.computeHexDigest(database, "sha256");
  const usageHash = await IOUtils.computeHexDigest(usage, "sha256");
  await settleOrigin(principal);
  await QuotaUtils.withArtificialFailures(
    Ci.nsIQuotaArtificialFailure.CATEGORY_FLAG_ORIGIN_INFO_AS_DIRTY,
    100,
    Cr.NS_ERROR_FAILURE,
    async () => {
      storage = getLocalStorage(principal);
      Assert.throws(
        () => storage.getItem("key"),
        /NS_ERROR_FAILURE/,
        "Recovery needs a lease"
      );
      storage.close();
      await requestFinished(resetClient(principal));
    }
  );
  is(
    await IOUtils.computeHexDigest(database, "sha256"),
    databaseHash,
    "Rejected recovery retained the database"
  );
  is(
    await IOUtils.computeHexDigest(usage, "sha256"),
    usageHash,
    "Rejected recovery retained the usage file"
  );
  storage = getLocalStorage(principal);
  is(storage.length, 0, "Recovery succeeds once a lease is available");
  storage.close();
  await requestFinished(resetClient(principal));
  await requestFinished(keeper.close());
});

add_task(async function migrationRetriesAfterLeaseFailure() {
  await requestFinished(clear());
  installPackage("migration_profile");
  const principal = getPrincipal("http://localhost");
  const keeper = getSimpleDatabase(principal, "default");
  await requestFinished(keeper.open("keeper"));
  await settleOrigin(principal);
  const storage = getLocalStorage(principal);
  await QuotaUtils.withArtificialFailures(
    Ci.nsIQuotaArtificialFailure.CATEGORY_FLAG_ORIGIN_INFO_AS_DIRTY,
    100,
    Cr.NS_ERROR_FAILURE,
    async () => {
      Assert.throws(
        () => storage.getItem("foo0"),
        /NS_ERROR_FAILURE/,
        "Migration cannot proceed without a lease"
      );
    }
  );
  storage.close();
  await requestFinished(resetClient(principal));
  const retry = getLocalStorage(principal);
  is(
    retry.getItem("foo0"),
    "bar0",
    "Legacy data survives and migration retries"
  );
  retry.close();
  await requestFinished(resetClient(principal));
  await requestFinished(keeper.close());
});
