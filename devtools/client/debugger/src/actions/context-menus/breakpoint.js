/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at <http://mozilla.org/MPL/2.0/>. */

import { buildMenu, showMenu } from "../../context-menu/menu";
import { getSelectedLocation } from "../../utils/selected-location";
import { isLineBlackboxed } from "../../utils/source";
import { features } from "../../utils/prefs";
const {
  stringifyFromElectronKey,
} = require("resource://devtools/client/shared/key-shortcuts.js");

import {
  getBreakpointsList,
  getSelectedSource,
  getBlackBoxRanges,
  isSourceMapIgnoreListEnabled,
  isSourceOnSourceMapIgnoreList,
} from "../../selectors/index";

import {
  removeBreakpoint,
  setBreakpointOptions,
} from "../../actions/breakpoints/modify";
import {
  removeBreakpoints,
  removeAllBreakpoints,
  toggleBreakpoints,
  toggleAllBreakpoints,
  toggleDisabledBreakpoint,
} from "../../actions/breakpoints/index";
import { selectSpecificLocation } from "../../actions/sources/select";
import { openConditionalPanel } from "../../actions/ui";

export function showBreakpointContextMenu(event, breakpoint, source) {
  return async ({ dispatch, getState }) => {
    const state = getState();
    const breakpoints = getBreakpointsList(state);
    const blackboxedRanges = getBlackBoxRanges(state);
    const blackboxedRangesForSource = blackboxedRanges[source.url];
    const checkSourceOnIgnoreList = _source =>
      isSourceMapIgnoreListEnabled(state) &&
      isSourceOnSourceMapIgnoreList(state, _source);
    const selectedSource = getSelectedSource(state);

    const selectedLocation = getSelectedLocation(breakpoint, selectedSource);
    const otherBreakpoints = breakpoints.filter(b => b.id !== breakpoint.id);
    const enabledBreakpoints = breakpoints.filter(b => !b.disabled);
    const disabledBreakpoints = breakpoints.filter(b => b.disabled);
    const otherEnabledBreakpoints = breakpoints.filter(
      b => !b.disabled && b.id !== breakpoint.id
    );
    const otherDisabledBreakpoints = breakpoints.filter(
      b => b.disabled && b.id !== breakpoint.id
    );

    const deleteSelfItem = {
      id: "node-menu-delete-self",
      l10nID: "debugger-breakpoint-remove",
      disabled: false,
      click: () => {
        dispatch(removeBreakpoint(breakpoint));
      },
    };

    const deleteAllItem = {
      id: "node-menu-delete-all",
      l10nID: "debugger-breakpoint-remove-all",
      disabled: false,
      click: () => dispatch(removeAllBreakpoints()),
    };

    const deleteOthersItem = {
      id: "node-menu-delete-other",
      l10nID: "debugger-breakpoint-remove-others",
      disabled: false,
      click: () => dispatch(removeBreakpoints(otherBreakpoints)),
    };

    const enableSelfItem = {
      id: "node-menu-enable-self",
      l10nID: "debugger-breakpoint-enable",
      disabled: isLineBlackboxed(
        blackboxedRangesForSource,
        breakpoint.location.line,
        checkSourceOnIgnoreList(breakpoint.location.source)
      ),
      click: () => {
        dispatch(toggleDisabledBreakpoint(breakpoint));
      },
    };

    const enableAllItem = {
      id: "node-menu-enable-all",
      l10nID: "debugger-breakpoint-enable-all",
      disabled: isLineBlackboxed(
        blackboxedRangesForSource,
        breakpoint.location.line,
        checkSourceOnIgnoreList(breakpoint.location.source)
      ),
      click: () => dispatch(toggleAllBreakpoints(false)),
    };

    const enableOthersItem = {
      id: "node-menu-enable-others",
      l10nID: "debugger-breakpoint-enable-others",
      disabled: isLineBlackboxed(
        blackboxedRangesForSource,
        breakpoint.location.line,
        checkSourceOnIgnoreList(breakpoint.location.source)
      ),
      click: () => dispatch(toggleBreakpoints(false, otherDisabledBreakpoints)),
    };

    const disableSelfItem = {
      id: "node-menu-disable-self",
      l10nID: "debugger-breakpoint-disable",
      disabled: false,
      click: () => {
        dispatch(toggleDisabledBreakpoint(breakpoint));
      },
    };

    const disableAllItem = {
      id: "node-menu-disable-all",
      l10nID: "debugger-breakpoint-disable-all",
      disabled: false,
      click: () => dispatch(toggleAllBreakpoints(true)),
    };

    const disableOthersItem = {
      id: "node-menu-disable-others",
      l10nID: "debugger-breakpoint-disable-others",
      click: () => dispatch(toggleBreakpoints(true, otherEnabledBreakpoints)),
    };

    const enableDbgStatementItem = {
      id: "node-menu-enable-dbgStatement",
      l10nID: "debugger-pause-here",
      disabled: false,
      click: () =>
        dispatch(
          setBreakpointOptions(selectedLocation, {
            ...breakpoint.options,
            condition: null,
          })
        ),
    };

    const disableDbgStatementItem = {
      id: "node-menu-disable-dbgStatement",
      l10nID: "debugger-never-pause-here",
      disabled: false,
      click: () =>
        dispatch(
          setBreakpointOptions(selectedLocation, {
            ...breakpoint.options,
            condition: "false",
          })
        ),
    };

    const removeConditionItem = {
      id: "node-menu-remove-condition",
      l10nID: "debugger-breakpoint-remove-condition",
      disabled: false,
      click: () =>
        dispatch(
          setBreakpointOptions(selectedLocation, {
            ...breakpoint.options,
            condition: null,
          })
        ),
    };

    const addConditionItem = {
      id: "node-menu-add-condition",
      l10nID: "debugger-breakpoint-add-condition",
      click: async () => {
        await dispatch(selectSpecificLocation(selectedLocation));
        await dispatch(openConditionalPanel(selectedLocation));
      },
      accelerator: stringifyFromElectronKey(
        L10N.getStr("toggleCondPanel.breakpoint.key")
      ),
    };

    const editConditionItem = {
      id: "node-menu-edit-condition",
      l10nID: "debugger-breakpoint-edit-condition",
      click: async () => {
        await dispatch(selectSpecificLocation(selectedLocation));
        await dispatch(openConditionalPanel(selectedLocation));
      },
      accelerator: stringifyFromElectronKey(
        L10N.getStr("toggleCondPanel.breakpoint.key")
      ),
    };

    const addLogPointItem = {
      id: "node-menu-add-log-point",
      l10nID: "debugger-add-log-point",
      disabled: false,
      click: async () => {
        await dispatch(selectSpecificLocation(selectedLocation));
        await dispatch(openConditionalPanel(selectedLocation, true));
      },
      accelerator: stringifyFromElectronKey(
        L10N.getStr("toggleCondPanel.logPoint.key")
      ),
    };

    const editLogPointItem = {
      id: "node-menu-edit-log-point",
      l10nID: "debugger-edit-log-point",
      disabled: false,
      click: async () => {
        await dispatch(selectSpecificLocation(selectedLocation));
        await dispatch(openConditionalPanel(selectedLocation, true));
      },
      accelerator: stringifyFromElectronKey(
        L10N.getStr("toggleCondPanel.logPoint.key")
      ),
    };

    const removeLogPointItem = {
      id: "node-menu-remove-log",
      l10nID: "debugger-remove-log-point",
      disabled: false,
      click: () =>
        dispatch(
          setBreakpointOptions(selectedLocation, {
            ...breakpoint.options,
            logValue: null,
          })
        ),
    };

    const logPointItem = breakpoint.options.logValue
      ? editLogPointItem
      : addLogPointItem;

    const hideEnableSelfItem = !breakpoint.disabled;
    const hideEnableAllItem = disabledBreakpoints.length === 0;
    const hideEnableOthersItem = otherDisabledBreakpoints.length === 0;
    const hideDisableAllItem = enabledBreakpoints.length === 0;
    const hideDisableOthersItem = otherEnabledBreakpoints.length === 0;
    const hideDisableSelfItem = breakpoint.disabled;
    const hideEnableDbgStatementItem =
      !breakpoint.originalText.startsWith("debugger") ||
      (breakpoint.originalText.startsWith("debugger") &&
        breakpoint.options.condition !== "false");
    const hideDisableDbgStatementItem =
      !breakpoint.originalText.startsWith("debugger") ||
      (breakpoint.originalText.startsWith("debugger") &&
        breakpoint.options.condition === "false");
    const items = [
      { item: enableSelfItem, hidden: () => hideEnableSelfItem },
      { item: enableAllItem, hidden: () => hideEnableAllItem },
      { item: enableOthersItem, hidden: () => hideEnableOthersItem },
      {
        item: { type: "separator" },
        hidden: () =>
          hideEnableSelfItem && hideEnableAllItem && hideEnableOthersItem,
      },
      { item: deleteSelfItem },
      { item: deleteAllItem },
      { item: deleteOthersItem, hidden: () => breakpoints.length === 1 },
      {
        item: { type: "separator" },
        hidden: () =>
          hideDisableSelfItem && hideDisableAllItem && hideDisableOthersItem,
      },

      { item: disableSelfItem, hidden: () => hideDisableSelfItem },
      { item: disableAllItem, hidden: () => hideDisableAllItem },
      { item: disableOthersItem, hidden: () => hideDisableOthersItem },
      {
        item: { type: "separator" },
      },
      {
        item: enableDbgStatementItem,
        hidden: () => hideEnableDbgStatementItem,
      },
      {
        item: disableDbgStatementItem,
        hidden: () => hideDisableDbgStatementItem,
      },
      {
        item: { type: "separator" },
        hidden: () => hideDisableDbgStatementItem && hideEnableDbgStatementItem,
      },
      {
        item: addConditionItem,
        hidden: () => breakpoint.options.condition,
      },
      {
        item: editConditionItem,
        hidden: () => !breakpoint.options.condition,
      },
      {
        item: removeConditionItem,
        hidden: () => !breakpoint.options.condition,
      },
      {
        item: logPointItem,
        hidden: () => !features.logPoints,
      },
      {
        item: removeLogPointItem,
        hidden: () => !features.logPoints || !breakpoint.options.logValue,
      },
    ];

    showMenu(event, buildMenu(items));
  };
}
