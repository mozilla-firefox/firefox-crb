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
const { isOriginDirty, waitForOriginToSettle } = ChromeUtils.importESModule(
  "resource://testing-common/dom/quota/test/modules/StorageUtils.sys.mjs"
);
const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

add_task(
  { pref_set: [["dom.cache.databaseInitialization.pauseOnIOThreadMs", 2000]] },
  async function test_closeDuringInitialization() {
    const principal = PrincipalUtils.createPrincipal(
      "https://init.example.com"
    );
    const sandbox = new Cu.Sandbox(principal, {
      wantGlobalProperties: ["caches"],
    });
    const databaseWorkStarted = TestUtils.topicObserved(
      "CacheAPI::DatabaseWorkStarted"
    );
    Cu.evalInSandbox('caches.open("close").catch(() => {});', sandbox);
    await databaseWorkStarted;

    Cu.nukeSandbox(sandbox);
    await requestFinished(reset());

    const reopenedSandbox = new Cu.Sandbox(principal, {
      wantGlobalProperties: ["caches"],
    });
    registerCleanupFunction(() => Cu.nukeSandbox(reopenedSandbox));
    const cache = await Cu.evalInSandbox(
      'caches.open("close")',
      reopenedSandbox
    );
    Assert.ok(cache, "Cache reopens after closing during initialization");
    await requestFinished(reset());
  }
);

add_task(
  { pref_set: [["dom.quotaManager.originWriteQuiescentThresholdMs", 100]] },
  async function test_closeWriteLease() {
    for (const [category, settled] of [
      [Ci.nsIQuotaArtificialFailure.CATEGORY_NONE, false],
      [Ci.nsIQuotaArtificialFailure.CATEGORY_NONE, true],
      [Ci.nsIQuotaArtificialFailure.CATEGORY_FLAG_ORIGIN_INFO_AS_DIRTY, true],
      [
        Ci.nsIQuotaArtificialFailure.CATEGORY_ACQUIRE_WRITE_LEASE_DISPATCH,
        true,
      ],
    ]) {
      Services.prefs.setIntPref(
        "dom.quotaManager.originWriteQuiescentThresholdMs",
        settled ? 100 : 60000
      );
      const host = `close${category}-${settled}.example.com`;
      const principal = PrincipalUtils.createPrincipal(`https://${host}`);
      const sandbox = new Cu.Sandbox(principal, {
        wantGlobalProperties: ["caches", "fetch"],
      });
      registerCleanupFunction(() => Cu.nukeSandbox(sandbox));
      const cache = await Cu.evalInSandbox('caches.open("close")', sandbox);
      const response = Cu.evalInSandbox(
        'new Response("retained data")',
        sandbox
      );
      await cache.put("https://example.com/data", response);

      if (settled) {
        await waitForOriginToSettle(principal);
        ok(!(await isOriginDirty(principal)), "Origin settled before close");
      } else {
        ok(await isOriginDirty(principal), "Origin is dirty for the fast path");
      }

      const databaseFile = PathUtils.join(
        PathUtils.profileDir,
        "storage",
        "default",
        `https+++${host}`,
        "cache",
        "caches.sqlite"
      );
      const walFile = `${databaseFile}-wal`;
      const databaseBefore = await IOUtils.computeHexDigest(
        databaseFile,
        "sha256"
      );
      const walBefore = await IOUtils.computeHexDigest(walFile, "sha256");
      Assert.greater(
        (await IOUtils.stat(walFile)).size,
        32,
        "WAL contains committed frames"
      );

      await QuotaUtils.withArtificialFailures(
        category,
        100,
        Cr.NS_ERROR_FAILURE,
        async () => requestFinished(reset())
      );

      if (category != Ci.nsIQuotaArtificialFailure.CATEGORY_NONE) {
        Assert.equal(
          await IOUtils.computeHexDigest(databaseFile, "sha256"),
          databaseBefore,
          "Rejected lease skips vacuum and checkpoint"
        );
        Assert.equal(
          await IOUtils.computeHexDigest(walFile, "sha256"),
          walBefore,
          "Rejected lease preserves the WAL"
        );
      } else {
        Assert.equal(
          (await IOUtils.stat(walFile)).size,
          0,
          "Successful close truncates the WAL"
        );
        Assert.notEqual(
          await IOUtils.computeHexDigest(databaseFile, "sha256"),
          databaseBefore,
          "Successful lease allows the close checkpoint"
        );
      }

      const reopened = await Cu.evalInSandbox('caches.open("close")', sandbox);
      const saved = await reopened.match("https://example.com/data");
      Assert.equal(
        await saved.text(),
        "retained data",
        "Data survives closing and reopening"
      );
      await requestFinished(reset());
    }
  }
);
