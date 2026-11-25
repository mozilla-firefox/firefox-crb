/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at <http://mozilla.org/MPL/2.0/>. */

import { showMenu } from "../../context-menu/menu";

import { copyToTheClipboard } from "../../utils/clipboard";
import {
  getRawSourceURL,
  shouldBlackbox,
  findBlackBoxRange,
} from "../../utils/source";
import { toSourceLine } from "../../utils/editor/index";
import { downloadFile } from "../../utils/utils";
import { features } from "../../utils/prefs";
import { isFulfilled } from "../../utils/async-value";

import { createBreakpointItems } from "./editor-breakpoint";

import {
  getPrettySource,
  getIsCurrentThreadPaused,
  isSourceWithMap,
  getBlackBoxRanges,
  isSourceOnSourceMapIgnoreList,
  isSourceMapIgnoreListEnabled,
  getEditorWrapping,
} from "../../selectors/index";

import { continueToHere } from "../../actions/pause/continueToHere";
import { jumpToMappedLocation } from "../../actions/sources/select";
import {
  showSource,
  toggleInlinePreview,
  toggleEditorWrapping,
} from "../../actions/ui";
import { toggleBlackBox } from "../../actions/sources/blackbox";
import { addExpression } from "../../actions/expressions";
import { evaluateInConsole } from "../../actions/toolbox";

export function showEditorContextMenu(event, editor, lineObject, location) {
  return async ({ dispatch, getState }) => {
    const { source } = location;
    const state = getState();
    const blackboxedRanges = getBlackBoxRanges(state);
    const isPaused = getIsCurrentThreadPaused(state);
    const hasMappedLocation =
      (source.isOriginal ||
        isSourceWithMap(state, source.id) ||
        source.isPrettyPrinted) &&
      !getPrettySource(state, source.id);
    const isSourceOnIgnoreList =
      isSourceMapIgnoreListEnabled(state) &&
      isSourceOnSourceMapIgnoreList(state, source);
    const editorWrappingEnabled = getEditorWrapping(state);
    const endColumn = editor.getText(lineObject.to.line).length;

    showMenu(
      event,
      editorMenuItems({
        blackboxedRanges,
        hasMappedLocation,
        location,
        isPaused,
        editorWrappingEnabled,
        selectionText: editor.getSelectedText(),
        isTextSelected: editor.isTextSelected(),
        lineObject,
        isSourceOnIgnoreList,
        dispatch,
        endColumn,
      }),
      { accesskeyConflictsBug: 2073896 }
    );
  };
}

export function showEditorGutterContextMenu(event, line, location, lineText) {
  return async ({ dispatch, getState }) => {
    const { source } = location;
    const state = getState();
    const blackboxedRanges = getBlackBoxRanges(state);
    const isPaused = getIsCurrentThreadPaused(state);
    const isSourceOnIgnoreList =
      isSourceMapIgnoreListEnabled(state) &&
      isSourceOnSourceMapIgnoreList(state, source);

    showMenu(
      event,
      [
        ...createBreakpointItems(location, lineText, dispatch),
        { type: "separator" },
        continueToHereItem(location, isPaused, dispatch),
        { type: "separator" },
        blackBoxLineMenuItem(
          source,
          line,
          blackboxedRanges,
          isSourceOnIgnoreList,
          location.line,
          dispatch,
          lineText.length
        ),
      ],
      { accesskeyConflictsBug: 2073896 }
    );
  };
}

// Menu Items
const continueToHereItem = (location, isPaused, dispatch) => ({
  disabled: !isPaused,
  click: () => dispatch(continueToHere(location)),
  id: "node-menu-continue-to-here",
  l10nID: "debugger-editor-continue-to-here",
});

const copyToClipboardItem = selectionText => ({
  id: "node-menu-copy-to-clipboard",
  l10nID: "debugger-editor-copy-to-clipboard",
  disabled: selectionText.length === 0,
  click: () => copyToTheClipboard(selectionText),
});

const copySourceItem = selectedContent => ({
  id: "node-menu-copy-source",
  l10nID: "debugger-copy-source",
  disabled: false,
  click: () =>
    selectedContent.type === "text" &&
    copyToTheClipboard(selectedContent.value),
});

