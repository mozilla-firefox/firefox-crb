"use strict";

const TEST_URL =
  "https://example.com/browser/browser/components/extensions/test/browser/file_dummy.html";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [["privacy.userContext.enabled", true]],
  });
  await PlacesUtils.history.clear();
  registerCleanupFunction(() => PlacesUtils.history.clear());
});

add_task(async function test_history_in_containers() {
  async function background(url) {
    async function visitInContainer(cookieStoreId) {
      let visited = new Promise(resolve => {
        browser.history.onVisited.addListener(function listener(item) {
          if (item.url === url) {
            browser.history.onVisited.removeListener(listener);
            resolve(item);
          }
        });
      });
      let tab = await browser.tabs.create({ url, cookieStoreId });
      browser.test.assertEq(
        cookieStoreId,
        tab.cookieStoreId,
        "The tab is opened in the requested container"
      );
      let item = await visited;
      browser.test.assertEq(
        cookieStoreId,
        item.cookieStoreId,
        "onVisited reports the container of the tab"
      );
      await browser.tabs.remove(tab.id);
    }

    async function getVisitCookieStoreIds() {
      let visits = await browser.history.getVisits({ url });
      return visits.map(v => v.cookieStoreId).sort();
    }

    await visitInContainer("firefox-default");
    await visitInContainer("firefox-container-1");
    await visitInContainer("firefox-container-2");

    browser.test.assertDeepEq(
      ["firefox-container-1", "firefox-container-2", "firefox-default"],
      await getVisitCookieStoreIds(),
      "getVisits returns the visits of every container"
    );

    let items = await browser.history.search({ text: url, startTime: 0 });
    browser.test.assertDeepEq(
      [url],
      items.map(item => item.url),
      "search finds the page"
    );

    await browser.history.deleteUrl({
      url,
      cookieStoreId: "firefox-container-1",
    });
    browser.test.assertDeepEq(
      ["firefox-container-2", "firefox-default"],
      await getVisitCookieStoreIds(),
      "deleteUrl only removes the visits of the container"
    );

    await browser.history.deleteRange({
      startTime: 0,
      endTime: Date.now(),
      cookieStoreId: "firefox-container-2",
    });
    browser.test.assertDeepEq(
      ["firefox-default"],
      await getVisitCookieStoreIds(),
      "deleteRange only removes the visits of the container"
    );

    await visitInContainer("firefox-container-1");
    await browser.browsingData.removeHistory({
      cookieStoreId: "firefox-default",
    });
    browser.test.assertDeepEq(
      ["firefox-container-1"],
      await getVisitCookieStoreIds(),
      "browsingData.removeHistory only removes the visits of the container"
    );

    browser.test.sendMessage("done");
  }

  let extension = ExtensionTestUtils.loadExtension({
    manifest: {
      permissions: ["history", "cookies", "tabs", "browsingData"],
    },
    background: `(${background})(${JSON.stringify(TEST_URL)})`,
  });

  await extension.startup();
  await extension.awaitMessage("done");
  await extension.unload();
});
