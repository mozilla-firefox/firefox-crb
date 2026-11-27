"use strict";

const BASE = "https://example.com/browser/dom/base/test/";
const TARGET = `${BASE}file_pageload_prefetch_target.sjs`;

function isPrefetchOf(subject, url) {
  const channel = subject.QueryInterface(Ci.nsIHttpChannel);
  if (channel.URI.spec !== url) {
    return false;
  }
  try {
    return channel.getRequestHeader("Sec-Purpose").startsWith("prefetch");
  } catch (e) {
    return false;
  }
}

// Navigates to a prefetched target whose body ends long after its headers,
// and checks that the navigation is served by the prefetch while the body is
// still arriving.
async function navigateDuringBody(
  token,
  { cacheControl, contentLength = false, navigateAtHead }
) {
  const target =
    `${TARGET}?v=${token}-${Date.now()}&slowbody=3000` +
    (cacheControl == "no-store" ? "&nostore=1" : "") +
    (contentLength ? "&length=1" : "");
  const source = `${BASE}file_pageload_prefetch_source.html?target=${encodeURIComponent(target)}`;

  let prefetchStopped = false;
  const stopped = TestUtils.topicObserved("http-on-stop-request", subject =>
    isPrefetchOf(subject, target)
  ).then(() => (prefetchStopped = true));
  const headArrived = TestUtils.topicObserved(
    "http-on-examine-response",
    subject => isPrefetchOf(subject, target)
  );

  Services.fog.testResetFOG();
  const tab = await BrowserTestUtils.openNewForegroundTab({
    gBrowser,
    url: source,
    waitForLoad: true,
  });
  try {
    if (navigateAtHead) {
      await headArrived;
    } else {
      // The parent has the record once this content round trip is over.
      await SpecialPowers.spawn(
        tab.linkedBrowser,
        [],
        () => new Promise(resolve => content.setTimeout(resolve, 0))
      );
    }

    const titled = BrowserTestUtils.waitForEvent(
      tab.linkedBrowser,
      "pagetitlechanged",
      false,
      () => tab.linkedBrowser.contentTitle == "prefetch target"
    );
    const loaded = BrowserTestUtils.browserLoaded(
      tab.linkedBrowser,
      false,
      target
    );
    BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, target);

    await titled;
    Assert.ok(
      !prefetchStopped,
      "The target started rendering while the prefetch was still downloading."
    );

    await loaded;
    await stopped;
    const { complete, hits, deliveryType } = await SpecialPowers.spawn(
      tab.linkedBrowser,
      [`${TARGET}?count=${new URL(target).searchParams.get("v")}`],
      async countURL => ({
        complete: !!content.document.getElementById("end"),
        hits: await (await content.fetch(countURL)).text(),
        deliveryType:
          content.performance.getEntriesByType("navigation")[0].deliveryType,
      })
    );
    Assert.ok(complete, "The navigation received the whole body.");
    Assert.equal(hits, "1", "The target was requested once.");
    Assert.equal(
      deliveryType,
      "navigational-prefetch",
      "The navigation was served by the prefetch."
    );
    Assert.equal(
      Glean.speculationRules.prefetchNavigationResult.served.testGetValue(),
      1,
      "The navigation counts served."
    );
  } finally {
    await BrowserTestUtils.removeTab(tab);
  }
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["dom.speculation_rules.enabled", true],
      ["dom.performance.deliverytype.enabled", true],
    ],
  });
});

add_task(async function test_navigation_after_head() {
  await navigateDuringBody("afterhead", { navigateAtHead: true });
});

add_task(async function test_navigation_waiting_for_head() {
  await navigateDuringBody("waiting", { navigateAtHead: false });
});

add_task(async function test_no_store() {
  await navigateDuringBody("nostore", {
    cacheControl: "no-store",
    navigateAtHead: true,
  });
});

add_task(async function test_content_length() {
  await navigateDuringBody("length", {
    contentLength: true,
    navigateAtHead: true,
  });
});

// The body cap must not cut off a response a navigation is being served.
add_task(async function test_over_body_cap() {
  await SpecialPowers.pushPrefEnv({
    set: [["dom.speculation_rules.max_body_bytes", 50]],
  });
  await navigateDuringBody("overcap", { navigateAtHead: true });
  await SpecialPowers.popPrefEnv();
});
