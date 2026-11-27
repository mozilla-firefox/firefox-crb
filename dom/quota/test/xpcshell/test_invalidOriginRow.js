/**
 * Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

/**
 * Verifies that an origin row in storage.sqlite whose origin string no longer
 * resolves to a valid principal does not break initialization. The cache load
 * rejects the row, the repository is rescanned from disk, and the stale row is
 * dropped while the valid origin survives.
 */
async function testSteps() {
  const origin = "https://foo.example.com";

  const badOrigins = [
    // Fails to parse at all, so no principal can be created from it.
    "https://foo.exa mple.com^garbage",
    // Parses as a URI and yields a principal, but a null one, so only the
    // full principal validation rejects it.
    "about:blank",
  ];

  function originRowExists(originString) {
    let dbFile = getRelativeFile("storage.sqlite");
    let conn = Services.storage.openUnsharedDatabase(dbFile);
    let stmt = conn.createStatement(
      "SELECT 1 FROM origin WHERE origin = :origin"
    );
    stmt.params.origin = originString;
    let exists = stmt.executeStep();
    stmt.finalize();
    conn.close();
    return exists;
  }

  function replaceOriginInDB(from, to) {
    let dbFile = getRelativeFile("storage.sqlite");
    let conn = Services.storage.openUnsharedDatabase(dbFile);
    let stmt = conn.createStatement(
      "UPDATE origin SET origin = :to WHERE origin = :from"
    );
    stmt.params.to = to;
    stmt.params.from = from;
    stmt.executeStep();
    stmt.finalize();
    conn.close();
  }

  info("Clearing");

  let request = clear();
  await requestFinished(request);

  info("Initializing");

  request = init();
  await requestFinished(request);

  info("Initializing temporary storage");

  request = initTemporaryStorage();
  await requestFinished(request);

  info("Initializing temporary origin");

  request = initTemporaryOrigin("default", getPrincipal(origin));
  await requestFinished(request);

  info("Shutting down storage to flush DB writes");

  request = reset();
  await requestFinished(request);

  ok(originRowExists(origin), "Origin row exists before corruption");

  for (const badOrigin of badOrigins) {
    info("Corrupting the origin string in DB to " + badOrigin);

    replaceOriginInDB(origin, badOrigin);

    ok(originRowExists(badOrigin), "Corrupted origin row exists");
    ok(!originRowExists(origin), "Valid origin row is gone");

    info("Initializing");

    request = init();
    await requestFinished(request);

    info("Initializing temporary storage");

    request = initTemporaryStorage();
    await requestFinished(request);

    info("Shutting down storage to flush DB writes");

    request = reset();
    await requestFinished(request);

    ok(!originRowExists(badOrigin), "Corrupted origin row was dropped");
    ok(originRowExists(origin), "Valid origin row was restored from disk");
  }
}
