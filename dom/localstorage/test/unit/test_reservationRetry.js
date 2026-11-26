/**
 * Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

const { QuotaUtils } = ChromeUtils.importESModule(
  "resource://testing-common/dom/quota/test/modules/QuotaUtils.sys.mjs"
);
const { waitForCondition: waitUntil } = ChromeUtils.importESModule(
  "resource://testing-common/dom/quota/test/modules/StorageUtils.sys.mjs"
);
const principal = getPrincipal("http://example.com");
const directory = "storage/default/http+++example.com/ls/";
// Journal polling can observe an attempt before it consumes the injected error.
// That may miss the retry path; the C++ tests exercise failed-batch merging
// deterministically, while these checks compare accounting with persisted data.
let journal;

add_setup(function () {
  journal = getRelativeFile(directory + "usage-journal");
});

async function cachedUsage() {
  return requestFinished(getCachedOriginUsage(principal));
}

async function checkDiskUsage(expected) {
  const connection = Services.storage.openDatabase(
    getRelativeFile(directory + "data.sqlite")
  );
  try {
    const statement = connection.createStatement(
      "SELECT usage, " +
        "(SELECT COALESCE(SUM(length(key) + utf16_length), 0) FROM data) " +
        "FROM database"
    );
    try {
      ok(statement.executeStep(), "Database has its usage row");
      is(
        statement.getInt64(0),
        expected,
        "SQLite's counter matches the commit"
      );
      is(statement.getInt64(1), expected, "Stored rows match the counter");
    } finally {
      statement.finalize();
    }
  } finally {
    connection.close();
  }
  is(
    await readUsageFromUsageFile(getRelativeFile(directory + "usage")),
    expected,
    "Usage file matches the committed rows"
  );
  is(await cachedUsage(), expected, "QuotaManager matches the committed rows");
}

add_task(async function retryWithoutNewWrites() {
  await requestFinished(clear());
  const storage = getLocalStorage(principal);
  const value = "x".repeat(99);
  await QuotaUtils.withArtificialFailures(
    Ci.nsIQuotaArtificialFailure.CATEGORY_LOCAL_STORAGE_FLUSH,
    100,
    Cr.NS_ERROR_FAILURE,
    async () => {
      storage.setItem("k", value);
      await waitUntil(
        () => journal.exists(),
        "The flush reached failure injection"
      );
      is(await cachedUsage(), 0, "Failed writes are reserved, not committed");
      is(storage.getItem("k"), value, "Acknowledged value remains available");
    }
  );

  await waitUntil(
    async () => !journal.exists() && (await cachedUsage()) === 100,
    "Pending writes are retried without another mutation or close"
  );
  storage.close();
  await requestFinished(resetClient(principal));
  await checkDiskUsage(100);
});

add_task(async function retryCoalescesWithNewerWrites() {
  await requestFinished(clear());
  const storage = getLocalStorage(principal);
  await QuotaUtils.withArtificialFailures(
    Ci.nsIQuotaArtificialFailure.CATEGORY_LOCAL_STORAGE_FLUSH_COMMIT,
    100,
    Cr.NS_ERROR_FAILURE,
    async () => {
      storage.setItem("k", "x".repeat(99));
      await waitUntil(() => journal.exists(), "The insertion failed to commit");
      storage.setItem("k", "y".repeat(79));
      await returnToEventLoop();
      is(await cachedUsage(), 0, "Neither version has committed");
    }
  );

  storage.close();
  await requestFinished(resetClient(principal));
  await checkDiskUsage(80);
  const reopened = getLocalStorage(principal);
  is(
    reopened.getItem("k"),
    "y".repeat(79),
    "Only the latest value is persisted"
  );
  reopened.close();
  await requestFinished(resetClient(principal));
});

add_task(async function cleanupFailureDoesNotReplayCommittedWrites() {
  await requestFinished(clear());
  const storage = getLocalStorage(principal);
  await QuotaUtils.withArtificialFailures(
    Ci.nsIQuotaArtificialFailure.CATEGORY_LOCAL_STORAGE_FLUSH_CLEANUP,
    100,
    Cr.NS_ERROR_FAILURE,
    async () => {
      storage.setItem("k", "first");
      await waitUntil(
        async () => (await cachedUsage()) === 6,
        "COMMIT is accounted for despite the cleanup error"
      );
      ok(journal.exists(), "Cleanup failed after COMMIT");
    }
  );

  storage.setItem("k", "replacement");
  storage.close();
  await requestFinished(resetClient(principal));
  await checkDiskUsage(12);
  await requestFinished(reset());
  is(
    (await requestFinished(getOriginUsage(principal))).usage,
    12,
    "Reloading persisted quota does not count the first transaction again"
  );
});
