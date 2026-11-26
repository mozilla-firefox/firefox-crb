/**
 * Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

const { QuotaUtils } = ChromeUtils.importESModule(
  "resource://testing-common/dom/quota/test/modules/QuotaUtils.sys.mjs"
);
const { flushDirtyOriginInfos, isOriginDirty, waitForCondition } =
  ChromeUtils.importESModule(
    "resource://testing-common/dom/quota/test/modules/StorageUtils.sys.mjs"
  );

/**
 * LocalStorage only writes to disk when the batched changes are flushed. The
 * flush takes a quota write lease, which records the origin dirty flag before
 * writing and is dropped once the flush is done, so an idle datastore does not
 * keep the origin from settling.
 */

const kQuiescentThresholdPref =
  "dom.quotaManager.originWriteQuiescentThresholdMs";
const kFlushTimeoutMs = 100;

async function waitForValue(readValue, expected, message) {
  await waitForCondition(async () => (await readValue()) === expected, message);
}

async function waitForUsage(principal, expected, message) {
  await waitForValue(
    () => requestFinished(getCachedOriginUsage(principal)),
    expected,
    message
  );
}

async function settle(principal) {
  await waitForValue(
    async () => {
      await flushDirtyOriginInfos();
      return isOriginDirty(principal, persistenceFor(principal));
    },
    false,
    "Origin settled"
  );
}

add_task(async function testSteps() {
  const principal = getPrincipal("http://example.com");
  const usageFile = getRelativeFile(
    "storage/default/http+++example.com/ls/usage"
  );

  const data = { key: "key1", value: "value1" };
  data.usage = data.key.length + data.value.length;

  info("Setting prefs");

  Services.prefs.setIntPref(kQuiescentThresholdPref, 100);
  registerCleanupFunction(() =>
    Services.prefs.clearUserPref(kQuiescentThresholdPref)
  );

  // Private origins have no row in the storage database, so the dirty flag is
  // never recorded on disk and never settles.
  if (persistenceFor(principal) == "private") {
    info("Skipping the dirty flag stages for a private origin");
    return;
  }

  info("Stage 1 - Flushing on close records the dirty flag");

  // The origin directory only gets created by the first flush; origins
  // without a directory cannot settle.
  let storage = getLocalStorage(principal);

  storage.setItem(data.key, data.value);

  let request = resetClient(principal);
  await requestFinished(request);

  ok(
    await isOriginDirty(principal, persistenceFor(principal)),
    "The flush made the origin dirty"
  );

  await settle(principal);

  request = getOriginUsage(principal);
  await requestFinished(request);
  is(request.result.usage, data.usage, "Correct usage after flush");

  if (persistenceFor(principal) == "default") {
    is(
      await readUsageFromUsageFile(usageFile),
      data.usage,
      "Usage file matches"
    );
  }

  info("Stage 2 - An idle datastore does not pin the origin dirty");

  storage = getLocalStorage(principal);

  storage.setItem(data.key + "2", data.value);

  await waitForUsage(
    principal,
    2 * data.usage + 1,
    "The first periodic flush persisted the data"
  );

  await settle(principal);

  is(
    storage.getItem(data.key),
    data.value,
    "Reading from the open datastore does not dirty the origin"
  );

  await flushDirtyOriginInfos();
  ok(
    !(await isOriginDirty(principal, persistenceFor(principal))),
    "Origin still settled after a read"
  );

  storage.setItem(data.key + "3", data.value);

  await waitForUsage(
    principal,
    3 * data.usage + 2,
    "The second periodic flush persisted the data"
  );

  await settle(principal);

  request = getOriginUsage(principal);
  await requestFinished(request);
  is(
    request.result.usage,
    3 * data.usage + 2,
    "Both later flushes were persisted"
  );

  info("Stage 3 - A flush whose lease is rejected is retried later");

  await QuotaUtils.withArtificialFailures(
    Ci.nsIQuotaArtificialFailure.CATEGORY_FLAG_ORIGIN_INFO_AS_DIRTY,
    /* aProbability */ 100,
    Cr.NS_ERROR_FAILURE,
    async function () {
      // The lease request only does IO if the origin is not dirty on disk.
      ok(
        !(await isOriginDirty(principal, persistenceFor(principal))),
        "Origin settled before the flush"
      );

      storage.setItem(data.key + "4", data.value);

      // This interval usually covers a flush attempt, but delayed scheduling
      // may miss the rejection path. That only reduces coverage: we check the
      // state while failures are enabled, then wait for persistence after
      // disabling them, without assuming an attempt ran within the interval.
      const observationEnd = ChromeUtils.now() + 3 * kFlushTimeoutMs;
      await waitForValue(
        async () => {
          const usage = await requestFinished(getCachedOriginUsage(principal));
          if (usage !== 3 * data.usage + 2) {
            throw new Error(`Usage changed without a write lease: ${usage}`);
          }
          if (await isOriginDirty(principal, persistenceFor(principal))) {
            throw new Error("Origin became dirty despite lease rejection");
          }
          return ChromeUtils.now() >= observationEnd;
        },
        true,
        "Observing unchanged usage while write leases fail"
      );
    }
  );

  await waitForUsage(
    principal,
    4 * data.usage + 3,
    "The retried flush persisted the data"
  );

  await settle(principal);
});

add_task(async function testResetOnClose() {
  info("Stage 4 - Closing a datastore that never wrote resets client usage");

  const otherPrincipal = getPrincipal("http://example.org");

  const storage = getLocalStorage(otherPrincipal);
  is(storage.getItem("key1"), null, "Nothing stored yet");

  let request = resetClient(otherPrincipal);
  await requestFinished(request);

  request = getOriginUsage(otherPrincipal);
  await requestFinished(request);
  is(request.result.usage, 0, "No usage");

  info("Resetting");

  request = reset();
  await requestFinished(request);
});
