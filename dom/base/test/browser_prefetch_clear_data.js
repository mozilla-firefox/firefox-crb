/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

// User requests to clear data through nsIClearDataService discard
// speculation-rules prefetch records, so a later navigation is not served from
// them. Programmatic requests leave them alone.

"use strict";

const BASE = "https://example.com/browser/dom/base/test/";
const TARGET = `${BASE}file_pageload_prefetch_target.sjs`;
// Unique per run, so repeated runs (e.g. --verify) share neither the HTTP
// cache entry nor the server's hit counter.
const RUN = Date.now();

// no-store, so that once the prefetch record is gone the navigation has to go
// back to the network rather than being served from the HTTP cache.
function targetURL(token) {
  return `${TARGET}?v=${token}-${RUN}&nostore=1`;
}

function sourceURL(target) {
  return `${BASE}file_pageload_prefetch_source.html?target=${encodeURIComponent(
    target
  )}`;
}

// How many times the server has been asked for the token's target.
async function hitCount(token) {
  const response = await fetch(`${TARGET}?count=${token}-${RUN}`);
  return Number(await response.text());
}

// Opens a page that prefetches a fresh target, waits for the prefetch to
// complete, runs `clear`, then navigates to the target. Returns the target's
// deliveryType and how many times the server was asked for it.
async function navigateAfterClearing(token, clear) {
  const target = targetURL(token);
  const prefetched = TestUtils.topicObserved(
    "http-on-stop-request",
    subject => subject.QueryInterface(Ci.nsIHttpChannel).URI.spec === target
  );
  const tab = await BrowserTestUtils.openNewForegroundTab({
    gBrowser,
    url: sourceURL(target),
    waitForLoad: true,
  });
  await prefetched;

  await clear();

  const loaded = BrowserTestUtils.browserLoaded(
    tab.linkedBrowser,
    false,
    target
  );
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, target);
  await loaded;

  const deliveryType = await SpecialPowers.spawn(
    tab.linkedBrowser,
    [],
    () => content.performance.getEntriesByType("navigation")[0].deliveryType
  );
  BrowserTestUtils.removeTab(tab);
  return { deliveryType, hits: await hitCount(token) };
}

function deleteData(flags) {
  return new Promise(resolve => {
    Services.clearData.deleteData(flags, resolve);
  });
}

function deleteDataFromSite(site, flags) {
  return new Promise(resolve => {
    Services.clearData.deleteDataFromSite(site, {}, true, flags, resolve);
  });
}

function deleteDataFromPrincipal(origin, isUserRequest, flags) {
  const principal =
    Services.scriptSecurityManager.createContentPrincipalFromOrigin(origin);
  return new Promise(resolve => {
    Services.clearData.deleteDataFromPrincipal(
      principal,
      isUserRequest,
      flags,
      resolve
    );
  });
}

function assertServedFromPrefetch({ deliveryType, hits }, msg) {
  Assert.equal(deliveryType, "navigational-prefetch", `${msg}: deliveryType`);
  Assert.equal(hits, 1, `${msg}: the target was fetched once`);
}

function assertNotServedFromPrefetch({ deliveryType, hits }, msg) {
  Assert.equal(deliveryType, "", `${msg}: deliveryType`);
  Assert.equal(hits, 2, `${msg}: the target was fetched again`);
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["dom.speculation_rules.enabled", true],
      ["dom.performance.deliverytype.enabled", true],
    ],
  });
});

add_task(async function test_no_clearing() {
  assertServedFromPrefetch(
    await navigateAfterClearing("none", async () => {}),
    "Without clearing"
  );
});

add_task(async function test_clear_all_caches() {
  assertNotServedFromPrefetch(
    await navigateAfterClearing("all", () =>
      deleteData(Ci.nsIClearDataService.CLEAR_ALL_CACHES)
    ),
    "After CLEAR_ALL_CACHES"
  );
});

add_task(async function test_clear_prefetch_cache() {
  assertNotServedFromPrefetch(
    await navigateAfterClearing("flag", () =>
      deleteData(Ci.nsIClearDataService.CLEAR_PREFETCH_CACHE)
    ),
    "After CLEAR_PREFETCH_CACHE"
  );
});

add_task(async function test_clear_unrelated_flag() {
  assertServedFromPrefetch(
    await navigateAfterClearing("cookies", () =>
      deleteData(Ci.nsIClearDataService.CLEAR_COOKIES)
    ),
    "After CLEAR_COOKIES"
  );
});

add_task(async function test_clear_by_site() {
  assertNotServedFromPrefetch(
    await navigateAfterClearing("site", () =>
      deleteDataFromSite(
        "example.com",
        Ci.nsIClearDataService.CLEAR_PREFETCH_CACHE
      )
    ),
    "After clearing example.com"
  );
});

add_task(async function test_clear_by_principal() {
  assertNotServedFromPrefetch(
    await navigateAfterClearing("principal", () =>
      deleteDataFromPrincipal(
        "https://example.com",
        true,
        Ci.nsIClearDataService.CLEAR_PREFETCH_CACHE
      )
    ),
    "After clearing https://example.com"
  );
});

// Not a user request, as when the Clear-Site-Data header clears the cache. The
// header discards prefetch records itself, matched on partitioned principal.
add_task(async function test_programmatic_clear_by_principal() {
  assertServedFromPrefetch(
    await navigateAfterClearing("programmatic", () =>
      deleteDataFromPrincipal(
        "https://example.org",
        false,
        Ci.nsIClearDataService.CLEAR_PREFETCH_CACHE
      )
    ),
    "After a programmatic clear of https://example.org"
  );
});
