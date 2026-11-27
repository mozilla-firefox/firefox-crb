/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { BrowserProfiles } = ChromeUtils.importESModule(
  "moz-src:///browser/components/profiles/BrowserProfiles.sys.mjs"
);

add_task(async function test_each_window_has_its_own_instance() {
  let win = await BrowserTestUtils.openNewBrowserWindow();
  await win.gBrowserInit.idleTasksFinished.promise;

  Assert.strictEqual(
    gProfiles,
    BrowserProfiles.forWindow(window),
    "gProfiles is the main window's instance"
  );
  Assert.strictEqual(
    win.gProfiles,
    BrowserProfiles.forWindow(win),
    "gProfiles is the new window's instance"
  );
  Assert.notStrictEqual(
    win.gProfiles,
    gProfiles,
    "Each window has its own instance"
  );
  Assert.ok(SelectableProfileService.isEnabled, "Selectable profiles are on");
  Assert.ok(
    !win.document.getElementById("profiles-menu").hidden,
    "The new window's idle tasks set up its own profile menus"
  );

  await BrowserTestUtils.closeWindow(win);
});
