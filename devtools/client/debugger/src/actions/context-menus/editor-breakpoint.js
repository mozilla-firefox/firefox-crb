/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at <http://mozilla.org/MPL/2.0/>. */

import { showMenu } from "../../context-menu/menu";
import { getSelectedLocation } from "../../utils/selected-location";
import { features } from "../../utils/prefs";
import { isLineBlackboxed } from "../../utils/source";
const {
  stringifyFromElectronKey,
} = require("resource://devtools/client/shared/key-shortcuts.js");

import {
  getSelectedSource,
  getBlackBoxRanges,
  isSourceMapIgnoreListEnabled,
  isSourceOnSourceMapIgnoreList,
} from "../../selectors/index";
import {
  addBreakpoint,
  removeBreakpoint,
  setBreakpointOptions,
} from "../../actions/breakpoints/modify";
import {
  enableBreakpointsAtLine,
  disableBreakpointsAtLine,
  toggleDisabledBreakpoint,
  removeBreakpointsAtLine,
} from "../../actions/breakpoints/index";
import { openConditionalPanel } from "../../actions/ui";

export function showEditorEditBreakpointContextMenu(event, breakpoint) {
  return async ({ dispatch, getState }) => {
    const state = getState();
    const selectedSource = getSelectedSource(state);
    const selectedLocation = getSelectedLocation(breakpoint, selectedSource);
    const blackboxedRanges = getBlackBoxRanges(state);
    const blackboxedRangesForSelectedSource =
      blackboxedRanges[selectedSource.url];
    const isSelectedSourceOnIgnoreList =
      selectedSource &&
      isSourceMapIgnoreListEnabled(state) &&
      isSourceOnSourceMapIgnoreList(state, selectedSource);

    const items = [
      removeBreakpointItem(breakpoint, dispatch),
      toggleDisabledBreakpointItem(
        breakpoint,
        blackboxedRangesForSelectedSource,
        isSelectedSourceOnIgnoreList,
        dispatch
      ),
    ];

    if (breakpoint.originalText.startsWith("debugger")) {
      items.push(
        { type: "separator" },
        toggleDbgStatementItem(selectedLocation, breakpoint, dispatch)
      );
    }

    items.push(
      { type: "separator" },
      removeBreakpointsOnLineItem(selectedLocation, dispatch),
      breakpoint.disabled
        ? enableBreakpointsOnLineItem(
            selectedLocation,
            blackboxedRangesForSelectedSource,
            isSelectedSourceOnIgnoreList,
            dispatch
          )
        : disableBreakpointsOnLineItem(selectedLocation, dispatch),
      { type: "separator" }
    );

    items.push(
      conditionalBreakpointItem(breakpoint, selectedLocation, dispatch)
    );
    items.push(logPointItem(breakpoint, selectedLocation, dispatch));

    showMenu(event, items, { accesskeyConflictsBug: 2073896 });
  };
}

export function showEditorCreateBreakpointContextMenu(
  event,
  location,
  lineText
) {
  return async ({ dispatch }) => {
    const items = createBreakpointItems(location, lineText, dispatch);

    showMenu(event, items, { accesskeyConflictsBug: 2073896 });
  };
}

export function createBreakpointItems(location, lineText, dispatch) {
  const items = [
    addBreakpointItem(location, dispatch),
    addConditionalBreakpointItem(location, dispatch),
  ];

  if (features.logPoints) {
    items.push(addLogPointItem(location, dispatch));
  }

  if (lineText && lineText.startsWith("debugger")) {
    items.push(toggleDbgStatementItem(location, null, dispatch));
  }
  return items;
}

const addBreakpointItem = (location, dispatch) => ({
  id: "node-menu-add-breakpoint",
  l10nID: "debugger-editor-add-breakpoint",
  disabled: false,
  click: () => dispatch(addBreakpoint(location)),
  accelerator: stringifyFromElectronKey(L10N.getStr("toggleBreakpoint.key")),
});

const removeBreakpointItem = (breakpoint, dispatch) => ({
  id: "node-menu-remove-breakpoint",
  l10nID: "debugger-editor-remove-breakpoint",
  disabled: false,
  click: () => dispatch(removeBreakpoint(breakpoint)),
  accelerator: stringifyFromElectronKey(L10N.getStr("toggleBreakpoint.key")),
});

