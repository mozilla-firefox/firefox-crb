/**
 * Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

const { QuotaUtils } = ChromeUtils.importESModule(
  "resource://testing-common/dom/quota/test/modules/QuotaUtils.sys.mjs"
);
const StorageUtils = ChromeUtils.importESModule(
  "resource://testing-common/dom/quota/test/modules/StorageUtils.sys.mjs"
);

async function testSteps() {
  const principal = getPrincipal("https://clear.example.com");
  Services.prefs.setIntPref(
    "dom.quotaManager.originWriteQuiescentThresholdMs",
    0
  );
  registerCleanupFunction(() =>
    Services.prefs.clearUserPref(
      "dom.quotaManager.originWriteQuiescentThresholdMs"
    )
  );

  for (const persistence of ["default", null]) {
    await requestFinished(clear());
    for (const repository of ["default", "persistent"]) {
      const connection = getSimpleDatabase(principal, repository);
      await requestFinished(connection.open("data"));
      await requestFinished(connection.write(new Uint8Array(1024)));
      await requestFinished(connection.close());
    }
    await StorageUtils.waitForOriginToSettle(principal);
    ok(
      !(await StorageUtils.isOriginDirty(principal)),
      "Origin settled before clearing"
    );
    const usageBefore = await requestFinished(getCachedOriginUsage(principal));
    await QuotaUtils.withArtificialFailures(
      Ci.nsIQuotaArtificialFailure.CATEGORY_FLAG_ORIGIN_INFO_AS_DIRTY,
      100,
      Cr.NS_ERROR_FAILURE,
      async () => {
        await Assert.rejects(
          requestFinished(clearClient(principal, "sdb", persistence)),
          /NS_ERROR_FAILURE/,
          "Clear reports the lease failure"
        );
      }
    );
    ok(
      getRelativeFile("storage/default/https+++clear.example.com/sdb").exists(),
      "Failed clear retained the default data"
    );
    is(
      await requestFinished(getCachedOriginUsage(principal)),
      usageBefore,
      "Failed clear retained the usage"
    );
    is(
      getRelativeFile(
        "storage/permanent/https+++clear.example.com/sdb"
      ).exists(),
      persistence !== null,
      "Multi-repository clear still processes persistent storage"
    );
    await requestFinished(clearClient(principal, "sdb", persistence));
    ok(
      !getRelativeFile(
        "storage/default/https+++clear.example.com/sdb"
      ).exists(),
      "Retry removed the client directory"
    );
  }

  const persistPrincipal = getPrincipal("https://persist.example.com");
  for (const failMetadata of [false, true]) {
    await requestFinished(clear());
    await requestFinished(init());
    await requestFinished(initTemporaryStorage());
    await requestFinished(
      initTemporaryOrigin("default", persistPrincipal, false)
    );
    await QuotaUtils.withArtificialFailures(
      failMetadata
        ? Ci.nsIQuotaArtificialFailure.CATEGORY_CREATE_DIRECTORY_METADATA2
        : Ci.nsIQuotaArtificialFailure.CATEGORY_FLAG_ORIGIN_INFO_AS_DIRTY,
      100,
      Cr.NS_ERROR_FAILURE,
      async () => {
        if (failMetadata) {
          await Assert.rejects(
            requestFinished(persist(persistPrincipal)),
            /NS_ERROR_FAILURE/,
            "Metadata failure is returned"
          );
        } else {
          await requestFinished(persist(persistPrincipal));
        }
      }
    );
    const metadata = await requestFinished(
      getFullOriginMetadata("default", persistPrincipal)
    );
    is(
      metadata.persisted,
      !failMetadata,
      "Memory reflects the persisted metadata outcome"
    );
    if (!failMetadata) {
      ok(
        metadata.dirty,
        "The new persisted row is protected without a second write"
      );
    }
  }
}