const copySourceUri2Item = selectedSource => ({
  id: "node-menu-copy-source-url",
  l10nID: "debugger-copy-source-uri",
  disabled: !selectedSource.url,
  click: () => copyToTheClipboard(getRawSourceURL(selectedSource.url)),
});

const jumpToMappedLocationItem = (location, hasMappedLocation, dispatch) => ({
  id: "node-menu-jump",
  l10nID: location.source.isOriginal
    ? "debugger-editor-jump-to-generated-location"
    : "debugger-editor-jump-to-original-location",
  disabled: !hasMappedLocation,
  click: () => dispatch(jumpToMappedLocation(location)),
});

const showSourceMenuItem = (selectedSource, dispatch) => ({
  id: "node-menu-show-source",
  l10nID: "debugger-reveal-in-tree",
  disabled: !selectedSource.url,
  click: () => dispatch(showSource(selectedSource.id)),
});

const blackBoxMenuItem = (
  selectedSource,
  blackboxedRanges,
  isSourceOnIgnoreList,
  dispatch
) => {
  const isBlackBoxed = !!blackboxedRanges[selectedSource.url];
  return {
    id: "node-menu-blackbox",
    l10nID: isBlackBoxed
      ? "debugger-unignore-source"
      : "debugger-ignore-source",
    disabled: isSourceOnIgnoreList || !shouldBlackbox(selectedSource),
    click: () => dispatch(toggleBlackBox(selectedSource)),
  };
};

const blackBoxLineMenuItem = (
  selectedSource,
  { from, to },
  blackboxedRanges,
  isSourceOnIgnoreList,
  // the clickedLine is passed when the context menu
  // is opened from the gutter, it is not available when the
  // the context menu is opened from the editor.
  clickedLine = null,
  dispatch,
  endColumn
) => {
  const startLine = clickedLine ?? toSourceLine(selectedSource, from.line);
  const endLine = clickedLine ?? toSourceLine(selectedSource, to.line);

  const blackboxRange = findBlackBoxRange(selectedSource, blackboxedRanges, {
    start: startLine,
    end: endLine,
  });

  const selectedLineIsBlackBoxed = !!blackboxRange;

  const isSingleLine = selectedLineIsBlackBoxed
    ? blackboxRange.start.line == blackboxRange.end.line
    : startLine == endLine;

  const isSourceFullyBlackboxed =
    blackboxedRanges[selectedSource.url] &&
    !blackboxedRanges[selectedSource.url].length;

  // The ignore/unignore line context menu item should be disabled when
  // 1) The source is on the sourcemap ignore list
  // 2) The whole source is blackboxed or
  // 3) Multiple lines are blackboxed or
  // 4) Multiple lines are selected in the editor
  const shouldDisable =
    isSourceOnIgnoreList || isSourceFullyBlackboxed || !isSingleLine;

  return {
    id: "node-menu-blackbox-line",
    l10nID: !selectedLineIsBlackBoxed
      ? "debugger-editor-ignore-line"
      : "debugger-editor-unignore-line",
    disabled: shouldDisable,
    click: () => {
      const selectionRange = {
        start: {
          line: startLine,
          column: 0,
        },
        end: {
          line: endLine,
          column: endColumn,
        },
      };

      dispatch(
        toggleBlackBox(
          selectedSource,
          !selectedLineIsBlackBoxed,
          selectedLineIsBlackBoxed ? [blackboxRange] : [selectionRange]
        )
      );
    },
  };
};

const blackBoxLinesMenuItem = (
  selectedSource,
  { from, to },
  blackboxedRanges,
  isSourceOnIgnoreList,
  clickedLine,
  dispatch,
  endColumn
) => {
  const startLine = toSourceLine(selectedSource, from.line);
  const endLine = toSourceLine(selectedSource, to.line);

  const blackboxRange = findBlackBoxRange(selectedSource, blackboxedRanges, {
    start: startLine,
    end: endLine,
  });

  const selectedLinesAreBlackBoxed = !!blackboxRange;

  return {
    id: "node-menu-blackbox-lines",
    l10nID: !selectedLinesAreBlackBoxed
      ? "debugger-editor-ignore-lines"
      : "debugger-editor-unignore-lines",
    disabled: isSourceOnIgnoreList,
    click: () => {
      const selectionRange = {
        start: {
          line: startLine,
          column: 0,
        },
        end: {
          line: endLine,
          column: endColumn,
        },
      };

      dispatch(
        toggleBlackBox(
          selectedSource,
          !selectedLinesAreBlackBoxed,
          selectedLinesAreBlackBoxed ? [blackboxRange] : [selectionRange]
        )
      );
    },
  };
};

