/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  ProvidersManager:
    "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs",
});

add_task(async function test_providers() {
  let providersManager = ProvidersManager.getInstanceForSap("urlbar");
  Assert.throws(
    () => providersManager.registerProvider(),
    /invalid provider/,
    "Should throw with no arguments"
  );
  Assert.throws(
    () => providersManager.registerProvider({}),
    /invalid provider/,
    "Should throw with empty object"
  );
  Assert.throws(
    () =>
      providersManager.registerProvider({
        name: "",
      }),
    /invalid provider/,
    "Should throw with empty name"
  );
  Assert.throws(
    () =>
      providersManager.registerProvider({
        name: "test",
        startQuery: "no",
      }),
    /invalid provider/,
    "Should throw with invalid startQuery"
  );
  Assert.throws(
    () =>
      providersManager.registerProvider({
        name: "test",
        startQuery: () => {},
        cancelQuery: "no",
      }),
    /invalid provider/,
    "Should throw with invalid cancelQuery"
  );

  let match = new UrlbarResult({
    type: UrlbarShared.RESULT_TYPE.TAB_SWITCH,
    source: UrlbarShared.RESULT_SOURCE.TABS,
    payload: { url: "http://mozilla.org/foo/" },
  });

  let provider = registerBasicTestProvider([match]);
  let context = createContext(undefined, { providers: [provider.name] });
  let controller = UrlbarTestUtils.mockChildController();
  let resultsPromise = promiseControllerNotification(
    controller,
    "onQueryResults"
  );

  await providersManager.startQuery(context, controller.parentController);
  // Sanity check that this doesn't throw. It should be a no-op since we await
  // for startQuery.
  providersManager.cancelQuery(context);

  let params = await resultsPromise;
  Assert.deepEqual(params[0].results, [match]);
});

add_task(async function test_criticalSection() {
  // Just a sanity check, this shouldn't throw.
  await ProvidersManager.runInCriticalSection(async () => {
    let db = await PlacesUtils.promiseLargeCacheDBConnection();
    await db.execute(`PRAGMA page_cache`);
  });
});

const LONG_QUERY = `
  WITH RECURSIVE c(x) AS (
    VALUES(1) UNION ALL SELECT x + 1 FROM c WHERE x < :limit
  )
  SELECT x FROM c`;

async function cancelDuringLongQuery(limit, inCriticalSection) {
  let providersManager = ProvidersManager.getInstanceForSap("urlbar");
  let db = await PlacesUtils.promiseLargeCacheDBConnection();
  let firstRow = Promise.withResolvers();
  let rowCount = 0;
  let execute = () =>
    db.execute(LONG_QUERY, { limit }, () => {
      rowCount++;
      firstRow.resolve();
    });
  let sqlPromise;
  let provider = registerBasicTestProvider();
  provider.startQuery = async () => {
    sqlPromise = inCriticalSection
      ? ProvidersManager.runInCriticalSection(execute)
      : execute();
    await sqlPromise.catch(() => {});
  };
  let context = createContext(undefined, { providers: [provider.name] });
  let controller = UrlbarTestUtils.mockChildController();
  let queryPromise = providersManager.startQuery(
    context,
    controller.parentController
  );
  await firstRow.promise;
  providersManager.cancelQuery(context);
  await queryPromise;
  await sqlPromise;
  providersManager.unregisterProvider(provider);
  return rowCount;
}

add_task(async function test_cancel_interrupts() {
  let limit = Number.MAX_SAFE_INTEGER;
  Assert.less(
    await cancelDuringLongQuery(limit, false),
    limit,
    "Canceling the query interrupts the running statement"
  );
});

add_task(async function test_cancel_criticalSection() {
  let limit = 500000;
  Assert.equal(
    await cancelDuringLongQuery(limit, true),
    limit,
    "The statement in the critical section was not interrupted"
  );
});
