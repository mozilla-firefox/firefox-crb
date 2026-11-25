/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

// This test is for testing races of loading the Urlbar when loading shortcuts.
// For example, ensuring that if a search query is entered, but something causes
// a page load whilst we're getting the search url, then we don't handle the
// original search query.

const { UrlbarParentController } = ChromeUtils.importESModule(
  "moz-src:///browser/components/urlbar/UrlbarParentController.sys.mjs"
);

async function checkShortcutLoading(modifierKeys) {
  let tab = await BrowserTestUtils.openNewForegroundTab({
    gBrowser,
    opening: "about:robots",
  });

  // The class covers both the direct and message paths.
  const urlbarParentControllerProxy = TestUtils.asyncControlProxy(
    UrlbarParentController
  );
  using resolveFallbackNavigationController =
    urlbarParentControllerProxy.resolveFallbackNavigation();
  using getHeuristicResultController =
    urlbarParentControllerProxy.getHeuristicResult();

  // Use a string that will be interpreted as a local URL to avoid hitting the
  // network.
  gURLBar.focus();
  gURLBar.value = "example.com";
  gURLBar.userTypedValue = true;
  EventUtils.synthesizeKey("KEY_Enter", modifierKeys);

  const fallbackResultPromise =
    resolveFallbackNavigationController.waitForResult();

  // Hold the heuristic lookup until a different page loads in the same tab.
  await getHeuristicResultController.waitForInterception();

  // Now load a different page.
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, "about:license");
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  Assert.equal(gBrowser.visibleTabs.length, 2, "Should have 2 tabs");

  let tabOpened =
    modifierKeys && BrowserTestUtils.waitForNewTab(gBrowser, null, true);
  getHeuristicResultController.releaseResult();

  const fallbackResult = await fallbackResultPromise;
  if (!modifierKeys) {
    Assert.deepEqual(
      fallbackResult,
      {},
      "The parent discards the stale navigation"
    );
  }
  await resolveFallbackNavigationController.releaseResult();

  if (modifierKeys) {
    let openedTab = await tabOpened;
    Assert.ok(
      openedTab.linkedBrowser.currentURI.spec.includes("example.com"),
      "Should have attempted to open the shortcut page"
    );
    BrowserTestUtils.removeTab(openedTab);
  }

  Assert.equal(
    tab.linkedBrowser.currentURI.spec,
    "about:license",
    "Tab url should not have changed"
  );
  Assert.equal(gBrowser.visibleTabs.length, 2, "Should still have 2 tabs");

  BrowserTestUtils.removeTab(tab);
}

add_task(async function test_location_change_stops_load() {
  await checkShortcutLoading();
});

add_task(async function test_opening_different_tab_with_location_change() {
  await checkShortcutLoading({ altKey: true });
});
