/* Any copyright is dedicated to the Public Domain.
http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  sinon: "resource://testing-common/Sinon.sys.mjs",
  TaskbarTabs: "moz-src:///browser/components/taskbartabs/TaskbarTabs.sys.mjs",
  TaskbarTabsPin:
    "moz-src:///browser/components/taskbartabs/TaskbarTabsPin.sys.mjs",
});

const PAGE_URL = "https://example.com/";
const OTHER_SITE_URL = "https://example.org/";
const DESKTOP_ENTRY_ID = "org.test.webapp-alert";
const SERVICE_WORKER_URL =
  getRootDirectory(gTestPath).replace(
    "chrome://mochitests/content/",
    "https://example.com/"
  ) + "file_showNotification.serviceworker.js";

const PIN_RESULT = { shortcut: `${DESKTOP_ENTRY_ID}.desktop`, rejected: false };

sinon.stub(TaskbarTabsPin, "pinTaskbarTab").resolves(PIN_RESULT);
sinon.stub(TaskbarTabsPin, "unpinTaskbarTab");
registerCleanupFunction(() => sinon.restore());

// The app ID is resolved by the alerts service, so its real implementation is
// used, with the XUL backend because the system one cannot be driven from a
// test.
add_setup(async () => {
  await SpecialPowers.pushPrefEnv({
    set: [["alerts.useSystemBackend", false]],
  });
});

/**
 * Shows a notification from the page loaded in aBrowser, and returns the
 * alert that was shown.
 *
 * @param {Browser} aBrowser - The browser to show the notification from.
 * @returns {Promise<nsIAlertNotification>} The alert that was shown.
 */
async function showNotificationFrom(aBrowser) {
  const shown = TestUtils.topicObserved("web-notification-shown");
  await SpecialPowers.spawn(aBrowser, [], async () => {
    await SpecialPowers.pushPermissions([
      {
        type: "desktop-notification",
        allow: SpecialPowers.Services.perms.ALLOW_ACTION,
        context: content.document,
      },
    ]);
    const notification = new content.Notification("title");
    await new Promise((resolveShow, rejectShow) => {
      notification.onshow = resolveShow;
      notification.onerror = () => rejectShow(new Error("onerror"));
    });
    notification.close();
  });
  const [subject] = await shown;
  return subject.QueryInterface(Ci.nsIAlertNotification);
}

add_task(async function test_notificationAttribution() {
  const { window: webAppWindow, taskbarTab } = await openPinnedWebAppWindow();

  let alert = await showNotificationFrom(webAppWindow.gBrowser.selectedBrowser);
  Assert.equal(
    alert.appId,
    DESKTOP_ENTRY_ID,
    "A notification shown in the web app window belongs to the web app"
  );

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: PAGE_URL },
    async browser => {
      alert = await showNotificationFrom(browser);
      Assert.equal(
        alert.appId,
        DESKTOP_ENTRY_ID,
        "A notification shown in a regular tab of the same site belongs to the web app"
      );
    }
  );

  const webAppBrowser = webAppWindow.gBrowser.selectedBrowser;
  BrowserTestUtils.startLoadingURIString(webAppBrowser, OTHER_SITE_URL);
  await BrowserTestUtils.browserLoaded(webAppBrowser, false, OTHER_SITE_URL);
  alert = await showNotificationFrom(webAppBrowser);
  Assert.equal(
    alert.appId,
    "",
    "A notification from another site in the web app window belongs to Firefox"
  );

  await BrowserTestUtils.closeWindow(webAppWindow);
  await TaskbarTabs.removeTaskbarTab(taskbarTab.id);
});

async function openWebAppWindow() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE_URL);
  return TaskbarTabs.moveTabIntoTaskbarTab(tab);
}

async function openPinnedWebAppWindow() {
  const result = await openWebAppWindow();
  await TestUtils.waitForCondition(
    () => result.taskbarTab.shortcutRelativePath,
    "Waiting for the desktop entry to be recorded"
  );
  return result;
}

add_task(async function test_taskbarTabRemovedWhileWindowOpen() {
  const { window: webAppWindow, taskbarTab } = await openPinnedWebAppWindow();
  await TaskbarTabs.removeTaskbarTab(taskbarTab.id);

  const alert = await showNotificationFrom(
    webAppWindow.gBrowser.selectedBrowser
  );
  Assert.equal(
    alert.appId,
    "",
    "A notification from the window of a removed Taskbar Tab belongs to Firefox"
  );

  await BrowserTestUtils.closeWindow(webAppWindow);
});

