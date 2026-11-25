/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at <http://mozilla.org/MPL/2.0/>. */

/**
 * Finds the hidden tabs by comparing the tabs' top offset.
 * hidden tabs will have a great top offset.
 *
 * @param tabs Array<reducer's Source object>
 * @param sourceTabEls HTMLCollection
 *
 * @returns Array
 */

export function getHiddenTabsSources(openedSources, sourceTabEls) {
  sourceTabEls = Array.from(sourceTabEls);
  function getTopOffset() {
    const topOffsets = sourceTabEls.map(t => t.getBoundingClientRect().top);
    return Math.min(...topOffsets);
  }
  const tabTopOffset = getTopOffset();

  function hasTopOffset(el) {
    // adding 10px helps account for cases where the tab might be offset by
    // styling such as selected tabs which don't have a border.
    return el.getBoundingClientRect().top > tabTopOffset + 10;
  }

  const hiddenSources = [];
  for (let i = 0; i < openedSources.length; i++) {
    const element = sourceTabEls[i];
    if (element && hasTopOffset(element)) {
      hiddenSources.push(openedSources[i]);
    }
  }
  return hiddenSources;
}

export function getTabMenuItems() {
  return {
    closeTab: {
      id: "node-menu-close-tab",
      l10nID: "debugger-tab-close",
      disabled: false,
    },
    closeOtherTabs: {
      id: "node-menu-close-other-tabs",
      l10nID: "debugger-tab-close-others",
      disabled: false,
    },
    closeTabsToEnd: {
      id: "node-menu-close-tabs-to-end",
      l10nID: "debugger-tab-close-to-end",
      disabled: false,
    },
    closeAllTabs: {
      id: "node-menu-close-all-tabs",
      l10nID: "debugger-tab-close-all",
      disabled: false,
    },
    showSource: {
      id: "node-menu-show-source",
      l10nID: "debugger-reveal-in-tree",
      disabled: false,
    },
    copySource: {
      id: "node-menu-copy-source",
      l10nID: "debugger-copy-source",
      disabled: false,
    },
    copySourceUri2: {
      id: "node-menu-copy-source-url",
      l10nID: "debugger-copy-source-uri",
      disabled: false,
    },
    toggleBlackBox: {
      id: "node-menu-blackbox",
      l10nID: "debugger-ignore-source",
      disabled: false,
    },
    prettyPrint: {
      id: "node-menu-pretty-print",
      l10nID: "debugger-tab-pretty-print",
      disabled: false,
    },
  };
}
