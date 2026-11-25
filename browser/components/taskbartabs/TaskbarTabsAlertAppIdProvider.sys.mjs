/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  TaskbarTabs: "moz-src:///browser/components/taskbartabs/TaskbarTabs.sys.mjs",
  TaskbarTabsUtils:
    "moz-src:///browser/components/taskbartabs/TaskbarTabsUtils.sys.mjs",
});

/**
 * Attributes web notifications to a Taskbar Tab, so that the desktop
 * associates them with the web app rather than with Firefox.
 *
 * A notification belongs to the only Taskbar Tab on its host and container,
 * wherever it was created: its URL can be anywhere on the site (e.g. the
 * script of a service worker), so it is only used to choose between several
 * Taskbar Tabs on the same host. Notifications shown before the Taskbar Tabs
 * registry is loaded belong to Firefox.
 */
export class TaskbarTabsAlertAppIdProvider {
  QueryInterface = ChromeUtils.generateQI(["nsIAlertAppIdProvider"]);

  getAppId(aUri, aUserContextId) {
    if (!lazy.TaskbarTabsUtils.isEnabled() || !(aUri instanceof Ci.nsIURL)) {
      return "";
    }

    let taskbarTab = this.#findTaskbarTab(aUri, aUserContextId);
    if (!taskbarTab) {
      return "";
    }

    return lazy.TaskbarTabsUtils.getExistingDesktopEntryId(taskbarTab) ?? "";
  }

  #findTaskbarTab(aUri, aUserContextId) {
    let onHost = lazy.TaskbarTabs.findTaskbarTabsForHostIfLoaded(
      aUri.host,
      aUserContextId
    );
    if (onHost.length > 1) {
      return lazy.TaskbarTabs.findTaskbarTabIfLoaded(aUri, aUserContextId);
    }
    return onHost[0] ?? null;
  }
}
