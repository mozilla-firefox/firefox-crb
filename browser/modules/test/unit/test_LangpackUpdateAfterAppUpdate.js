/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { AddonManager } = ChromeUtils.importESModule(
  "resource://gre/modules/AddonManager.sys.mjs"
);
const { AddonTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/AddonTestUtils.sys.mjs"
);
const { BrowserWindowTracker } = ChromeUtils.importESModule(
  "resource:///modules/BrowserWindowTracker.sys.mjs"
);
const { ExtensionTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/ExtensionXPCShellUtils.sys.mjs"
);
const { LangpackUpdateAfterAppUpdate } = ChromeUtils.importESModule(
  "moz-src:///browser/modules/LangpackUpdateAfterAppUpdate.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);
const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

ExtensionTestUtils.init(this);
AddonTestUtils.init(this);
AddonTestUtils.overrideCertDB();
AddonTestUtils.createAppInfo(
  "xpcshell@tests.mozilla.org",
  "XPCShell",
  "58",
  "58"
);

const ID = "langpack-fr@test.mozilla.org";

function langpackFiles(version, major) {
  return {
    "browser/localization/fr/browser.ftl": "message-browser = Value\n",
    "manifest.json": {
      name: "fr Language Pack",
      version,
      manifest_version: 2,
      browser_specific_settings: {
        gecko: {
          id: ID,
          strict_min_version: `${major}.0`,
          strict_max_version: `${major}.*`,
          update_url: "http://example.com/updates.json",
        },
      },
      sources: { browser: { base_path: "browser/" } },
      langpack_id: "fr",
      languages: { fr: { chrome_resources: {}, version: "20171001190118" } },
    },
  };
}

const UPDATES = {
  addons: {
    [ID]: {
      updates: [
        {
          version: "60.0.1",
          update_link: "http://example.com/langpack-60.xpi",
          applications: {
            gecko: { strict_min_version: "60.0", strict_max_version: "60.*" },
          },
        },
      ],
    },
  },
};

// While set, update checks get no response until the promise resolves.
let gHeldUpdates = null;

let server = AddonTestUtils.createHttpServer({ hosts: ["example.com"] });
server.registerPathHandler("/updates.json", (request, response) => {
  response.setHeader("Content-Type", "application/json");
  if (!gHeldUpdates) {
    response.write(JSON.stringify(UPDATES));
    return;
  }
  response.processAsync();
  gHeldUpdates.then(() => {
    response.write(JSON.stringify(UPDATES));
    response.finish();
  });
});
server.registerFile(
  "/langpack-60.xpi",
  AddonTestUtils.createTempXPIFile(langpackFiles("60.0.1", "60"))
);

const PREF_UPDATE_AT_STARTUP =
  "extensions.langpacks.updateAtStartup.featureGate";
const PREF_LAST_FAILED_VERSION =
  "extensions.langpacks.updateAtStartup.lastFailedVersion";

function makeFakeWindow() {
  let win = {
    shownL10nIds: [],
    onNotificationShown: null,
    gNotificationBox: {
      PRIORITY_INFO_MEDIUM: 1,
      current: null,
      shouldThrow: false,
      async appendNotification(id, { label }) {
        if (this.shouldThrow) {
          throw new Error("Notification failed");
        }
        this.current = { id, l10nId: label["l10n-id"] };
        win.shownL10nIds.push(label["l10n-id"]);
        win.onNotificationShown?.(label["l10n-id"]);
        return this.current;
      },
      getNotificationWithValue(id) {
        return this.current?.id == id ? this.current : null;
      },
      removeNotification(notification) {
        if (this.current == notification) {
          this.current = null;
        }
      },
    },
  };
  return win;
}

let gWindow;
let gWindows = [];

add_setup(function () {
  Services.prefs.setBoolPref("extensions.checkUpdateSecurity", false);
  Services.prefs.setBoolPref("extensions.langpacks.signatures.required", false);
  let originalLocales = Services.locale.requestedLocales;
  Services.locale.requestedLocales = ["fr"];

  let topWindowStub = sinon
    .stub(BrowserWindowTracker, "getTopWindow")
    .callsFake(() => gWindows.at(-1) ?? null);
  let orderedWindowsStub = sinon
    .stub(BrowserWindowTracker, "orderedWindows")
    .get(() => gWindows.toReversed());

  registerCleanupFunction(() => {
    topWindowStub.restore();
    orderedWindowsStub.restore();
    Services.locale.requestedLocales = originalLocales;
    Services.prefs.clearUserPref(PREF_UPDATE_AT_STARTUP);
    Services.prefs.clearUserPref(PREF_LAST_FAILED_VERSION);
    Services.prefs.clearUserPref("app.update.langpack.enabled");
    Services.prefs.clearUserPref("app.update.langpack.timeout");
  });
});

async function installLangpackThenUpdateApp(newVersion) {
  gWindow = makeFakeWindow();
  gWindows = [gWindow];
  Services.prefs.clearUserPref(PREF_LAST_FAILED_VERSION);
  await AddonTestUtils.promiseStartupManager("58");
  await Promise.all([
    TestUtils.topicObserved("webextension-langpack-startup"),
    AddonTestUtils.promiseInstallXPI(langpackFiles("58.0.1", "58")),
  ]);
  await AddonTestUtils.promiseRestartManager(newVersion);
  return AddonManager.getAddonByID(ID);
}

async function uninstallLangpack() {
  let addon = await AddonManager.getAddonByID(ID);
  await addon.uninstall();
  await AddonTestUtils.promiseShutdownManager();
}

add_task(async function test_pref_off() {
  Services.prefs.setBoolPref(PREF_UPDATE_AT_STARTUP, false);
  let addon = await installLangpackThenUpdateApp("60");
  Assert.ok(addon.appDisabled, "Langpack is incompatible after the update");

  await LangpackUpdateAfterAppUpdate.maybeUpdateLangpacks();

  Assert.deepEqual(gWindow.shownL10nIds, [], "No notification was shown");
  addon = await AddonManager.getAddonByID(ID);
  Assert.ok(addon.appDisabled, "Langpack was not updated");
  await uninstallLangpack();
});

add_task(async function test_compatible_langpack() {
  Services.prefs.setBoolPref(PREF_UPDATE_AT_STARTUP, true);
  let addon = await installLangpackThenUpdateApp("58.1");
  Assert.ok(addon.isActive, "Langpack is still compatible after the update");

  await LangpackUpdateAfterAppUpdate.maybeUpdateLangpacks();

  Assert.deepEqual(gWindow.shownL10nIds, [], "No notification was shown");
  await uninstallLangpack();
});

add_task(async function test_langpack_for_other_locale() {
  Services.prefs.setBoolPref(PREF_UPDATE_AT_STARTUP, true);
  Services.locale.requestedLocales = ["de"];
  let addon = await installLangpackThenUpdateApp("60");
  Assert.ok(addon.appDisabled, "Langpack is incompatible after the update");

  await LangpackUpdateAfterAppUpdate.maybeUpdateLangpacks();

  Assert.deepEqual(gWindow.shownL10nIds, [], "No notification was shown");
  addon = await AddonManager.getAddonByID(ID);
  Assert.ok(addon.appDisabled, "Langpack was not updated");
  Services.locale.requestedLocales = ["fr"];
  await uninstallLangpack();
});

add_task(async function test_update() {
  Services.prefs.setBoolPref(PREF_UPDATE_AT_STARTUP, true);
  await installLangpackThenUpdateApp("60");

  await LangpackUpdateAfterAppUpdate.maybeUpdateLangpacks();

  Assert.deepEqual(gWindow.shownL10nIds, [
    "langpack-update-in-progress-message",
    "langpack-update-done-message",
  ]);
  let addon = await AddonManager.getAddonByID(ID);
  Assert.ok(addon.isActive, "Langpack is active");
  Assert.equal(addon.version, "60.0.1");
  await uninstallLangpack();
});

add_task(async function test_retry_on_later_startup() {
  Services.prefs.setBoolPref(PREF_UPDATE_AT_STARTUP, true);
  await installLangpackThenUpdateApp("60");
  await AddonTestUtils.promiseRestartManager();

  await LangpackUpdateAfterAppUpdate.maybeUpdateLangpacks();

  let addon = await AddonManager.getAddonByID(ID);
  Assert.ok(
    addon.isActive,
    "Langpack is updated on a startup without a version change"
  );
  await uninstallLangpack();
});

add_task(async function test_update_when_notification_fails() {
  Services.prefs.setBoolPref(PREF_UPDATE_AT_STARTUP, true);
  await installLangpackThenUpdateApp("60");
  gWindow.gNotificationBox.shouldThrow = true;

  await LangpackUpdateAfterAppUpdate.maybeUpdateLangpacks();

  gWindow.gNotificationBox.shouldThrow = false;
  let addon = await AddonManager.getAddonByID(ID);
  Assert.ok(addon.isActive, "Langpack is updated even without a notification");
  await uninstallLangpack();
});

add_task(async function test_update_fails() {
  Services.prefs.setBoolPref(PREF_UPDATE_AT_STARTUP, true);
  await installLangpackThenUpdateApp("59");

  await LangpackUpdateAfterAppUpdate.maybeUpdateLangpacks();

  Assert.deepEqual(gWindow.shownL10nIds, [
    "langpack-update-in-progress-message",
    "langpack-update-failed-message",
  ]);
  let addon = await AddonManager.getAddonByID(ID);
  Assert.ok(addon.appDisabled, "Langpack is still incompatible");
  Assert.equal(
    Services.prefs.getStringPref(PREF_LAST_FAILED_VERSION, ""),
    "59",
    "The version of the failed attempt was stored"
  );
  await uninstallLangpack();
});

add_task(async function test_update_after_timeout() {
  Services.prefs.setBoolPref(PREF_UPDATE_AT_STARTUP, true);
  Services.prefs.setIntPref("app.update.langpack.timeout", 0);
  let releaseUpdates;
  gHeldUpdates = new Promise(resolve => {
    releaseUpdates = resolve;
  });
  await installLangpackThenUpdateApp("60");

  let slowShown = Promise.withResolvers();
  gWindow.onNotificationShown = l10nId => {
    if (l10nId == "langpack-update-slow-message") {
      slowShown.resolve();
    }
  };
  let updated = LangpackUpdateAfterAppUpdate.maybeUpdateLangpacks();
  await slowShown.promise;
  gWindow.onNotificationShown = null;
  releaseUpdates();
  gHeldUpdates = null;
  await updated;

  Assert.deepEqual(gWindow.shownL10nIds, [
    "langpack-update-in-progress-message",
    "langpack-update-slow-message",
    "langpack-update-done-message",
  ]);
  let addon = await AddonManager.getAddonByID(ID);
  Assert.ok(addon.isActive, "Langpack is active");
  Services.prefs.clearUserPref("app.update.langpack.timeout");
  await uninstallLangpack();
});

add_task(async function test_langpack_updating_disabled() {
  Services.prefs.setBoolPref(PREF_UPDATE_AT_STARTUP, true);
  Services.prefs.setBoolPref("app.update.langpack.enabled", false);
  await installLangpackThenUpdateApp("60");

  await LangpackUpdateAfterAppUpdate.maybeUpdateLangpacks();

  Assert.deepEqual(gWindow.shownL10nIds, [], "No notification was shown");
  let addon = await AddonManager.getAddonByID(ID);
  Assert.ok(addon.appDisabled, "Langpack was not updated");
  Services.prefs.clearUserPref("app.update.langpack.enabled");
  await uninstallLangpack();
});

add_task(async function test_quiet_retry_after_failure() {
  Services.prefs.setBoolPref(PREF_UPDATE_AT_STARTUP, true);
  await installLangpackThenUpdateApp("59");

  await LangpackUpdateAfterAppUpdate.maybeUpdateLangpacks();
  Assert.equal(
    Services.prefs.getStringPref(PREF_LAST_FAILED_VERSION, ""),
    "59",
    "The version of the failed attempt was stored"
  );

  await LangpackUpdateAfterAppUpdate.maybeUpdateLangpacks();

  Assert.deepEqual(
    gWindow.shownL10nIds,
    ["langpack-update-in-progress-message", "langpack-update-failed-message"],
    "The second failed attempt showed no notification"
  );
  await uninstallLangpack();
});

add_task(async function test_quiet_retry_succeeds() {
  Services.prefs.setBoolPref(PREF_UPDATE_AT_STARTUP, true);
  await installLangpackThenUpdateApp("60");
  Services.prefs.setStringPref(PREF_LAST_FAILED_VERSION, "60");

  await LangpackUpdateAfterAppUpdate.maybeUpdateLangpacks();

  Assert.deepEqual(gWindow.shownL10nIds, ["langpack-update-done-message"]);
  Assert.ok(
    !Services.prefs.prefHasUserValue(PREF_LAST_FAILED_VERSION),
    "The stored version was cleared"
  );
  let addon = await AddonManager.getAddonByID(ID);
  Assert.ok(addon.isActive, "Langpack is active");
  await uninstallLangpack();
});

add_task(async function test_notification_follows_top_window() {
  Services.prefs.setBoolPref(PREF_UPDATE_AT_STARTUP, true);
  let releaseUpdates;
  gHeldUpdates = new Promise(resolve => {
    releaseUpdates = resolve;
  });
  await installLangpackThenUpdateApp("60");

  let inProgressShown = Promise.withResolvers();
  gWindow.onNotificationShown = inProgressShown.resolve;
  let updated = LangpackUpdateAfterAppUpdate.maybeUpdateLangpacks();
  await inProgressShown.promise;
  let newTopWindow = makeFakeWindow();
  gWindows.push(newTopWindow);
  releaseUpdates();
  gHeldUpdates = null;
  await updated;

  Assert.equal(
    gWindow.gNotificationBox.current,
    null,
    "The notification was removed from the previous window"
  );
  Assert.deepEqual(newTopWindow.shownL10nIds, ["langpack-update-done-message"]);
  await uninstallLangpack();
});
