/**
 * Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

/**
 * This test is mainly to verify that a flush failing for one origin doesn't
 * prevent flushing other origins. See bug 1559029.
 */

const { waitForCondition } = ChromeUtils.importESModule(
  "resource://testing-common/dom/quota/test/modules/StorageUtils.sys.mjs"
);

add_task(async function testSteps() {
  const principal1 = getPrincipal("http://example1.com");

  const usageFile1 = getRelativeFile(
    "storage/default/http+++example1.com/ls/usage"
  );

  const principal2 = getPrincipal("http://example2.com");

  const data = {
    key: "foo",
    value: "bar",
  };

  info("Setting prefs");

  Services.prefs.setBoolPref("dom.storage.next_gen", true);

  info("Getting storage 1");

  let storage1 = getLocalStorage(principal1);

  is(storage1.length, 0, "Datastore initialized before installing the failure");

  info("Creating usage as a directory");

  // Install the failure before scheduling any writes.
  usageFile1.create(Ci.nsIFile.DIRECTORY_TYPE, parseInt("0755", 8));

  info("Adding item");
  storage1.setItem(data.key, data.value);

  info("Getting storage 2");

  let storage2 = getLocalStorage(principal2);

  info("Adding item");

  storage2.setItem(data.key, data.value);

  // The flush for second principal shouldn't be affected by failed flush for
  // first principal.

  await waitForCondition(
    async () =>
      (await requestFinished(getCachedOriginUsage(principal2))) ===
      data.key.length + data.value.length,
    "second origin's flush to commit"
  );

  info("Checking usage");

  // The failed flush must not have committed the reserved usage, while the
  // successful one did.
  let request = getCachedOriginUsage(principal1);
  is(await requestFinished(request), 0, "Nothing recorded for principal 1");

  request = getCachedOriginUsage(principal2);
  is(
    await requestFinished(request),
    data.key.length + data.value.length,
    "Usage recorded for principal 2"
  );

  is(
    storage1.getItem(data.key),
    data.value,
    "Failed flush leaves item in memory"
  );

  info("Closing the datastore after the failed flush");

  request = resetClient(principal1);
  await requestFinished(request);

  usageFile1.remove(false);

  request = reset();
  await requestFinished(request);

  info("Reopening storage after removing the cause of the flush failure");

  storage1 = getLocalStorage(principal1);

  // The final retry also failed because the usage file was still a directory.
  is(
    storage1.getItem(data.key),
    null,
    "Closing did not commit the failed batch"
  );

  request = getCachedOriginUsage(principal1);
  is(await requestFinished(request), 0, "No usage recorded for the lost item");

  info("Resetting");

  // Wait for all database connections to close.
  request = reset();
  await requestFinished(request);
});
