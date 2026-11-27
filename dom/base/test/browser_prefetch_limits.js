"use strict";

const BASE = "https://example.com/browser/dom/base/test/";
const TARGET = `${BASE}file_pageload_prefetch_target.sjs`;

// A fresh target per call. Targets are no-store, so a navigation only avoids
// the network when it is activated from its prefetch.
function newTarget(name, extra = "") {
  const token = `${name}-${Date.now()}-${Math.random()}`;
  return { token, url: `${TARGET}?v=${token}&nostore=1${extra}` };
}

async function hits(target) {
  const response = await fetch(`${TARGET}?count=${target.token}`);
  return Number(await response.text());
}

function sourceURL({ immediate = [], conservative = [] }) {
  const params = new URLSearchParams({
    immediate: JSON.stringify(immediate.map(t => t.url)),
    conservative: JSON.stringify(conservative.map(t => t.url)),
  });
  return `${BASE}file_prefetch_limits_source.html?${params}`;
}

// Navigation channels have no Sec-Purpose header, and reading a missing
// header throws.
function isPrefetch(channel) {
  try {
    return channel.getRequestHeader("Sec-Purpose") === "prefetch";
  } catch {
    return false;
  }
}

function prefetchStopped(target) {
  return TestUtils.topicObserved("http-on-stop-request", subject => {
    const channel = subject.QueryInterface(Ci.nsIHttpChannel);
    return channel.URI.spec === target.url && isPrefetch(channel);
  });
}

// Resolves once aCount prefetches of any of aTargets have finished.
function prefetchesStopped(targets, count) {
  const urls = new Set(targets.map(t => t.url));
  let stopped = 0;
  return TestUtils.topicObserved("http-on-stop-request", subject => {
    const channel = subject.QueryInterface(Ci.nsIHttpChannel);
    if (urls.has(channel.URI.spec) && isPrefetch(channel)) {
      ++stopped;
    }
    return stopped === count;
  });
}

// Messages to the content process and its prefetch records share a channel,
// so once this round trip completes the parent has seen every prefetch record
// the page created before it.
function flushPrefetchRecords(browser) {
  return SpecialPowers.spawn(browser, [], async () => {
    await new Promise(resolve => content.setTimeout(resolve, 0));
  });
}

// A conservative candidate is enacted when its link is pressed. The button is
// released elsewhere so that no click, and so no navigation, follows.
async function pressLink(browser, index) {
  await BrowserTestUtils.synthesizeMouseAtCenter(
    `#link${index}`,
    { type: "mousedown" },
    browser
  );
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#blank",
    { type: "mouseup" },
    browser
  );
  await flushPrefetchRecords(browser);
}

// Adds an immediate rule for aTarget to the page after it has loaded.
async function addImmediateRule(browser, target) {
  await SpecialPowers.spawn(browser, [target.url], async url => {
    const script = content.document.createElement("script");
    script.type = "speculationrules";
    script.textContent = JSON.stringify({
      prefetch: [{ source: "list", urls: [url], eagerness: "immediate" }],
    });
    content.document.head.appendChild(script);
  });
  await flushPrefetchRecords(browser);
}

// Navigates to aTarget and reports how the navigation was served. The HTTP
// channel notifies http-on-examine-cached-response for a response read from
// the cache, and http-on-examine-response for one from the network.
async function navigate(browser, target) {
  const served = new Promise(resolve => {
    const topics = [
      "http-on-examine-response",
      "http-on-examine-cached-response",
    ];
    const observer = (subject, topic) => {
      const channel = subject.QueryInterface(Ci.nsIHttpChannel);
      if (channel.URI.spec !== target.url || isPrefetch(channel)) {
        return;
      }
      topics.forEach(t => Services.obs.removeObserver(observer, t));
      resolve({
        fromPrefetch: channel.loadInfo.activatedFromNavigationalPrefetch,
        fromCache: topic === "http-on-examine-cached-response",
      });
    };
    topics.forEach(t => Services.obs.addObserver(observer, t));
  });
  BrowserTestUtils.startLoadingURIString(browser, target.url);
  const navigation = await served;
  await BrowserTestUtils.browserLoaded(browser, false, target.url);
  navigation.hits = await hits(target);
  return navigation;
}

// Targets are no-store, so a navigation that isn't activated from a prefetch
// can only be served from the network.
function assertServedFromPrefetch(navigation, message) {
  Assert.ok(
    navigation.fromPrefetch,
    `${message}: activated from the prefetch.`
  );
  Assert.ok(navigation.fromCache, `${message}: served from the cache.`);
  Assert.equal(navigation.hits, 1, `${message}: no further network request.`);
}

