"use strict";

const BASE = "https://example.com/browser/dom/base/test/";
const TARGET = `${BASE}file_pageload_prefetch_target.sjs`;

function isRequestFor(subject, url, { prefetch }) {
  const channel = subject.QueryInterface(Ci.nsIHttpChannel);
  if (channel.URI.spec !== url) {
    return false;
  }
  let purpose = "";
  try {
    purpose = channel.getRequestHeader("Sec-Purpose");
  } catch (e) {}
  return purpose.startsWith("prefetch") == prefetch;
}

// Navigates to a prefetched target whose server holds back the end of the
// body, and calls aCheck({ tab, target, token, release }) once the target has
// started rendering. release() lets the body end.
async function navigateDuringBody(
  name,
  {
    noStore = false,
    contentLength = false,
    abort = false,
    redirect = false,
    navigateAtHead,
  },
  aCheck
) {
  const token = `${name}-${Date.now()}`;
  const target =
    `${TARGET}?v=${token}&held=1` +
    (noStore ? "&nostore=1" : "") +
    (contentLength ? "&length=1" : "") +
    (abort ? "&abort=1" : "");
  const navigated = redirect
    ? `${TARGET}?redirectto=${encodeURIComponent(target)}&r=${token}`
    : target;
  const source = `${BASE}file_pageload_prefetch_source.html?target=${encodeURIComponent(navigated)}`;
  const release = () => fetch(`${TARGET}?release=${token}`);

  const headArrived = TestUtils.topicObserved(
    "http-on-examine-response",
    subject => isRequestFor(subject, target, { prefetch: true })
  );

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

    // The title is in the part of the body sent with the headers, so it only
    // shows up before the release if the navigation is not waiting for the end.
    const titled = BrowserTestUtils.waitForEvent(
      tab.linkedBrowser,
      "pagetitlechanged",
      false,
      () => tab.linkedBrowser.contentTitle == "prefetch target"
    );
    BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, navigated);
    await titled;
    Assert.ok(true, "The target rendered while its body was still held back.");

    await aCheck({ tab, target, token, release });
  } finally {
    await release();
    await BrowserTestUtils.removeTab(tab);
  }
}

async function checkServed({ tab, target, token, release }) {
  const loaded = BrowserTestUtils.browserLoaded(
    tab.linkedBrowser,
    false,
    target
  );
  await release();
  await loaded;
  const { complete, hits, deliveryType } = await SpecialPowers.spawn(
    tab.linkedBrowser,
    [`${TARGET}?count=${token}`],
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
  await navigateDuringBody("afterhead", { navigateAtHead: true }, checkServed);
});

add_task(async function test_navigation_waiting_for_head() {
  await navigateDuringBody("waiting", { navigateAtHead: false }, checkServed);
});

add_task(async function test_no_store() {
  await navigateDuringBody(
    "nostore",
    { noStore: true, navigateAtHead: true },
    checkServed
  );
});

add_task(async function test_content_length() {
  await navigateDuringBody(
    "length",
    { contentLength: true, navigateAtHead: true },
    checkServed
  );
});

// The body cap must not cut off a response a navigation is being served,
// including one the navigation reaches through a redirect.
add_task(async function test_over_body_cap() {
  await SpecialPowers.pushPrefEnv({
    set: [["dom.speculation_rules.max_body_bytes", 50]],
  });
  try {
    await navigateDuringBody("overcap", { navigateAtHead: true }, checkServed);
    await navigateDuringBody(
      "overcap-redirect",
      { redirect: true, navigateAtHead: true },
      checkServed
    );
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

// A prefetch that fails mid-body must not leave the navigation looking
// complete.
add_task(async function test_prefetch_fails_mid_body() {
  await navigateDuringBody(
    "abort",
    { abort: true, navigateAtHead: true },
    async ({ target, release }) => {
      const stopped = TestUtils.topicObserved("http-on-stop-request", subject =>
        isRequestFor(subject, target, { prefetch: false })
      );
      await release();
      const [subject] = await stopped;
      Assert.equal(
        subject.QueryInterface(Ci.nsIRequest).status,
        Cr.NS_ERROR_NET_PARTIAL_TRANSFER,
        "The navigation fails with the prefetch it was reading."
      );
    }
  );
});
