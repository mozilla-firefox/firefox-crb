/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

// Searching and loading a URL from the about:privatebrowsing search bar.

"use strict";

let win;

add_setup(async function () {
  await SearchTestUtils.updateRemoteSettingsConfig([
    { identifier: "engine1" },
    {
      identifier: "privateEngine",
      base: {
        urls: {
          search: {
            base: "https://example.com/private",
            searchTermParamName: "q",
          },
        },
      },
    },
    { globalDefault: "engine1", globalDefaultPrivate: "privateEngine" },
  ]);
  win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  registerCleanupFunction(() => BrowserTestUtils.closeWindow(win));
});

add_task(async function search() {
  let expectedURL = "https://example.com/private?q=foo";
  let tab = await NewtabSearchbarTestUtils.openPrivateBrowsingPage(win);
  let browser = tab.linkedBrowser;

  await NewtabSearchbarTestUtils.promiseAutocompleteResultPopup({
    browser,
    value: "foo",
  });
  let loaded = BrowserTestUtils.browserLoaded(browser, false, expectedURL);
  await BrowserTestUtils.synthesizeKey("KEY_Enter", {}, browser);
  await loaded;

  Assert.equal(
    browser.currentURI.spec,
    expectedURL,
    "Did a search using the private default engine"
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function navigate() {
  let testURL = "https://example.com/";
  let tab = await NewtabSearchbarTestUtils.openPrivateBrowsingPage(win);
  let browser = tab.linkedBrowser;

  await NewtabSearchbarTestUtils.promiseAutocompleteResultPopup({
    browser,
    value: testURL,
  });
  let loaded = BrowserTestUtils.browserLoaded(browser, false, testURL);
  await BrowserTestUtils.synthesizeKey("KEY_Enter", {}, browser);
  await loaded;

  Assert.equal(browser.currentURI.spec, testURL, "Loaded the URL");
  BrowserTestUtils.removeTab(tab);
});