const addConditionalBreakpointItem = (location, dispatch) => ({
  id: "node-menu-add-conditional-breakpoint",
  l10nID: "debugger-editor-add-condition",
  accelerator: stringifyFromElectronKey(
    L10N.getStr("toggleCondPanel.breakpoint.key")
  ),
  disabled: false,
  click: () => dispatch(openConditionalPanel(location)),
});

const editConditionalBreakpointItem = (location, dispatch) => ({
  id: "node-menu-edit-conditional-breakpoint",
  l10nID: "debugger-editor-edit-condition",
  accelerator: stringifyFromElectronKey(
    L10N.getStr("toggleCondPanel.breakpoint.key")
  ),
  disabled: false,
  click: () => dispatch(openConditionalPanel(location)),
});

const conditionalBreakpointItem = (breakpoint, location, dispatch) => {
  const {
    options: { condition },
  } = breakpoint;
  return condition
    ? editConditionalBreakpointItem(location, dispatch)
    : addConditionalBreakpointItem(location, dispatch);
};

const addLogPointItem = (location, dispatch) => ({
  id: "node-menu-add-log-point",
  l10nID: "debugger-add-log-point",
  disabled: false,
  click: () => dispatch(openConditionalPanel(location, true)),
  accelerator: stringifyFromElectronKey(
    L10N.getStr("toggleCondPanel.logPoint.key")
  ),
});

const editLogPointItem = (location, dispatch) => ({
  id: "node-menu-edit-log-point",
  l10nID: "debugger-edit-log-point",
  disabled: false,
  click: () => dispatch(openConditionalPanel(location, true)),
  accelerator: stringifyFromElectronKey(
    L10N.getStr("toggleCondPanel.logPoint.key")
  ),
});

const logPointItem = (breakpoint, location, dispatch) => {
  const {
    options: { logValue },
  } = breakpoint;
  return logValue
    ? editLogPointItem(location, dispatch)
    : addLogPointItem(location, dispatch);
};

const toggleDisabledBreakpointItem = (
  breakpoint,
  blackboxedRangesForSelectedSource,
  isSelectedSourceOnIgnoreList,
  dispatch
) => {
  return {
    disabled: isLineBlackboxed(
      blackboxedRangesForSelectedSource,
      breakpoint.location.line,
      isSelectedSourceOnIgnoreList
    ),
    click: () => dispatch(toggleDisabledBreakpoint(breakpoint)),
    ...(breakpoint.disabled
      ? {
          id: "node-menu-enable-breakpoint",
          l10nID: "debugger-editor-enable-breakpoint",
        }
      : {
          id: "node-menu-disable-breakpoint",
          l10nID: "debugger-editor-disable-breakpoint",
        }),
  };
};

const toggleDbgStatementItem = (location, breakpoint, dispatch) => {
  if (breakpoint && breakpoint.options.condition === "false") {
    return {
      disabled: false,
      id: "node-menu-enable-dbgStatement",
      l10nID: "debugger-pause-here",
      click: () =>
        dispatch(
          setBreakpointOptions(location, {
            ...breakpoint.options,
            condition: null,
          })
        ),
    };
  }

  return {
    disabled: false,
    id: "node-menu-disable-dbgStatement",
    l10nID: "debugger-never-pause-here",
    click: () =>
      dispatch(
        setBreakpointOptions(location, {
          condition: "false",
        })
      ),
  };
};

// ToDo: Only enable if there are more than one breakpoints on a line?
const removeBreakpointsOnLineItem = (location, dispatch) => ({
  id: "node-menu-remove-breakpoints-on-line",
  l10nID: "debugger-editor-remove-breakpoints-on-line",
  disabled: false,
  click: () =>
    dispatch(removeBreakpointsAtLine(location.source, location.line)),
});

const enableBreakpointsOnLineItem = (
  location,
  blackboxedRangesForSelectedSource,
  isSelectedSourceOnIgnoreList,
  dispatch
) => ({
  id: "node-menu-remove-breakpoints-on-line",
  l10nID: "debugger-editor-enable-breakpoints-on-line",
  disabled: isLineBlackboxed(
    blackboxedRangesForSelectedSource,
    location.line,
    isSelectedSourceOnIgnoreList
  ),
  click: () =>
    dispatch(enableBreakpointsAtLine(location.source, location.line)),
});

const disableBreakpointsOnLineItem = (location, dispatch) => ({
  id: "node-menu-remove-breakpoints-on-line",
  l10nID: "debugger-editor-disable-breakpoints-on-line",
  disabled: false,
  click: () =>
    dispatch(disableBreakpointsAtLine(location.source, location.line)),
});
