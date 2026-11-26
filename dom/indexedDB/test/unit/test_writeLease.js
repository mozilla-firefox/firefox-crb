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
 * IndexedDB write transactions take a quota write lease before their first
 * operation is dispatched, so the origin is marked dirty before the transaction
 * writes and an idle open database does not keep the origin from settling.
 */

const kQuiescentThresholdPref =
  "dom.quotaManager.originWriteQuiescentThresholdMs";
const kPauseOnIOThreadPref =
  "dom.quotaManager.originOperations.pauseOnIOThreadMs";

// Resolve with the request result, or reject with its IndexedDB error.
function requestSucceeded(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = event => resolve(event.target.result);
    request.onerror = event => reject(event.target.error);
  });
}

// Observe the final transaction outcome, including expected aborts.
function transactionDone(transaction) {
  return new Promise(resolve => {
    transaction.oncomplete = () => resolve("complete");
    transaction.onabort = () => resolve("abort");
    // Request errors (e.g. AbortError after abort()) bubble here; the outcome
    // is reported through the abort/complete events.
    transaction.onerror = event => event.preventDefault();
  });
}

// Keep a readonly transaction alive by issuing another request on each success.
// The callback receives a stop function; finally also stops it on failure.
async function withActiveReader(database, storeName, callback) {
  const transaction = database.transaction(storeName, "readonly");
  const done = transactionDone(transaction);
  const store = transaction.objectStore(storeName);
  let reading = true;
  function read() {
    store.get("value").onsuccess = () => {
      if (reading) {
        read();
      }
    };
  }
  read();
  const stop = () => {
    reading = false;
    return done;
  };
  try {
    return await callback(stop);
  } finally {
    is(await stop(), "complete", "Keeper reader completed");
  }
}

// Wait for the origin to settle, including any asynchronous close or maintenance.
async function settle(principal) {
  await waitForOriginToSettle(principal);
}

