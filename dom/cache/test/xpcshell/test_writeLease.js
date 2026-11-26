/**
 * Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

const { QuotaUtils } = ChromeUtils.importESModule(
  "resource://testing-common/dom/quota/test/modules/QuotaUtils.sys.mjs"
);
const { flushDirtyOriginInfos, isOriginDirty, waitForOriginToSettle } =
  ChromeUtils.importESModule(
    "resource://testing-common/dom/quota/test/modules/StorageUtils.sys.mjs"
  );

/**
 * Cache API actions that modify the origin take a quota write lease for their
 * duration, so the origin is marked dirty on disk before the action writes and
 * an idle Cache object does not keep the origin from settling.
 */

const kQuiescentThresholdPref =
  "dom.quotaManager.originWriteQuiescentThresholdMs";
const kPauseOnIOThreadPref =
  "dom.quotaManager.originOperations.pauseOnIOThreadMs";

// Wait for the origin to settle, including any asynchronous close or maintenance.
async function settle(principal) {
  await waitForOriginToSettle(principal);
}

add_task(async function testSteps() {
  const principal = getPrincipal("https://example.com");

  Services.prefs.setIntPref(kQuiescentThresholdPref, 100);
  registerCleanupFunction(() => {
    Services.prefs.clearUserPref(kQuiescentThresholdPref);
    Services.prefs.clearUserPref(kPauseOnIOThreadPref);
  });

  const sandbox = new Cu.Sandbox(principal, {
    wantGlobalProperties: ["caches", "fetch"],
  });

  // Runs an async function in the sandbox, keeping any state it stores on
  // `self` alive across calls.
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

  info("Stage 1 - Opening a cache and putting records the dirty flag");

  await run(async function () {
    globalThis.cache = await caches.open("myCache");
    await globalThis.cache.put(
      new Request("https://example.com/a"),
      new Response("a")
    );
  });

  ok(await isOriginDirty(principal), "Origin dirty after put");

  info("Stage 2 - An idle Cache object does not pin the origin dirty");

  await settle(principal);

  info("Stage 3 - Reads do not dirty a settled origin");

  const matched = await run(async function () {
    const response = await globalThis.cache.match("https://example.com/a");
    return response ? await response.text() : null;
  });
  Assert.equal(matched, "a", "Entry is there");

  await flushDirtyOriginInfos();
  ok(!(await isOriginDirty(principal)), "Origin still settled after match");

  info("Stage 4 - The first write after settling records the flag again");

  await run(async function () {
    await globalThis.cache.put(
      new Request("https://example.com/b"),
      new Response("b")
    );
  });

  ok(await isOriginDirty(principal), "Origin dirty again");

  await settle(principal);

  info("Stage 5 - Actions issued while the lease is pending keep their order");

  // Occupying the quota IO thread with a paused origin operation delays the
  // lease, so the whole burst is dispatched once it resolves.
  Services.prefs.setIntPref(kPauseOnIOThreadPref, 500);
  const pauseRequest = Services.qms.getFullOriginMetadata("default", principal);
  const pausePromise = requestFinished(pauseRequest);

  // Cache storage operations run synchronously on the cache thread (unlike
  // put, whose body copy completes asynchronously), so their results reflect
  // the dispatch order.
  const results = await run(async function () {
    return Promise.all([
      caches.open("otherCache"),
      caches.has("otherCache"),
      caches.delete("otherCache"),
      caches.has("otherCache"),
    ]);
  });

  await pausePromise;
  Services.prefs.clearUserPref(kPauseOnIOThreadPref);

  Assert.equal(results[1], true, "has saw the cache opened before it");
  Assert.equal(results[2], true, "delete found the cache");
  Assert.equal(results[3], false, "has after delete found nothing");

  await settle(principal);

  info("Stage 6 - A write whose lease is rejected fails");

  const rejected = await QuotaUtils.withArtificialFailures(
    Ci.nsIQuotaArtificialFailure.CATEGORY_FLAG_ORIGIN_INFO_AS_DIRTY,
    /* aProbability */ 100,
    Cr.NS_ERROR_FAILURE,
    async function () {
      return run(async function () {
        try {
          await globalThis.cache.put(
            new Request("https://example.com/d"),
            new Response("d")
          );
          return false;
        } catch (e) {
          return true;
        }
      });
    }
  );
  ok(rejected, "put failed without the lease");

  const matchedD = await run(async function () {
    const response = await globalThis.cache.match("https://example.com/d");
    return response ? await response.text() : null;
  });
  Assert.equal(matchedD, null, "Nothing was written without the lease");

  ok(!(await isOriginDirty(principal)), "Origin still settled");

  await run(async function () {
    await globalThis.cache.put(
      new Request("https://example.com/d"),
      new Response("d")
    );
  });

  await settle(principal);

  info("Stage 7 - Deleting a cache while a put waits for its lease");

  Services.prefs.setIntPref(kPauseOnIOThreadPref, 500);
  const pauseRequest2 = Services.qms.getFullOriginMetadata(
    "default",
    principal
  );
  const pausePromise2 = requestFinished(pauseRequest2);

  const settled = await run(async function () {
    const putPromise = globalThis.cache.put(
      new Request("https://example.com/e"),
      new Response("e")
    );
    const deletePromise = caches.delete("myCache");
    const outcomes = await Promise.allSettled([putPromise, deletePromise]);
    return outcomes.map(r => r.status);
  });

  await pausePromise2;
  Services.prefs.clearUserPref(kPauseOnIOThreadPref);

  Assert.equal(settled.length, 2, "Both operations settled");
  Assert.equal(settled[1], "fulfilled", "caches.delete resolved");

  await settle(principal);

  info(
    "Stage 8 - Dropping the listener while actions are queued " +
      "(doom-while-pending; observable: no crash)"
  );

  // Re-open a cache from a fresh sandbox so the Context is in READY state.
  const sandbox2 = new Cu.Sandbox(principal, {
    wantGlobalProperties: ["caches", "fetch"],
  });

  async function run2(fn) {
    const promise = new Promise(function (resolve, reject) {
      sandbox2.resolve = resolve;
      sandbox2.reject = reject;
    });
    Cu.evalInSandbox(
      `(${fn.toSource()})().then(v => resolve(v), e => reject(e));`,
      sandbox2
    );
    return promise;
  }

  await run2(async function () {
    globalThis.cache2 = await caches.open("doom-test");
    await globalThis.cache2.put(
      new Request("https://example.com/f"),
      new Response("f")
    );
  });

  await settle(principal);

  // After settling, the next put needs an async write lease
  // (TryAcquireWriteLease returns Nothing on a clean origin).  Queue a put
  // and a match without awaiting them, then nuke the sandbox.  This drops
  // the last listener, triggering AllowToClose -> DoomTargetData while the
  // lease is pending and the match is queued.  With the deferred doom, the
  // pending actions run with valid Data instead of crashing.
  Cu.evalInSandbox(
    `globalThis.cache2.put(
       new Request("https://example.com/g"),
       new Response("g")
     );
     globalThis.cache2.match(new Request("https://example.com/f"));`,
    sandbox2
  );

  Cu.nukeSandbox(sandbox2);

  await settle(principal);

  info("Resetting");

  Cu.nukeSandbox(sandbox);

  const request = reset();
  await requestFinished(request);
});
