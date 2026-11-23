/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Error-page navigations are LOAD_BACKGROUND. Committing one still has to
// cancel the outgoing document's requests, like any other navigation.

const TEST_PATH = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com"
);
const FRAME_URL = TEST_PATH + "dummy_page.html";
const SLOW_URL = TEST_PATH + "file_slow_load.sjs?errorpage";

function waitForChannel(url) {
  return new Promise(resolve => {
    const observer = subject => {
      const channel = subject.QueryInterface(Ci.nsIChannel);
      if (channel.URI.spec == url) {
        Services.obs.removeObserver(observer, "http-on-modify-request");
        resolve(channel);
      }
    };
    Services.obs.addObserver(observer, "http-on-modify-request");
  });
}

async function testErrorPageCancelsOutgoingRequests(newLoadGroup) {
  await SpecialPowers.pushPrefEnv({
    set: [["docshell.navigation.new_load_group", newLoadGroup]],
  });

  await BrowserTestUtils.withNewTab(FRAME_URL, async browser => {
    await SpecialPowers.spawn(browser, [FRAME_URL], async url => {
      const iframe = content.document.createElement("iframe");
      const loaded = new Promise(r => (iframe.onload = r));
      iframe.src = url;
      content.document.body.append(iframe);
      await loaded;
    });
    const frameBC = browser.browsingContext.children[0];

    const channelPromise = waitForChannel(SLOW_URL);
    await SpecialPowers.spawn(frameBC, [SLOW_URL], async url => {
      // Resolves on the response headers; the body never finishes.
      await content.fetch(url);
    });
    const channel = await channelPromise;
    ok(!channel.canceled, "The fetch is in flight before the error page");

    await SpecialPowers.spawn(frameBC, [FRAME_URL], url => {
      docShell.displayLoadError(
        Cr.NS_ERROR_CONNECTION_REFUSED,
        Services.io.newURI(url),
        null,
        null
      );
    });
    await TestUtils.waitForCondition(
      () =>
        frameBC.currentWindowGlobal?.documentURI.spec.startsWith(
          "about:neterror"
        ),
      "The error page commits in the frame"
    );
    // The child's cancel is sent before the error page's window global, so
    // a round trip is enough for it to have reached the parent.
    await SpecialPowers.spawn(frameBC, [], () => {});

    ok(channel.canceled, "Committing the error page cancelled the fetch");
  });

  await SpecialPowers.popPrefEnv();
}

add_task(async function test_new_load_group() {
  await testErrorPageCancelsOutgoingRequests(true);
});

add_task(async function test_old_load_group() {
  await testErrorPageCancelsOutgoingRequests(false);
});
