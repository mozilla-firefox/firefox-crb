/**
 * Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

add_task(async function testPendingDeletion() {
  const peakPref = "dom.storage.snapshot_peak_usage.initial_preincrement";
  Services.prefs.setIntPref(peakPref, 0);
  Services.prefs.setBoolPref("dom.storage.snapshot_reusing", false);
  setGlobalLimit(5 * 1024);
  registerCleanupFunction(() => {
    Services.prefs.clearUserPref(peakPref);
    Services.prefs.clearUserPref("dom.storage.snapshot_reusing");
    resetGlobalLimit();
  });
  await requestFinished(clear());

  const principalA = getPrincipal("http://example.com");
  const principalB = getPrincipal("http://example.org");
  const value = repeatChar(3 * 1024 * 1024, ".");
  let storageA = getLocalStorage(principalA);
  storageA.setItem("a", value);
  storageA.close();
  await requestFinished(resetClient(principalA));

  storageA = getLocalStorage(principalA);
  is(storageA.getItem("a"), value, "The allocation was loaded from disk");
  const storageB = getLocalStorage(principalB);
  storageA.clear();
  await returnToEventLoop();

  is(
    await requestFinished(getCachedOriginUsage(principalA)),
    value.length + 1,
    "The pending deletion has not changed committed usage"
  );
  Assert.throws(
    () => storageB.setItem("b", value),
    /QuotaExceededError/,
    "A pending deletion cannot grant quota to another origin"
  );

  storageA.close();
  await requestFinished(resetClient(principalA));
  is(
    await requestFinished(getCachedOriginUsage(principalA)),
    0,
    "The committed deletion releases space"
  );
  storageB.setItem("b", value);
  is(storageB.getItem("b"), value, "The released space can now be allocated");
  storageB.close();
  await requestFinished(reset());
});