add_task(async function test_taskbarTabWithoutDesktopEntry() {
  // Keep the pin pending so that no desktop entry is recorded.
  TaskbarTabsPin.pinTaskbarTab.returns(new Promise(() => {}));
  let webAppWindow, taskbarTab;
  try {
    ({ window: webAppWindow, taskbarTab } = await openWebAppWindow());
  } finally {
    TaskbarTabsPin.pinTaskbarTab.resolves(PIN_RESULT);
  }
  Assert.ok(
    !taskbarTab.shortcutRelativePath,
    "The Taskbar Tab has no desktop entry"
  );

  const alert = await showNotificationFrom(
    webAppWindow.gBrowser.selectedBrowser
  );
  Assert.equal(
    alert.appId,
    "",
    "A notification from a Taskbar Tab without a desktop entry belongs to Firefox"
  );

  await BrowserTestUtils.closeWindow(webAppWindow);
  await TaskbarTabs.removeTaskbarTab(taskbarTab.id);
});

add_task(async function test_taskbarTabsDisabled() {
  const { window: webAppWindow, taskbarTab } = await openPinnedWebAppWindow();

  await SpecialPowers.pushPrefEnv({
    set: [["browser.taskbarTabs.enabled", false]],
  });
  const alert = await showNotificationFrom(
    webAppWindow.gBrowser.selectedBrowser
  );
  Assert.equal(
    alert.appId,
    "",
    "A notification from a web app window belongs to Firefox while Taskbar Tabs is disabled"
  );
  await SpecialPowers.popPrefEnv();

  await BrowserTestUtils.closeWindow(webAppWindow);
  await TaskbarTabs.removeTaskbarTab(taskbarTab.id);
});

add_task(async function test_declarativePushNotification() {
  await SpecialPowers.pushPrefEnv({
    set: [["dom.push.declarative.enabled", true]],
  });
  const { window: webAppWindow, taskbarTab } = await openPinnedWebAppWindow();

  const principal = Services.scriptSecurityManager.createContentPrincipal(
    Services.io.newURI(PAGE_URL),
    {}
  );
  await SpecialPowers.pushPermissions([
    {
      type: "desktop-notification",
      allow: Services.perms.ALLOW_ACTION,
      context: PAGE_URL,
    },
  ]);
  const payload = new TextEncoder().encode(
    JSON.stringify({
      web_push: 8030,
      notification: { title: "title", navigate: PAGE_URL },
    })
  );

  const shown = TestUtils.topicObserved("web-notification-shown");
  await Cc["@mozilla.org/push/Notifier;1"]
    .getService(Ci.nsIPushNotifier)
    .notifyPushWithData(PAGE_URL, principal, "message", payload);
  const [subject] = await shown;
  const alert = subject.QueryInterface(Ci.nsIAlertNotification);
  Assert.equal(
    alert.appId,
    DESKTOP_ENTRY_ID,
    "A declarative push notification for the web app's site belongs to the web app"
  );

  Cc["@mozilla.org/alerts-service;1"]
    .getService(Ci.nsIAlertsService)
    .closeAlert(alert.name);
  await BrowserTestUtils.closeWindow(webAppWindow);
  await TaskbarTabs.removeTaskbarTab(taskbarTab.id);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_serviceWorkerNotification() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["dom.serviceWorkers.enabled", true],
      ["dom.serviceWorkers.testing.enabled", true],
    ],
  });
  const { window: webAppWindow, taskbarTab } = await openPinnedWebAppWindow();

  // The worker is registered from a regular tab, which does not matter since
  // only the URL is used.
  await BrowserTestUtils.withNewTab(
    { gBrowser, url: PAGE_URL },
    async browser => {
      const shown = TestUtils.topicObserved("web-notification-shown");
      await SpecialPowers.spawn(
        browser,
        [SERVICE_WORKER_URL],
        async aScriptUrl => {
          await SpecialPowers.pushPermissions([
            {
              type: "desktop-notification",
              allow: SpecialPowers.Services.perms.ALLOW_ACTION,
              context: content.document,
            },
          ]);
          const registration =
            await content.navigator.serviceWorker.register(aScriptUrl);
          const worker =
            registration.installing ||
            registration.waiting ||
            registration.active;
          await new Promise(resolve => {
            const check = () => {
              if (worker.state == "activated") {
                resolve();
              }
            };
            worker.addEventListener("statechange", check);
            check();
          });
          registration.active.postMessage("title");
        }
      );
      const [subject] = await shown;
      const alert = subject.QueryInterface(Ci.nsIAlertNotification);
      Assert.equal(
        alert.appId,
        DESKTOP_ENTRY_ID,
        "A service worker notification for the web app's site belongs to the web app"
      );

      await SpecialPowers.spawn(browser, [], async () => {
        for (const registration of await content.navigator.serviceWorker.getRegistrations()) {
          for (const notification of await registration.getNotifications()) {
            notification.close();
          }
          await registration.unregister();
        }
      });
    }
  );

  await BrowserTestUtils.closeWindow(webAppWindow);
  await TaskbarTabs.removeTaskbarTab(taskbarTab.id);
  await SpecialPowers.popPrefEnv();
});