function assertServedFromNetwork(navigation, message) {
  Assert.ok(
    !navigation.fromPrefetch,
    `${message}: not activated from a prefetch.`
  );
  Assert.ok(!navigation.fromCache, `${message}: not served from the cache.`);
  Assert.equal(navigation.hits, 2, `${message}: fetched again.`);
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [["dom.speculation_rules.enabled", true]],
  });
});

add_task(async function test_immediate_prefetches_are_capped() {
  for (const limit of [1, 3]) {
    await SpecialPowers.pushPrefEnv({
      set: [["dom.speculation_rules.max_immediate_prefetches", limit]],
    });

    // Slow responses keep the accepted prefetches in flight while the rest
    // are considered, so in-flight prefetches have to count.
    const targets = ["a", "b", "c", "d", "e"].map(n =>
      newTarget(n, "&slow=500")
    );
    const stopped = prefetchesStopped(targets, limit);
    const tab = await BrowserTestUtils.openNewForegroundTab({
      gBrowser,
      url: sourceURL({ immediate: targets }),
      waitForLoad: true,
    });
    await flushPrefetchRecords(tab.linkedBrowser);
    await stopped;

    const requested = (await Promise.all(targets.map(hits))).filter(h => h);
    Assert.equal(
      requested.length,
      limit,
      `With a budget of ${limit}, only ${limit} of 5 immediate prefetches are fetched.`
    );

    BrowserTestUtils.removeTab(tab);
    await SpecialPowers.popPrefEnv();
  }
});

// How many of this document's prefetch records started a fetch. Each such
// record is reported once, when discarded with its document; a record
// rejected before its fetch started is never reported.
function fetchedRecords() {
  return ["used", "unused", "incomplete"].reduce(
    (sum, label) =>
      sum +
      (Glean.speculationRules.prefetchTransferSize[label].testGetValue()
        ?.count ?? 0),
    0
  );
}

add_task(async function test_expired_prefetches_free_their_budget() {
  if (Services.prefs.getBoolPref("telemetry.fog.artifact_build", false)) {
    Assert.ok(true, "Test skipped in artifact builds. See bug 1836686.");
    return;
  }

  for (const expiryMs of [300000, 0]) {
    Services.fog.testResetFOG();
    await SpecialPowers.pushPrefEnv({
      set: [
        ["dom.speculation_rules.max_immediate_prefetches", 1],
        ["dom.speculation_rules.record_expiry_ms", expiryMs],
      ],
    });

    const first = newTarget("first");
    const second = newTarget("second");
    const stopped = prefetchStopped(first);
    const tab = await BrowserTestUtils.openNewForegroundTab({
      gBrowser,
      url: sourceURL({ immediate: [first] }),
      waitForLoad: true,
    });
    await stopped;

    await addImmediateRule(tab.linkedBrowser, second);
    // A document's records are all discarded with it, so once one is
    // reported, every record that started a fetch has been.
    BrowserTestUtils.removeTab(tab);
    await TestUtils.waitForCondition(
      () => fetchedRecords() >= 1,
      "Wait for the discarded records to be reported."
    );

    if (expiryMs) {
      Assert.equal(
        fetchedRecords(),
        1,
        "A completed prefetch that hasn't expired uses up the budget."
      );
      Assert.equal(await hits(second), 0, "The second target isn't fetched.");
    } else {
      Assert.equal(
        fetchedRecords(),
        2,
        "An expired prefetch no longer counts against the budget."
      );
    }

    await SpecialPowers.popPrefEnv();
  }
});

// Presses the links of four conservative targets in order, letting each
// prefetch complete before the next, then navigates to targets[aIndex].
// Returns how often each target was requested, and how the navigation was
// served.
async function pressAllThenNavigate(aIndex) {
  const targets = ["first", "second", "third", "fourth"].map(n => newTarget(n));
  const tab = await BrowserTestUtils.openNewForegroundTab({
    gBrowser,
    url: sourceURL({ conservative: targets }),
    waitForLoad: true,
  });
  const browser = tab.linkedBrowser;

  const prefetched = [];
  for (let i = 0; i < targets.length; ++i) {
    const stopped = prefetchStopped(targets[i]);
    await pressLink(browser, i);
    await stopped;
    prefetched.push(await hits(targets[i]));
  }

  const navigation = await navigate(browser, targets[aIndex]);
  BrowserTestUtils.removeTab(tab);
  return { prefetched, navigation };
}

