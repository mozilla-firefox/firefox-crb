/**
 * Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

/**
 * The headroom LocalStorage grants to snapshots is a quota reservation: it
 * counts against the limits, but it only becomes recorded (and persisted)
 * usage once the changes have been flushed to disk.
 */

const kPeakUsagePref = "dom.storage.snapshot_peak_usage.initial_preincrement";
const kPeakUsage = 1024 * 1024;

add_task(async function testSteps() {
  const principal = getPrincipal("http://example.com");
  const usageFile = getRelativeFile(
    "storage/default/http+++example.com/ls/usage"
  );

  const data = { key: "key1", value: "value1" };
  data.usage = data.key.length + data.value.length;

  info("Setting prefs");

  Services.prefs.setIntPref(kPeakUsagePref, kPeakUsage);
  registerCleanupFunction(() => Services.prefs.clearUserPref(kPeakUsagePref));

  async function cachedUsage() {
    const request = getCachedOriginUsage(principal);
    return requestFinished(request);
  }

  async function originUsage() {
    const request = getOriginUsage(principal);
    await requestFinished(request);
    return request.result.usage;
  }

  info("Stage 1 - Headroom is not usage before the flush");

  let storage = getLocalStorage(principal);

  storage.setItem(data.key, data.value);

  is(await cachedUsage(), 0, "Nothing recorded before the flush");

  let request = resetClient(principal);
  await requestFinished(request);

  is(await cachedUsage(), data.usage, "Recorded usage after the flush");
  is(await originUsage(), data.usage, "Origin usage after the flush");

  if (persistenceFor(principal) == "default") {
    is(
      await readUsageFromUsageFile(usageFile),
      data.usage,
      "Usage file matches"
    );
  }

  info("Stage 2 - Repeated snapshots only commit what was written");

  for (let i = 0; i < 5; i++) {
    storage = getLocalStorage(principal);
    is(storage.getItem(data.key), data.value, "Item is there");

    request = resetClient(principal);
    await requestFinished(request);

    is(await cachedUsage(), data.usage, "Usage unchanged by reading");
  }

  info("Stage 3 - A decrease is committed by the flush");

  storage = getLocalStorage(principal);

  storage.setItem(data.key + "2", data.value);
  storage.removeItem(data.key);

  request = resetClient(principal);
  await requestFinished(request);

  is(await cachedUsage(), data.usage + 1, "Usage after replace");

  storage = getLocalStorage(principal);

  storage.clear();

  request = resetClient(principal);
  await requestFinished(request);

  is(await cachedUsage(), 0, "Usage after clear");
  is(await originUsage(), 0, "Origin usage after clear");

  info("Stage 4 - The origin limit is enforced against the reservation");

  const originLimitKB = 1;
  setOriginLimit(originLimitKB);

  storage = getLocalStorage(principal);

  let threw = false;
  try {
    storage.setItem("big", repeatChar(originLimitKB * 1024 + 1, "."));
  } catch (ex) {
    threw = true;
    is(ex.name, "QuotaExceededError", "Correct exception");
  }
  ok(threw, "Setting over the origin limit throws before any flush");

  is(await cachedUsage(), 0, "A failed reservation leaves usage untouched");

  resetOriginLimit();

  request = resetClient(principal);
  await requestFinished(request);

  is(await cachedUsage(), 0, "Nothing was flushed");

  info("Resetting");

  request = reset();
  await requestFinished(request);
});
