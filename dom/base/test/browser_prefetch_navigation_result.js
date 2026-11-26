"use strict";

const BASE = "https://example.com/browser/dom/base/test/";

const RESULTS = [
  "served",
  "cache_miss",
  "expired",
  "hint_mismatch",
  "wait_timeout",
  "http_error",
  "too_large",
  "network_error",
  "canceled",
  "dry_run",
  "navigation_canceled",
];

function prefetchNavigationResults() {
  const results = {};
  for (const label of RESULTS) {
    const value =
      Glean.speculationRules.prefetchNavigationResult[label].testGetValue();
    if (value) {
      results[label] = value;
    }
  }
  return results;
}

function targetURL(
  token,
  { noStore = false, large = false, slow = 0, status = 0 } = {}
) {
  return (
    `${BASE}file_pageload_prefetch_target.sjs?v=${token}-${Date.now()}` +
    (noStore ? "&nostore=1" : "") +
    (large ? "&large=1" : "") +
    (slow ? `&slow=${slow}` : "") +
    (status ? `&status=${status}` : "")
  );
}

function sourceURL(
  target,
  { file = "file_pageload_prefetch_source.html", hint } = {}
) {
  return (
    `${BASE}${file}?target=${encodeURIComponent(target)}` +
    (hint ? `&hint=${encodeURIComponent(hint)}` : "")
  );
}

// A content round trip, which the parent handles after the PrefetchRecord
// actors the source page's rules created.
function rulesProcessed(browser) {
  return SpecialPowers.spawn(
    browser,
    [],
    () => new Promise(resolve => content.setTimeout(resolve, 0))
  );
}

// Navigates source -> target and returns the counted results.
async function resultsForNavigation({
  source,
  target,
  prefetchURL = target,
  waitForPrefetch = true,
  loadFlags,
  prefs = [],
}) {
  await SpecialPowers.pushPrefEnv({ set: prefs });

  const prefetched = waitForPrefetch
    ? TestUtils.topicObserved(
        "http-on-stop-request",
        subject =>
          subject.QueryInterface(Ci.nsIHttpChannel).URI.spec === prefetchURL
      )
    : Promise.resolve();

  Services.fog.testResetFOG();

  const tab = await BrowserTestUtils.openNewForegroundTab({
    gBrowser,
    url: source,
    waitForLoad: true,
  });
  try {
    await prefetched;
    if (!waitForPrefetch) {
      await rulesProcessed(tab.linkedBrowser);
    }
    const loaded = BrowserTestUtils.browserLoaded(
      tab.linkedBrowser,
      false,
      target
    );
    BrowserTestUtils.startLoadingURIString(
      tab.linkedBrowser,
      target,
      loadFlags
    );
    await loaded;
    return prefetchNavigationResults();
  } finally {
    await BrowserTestUtils.removeTab(tab);
    await SpecialPowers.popPrefEnv();
  }
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [["dom.speculation_rules.enabled", true]],
  });
});

add_task(async function test_served() {
  const target = targetURL("served");
  Assert.deepEqual(
    await resultsForNavigation({ source: sourceURL(target), target }),
    { served: 1 },
    "A navigation served from a prefetch counts served."
  );
});

add_task(async function test_nostore_served() {
  const target = targetURL("nostore", { noStore: true });
  Assert.deepEqual(
    await resultsForNavigation({ source: sourceURL(target), target }),
    { served: 1 },
    "A navigation served from a no-store prefetch counts served."
  );
});

add_task(async function test_cache_miss() {
  const target = targetURL("cachemiss");
  Assert.deepEqual(
    await resultsForNavigation({
      source: sourceURL(target),
      target,
      loadFlags: Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE,
    }),
    { cache_miss: 1 },
    "A navigation that bypasses the cache counts cache_miss."
  );
});

add_task(async function test_too_large() {
  const target = targetURL("large", { large: true });
  Assert.deepEqual(
    await resultsForNavigation({
      source: sourceURL(target),
      target,
      prefs: [["dom.speculation_rules.max_body_bytes", 64]],
    }),
    { too_large: 1 },
    "A prefetch over the body cap counts too_large."
  );
});