add_task(async function test_non_immediate_budget_evicts_oldest_first() {
  await SpecialPowers.pushPrefEnv({
    set: [["dom.speculation_rules.max_non_immediate_prefetches", 2]],
  });

  // With a budget of 2, the third and fourth prefetches evict the first and
  // second. A navigation is served from a kept prefetch, but has to fetch an
  // evicted one again.
  const expected = [
    { index: 0, kept: false },
    { index: 1, kept: false },
    { index: 2, kept: true },
    { index: 3, kept: true },
  ];
  for (const { index, kept } of expected) {
    const { prefetched, navigation } = await pressAllThenNavigate(index);
    Assert.deepEqual(
      prefetched,
      [1, 1, 1, 1],
      "The newest candidate is prefetched every time."
    );
    if (kept) {
      assertServedFromPrefetch(navigation, `Prefetch ${index + 1} is kept`);
    } else {
      assertServedFromNetwork(navigation, `Prefetch ${index + 1} is evicted`);
    }
  }

  await SpecialPowers.popPrefEnv();
});

add_task(async function test_non_immediate_budget_never_evicts_inflight() {
  await SpecialPowers.pushPrefEnv({
    set: [["dom.speculation_rules.max_non_immediate_prefetches", 1]],
  });

  const inflight = newTarget("inflight", "&slow=500");
  const rejected = newTarget("rejected");
  const tab = await BrowserTestUtils.openNewForegroundTab({
    gBrowser,
    url: sourceURL({ conservative: [inflight, rejected] }),
    waitForLoad: true,
  });
  const browser = tab.linkedBrowser;

  const stopped = prefetchStopped(inflight);
  await pressLink(browser, 0);
  await pressLink(browser, 1);
  await stopped;

  Assert.equal(
    await hits(rejected),
    0,
    "With only an in-flight prefetch to evict, the new candidate is rejected."
  );

  assertServedFromPrefetch(
    await navigate(browser, inflight),
    "The in-flight prefetch is kept"
  );

  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_budgets_are_independent() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["dom.speculation_rules.max_immediate_prefetches", 1],
      ["dom.speculation_rules.max_non_immediate_prefetches", 1],
    ],
  });

  // A full immediate budget doesn't stop a non-immediate prefetch, and the
  // non-immediate prefetch doesn't evict the immediate one.
  {
    const immediate = newTarget("immediate");
    const conservative = newTarget("conservative");
    const immediateStopped = prefetchStopped(immediate);
    const tab = await BrowserTestUtils.openNewForegroundTab({
      gBrowser,
      url: sourceURL({ immediate: [immediate], conservative: [conservative] }),
      waitForLoad: true,
    });
    const browser = tab.linkedBrowser;
    await immediateStopped;

    const conservativeStopped = prefetchStopped(conservative);
    await pressLink(browser, 0);
    await conservativeStopped;
    Assert.equal(
      await hits(conservative),
      1,
      "A full immediate budget doesn't block a non-immediate prefetch."
    );

    assertServedFromPrefetch(
      await navigate(browser, immediate),
      "The non-immediate prefetch doesn't evict the immediate one"
    );
    BrowserTestUtils.removeTab(tab);
  }

  // A full non-immediate budget doesn't stop an immediate prefetch, and the
  // immediate prefetch doesn't evict the non-immediate one.
  {
    const conservative = newTarget("conservative");
    const immediate = newTarget("immediate");
    const tab = await BrowserTestUtils.openNewForegroundTab({
      gBrowser,
      url: sourceURL({ conservative: [conservative] }),
      waitForLoad: true,
    });
    const browser = tab.linkedBrowser;

    const conservativeStopped = prefetchStopped(conservative);
    await pressLink(browser, 0);
    await conservativeStopped;

    const immediateStopped = prefetchStopped(immediate);
    await addImmediateRule(browser, immediate);
    await immediateStopped;
    Assert.equal(
      await hits(immediate),
      1,
      "A full non-immediate budget doesn't block an immediate prefetch."
    );

    assertServedFromPrefetch(
      await navigate(browser, conservative),
      "The immediate prefetch doesn't evict the non-immediate one"
    );
    BrowserTestUtils.removeTab(tab);
  }

  await SpecialPowers.popPrefEnv();
});
