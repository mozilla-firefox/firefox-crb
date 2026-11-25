/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at <http://mozilla.org/MPL/2.0/>. */

import { showMenu } from "../../context-menu/menu";
import { sourceTree } from "../../constants";
import {
  isSourceMapIgnoreListEnabled,
  isSourceOnSourceMapIgnoreList,
  getProjectDirectoryRoot,
  getSourcesTreeSources,
  getBlackBoxRanges,
} from "../../selectors/index";

import {
  setNetworkOverride,
  removeNetworkOverride,
} from "devtools/client/framework/actions/index";

import { loadSourceText } from "../sources/loadSourceText";
import { toggleBlackBox, blackBoxSources } from "../sources/blackbox";
import {
  setProjectDirectoryRoot,
  clearProjectDirectoryRoot,
} from "../sources-tree";

import { shouldBlackbox } from "../../utils/source";
import { copyToTheClipboard } from "../../utils/clipboard";
import { saveAsLocalFile } from "../../utils/utils";

/**
 * Show the context menu of SourceTreeItem.
 *
 * @param {object} event
 *        The context-menu DOM event.
 * @param {object} item
 *        Source Tree Item object.
 */
export function showSourceTreeItemContextMenu(
  event,
  item,
  depth,
  setExpanded,
  itemName,
  isOverridden
) {
  return async ({ dispatch, getState, panel }) => {
    const menuOptions = [];

    const state = getState();
    const isSourceOnIgnoreList =
      isSourceMapIgnoreListEnabled(state) &&
      isSourceOnSourceMapIgnoreList(state, item.source);
    const projectRoot = getProjectDirectoryRoot(state);

    if (item.type == sourceTree.itemTypes.SOURCE) {
      const { source } = item;
      const copySourceUri2 = {
        id: "node-menu-copy-source",
        l10nID: "debugger-copy-source-uri",
        disabled: false,
        click: () => copyToTheClipboard(source.url),
      };

      const blackBoxMenuItem = {
        id: "node-menu-blackbox",
        l10nID: item.isBlackBoxed
          ? "debugger-unignore-source"
          : "debugger-ignore-source",
        disabled: isSourceOnIgnoreList || !shouldBlackbox(source),
        click: () => dispatch(toggleBlackBox(source)),
      };
      const downloadFileItem = {
        id: "node-menu-download-file",
        l10nID: "debugger-download-file",
        disabled: false,
        click: () => saveLocalFile(dispatch, source),
      };

      const overridesItem = {
        id: "node-menu-overrides",
        l10nID: isOverridden
          ? "debugger-source-tree-remove-override"
          : "debugger-source-tree-add-override",
        // Network overrides are disabled for original files.
        disabled: source.isOriginal,
        // Network overrides are disabled for remote debugging (bug 1881441).
        visible: panel.toolbox.commands.descriptorFront.isLocalTab,
        click: () =>
          handleLocalOverride(dispatch, panel.toolbox, source, isOverridden),
      };

      menuOptions.push(
        copySourceUri2,
        blackBoxMenuItem,
        downloadFileItem,
        overridesItem
      );
    }

    // All other types other than source are folder-like
    if (item.type != sourceTree.itemTypes.SOURCE) {
      addCollapseExpandAllOptions(menuOptions, item, setExpanded);

      if (projectRoot == item.uniquePath) {
        menuOptions.push({
          id: "node-remove-directory-root",
          l10nID: "debugger-source-tree-remove-directory-root",
          disabled: false,
          click: () => dispatch(clearProjectDirectoryRoot()),
        });
      } else {
        menuOptions.push({
          id: "node-set-directory-root",
          l10nID: "debugger-source-tree-set-directory-root",
          disabled: false,
          click: () =>
            dispatch(
              setProjectDirectoryRoot(
                item.uniquePath,
                itemName,
                getItemProjectDirectoryRootName(item)
              )
            ),
        });
      }

      addBlackboxAllOption(dispatch, state, menuOptions, item, depth);
    }

    showMenu(event, menuOptions);
  };
}

/**
 * Compute the string which will be displayed as tooltip on the project directory root header
 */
function getItemProjectDirectoryRootName(item) {
  if (item.thread) {
    return item.thread.name;
  }

  // Go up the source tree to get to the group item
  let groupItem = item;
  while (!groupItem.groupName) {
    groupItem = groupItem.parent;
  }

  // Group's origin is the base URL
  const origin = groupItem.origin;
  const path = item != groupItem ? item.path : "";
  // The group item's parent is always a thread item
  const threadName = groupItem.parent.thread.name;

  return `${origin}${path} on ${threadName}`;
}

async function saveLocalFile(dispatch, source) {
  if (!source) {
    return null;
  }

  const data = await dispatch(loadSourceText(source));
  if (!data) {
    return null;
  }
  return saveAsLocalFile(data.value, source.displayURL.filename);
}