add_task(async function test_http_error() {
  const target = targetURL("httperror", { slow: 1, status: 404 });
  Assert.deepEqual(
    await resultsForNavigation({ source: sourceURL(target), target }),
    { http_error: 1 },
    "A prefetch with a 404 response counts http_error."
  );
});

add_task(async function test_wait_timeout() {
  const target = targetURL("timeout", { slow: 1000 });
  Assert.deepEqual(
    await resultsForNavigation({
      source: sourceURL(target),
      target,
      waitForPrefetch: false,
      prefs: [["dom.speculation_rules.wait_timeout_ms", 50]],
    }),
    { wait_timeout: 1 },
    "A prefetch still in flight after the wait counts wait_timeout."
  );
});

add_task(async function test_expired() {
  const target = targetURL("expired");
  Assert.deepEqual(
    await resultsForNavigation({
      source: sourceURL(target),
      target,
      prefs: [["dom.speculation_rules.record_expiry_ms", 0]],
    }),
    { expired: 1 },
    "An expired prefetch counts expired."
  );
});

add_task(async function test_hint_mismatch() {
  // No No-Vary-Search response header confirms the hint.
  const target = targetURL("hint");
  const prefetchURL = `${target}&extra=1`;
  Assert.deepEqual(
    await resultsForNavigation({
      source: sourceURL(prefetchURL, { hint: 'params=("extra")' }),
      target,
      prefetchURL,
    }),
    { hint_mismatch: 1 },
    "A prefetch covering the URL only through its hint counts hint_mismatch."
  );
});

add_task(async function test_dry_run() {
  const target = targetURL("dryrun");
  Assert.deepEqual(
    await resultsForNavigation({
      source: sourceURL(target),
      target,
      waitForPrefetch: false,
      prefs: [["dom.speculation_rules.prefetch.dry_run", true]],
    }),
    { dry_run: 1 },
    "A dry-run candidate counts dry_run."
  );
});

add_task(async function test_navigation_canceled() {
  await SpecialPowers.pushPrefEnv({
    set: [["dom.speculation_rules.wait_timeout_ms", 500]],
  });
  const target = targetURL("navcanceled", { slow: 1000 });
  const other = targetURL("navcanceled-other");
  Services.fog.testResetFOG();
  const tab = await BrowserTestUtils.openNewForegroundTab({
    gBrowser,
    url: sourceURL(target),
    waitForLoad: true,
  });
  try {
    await rulesProcessed(tab.linkedBrowser);
    // Resolves once the content process has sent the navigation to the
    // parent, which then opens it ahead of the load of `other`.
    await SpecialPowers.spawn(tab.linkedBrowser, [target], url => {
      const opened = new Promise(resolve => {
        const observer = subject => {
          if (subject.QueryInterface(Ci.nsIChannel).URI.spec === url) {
            Services.obs.removeObserver(
              observer,
              "document-on-opening-request"
            );
            resolve();
          }
        };
        Services.obs.addObserver(observer, "document-on-opening-request");
      });
      content.location.href = url;
      return opened;
    });
    const loaded = BrowserTestUtils.browserLoaded(
      tab.linkedBrowser,
      false,
      other
    );
    BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, other);
    await loaded;
    await TestUtils.waitForCondition(
      () => Object.keys(prefetchNavigationResults()).length,
      "Waiting for the canceled navigation to be counted"
    );
    Assert.deepEqual(
      prefetchNavigationResults(),
      { navigation_canceled: 1 },
      "A navigation canceled while waiting counts navigation_canceled."
    );
  } finally {
    await BrowserTestUtils.removeTab(tab);
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_no_rules() {
  const target = targetURL("norules");
  Assert.deepEqual(
    await resultsForNavigation({
      source: sourceURL(target, { file: "file_pageload_prefetch_plain.html" }),
      target,
      waitForPrefetch: false,
    }),
    {},
    "A navigation with no speculation rules counts nothing."
  );
});
