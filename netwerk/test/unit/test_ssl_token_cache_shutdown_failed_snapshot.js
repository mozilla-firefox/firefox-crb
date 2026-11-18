/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Removals pending at shutdown don't survive on disk when the final snapshot
// can't open the DB.

"use strict";

const kRemoved = ["anon:host-a.example.com:443", "host-a.example.com:443"];
const kKept = ["other.example.com:443"];

add_task(async function test_ssl_token_cache_failed_shutdown_snapshot() {
  let { cache, testCache } = getCacheServices();
  seedCacheRows([...kRemoved, ...kKept]);
  testCache.holdLoadForTest(true);
  activatePersistence();
  await releaseHeldLoad(testCache);

  let requeued = TestUtils.topicObserved(kRequeuedTopic);
  testCache.failDBOpensForTest(1);
  cache.removeSSLTokensByHostAndOriginAttributesPattern(
    "host-a.example.com",
    "{}"
  );
  await requeued;
  Assert.deepEqual(await readCacheKeys(), [...kRemoved, ...kKept]);

  testCache.failDBOpensForTest(1000);
  await triggerProfileBeforeChange();

  let keys = (await readCacheKeys()) ?? [];
  Assert.deepEqual(
    keys.filter(k => kRemoved.includes(k)),
    [],
    "no removed row survives shutdown"
  );
});
