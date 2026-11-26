/**
 * Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

/**
 * The headroom reserved for a LocalStorage snapshot counts against the global
 * limit even though it is not recorded usage. Finishing the snapshot releases
 * the unused part for other origins, and only what was written is recorded
 * once the datastore flushes.
 */

const kPeakUsagePref = "dom.storage.snapshot_peak_usage.initial_preincrement";

add_task(async function testSteps() {
  const globalLimitKB = 5 * 1024;
  const headroom = 2 * 1024 * 1024;

  const principalA = getPrincipal("http://example.com");
  const principalB = getPrincipal("http://example.org");

  const smallValue = repeatChar(1024, ".");
  const largeValue = repeatChar(3.5 * 1024 * 1024, ".");

  info("Setting prefs");

  Services.prefs.setBoolPref("dom.storage.snapshot_reusing", false);
  Services.prefs.setIntPref(kPeakUsagePref, headroom);
  registerCleanupFunction(() => {
    Services.prefs.clearUserPref("dom.storage.snapshot_reusing");
    Services.prefs.clearUserPref(kPeakUsagePref);
    resetGlobalLimit();
  });

  setGlobalLimit(globalLimitKB);

  let request = clear();
  await requestFinished(request);

  info("Origin A's snapshot reserves its headroom");

  const storageA = getLocalStorage(principalA);
  const storageB = getLocalStorage(principalB);

  storageA.setItem("A", smallValue);

  info("Origin B cannot use the space held by the snapshot");

  try {
    storageB.setItem("B", largeValue);
    ok(false, "Should have thrown");
  } catch (ex) {
    ok(DOMException.isInstance(ex), "Threw DOMException");
    is(ex.name, "QuotaExceededError", "Threw right DOMException");
  }

  await returnToEventLoop();

  request = getCachedOriginUsage(principalA);
  await requestFinished(request);
  is(request.result, 0, "Headroom is not recorded usage");

  info("Finishing the snapshot releases the unused headroom");

  storageB.setItem("B", largeValue);
  is(storageB.getItem("B").length, largeValue.length, "Write succeeded");

  await returnToEventLoop();

  info("Only what was written is recorded by the flush");

  storageA.close();

  request = resetClient(principalA);
  await requestFinished(request);

  request = getOriginUsage(principalA);
  await requestFinished(request);
  is(request.result.usage, 1 + smallValue.length, "Only the item was flushed");

  storageB.close();

  request = reset();
  await requestFinished(request);
});
