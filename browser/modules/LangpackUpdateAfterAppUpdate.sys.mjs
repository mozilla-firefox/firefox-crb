/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const PREF_UPDATE_AT_STARTUP =
  "extensions.langpacks.updateAtStartup.featureGate";
const PREF_LAST_FAILED_VERSION =
  "extensions.langpacks.updateAtStartup.lastFailedVersion";
const PREF_LANGPACK_ENABLED = "app.update.langpack.enabled";
const PREF_LANGPACK_TIMEOUT = "app.update.langpack.timeout";
const DEFAULT_LANGPACK_TIMEOUT_MS = 300000;
const NOTIFICATION_ID = "langpack-update-after-app-update";

/**
 * Updates the langpacks that an application update left incompatible, for
 * example after a background update, which cannot stage langpack updates.
 * Runs on every startup, so a failed attempt is retried on the next one. Once
 * the failure message was shown for this application version, later attempts
 * only show a message when they succeed.
 */
export const LangpackUpdateAfterAppUpdate = {
  async maybeUpdateLangpacks() {
    if (
      !Services.prefs.getBoolPref(PREF_UPDATE_AT_STARTUP, false) ||
      !Services.prefs.getBoolPref(PREF_LANGPACK_ENABLED, false)
    ) {
      return;
    }

    // Avoids loading the add-ons database when the requested locale is
    // already available.
    let [requestedLocale] = Services.locale.requestedLocales;
    if (
      !requestedLocale ||
      Services.locale.availableLocales.includes(requestedLocale)
    ) {
      return;
    }

    let langpacks = await lazy.AddonManager.getIncompatibleLangpacks(
      Services.locale.requestedLocales
    );
    if (!langpacks.length) {
      return;
    }

    let installPromise = lazy.AddonManager.installLangpackUpdates(langpacks);
    let hasShownFailure =
      Services.prefs.getStringPref(PREF_LAST_FAILED_VERSION, "") ===
      Services.appinfo.version;
    if (hasShownFailure) {
      if (await installPromise) {
        await this._onUpdated();
      }
      return;
    }

    await this._showNotification("langpack-update-in-progress-message");

    let timer;
    let timeout = new Promise(resolve => {
      timer = lazy.setTimeout(
        () => resolve(null),
        Services.prefs.getIntPref(
          PREF_LANGPACK_TIMEOUT,
          DEFAULT_LANGPACK_TIMEOUT_MS
        )
      );
    });
    let isUpdated = await Promise.race([installPromise, timeout]);
    lazy.clearTimeout(timer);

    if (isUpdated === null) {
      await this._showNotification("langpack-update-slow-message");
      isUpdated = await installPromise;
    }

    if (isUpdated) {
      await this._onUpdated();
    } else if (!Services.startup.shuttingDown) {
      Services.prefs.setStringPref(
        PREF_LAST_FAILED_VERSION,
        Services.appinfo.version
      );
      await this._showNotification("langpack-update-failed-message");
    }
  },

  async _onUpdated() {
    Services.prefs.clearUserPref(PREF_LAST_FAILED_VERSION);
    await this._showNotification("langpack-update-done-message");
  },

  async _showNotification(l10nId) {
    try {
      for (let browserWindow of lazy.BrowserWindowTracker.orderedWindows) {
        let notification =
          browserWindow.gNotificationBox.getNotificationWithValue(
            NOTIFICATION_ID
          );
        if (notification) {
          browserWindow.gNotificationBox.removeNotification(notification);
        }
      }
      let win = lazy.BrowserWindowTracker.getTopWindow({
        allowFromInactiveWorkspace: true,
      });
      if (!win) {
        return;
      }
      await win.gNotificationBox.appendNotification(NOTIFICATION_ID, {
        label: { "l10n-id": l10nId },
        priority: win.gNotificationBox.PRIORITY_INFO_MEDIUM,
      });
    } catch (e) {
      console.error(e);
    }
  },
};
