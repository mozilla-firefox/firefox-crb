/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { BrowserThumbnails } = ChromeUtils.importESModule(
  "moz-src:///browser/modules/BrowserThumbnails.sys.mjs"
);

add_task(async function test_each_window_has_its_own_instance() {
  let win = await BrowserTestUtils.openNewBrowserWindow();
  await win.gBrowserInit.idleTasksFinished.promise;

  let mainTopSites = BrowserThumbnails.getTopSiteURLs(window);
  let newTopSites = BrowserThumbnails.getTopSiteURLs(win);
  Assert.ok(
    mainTopSites && newTopSites,
    "Each window's idle tasks create its thumbnails instance"
  );
  Assert.notStrictEqual(
    mainTopSites,
    newTopSites,
    "Each window caches its own top site URLs"
  );

  BrowserThumbnails.clearTopSiteURLCache(win);
  Assert.notStrictEqual(
    BrowserThumbnails.getTopSiteURLs(win),
    newTopSites,
    "Clearing a window's cache replaces its top site URLs"
  );
  Assert.strictEqual(
    BrowserThumbnails.getTopSiteURLs(window),
    mainTopSites,
    "Clearing one window's cache leaves the other window's alone"
  );

  await BrowserTestUtils.closeWindow(win);
  Assert.strictEqual(
    BrowserThumbnails.getTopSiteURLs(win),
    undefined,
    "Closing a window removes its instance"
  );
  Assert.strictEqual(
    BrowserThumbnails.getTopSiteURLs(window),
    mainTopSites,
    "Closing a window leaves the other window's instance alone"
  );

  BrowserThumbnails.clearTopSiteURLCache(window);
});
