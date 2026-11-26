/**
 * Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

const { isOriginDirty, waitForOriginToSettle } = ChromeUtils.importESModule(
  "resource://testing-common/dom/quota/test/modules/StorageUtils.sys.mjs"
);

/**
 * Verify that a corruption wipe of the cache database marks the origin dirty
 * via a write lease.  SetupAction (Mode::Create) holds a lease from
 * QuotaInitRunnable::DirectoryLockAcquired, so it may wipe; read actions
 * (Mode::Existing) propagate the error instead.
 */

const kQuiescentThresholdPref =
  "dom.quotaManager.originWriteQuiescentThresholdMs";

add_task(async function corruptionWipeMarksOriginDirty() {
  const principal = getPrincipal("https://example.com");

  Services.prefs.setIntPref(kQuiescentThresholdPref, 100);
  registerCleanupFunction(() => {
    Services.prefs.clearUserPref(kQuiescentThresholdPref);
  });

  const sandbox = new Cu.Sandbox(principal, {
    wantGlobalProperties: ["caches", "fetch"],
  });

  async function run(fn) {
    const promise = new Promise(function (resolve, reject) {
      sandbox.resolve = resolve;
      sandbox.reject = reject;
    });
    Cu.evalInSandbox(
      `(${fn.toSource()})().then(v => resolve(v), e => reject(e));`,
      sandbox
    );
    return promise;
  }

  info("Populating a cache entry");

  await run(async function () {
    const cache = await caches.open("test");
    await cache.put(
      new Request("https://example.com/key"),
      new Response("value")
    );
  });

  info("Resetting storage so the origin is flushed");

  await requestFinished(reset());
  await requestFinished(initStorage());
  await requestFinished(initTemporaryStorage());

  // Initialize the origin so OriginInfo exists, otherwise the wipe happening
  // inside InitOrigin has no dirty-flag tracking.
  await requestFinished(initTemporaryOrigin(principal));

  ok(!(await isOriginDirty(principal)), "Origin should be clean after reset");

  info("Corrupting the cache database");

  const originDirRelPath = "storage/default/https+++example.com";
  const dbFile = getRelativeFile(originDirRelPath + "/cache/caches.sqlite");
  const walFile = getRelativeFile(
    originDirRelPath + "/cache/caches.sqlite-wal"
  );

  // Write garbage over the database file.
  const garbage = new Uint8Array(2048);
  for (let i = 0; i < garbage.length; i++) {
    garbage[i] = i & 0xff;
  }

  await IOUtils.write(dbFile.path, garbage);

  // Remove the WAL so SQLite cannot recover from it.
  try {
    await IOUtils.remove(walFile.path);
  } catch (e) {
    // WAL may not exist if the last connection closed cleanly.
  }

  info("Opening the cache again; SetupAction should wipe under a lease");

  const matched = await run(async function () {
    const cache = await caches.open("test");
    const response = await cache.match(new Request("https://example.com/key"));
    return !!response;
  });
  ok(!matched, "Entry should be gone after corruption wipe");

  info("Verifying the origin is dirty after the wipe");

  ok(await isOriginDirty(principal), "Origin should be dirty after wipe");

  info("Settling the origin");

  await waitForOriginToSettle(principal);

  ok(!(await isOriginDirty(principal)), "Origin settled after flush");

  Cu.nukeSandbox(sandbox);
  await requestFinished(Services.qms.clear());
});
