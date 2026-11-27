/**
 * Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

async function testSteps() {
  const origin = "https://foo.example.com";

  function readLastAccessTimeFromDB() {
    let dbFile = getRelativeFile("storage.sqlite");
    let conn = Services.storage.openUnsharedDatabase(dbFile);
    let stmt = conn.createStatement(
      "SELECT last_access_time FROM origin WHERE origin = :origin"
    );
    stmt.params.origin = origin;
    ok(stmt.executeStep(), "Origin row exists in DB");
    let lastAccessTime = BigInt.asIntN(64, BigInt(stmt.getInt64(0)));
    stmt.finalize();
    conn.close();
    return lastAccessTime;
  }

  info("Clearing");

  let request = clear();
  await requestFinished(request);

  info("Installing package");

  // The profile contains one initialized origin directory and the storage
  // database:
  // - storage/default/https+++foo.example.com
  // - storage.sqlite
  // The file make_unsetLastAccessTime.js was run locally, specifically it was
  // temporarily enabled in xpcshell.toml and then executed:
  // mach test --interactive dom/quota/test/xpcshell/make_unsetLastAccessTime.js
  // Note: to make it become the profile in the test, additional manual steps
  // are needed.
  // 1. Remove the folder "storage/temporary".
  // 2. Remove the file "storage/ls-archive.sqlite".
  installPackage("unsetLastAccessTime_profile");

  info("Verifying the packaged profile starts with an unset last access time");

  Assert.equal(
    readLastAccessTimeFromDB(),
    INT64_MIN,
    "Last access time is unset before initialization"
  );

  info("Initializing");

  request = init();
  await requestFinished(request);

  info("Initializing temporary storage");

  request = initTemporaryStorage();
  await requestFinished(request);

  info("Shutting down storage to flush DB writes");

  request = reset();
  await requestFinished(request);

  info("Verifying last access time in DB");

  // The origin has no client files, so initialization derives its access time
  // from the origin directory itself, which yields a real timestamp.
  const lastAccessTime = readLastAccessTimeFromDB();
  const isPositive = lastAccessTime > 0n;
  Assert.ok(isPositive, "Last access time is set after initialization");

  // The packaged profile was written by a different build, so the first
  // initialization above could not use the quota info cache and scanned the
  // repository instead. Unset the value again now that the cache belongs to
  // this build, so the second initialization has to repair it from the cache
  // path.
  info("Unsetting last access time in DB");

  {
    let dbFile = getRelativeFile("storage.sqlite");
    let conn = Services.storage.openUnsharedDatabase(dbFile);
    // Binding parameters can't carry a BigInt, so spell INT64_MIN out as
    // integer arithmetic in SQL.
    let stmt = conn.createStatement(
      "UPDATE origin SET last_access_time = -9223372036854775807 - 1 " +
        "WHERE origin = :origin"
    );
    stmt.params.origin = origin;
    stmt.executeStep();
    stmt.finalize();
    conn.close();
  }

  Assert.equal(
    readLastAccessTimeFromDB(),
    INT64_MIN,
    "Last access time is unset before the second initialization"
  );

  info("Initializing");

  request = init();
  await requestFinished(request);

  info("Initializing temporary storage");

  request = initTemporaryStorage();
  await requestFinished(request);

  info("Shutting down storage to flush DB writes");

  request = reset();
  await requestFinished(request);

  info("Verifying last access time in DB");

  const repairedLastAccessTime = readLastAccessTimeFromDB();
  const isRepaired = repairedLastAccessTime > 0n;
  Assert.ok(
    isRepaired,
    "Last access time is set after the second initialization"
  );
}