async function handleLocalOverride(dispatch, toolbox, source, isOverridden) {
  if (!source || !source.url) {
    return;
  }

  const toolboxStore = toolbox.store;
  if (!isOverridden) {
    const data = await dispatch(loadSourceText(source));
    if (data?.value && data.value.type == "text") {
      toolboxStore.dispatch(
        setNetworkOverride(
          toolbox.commands,
          source.url,
          data.value.value,
          window
        )
      );
    }
  } else {
    toolboxStore.dispatch(removeNetworkOverride(toolbox.commands, source.url));
  }
}

function addBlackboxAllOption(dispatch, state, menuOptions, item, depth) {
  const {
    sourcesInside,
    sourcesOutside,
    allInsideBlackBoxed,
    allOutsideBlackBoxed,
  } = getBlackBoxSourcesGroups(state, item);
  const projectRoot = getProjectDirectoryRoot(state);

  let blackBoxInsideMenuItemL10nID;
  let blackBoxOutsideMenuItemL10nID;
  if (depth === 0 || (depth === 1 && projectRoot === "")) {
    blackBoxInsideMenuItemL10nID = allInsideBlackBoxed
      ? "debugger-source-tree-unignore-in-group"
      : "debugger-source-tree-ignore-in-group";
    if (sourcesOutside.length) {
      blackBoxOutsideMenuItemL10nID = allOutsideBlackBoxed
        ? "debugger-source-tree-unignore-outside-group"
        : "debugger-source-tree-ignore-outside-group";
    }
  } else {
    blackBoxInsideMenuItemL10nID = allInsideBlackBoxed
      ? "debugger-source-tree-unignore-in-directory"
      : "debugger-source-tree-ignore-in-directory";
    if (sourcesOutside.length) {
      blackBoxOutsideMenuItemL10nID = allOutsideBlackBoxed
        ? "debugger-source-tree-unignore-outside-directory"
        : "debugger-source-tree-ignore-outside-directory";
    }
  }

  const blackBoxInsideMenuItem = {
    id: allInsideBlackBoxed
      ? "node-unblackbox-all-inside"
      : "node-blackbox-all-inside",
    l10nID: blackBoxInsideMenuItemL10nID,
    disabled: false,
    click: () => dispatch(blackBoxSources(sourcesInside, !allInsideBlackBoxed)),
  };

  if (sourcesOutside.length) {
    menuOptions.push({
      id: "node-blackbox-all",
      l10nID: "debugger-source-tree-ignore",
      submenu: [
        blackBoxInsideMenuItem,
        {
          id: allOutsideBlackBoxed
            ? "node-unblackbox-all-outside"
            : "node-blackbox-all-outside",
          l10nID: blackBoxOutsideMenuItemL10nID,
          disabled: false,
          click: () =>
            dispatch(blackBoxSources(sourcesOutside, !allOutsideBlackBoxed)),
        },
      ],
    });
  } else {
    menuOptions.push(blackBoxInsideMenuItem);
  }
}

function addCollapseExpandAllOptions(menuOptions, item, setExpanded) {
  menuOptions.push({
    id: "node-menu-collapse-all",
    l10nID: "debugger-source-tree-collapse-all",
    disabled: false,
    click: () => setExpanded(item, false, true),
  });

  menuOptions.push({
    id: "node-menu-expand-all",
    l10nID: "debugger-source-tree-expand-all",
    disabled: false,
    click: () => setExpanded(item, true, true),
  });
}

/**
 * Computes 4 lists:
 *  - `sourcesInside`: the list of all Source Items that are
 *    children of the current item (can be thread/group/directory).
 *    This include any nested level of children.
 *  - `sourcesOutside`: all other Source Items.
 *    i.e. all sources that are in any other folder of any group/thread.
 *  - `allInsideBlackBoxed`, all sources of `sourcesInside` which are currently
 *    blackboxed.
 *  - `allOutsideBlackBoxed`, all sources of `sourcesOutside` which are currently
 *    blackboxed.
 */
function getBlackBoxSourcesGroups(state, item) {
  const allSources = [];
  function collectAllSources(list, _item) {
    if (_item.children) {
      _item.children.forEach(i => collectAllSources(list, i));
    }
    if (_item.type == sourceTree.itemTypes.SOURCE) {
      list.push(_item.source);
    }
  }

  const rootItems = getSourcesTreeSources(state);
  const blackBoxRanges = getBlackBoxRanges(state);

  for (const rootItem of rootItems) {
    collectAllSources(allSources, rootItem);
  }

  const sourcesInside = [];
  collectAllSources(sourcesInside, item);

  const sourcesOutside = allSources.filter(
    source => !sourcesInside.includes(source)
  );
  const allInsideBlackBoxed = sourcesInside.every(
    source => blackBoxRanges[source.url]
  );
  const allOutsideBlackBoxed = sourcesOutside.every(
    source => blackBoxRanges[source.url]
  );

  return {
    sourcesInside,
    sourcesOutside,
    allInsideBlackBoxed,
    allOutsideBlackBoxed,
  };
}