/* exported testSteps */
async function testSteps() {
  const principal = PrincipalUtils.createPrincipal("https://example.com");
  const name = "test_writeLease.js";
  const storeName = "store";

  Services.prefs.setIntPref(kQuiescentThresholdPref, 100);
  registerCleanupFunction(() => {
    Services.prefs.clearUserPref(kQuiescentThresholdPref);
    Services.prefs.clearUserPref(kPauseOnIOThreadPref);
  });

  // First, we will check that creating a database records the dirty flag.
  info("Stage 1 - Opening a database records the dirty flag");

  const openRequest = indexedDB.openForPrincipal(principal, name, 1);
  openRequest.onupgradeneeded = event => {
    event.target.result.createObjectStore(storeName);
    event.target.result.createObjectStore("independent");
  };
  const db = await requestSucceeded(openRequest);

  ok(await isOriginDirty(principal), "Origin dirty after version change");

  // Next, we will check that an open database can settle while it is idle.
  info("Stage 2 - An idle open database does not pin the origin dirty");

  await settle(principal);

  // Next, we will check that reading a settled origin leaves it clean.
  info("Stage 3 - A readonly transaction does not dirty a settled origin");

  {
    const transaction = db.transaction(storeName, "readonly");
    const value = await requestSucceeded(
      transaction.objectStore(storeName).get("missing")
    );
    is(value, undefined, "Nothing stored yet");
    is(await transactionDone(transaction), "complete", "Transaction done");
  }

  await flushDirtyOriginInfos();
  ok(!(await isOriginDirty(principal)), "Origin still settled after read");

  // Next, we will check that a write records the dirty flag again.
  info("Stage 4 - A readwrite transaction records the flag again");

  {
    const transaction = db.transaction(storeName, "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(storeName).put("a", "a");
    is(await done, "complete", "Transaction done");
  }

  ok(await isOriginDirty(principal), "Origin dirty after write");

  await settle(principal);

  // Next, we will delay lease acquisition and check request and transaction ordering.
  info("Stage 5 - Requests issued before the lease resolves run in order");

  // Occupying the quota IO thread with a paused origin operation delays the
  // lease; the requests must queue behind the transaction start.
  Services.prefs.setIntPref(kPauseOnIOThreadPref, 500);
  const pauseRequest = Services.qms.getFullOriginMetadata("default", principal);
  const pausePromise = requestFinished(pauseRequest);

  {
    const transaction = db.transaction(storeName, "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(storeName);
    store.put("b1", "b");
    store.put("b2", "b");
    const getRequest = store.get("b");
    store.put("b3", "b");

    const independent = db.transaction("independent", "readwrite");
    const independentDone = transactionDone(independent);
    independent.objectStore("independent").put("independent", "value");

    const dependent = db.transaction(storeName, "readwrite");
    const dependentDone = transactionDone(dependent);
    const dependentRequest = dependent.objectStore(storeName).get("b");
    const dependentValue = requestSucceeded(dependentRequest);
    dependent.objectStore(storeName).put("b4", "b");

    const readonly = db.transaction(storeName, "readonly");
    const readonlyDone = transactionDone(readonly);
    const readonlyValue = requestSucceeded(
      readonly.objectStore(storeName).get("b")
    );

    is(await requestSucceeded(getRequest), "b2", "Requests ran in order");
    is(await done, "complete", "Transaction done");
    is(await independentDone, "complete", "Independent writer completed");
    is(await dependentValue, "b3", "Dependent writer sees preceding writes");
    is(await dependentDone, "complete", "Dependent writer completed");
    is(await readonlyValue, "b4", "Dependent reader sees the last writer");
    is(await readonlyDone, "complete", "Readonly transaction completed");
  }

  await pausePromise;
  Services.prefs.clearUserPref(kPauseOnIOThreadPref);

  await settle(principal);

  // Next, we will abort a queued transaction and check that its lease is released.
  info("Stage 6 - Aborting before the transaction runs releases the lease");

  Services.prefs.setIntPref(kPauseOnIOThreadPref, 500);
  const abortPause = requestFinished(
    Services.qms.getFullOriginMetadata("default", principal)
  );

  {
    const transaction = db.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put("c", "c");
    transaction.abort();
    is(await transactionDone(transaction), "abort", "Transaction aborted");
  }

  await abortPause;
  Services.prefs.clearUserPref(kPauseOnIOThreadPref);
  await settle(principal);

  // Next, we will reject lease acquisition and check that queued writers abort
  // without changing either the database or its WAL.
  info("Stage 7 - A write transaction whose lease is rejected is aborted");

  const directory = PathUtils.join(
    PathUtils.profileDir,
    "storage",
    "default",
    "https+++example.com",
    "idb"
  );
  const files = await IOUtils.getChildren(directory);
  const databaseFile = files.find(path => path.endsWith(".sqlite"));
  ok(databaseFile, "Database file exists");
  const walFile = `${databaseFile}-wal`;
  const databaseBefore = await IOUtils.computeHexDigest(databaseFile, "sha256");
  const walBefore = await IOUtils.computeHexDigest(walFile, "sha256");

  for (const category of [
    Ci.nsIQuotaArtificialFailure.CATEGORY_FLAG_ORIGIN_INFO_AS_DIRTY,
    Ci.nsIQuotaArtificialFailure.CATEGORY_ACQUIRE_WRITE_LEASE_DISPATCH,
  ]) {
    await QuotaUtils.withArtificialFailures(
      category,
      100,
      Cr.NS_ERROR_FAILURE,
      async function () {
        const completions = [];
        for (const scope of [storeName, "independent", storeName]) {
          const transaction = db.transaction(scope, "readwrite");
          completions.push(transactionDone(transaction));
          for (let i = 0; i < 8; ++i) {
            const put = transaction.objectStore(scope).put("d", `d${i}`);
            put.onsuccess = () =>
              ok(false, "A rejected lease must not run puts");
          }
        }
        for (const completion of completions) {
          is(await completion, "abort", "Queued writer aborted");
        }
      }
    );
    is(
      await IOUtils.computeHexDigest(databaseFile, "sha256"),
      databaseBefore,
      "Rejected transactions leave the database unchanged"
    );
    is(
      await IOUtils.computeHexDigest(walFile, "sha256"),
      walBefore,
      "Rejected transactions leave the WAL unchanged"
    );
  }

  {
    const transaction = db.transaction(storeName, "readonly");
    is(
      await requestSucceeded(transaction.objectStore(storeName).get("d0")),
      undefined,
      "Nothing was written without the lease"
    );
  }

  ok(!(await isOriginDirty(principal)), "Origin still settled");

  {
    const transaction = db.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put("d", "d");
    is(await transactionDone(transaction), "complete", "Writes work again");
  }

  await settle(principal);

  db.close();

  const request = Services.qms.reset();
  await requestFinished(request);

  // Next, we will check that closing after a rejected writer does not checkpoint.
  info("A rejected writer does not cause a checkpoint on close");

  // Keep the origin lock alive across physical IDB closure so the last-lock
  // access-time update cannot hide an unnecessary close checkpoint.
  const sdbKeeper = Cc["@mozilla.org/dom/sdb-connection;1"].createInstance(
    Ci.nsISDBConnection
  );
  sdbKeeper.init(principal, "default");
  await requestFinished(sdbKeeper.open("sdbKeeper"));
  const reopened = await requestSucceeded(
    indexedDB.openForPrincipal(principal, name, 1)
  );
  await settle(principal);

  await QuotaUtils.withArtificialFailures(
    Ci.nsIQuotaArtificialFailure.CATEGORY_FLAG_ORIGIN_INFO_AS_DIRTY,
    100,
    Cr.NS_ERROR_FAILURE,
    async () => {
      const transaction = reopened.transaction(storeName, "readwrite");
      const done = transactionDone(transaction);
      transaction.objectStore(storeName).put("rejected", "rejected");
      is(await done, "abort", "Writer rejected without a lease");
    }
  );
  reopened.close();
  await requestFinished(Services.qms.resetStoragesForClient(principal, "idb"));
  ok(
    !(await isOriginDirty(principal)),
    "Closing after a rejected writer leaves the origin settled"
  );
  await requestFinished(sdbKeeper.close());

  // Next, we will reject the close lease and check that committed WAL data is
  // preserved, can be reopened, and is reclaimed by a later successful close.
  for (const category of [
    Ci.nsIQuotaArtificialFailure.CATEGORY_FLAG_ORIGIN_INFO_AS_DIRTY,
    Ci.nsIQuotaArtificialFailure.CATEGORY_ACQUIRE_WRITE_LEASE_DISPATCH,
  ]) {
    info(`Closing with failed lease acquisition: ${category}`);
    const closePrincipal = PrincipalUtils.createPrincipal(
      `https://close${category}.example.com`
    );
    const open = indexedDB.openForPrincipal(closePrincipal, name, 1);
    open.onupgradeneeded = event => {
      event.target.result.createObjectStore(storeName);
    };
    const closeDB = await requestSucceeded(open);
    const value = "retained WAL data";
    const transaction = closeDB.transaction(storeName, "readwrite");
    const committed = transactionDone(transaction);
    transaction.objectStore(storeName).put(value, "value");

    const directory = PathUtils.join(
      PathUtils.profileDir,
      "storage",
      "default",
      `https+++close${category}.example.com`,
      "idb"
    );
    // Idle maintenance can truncate the WAL while we wait for the origin to
    // settle, and has no disabling pref. Queue a reader behind the writer before
    // yielding: it prevents idle maintenance/closure without holding a write
    // lease. Stop it only after failure injection is active, so closing cannot
    // checkpoint successfully even if the test is delayed.
    const { databaseFile, walFile, databaseBefore, walBefore } =
      await withActiveReader(closeDB, storeName, async stopReader => {
        is(await committed, "complete", "Data committed");
        await settle(closePrincipal);

        const files = await IOUtils.getChildren(directory);
        const databaseFile = files.find(path => path.endsWith(".sqlite"));
        ok(databaseFile, "Database file exists");
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
          async () => {
            closeDB.close();
            await stopReader();
            await requestFinished(Services.qms.reset());
          }
        );
        return { databaseFile, walFile, databaseBefore, walBefore };
      });

    if (
      category ===
      Ci.nsIQuotaArtificialFailure.CATEGORY_FLAG_ORIGIN_INFO_AS_DIRTY
    ) {
      info("Initialization rejects before touching the WAL without a lease");
      // Keep the origin open so failure injection targets checkpointing rather
      // than the access-time update for the first directory lock.
      const keeper = await requestSucceeded(
        indexedDB.openForPrincipal(closePrincipal, name + "-keeper", 1)
      );
      await settle(closePrincipal);
      await QuotaUtils.withArtificialFailures(
        category,
        100,
        Cr.NS_ERROR_FAILURE,
        async () => {
          await Assert.rejects(
            requestSucceeded(
              indexedDB.openForPrincipal(closePrincipal, name, 1)
            ),
            /UnknownError/,
            "Initialization cannot write without a lease"
          );
        }
      );
      keeper.close();
      await requestFinished(Services.qms.reset());
    }

    Assert.equal(
      await IOUtils.computeHexDigest(databaseFile, "sha256"),
      databaseBefore,
      "Closing without a lease does not checkpoint the database"
    );
    Assert.equal(
      await IOUtils.computeHexDigest(walFile, "sha256"),
      walBefore,
      "Closing without a lease preserves the WAL"
    );

    const reopened = await requestSucceeded(
      indexedDB.openForPrincipal(closePrincipal, name, 1)
    );
    const read = reopened.transaction(storeName, "readonly");
    is(
      await requestSucceeded(read.objectStore(storeName).get("value")),
      value,
      "Committed data survives reopening with a retained WAL"
    );
    is(await transactionDone(read), "complete", "Read completed");
    reopened.close();
    await requestFinished(Services.qms.reset());
    is(
      (await IOUtils.exists(walFile)) ? (await IOUtils.stat(walFile)).size : 0,
      0,
      "A leased physical close reclaims the WAL"
    );
  }

  // Next, we will reject a blocked upgrade's lease and check that its old
  // version survives and the upgrade can be retried successfully.
  for (const category of [
    Ci.nsIQuotaArtificialFailure.CATEGORY_FLAG_ORIGIN_INFO_AS_DIRTY,
    Ci.nsIQuotaArtificialFailure.CATEGORY_ACQUIRE_WRITE_LEASE_DISPATCH,
  ]) {
    info(`Rejecting a blocked version-change transaction: ${category}`);
    const upgradePrincipal = PrincipalUtils.createPrincipal(
      `https://upgrade${category}.example.com`
    );
    const create = indexedDB.openForPrincipal(upgradePrincipal, name, 1);
    create.onupgradeneeded = () => create.result.createObjectStore(storeName);
    const oldDatabase = await requestSucceeded(create);
    const upgrade = indexedDB.openForPrincipal(upgradePrincipal, name, 2);
    const upgraded = requestSucceeded(upgrade).then(
      database => {
        database.close();
        ok(false, "Version upgrade must fail without a lease");
      },
      error => is(error.name, "AbortError", "Version upgrade rejected")
    );
    upgrade.onupgradeneeded = () =>
      ok(false, "Rejected lease must not start the version change");
    await new Promise(resolve => {
      upgrade.onblocked = resolve;
    });
    await settle(upgradePrincipal);

    await QuotaUtils.withArtificialFailures(
      category,
      100,
      Cr.NS_ERROR_FAILURE,
      async () => {
        oldDatabase.close();
        await upgraded;
        await requestFinished(Services.qms.reset());
      }
    );

    const unchanged = await requestSucceeded(
      indexedDB.openForPrincipal(upgradePrincipal, name)
    );
    is(unchanged.version, 1, "Failed upgrade preserved the version");
    unchanged.close();
    const retry = await requestSucceeded(
      indexedDB.openForPrincipal(upgradePrincipal, name, 2)
    );
    is(retry.version, 2, "Version upgrade succeeds after failure is removed");
    retry.close();
    await requestFinished(Services.qms.reset());
  }

  // Next, we will check that creating and upgrading another database on a settled
  // origin requires a lease, even while a keeper database remains open.
  info("Creating a second database on a settled origin requires a lease");
  const creationPrincipal = PrincipalUtils.createPrincipal(
    "https://creation.example.com"
  );
  const keeper = await requestSucceeded(
    indexedDB.openForPrincipal(creationPrincipal, "keeper", 1)
  );
  await settle(creationPrincipal);
  const creationDirectory = PathUtils.join(
    PathUtils.profileDir,
    "storage",
    "default",
    "https+++creation.example.com",
    "idb"
  );
  const filesBefore = (await IOUtils.getChildren(creationDirectory)).sort();
  await QuotaUtils.withArtificialFailures(
    Ci.nsIQuotaArtificialFailure.CATEGORY_FLAG_ORIGIN_INFO_AS_DIRTY,
    100,
    Cr.NS_ERROR_FAILURE,
    async () => {
      await Assert.rejects(
        requestSucceeded(
          indexedDB.openForPrincipal(creationPrincipal, "second", 1)
        ),
        /UnknownError/,
        "New database initialization rejects without a lease"
      );
    }
  );
  Assert.deepEqual(
    (await IOUtils.getChildren(creationDirectory)).sort(),
    filesBefore,
    "Rejected initialization did not create a database"
  );
  const second = await requestSucceeded(
    indexedDB.openForPrincipal(creationPrincipal, "second", 1)
  );
  ok(
    await isOriginDirty(creationPrincipal),
    "Database creation recorded the flag"
  );
  second.close();
  await settle(creationPrincipal);
  const upgradedSecond = await requestSucceeded(
    indexedDB.openForPrincipal(creationPrincipal, "second", 2)
  );
  is(
    upgradedSecond.version,
    2,
    "Upgrade on a settled origin succeeds under a lease"
  );
  upgradedSecond.close();
  keeper.close();
  await requestFinished(Services.qms.reset());

  // Finally, we will repeatedly close and reopen the database and check that
  // transactions preserve their ordering and committed data.
  info("Repeated close and reopen retains transaction ordering and data");
  for (let i = 0; i < 8; ++i) {
    const connection = await requestSucceeded(
      indexedDB.openForPrincipal(principal, name)
    );
    const transaction = connection.transaction(storeName, "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(storeName);
    const previous = requestSucceeded(store.get("session"));
    store.put(i, "session");
    connection.close();
    const next = requestSucceeded(indexedDB.openForPrincipal(principal, name));
    is(await previous, i ? i - 1 : undefined, "Previous session data retained");
    is(await done, "complete", "Closing waits for the transaction");
    const reopened = await next;
    const read = reopened.transaction(storeName, "readonly");
    const readDone = transactionDone(read);
    is(
      await requestSucceeded(read.objectStore(storeName).get("session")),
      i,
      "Reopened connection sees the committed transaction"
    );
    is(await readDone, "complete", "Reopened transaction completed");
    await settle(principal);
    reopened.close();
  }
  await requestFinished(Services.qms.reset());
}
