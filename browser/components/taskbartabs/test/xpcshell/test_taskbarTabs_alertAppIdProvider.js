/* Any copyright is dedicated to the Public Domain.
http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const kPinnedId = "4186657a-0fe5-492a-af64-dc628c232c4c";
const kUnpinnedId = "9c4a4c2b-2d0a-4f43-9a35-9a6d2c8d8f10";
const kContainerId = "0b8a7d47-6f7a-4b8f-93b8-1f0b3c7c6a55";
const kPrefixedId = "e2f1b3c4-5d6e-4f70-8a91-b2c3d4e5f607";
const kNotDesktopId = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
const kSharedMailId = "7d1e2f3a-4b5c-4d6e-9f80-a1b2c3d4e5f6";
const kSharedCalendarId = "8e2f3a4b-5c6d-4e7f-8091-b2c3d4e5f6a7";
const kTaskbarTabsModule =
  "moz-src:///browser/components/taskbartabs/TaskbarTabs.sys.mjs";

let gProvider;

add_setup(async function test_setup() {
  Services.prefs.setBoolPref("browser.taskbarTabs.enabled", true);
  registerCleanupFunction(() =>
    Services.prefs.clearUserPref("browser.taskbarTabs.enabled")
  );

  const taskbarTabsJSON = do_get_profile();
  taskbarTabsJSON.append("taskbartabs");
  taskbarTabsJSON.append("taskbartabs.json");
  await IOUtils.writeJSON(taskbarTabsJSON.path, {
    version: 1,
    taskbarTabs: [
      {
        id: kPinnedId,
        scopes: [{ hostname: "pinned.example.com" }],
        userContextId: 0,
        startUrl: "https://pinned.example.com/",
        shortcutRelativePath: `org.mozilla.firefox.webapp-${kPinnedId}.desktop`,
      },
      {
        id: kUnpinnedId,
        scopes: [{ hostname: "unpinned.example.com" }],
        userContextId: 0,
        startUrl: "https://unpinned.example.com/",
      },
      {
        id: kContainerId,
        scopes: [{ hostname: "container.example.com" }],
        userContextId: 2,
        startUrl: "https://container.example.com/",
        shortcutRelativePath: `org.mozilla.firefox.webapp-${kContainerId}.desktop`,
      },
      {
        id: kPrefixedId,
        scopes: [{ hostname: "prefix.example.com", prefix: "/app/" }],
        userContextId: 0,
        startUrl: "https://prefix.example.com/app/",
        shortcutRelativePath: `subdir/org.mozilla.firefox.webapp-${kPrefixedId}.desktop`,
      },
      {
        id: kNotDesktopId,
        scopes: [{ hostname: "lnk.example.com" }],
        userContextId: 0,
        startUrl: "https://lnk.example.com/",
        shortcutRelativePath: "Firefox Web Apps/Example.lnk",
      },
      {
        id: kSharedMailId,
        scopes: [{ hostname: "shared.example.com", prefix: "/mail/" }],
        userContextId: 0,
        startUrl: "https://shared.example.com/mail/",
        shortcutRelativePath: `org.mozilla.firefox.webapp-${kSharedMailId}.desktop`,
      },
      {
        id: kSharedCalendarId,
        scopes: [{ hostname: "shared.example.com", prefix: "/calendar/" }],
        userContextId: 0,
        startUrl: "https://shared.example.com/calendar/",
        shortcutRelativePath: `org.mozilla.firefox.webapp-${kSharedCalendarId}.desktop`,
      },
    ],
  });

  gProvider = Cc["@mozilla.org/alert-app-id-provider;1"].getService(
    Ci.nsIAlertAppIdProvider
  );
});

function appIdFor(aSpec, aUserContextId = 0) {
  return gProvider.getAppId(Services.io.newURI(aSpec), aUserContextId);
}

// Must stay the first task: it relies on nothing having loaded the registry.
add_task(async function test_registryNotLoaded() {
  Assert.ok(
    !Cu.isESModuleLoaded(kTaskbarTabsModule),
    "The Taskbar Tabs registry has not been loaded yet"
  );
  Assert.equal(
    appIdFor("https://pinned.example.com/"),
    "",
    "Notifications belong to Firefox until the registry is loaded"
  );

  const { TaskbarTabs } = ChromeUtils.importESModule(kTaskbarTabsModule);
  await TaskbarTabs.waitUntilReady();
  Assert.equal(
    appIdFor("https://pinned.example.com/"),
    `org.mozilla.firefox.webapp-${kPinnedId}`,
    "Notifications are attributed once the registry is loaded"
  );
});

add_task(async function test_matchingTaskbarTabWithDesktopEntry() {
  Assert.equal(
    appIdFor("https://pinned.example.com/inbox"),
    `org.mozilla.firefox.webapp-${kPinnedId}`,
    "The desktop entry of the matching Taskbar Tab is used"
  );
});

add_task(async function test_noDesktopEntry() {
  Assert.equal(
    appIdFor("https://unpinned.example.com/"),
    "",
    "A Taskbar Tab without a desktop entry is not used"
  );
});

add_task(async function test_shortcutIsNotDesktopEntry() {
  Assert.equal(
    appIdFor("https://lnk.example.com/"),
    "",
    "A shortcut that is not a desktop entry is not used"
  );
});

add_task(async function test_noMatchingTaskbarTab() {
  Assert.equal(
    appIdFor("https://other.example.com/"),
    "",
    "No app ID for a URL without a Taskbar Tab"
  );
  Assert.equal(
    appIdFor("https://sub.pinned.example.com/"),
    "",
    "Subdomains do not match"
  );
});

add_task(async function test_container() {
  Assert.equal(
    appIdFor("https://container.example.com/", 2),
    `org.mozilla.firefox.webapp-${kContainerId}`,
    "Matches within the Taskbar Tab's container"
  );
  Assert.equal(
    appIdFor("https://container.example.com/", 0),
    "",
    "Does not match in a different container"
  );
});

add_task(async function test_prefixScope() {
  Assert.equal(
    appIdFor("https://prefix.example.com/app/page"),
    `org.mozilla.firefox.webapp-${kPrefixedId}`,
    "Matches within the scope prefix, ignoring subdirectories of the shortcut"
  );
  Assert.equal(
    appIdFor("https://prefix.example.com/"),
    `org.mozilla.firefox.webapp-${kPrefixedId}`,
    "Matches outside the scope prefix when it is the only Taskbar Tab on the host"
  );
});

add_task(async function test_severalTaskbarTabsOnHost() {
  Assert.equal(
    appIdFor("https://shared.example.com/calendar/u/0/sw.js"),
    `org.mozilla.firefox.webapp-${kSharedCalendarId}`,
    "The scope prefix chooses between Taskbar Tabs on the same host"
  );
  Assert.equal(
    appIdFor("https://shared.example.com/"),
    "",
    "No app ID when the URL does not choose between them"
  );
});

add_task(async function test_nonURL() {
  Assert.equal(appIdFor("about:blank"), "", "Non-URL URIs are ignored");
});

add_task(async function test_taskbarTabsDisabled() {
  Services.prefs.setBoolPref("browser.taskbarTabs.enabled", false);
  Assert.equal(
    appIdFor("https://pinned.example.com/inbox"),
    "",
    "No app ID while Taskbar Tabs is disabled"
  );
  Services.prefs.setBoolPref("browser.taskbarTabs.enabled", true);
});
