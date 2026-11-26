/**
 * Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

function readCachedRow(origin) {
  const connection = Services.storage.openUnsharedDatabase(
    getRelativeFile("storage.sqlite")
  );
  const statement = connection.createStatement(
    "SELECT usage, metadata_flags FROM origin WHERE origin = :origin"
  );
  try {
    statement.params.origin = origin;
    ok(statement.executeStep(), "Cached origin exists");
    return {
      usage: statement.row.usage,
      accessed: !!(statement.row.metadata_flags & (1 << 1)),
      dirty: !!(statement.row.metadata_flags & (1 << 2)),
    };
  } finally {
    statement.finalize();
    connection.close();
  }
}

async function testSteps() {
  const origin = "https://example.com";
  const principal = getPrincipal(origin);
  const clientPath = "storage/default/https+++example.com/sdb";

  for (const initializeTemporaryStorage of [true, false]) {
    await requestFinished(clear());
    await requestFinished(init());
    await requestFinished(initTemporaryStorage());
    await requestFinished(initTemporaryOrigin("default", principal));

    const clientDirectory = getRelativeFile(clientPath);
    clientDirectory.create(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
    await IOUtils.write(
      getRelativeFile(clientPath + "/data").path,
      new Uint8Array(1024)
    );

    await requestFinished(reset());
    setCachedOriginUsage(origin, 1024, "S1024");
    const before = readCachedRow(origin);
    is(before.usage, 1024, "Cache initially accounts for the data file");
    ok(!before.accessed && !before.dirty, "Origin can remain unloaded");

    await requestFinished(init());
    if (initializeTemporaryStorage) {
      await requestFinished(initTemporaryStorage());
    }
    const initialized = temporaryOriginInitialized("default", principal);
    await requestFinished(initialized);
    ok(!initialized.result, "Origin has no in-memory OriginInfo");
    is(
      readCachedRow(origin).usage,
      1024,
      "Clear starts with nonzero cached usage"
    );

    await requestFinished(clearClient(principal, "sdb", "default"));
    ok(!clientDirectory.exists(), "Client directory was deleted");
    const after = readCachedRow(origin);
    ok(after.dirty, "Clear marked the unloaded origin dirty on disk");
    ok(after.accessed, "Next initialization must process the origin");

    await requestFinished(reset());
    await requestFinished(init());
    await requestFinished(initTemporaryStorage());
    is(
      readCachedRow(origin).usage,
      0,
      "Normal initialization corrects the persisted cached usage"
    );
    const usage = getCachedOriginUsage(principal);
    await requestFinished(usage);
    is(
      usage.result,
      0,
      "Normal initialization replaces the stale cached usage"
    );
  }
  finishTest();
}