const watchExpressionItem = (selectedSource, selectionText, dispatch) => ({
  id: "node-menu-add-watch-expression",
  l10nID: "debugger-editor-add-watch-expression",
  click: () => dispatch(addExpression(selectionText)),
});

const evaluateInConsoleItem = (selectedSource, selectionText, dispatch) => ({
  id: "node-menu-evaluate-in-console",
  l10nID: "debugger-editor-evaluate-in-console",
  click: () => dispatch(evaluateInConsole(selectionText)),
});

const downloadFileItem = (selectedSource, selectedContent) => ({
  id: "node-menu-download-file",
  l10nID: "debugger-download-file",
  click: () => downloadFile(selectedContent, selectedSource.shortName),
});

const inlinePreviewItem = dispatch => ({
  id: "node-menu-inline-preview",
  l10nID: features.inlinePreview
    ? "debugger-editor-hide-inline-preview"
    : "debugger-editor-show-inline-preview",
  click: () => dispatch(toggleInlinePreview(!features.inlinePreview)),
});

const editorWrappingItem = (editorWrappingEnabled, dispatch) => ({
  id: "node-menu-editor-wrapping",
  l10nID: editorWrappingEnabled
    ? "debugger-editor-unwrap-lines"
    : "debugger-editor-wrap-lines",
  click: () => dispatch(toggleEditorWrapping(!editorWrappingEnabled)),
});

function editorMenuItems({
  blackboxedRanges,
  location,
  selectionText,
  hasMappedLocation,
  isTextSelected,
  isPaused,
  editorWrappingEnabled,
  lineObject,
  isSourceOnIgnoreList,
  dispatch,
  endColumn,
}) {
  const items = [];

  const { source } = location;

  const content =
    source.content && isFulfilled(source.content) ? source.content.value : null;

  items.push(
    jumpToMappedLocationItem(location, hasMappedLocation, dispatch),
    continueToHereItem(location, isPaused, dispatch),
    { type: "separator" },
    copyToClipboardItem(selectionText),
    ...(!source.isWasm
      ? [
          ...(content ? [copySourceItem(content)] : []),
          copySourceUri2Item(source),
        ]
      : []),
    ...(content ? [downloadFileItem(source, content)] : []),
    { type: "separator" },
    showSourceMenuItem(source, dispatch),
    { type: "separator" },
    blackBoxMenuItem(source, blackboxedRanges, isSourceOnIgnoreList, dispatch)
  );

  const startLine = toSourceLine(source, lineObject.from.line);
  const endLine = toSourceLine(source, lineObject.to.line);

  // Find any blackbox ranges that exist for the selected lines
  const blackboxRange = findBlackBoxRange(source, blackboxedRanges, {
    start: startLine,
    end: endLine,
  });

  const isMultiLineSelection = blackboxRange
    ? blackboxRange.start.line !== blackboxRange.end.line
    : startLine !== endLine;

  // When the range is defined and is an empty array,
  // the whole source is blackboxed
  const theWholeSourceIsBlackBoxed =
    blackboxedRanges[source.url] && !blackboxedRanges[source.url].length;

  if (!theWholeSourceIsBlackBoxed) {
    const blackBoxSourceLinesMenuItem = isMultiLineSelection
      ? blackBoxLinesMenuItem
      : blackBoxLineMenuItem;

    items.push(
      blackBoxSourceLinesMenuItem(
        source,
        lineObject,
        blackboxedRanges,
        isSourceOnIgnoreList,
        null,
        dispatch,
        endColumn
      )
    );
  }

  if (isTextSelected) {
    items.push(
      { type: "separator" },
      watchExpressionItem(source, selectionText, dispatch),
      evaluateInConsoleItem(source, selectionText, dispatch)
    );
  }

  items.push(
    { type: "separator" },
    inlinePreviewItem(dispatch),
    editorWrappingItem(editorWrappingEnabled, dispatch)
  );

  return items;
}
