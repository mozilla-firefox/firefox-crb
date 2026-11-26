/**
 * Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

/**
 * Verify that persist() succeeds when the origin exists on disk but has no
 * OriginInfo in memory (Accessed=0, skipped by LoadQuotaFromCache).
 */

loadScript("dom/quota/test/xpcshell/common/utils.js");

async function testSteps() {
  const principal = getPrincipal("https://example.com");

  info("Creating origin data via SimpleDB");

  let database = getSimpleDatabase(principal);

  let request = database.open("data");
  await requestFinished(request);

  request = database.write(getBuffer(1024));
  await requestFinished(request);

  request = database.close();
  await requestFinished(request);

  info("Resetting to drop all in-memory state");

  request = reset();
  await requestFinished(request);

  info(
    "Reinitializing storage and temporary storage without touching the origin"
  );

  request = init();
  await requestFinished(request);

  request = initTemporaryStorage();
  await requestFinished(request);

  info("Persisting the origin that is not loaded into memory");

  request = persist(principal);
  await requestFinished(request);

  info("Verifying the origin is now persisted");

  request = persisted(principal);
  await requestFinished(request);

  ok(request.result, "Origin is persisted");

  info("Verifying origin data is still accessible");

  database = getSimpleDatabase(principal);

  request = database.open("data");
  await requestFinished(request);

  request = database.close();
  await requestFinished(request);

  request = reset();
  await requestFinished(request);
}
