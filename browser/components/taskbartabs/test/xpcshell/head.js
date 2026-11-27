/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const head = {};
ChromeUtils.defineESModuleGetters(head, {
  TaskbarTabsRegistry:
    "moz-src:///browser/components/taskbartabs/TaskbarTabsRegistry.sys.mjs",
  TaskbarTabsUtils:
    "moz-src:///browser/components/taskbartabs/TaskbarTabsUtils.sys.mjs",
});

/**
 * Creates the file where the icon of a Taskbar Tab is saved, which pinning
 * needs to find.
 *
 * (This function is also in browser/head.js.)
 *
 * @param {TaskbarTab} aTaskbarTab
 *   The Taskbar Tab to create the icon file for.
 */
async function saveTaskbarTabIconFile(aTaskbarTab) {
  let iconFile = head.TaskbarTabsUtils.getTaskbarTabIconFile(aTaskbarTab.id);
  await IOUtils.makeDirectory(iconFile.parent.path);
  await IOUtils.writeUTF8(iconFile.path, "");
}

/**
 * Creates a new Taskbar Tab within the registry, and asserts that it does not
 * already exist.
 *
 * (This function is also in browser/head.js.)
 *
 * @param {TaskbarTabsRegistry|TaskbarTabs} aRegistry
 *   The registry to create the taskbar tab in.
 * @param {...*} args
 *   Arguments to findOrCreateTaskbarTab.
 * @returns {TaskbarTab}
 *   The newly-created taskbar tab.
 */
function createTaskbarTab(aRegistry, ...args) {
  let result = aRegistry.findOrCreateTaskbarTab(...args);
  function check({ taskbarTab, created }) {
    Assert.ok(created, "Created taskbar tab did not exist before");
    return taskbarTab;
  }

  if (result.then) {
    return result.then(check);
  }

  return check(result);
}

/**
 * Creates a TaskbarTabsRegistry that doesn't save anything on disk.
 *
 * (This function is also in browser/head.js.)
 *
 * @returns {TaskbarTabsRegistry}
 *   The newly-created registry, which will be empty.
 */
function createInMemoryRegistry() {
  return new head.TaskbarTabsRegistry(
    {
      save: () => {},
    },
    []
  );
}
