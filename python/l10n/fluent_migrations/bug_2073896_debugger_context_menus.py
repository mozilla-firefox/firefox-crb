# Any copyright is dedicated to the Public Domain.
# http://creativecommons.org/publicdomain/zero/1.0/

import fluent.syntax.ast as FTL
from fluent.migrate.helpers import transforms_from
from fluent.migrate.transforms import COPY, REPLACE


def migrate(ctx):
    """Bug 2073896 - Migrate the debugger context menus to Fluent, part {index}."""

    source = "devtools/client/debugger.properties"
    target = "devtools/client/debugger.ftl"

    ctx.add_transforms(
        target,
        target,
        transforms_from(
            """
debugger-breakpoint-remove =
    .label = { COPY(from_path, "breakpointMenuItem.deleteSelf2.label") }
    .accesskey = { COPY(from_path, "breakpointMenuItem.deleteSelf2.accesskey") }
debugger-breakpoint-remove-all =
    .label = { COPY(from_path, "breakpointMenuItem.deleteAll2.label") }
    .accesskey = { COPY(from_path, "breakpointMenuItem.deleteAll2.accesskey") }
debugger-breakpoint-remove-others =
    .label = { COPY(from_path, "breakpointMenuItem.deleteOthers2.label") }
    .accesskey = { COPY(from_path, "breakpointMenuItem.deleteOthers2.accesskey") }
debugger-breakpoint-enable =
    .label = { COPY(from_path, "breakpointMenuItem.enableSelf2.label") }
    .accesskey = { COPY(from_path, "breakpointMenuItem.enableSelf2.accesskey") }
debugger-breakpoint-enable-all =
    .label = { COPY(from_path, "breakpointMenuItem.enableAll2.label") }
    .accesskey = { COPY(from_path, "breakpointMenuItem.enableAll2.accesskey") }
debugger-breakpoint-enable-others =
    .label = { COPY(from_path, "breakpointMenuItem.enableOthers2.label") }
    .accesskey = { COPY(from_path, "breakpointMenuItem.enableOthers2.accesskey") }
debugger-breakpoint-disable =
    .label = { COPY(from_path, "breakpointMenuItem.disableSelf2.label") }
    .accesskey = { COPY(from_path, "breakpointMenuItem.disableSelf2.accesskey") }
debugger-breakpoint-disable-all =
    .label = { COPY(from_path, "breakpointMenuItem.disableAll2.label") }
    .accesskey = { COPY(from_path, "breakpointMenuItem.disableAll2.accesskey") }
debugger-breakpoint-disable-others =
    .label = { COPY(from_path, "breakpointMenuItem.disableOthers2.label") }
    .accesskey = { COPY(from_path, "breakpointMenuItem.disableOthers2.accesskey") }
debugger-breakpoint-remove-condition =
    .label = { COPY(from_path, "breakpointMenuItem.removeCondition2.label") }
    .accesskey = { COPY(from_path, "breakpointMenuItem.removeCondition2.accesskey") }
debugger-breakpoint-add-condition =
    .label = { COPY(from_path, "breakpointMenuItem.addCondition2.label") }
    .accesskey = { COPY(from_path, "breakpointMenuItem.addCondition2.accesskey") }
debugger-breakpoint-edit-condition =
    .label = { COPY(from_path, "breakpointMenuItem.editCondition2.label") }
    .accesskey = { COPY(from_path, "breakpointMenuItem.editCondition2.accesskey") }
debugger-pause-here =
    .label = { COPY(from_path, "breakpointMenuItem.enabledbg.label") }
debugger-never-pause-here =
    .label = { COPY(from_path, "breakpointMenuItem.disabledbg.label") }
debugger-add-log-point =
    .label = { COPY(from_path, "editor.addLogPoint") }
    .accesskey = { COPY(from_path, "editor.addLogPoint.accesskey") }
debugger-edit-log-point =
    .label = { COPY(from_path, "editor.editLogPoint") }
    .accesskey = { COPY(from_path, "editor.editLogPoint.accesskey") }
debugger-remove-log-point =
    .label = { COPY(from_path, "editor.removeLogPoint.label") }
    .accesskey = { COPY(from_path, "editor.removeLogPoint.accesskey") }
debugger-editor-add-breakpoint =
    .label = { COPY(from_path, "editor.addBreakpoint") }
    .accesskey = { COPY(from_path, "shortcuts.toggleBreakpoint.accesskey") }
debugger-editor-remove-breakpoint =
    .label = { COPY(from_path, "editor.removeBreakpoint") }
    .accesskey = { COPY(from_path, "shortcuts.toggleBreakpoint.accesskey") }
debugger-editor-add-condition =
    .label = { COPY(from_path, "editor.addConditionBreakpoint") }
    .accesskey = { COPY(from_path, "editor.addConditionBreakpoint.accesskey") }
debugger-editor-edit-condition =
    .label = { COPY(from_path, "editor.editConditionBreakpoint") }
    .accesskey = { COPY(from_path, "editor.addConditionBreakpoint.accesskey") }
debugger-editor-enable-breakpoint =
    .label = { COPY(from_path, "editor.enableBreakpoint") }
    .accesskey = { COPY(from_path, "editor.disableBreakpoint.accesskey") }
debugger-editor-disable-breakpoint =
    .label = { COPY(from_path, "editor.disableBreakpoint") }
    .accesskey = { COPY(from_path, "editor.disableBreakpoint.accesskey") }
debugger-editor-remove-breakpoints-on-line =
    .label = { COPY(from_path, "breakpointMenuItem.removeAllAtLine.label") }
    .accesskey = { COPY(from_path, "breakpointMenuItem.removeAllAtLine.accesskey") }
debugger-editor-enable-breakpoints-on-line =
    .label = { COPY(from_path, "breakpointMenuItem.enableAllAtLine.label") }
    .accesskey = { COPY(from_path, "breakpointMenuItem.enableAllAtLine.accesskey") }
debugger-editor-disable-breakpoints-on-line =
    .label = { COPY(from_path, "breakpointMenuItem.disableAllAtLine.label") }
    .accesskey = { COPY(from_path, "breakpointMenuItem.disableAllAtLine.accesskey") }
debugger-editor-continue-to-here =
    .label = { COPY(from_path, "editor.continueToHere.label") }
    .accesskey = { COPY(from_path, "editor.continueToHere.accesskey") }
debugger-editor-ignore-line =
    .label = { COPY(from_path, "ignoreContextItem.ignoreLine") }
    .accesskey = { COPY(from_path, "ignoreContextItem.ignoreLine.accesskey") }
debugger-editor-unignore-line =
    .label = { COPY(from_path, "ignoreContextItem.unignoreLine") }
    .accesskey = { COPY(from_path, "ignoreContextItem.unignoreLine.accesskey") }
debugger-editor-copy-to-clipboard =
    .label = { COPY(from_path, "copyToClipboard.label") }
    .accesskey = { COPY(from_path, "copyToClipboard.accesskey") }
debugger-editor-ignore-lines =
    .label = { COPY(from_path, "ignoreContextItem.ignoreLines") }
    .accesskey = { COPY(from_path, "ignoreContextItem.ignoreLines.accesskey") }
debugger-editor-unignore-lines =
    .label = { COPY(from_path, "ignoreContextItem.unignoreLines") }
    .accesskey = { COPY(from_path, "ignoreContextItem.unignoreLines.accesskey") }
debugger-editor-add-watch-expression =
    .label = { COPY(from_path, "expressions.label") }
    .accesskey = { COPY(from_path, "expressions.accesskey") }
debugger-editor-evaluate-in-console =
    .label = { COPY(from_path, "evaluateInConsole.label") }
debugger-editor-show-inline-preview =
    .label = { COPY(from_path, "inlinePreview.show.label") }
debugger-editor-hide-inline-preview =
    .label = { COPY(from_path, "inlinePreview.hide.label") }
debugger-editor-wrap-lines =
    .label = { COPY(from_path, "editorWrapping.show.label") }
debugger-editor-unwrap-lines =
    .label = { COPY(from_path, "editorWrapping.hide.label") }
debugger-copy-source =
    .label = { COPY(from_path, "copySource.label") }
    .accesskey = { COPY(from_path, "copySource.accesskey") }
debugger-copy-source-uri =
    .label = { COPY(from_path, "copySourceUri2") }
    .accesskey = { COPY(from_path, "copySourceUri2.accesskey") }
debugger-reveal-in-tree =
    .label = { COPY(from_path, "sourceTabs.revealInTree") }
    .accesskey = { COPY(from_path, "sourceTabs.revealInTree.accesskey") }
debugger-ignore-source =
    .label = { COPY(from_path, "ignoreContextItem.ignore") }
    .accesskey = { COPY(from_path, "ignoreContextItem.ignore.accesskey") }
debugger-unignore-source =
    .label = { COPY(from_path, "ignoreContextItem.unignore") }
    .accesskey = { COPY(from_path, "ignoreContextItem.unignore.accesskey") }
debugger-download-file =
    .label = { COPY(from_path, "downloadFile.label") }
    .accesskey = { COPY(from_path, "downloadFile.accesskey") }
debugger-tab-close =
    .label = { COPY(from_path, "sourceTabs.closeTab") }
    .accesskey = { COPY(from_path, "sourceTabs.closeTab.accesskey") }
debugger-tab-close-others =
    .label = { COPY(from_path, "sourceTabs.closeOtherTabs") }
    .accesskey = { COPY(from_path, "sourceTabs.closeOtherTabs.accesskey") }
debugger-tab-close-to-end =
    .label = { COPY(from_path, "sourceTabs.closeTabsToEnd") }
    .accesskey = { COPY(from_path, "sourceTabs.closeTabsToEnd.accesskey") }
debugger-tab-close-all =
    .label = { COPY(from_path, "sourceTabs.closeAllTabs") }
    .accesskey = { COPY(from_path, "sourceTabs.closeAllTabs.accesskey") }
debugger-tab-unignore-source =
    .label = { COPY(from_path, "ignoreContextItem.unignore") }
    .accesskey = { COPY(from_path, "ignoreContextItem.ignore.accesskey") }
debugger-tab-pretty-print =
    .label = { COPY(from_path, "sourceTabs.prettyPrint") }
    .accesskey = { COPY(from_path, "sourceTabs.prettyPrint.accesskey") }
debugger-source-tree-add-override =
    .label = { COPY(from_path, "overridesContextItem.override") }
    .accesskey = { COPY(from_path, "overridesContextItem.override.accesskey") }
debugger-source-tree-remove-override =
    .label = { COPY(from_path, "overridesContextItem.removeOverride") }
    .accesskey = { COPY(from_path, "overridesContextItem.removeOverride.accesskey") }
debugger-source-tree-collapse-all =
    .label = { COPY(from_path, "collapseAll.label") }
debugger-source-tree-expand-all =
    .label = { COPY(from_path, "expandAll.label") }
debugger-source-tree-set-directory-root =
    .label = { COPY(from_path, "setDirectoryRoot.label") }
    .accesskey = { COPY(from_path, "setDirectoryRoot.accesskey") }
debugger-source-tree-remove-directory-root =
    .label = { COPY(from_path, "removeDirectoryRoot.label") }
debugger-source-tree-ignore =
    .label = { COPY(from_path, "ignoreAll.label") }
debugger-source-tree-ignore-in-group =
    .label = { COPY(from_path, "ignoreAllInGroup.label") }
debugger-source-tree-unignore-in-group =
    .label = { COPY(from_path, "unignoreAllInGroup.label") }
debugger-source-tree-ignore-outside-group =
    .label = { COPY(from_path, "ignoreAllOutsideGroup.label") }
debugger-source-tree-unignore-outside-group =
    .label = { COPY(from_path, "unignoreAllOutsideGroup.label") }
debugger-source-tree-ignore-in-directory =
    .label = { COPY(from_path, "ignoreAllInDir.label") }
debugger-source-tree-unignore-in-directory =
    .label = { COPY(from_path, "unignoreAllInDir.label") }
debugger-source-tree-ignore-outside-directory =
    .label = { COPY(from_path, "ignoreAllOutsideDir.label") }
debugger-source-tree-unignore-outside-directory =
    .label = { COPY(from_path, "unignoreAllOutsideDir.label") }
""",
            from_path=source,
        ),
    )

    ctx.add_transforms(
        target,
        target,
        [
            FTL.Message(
                id=FTL.Identifier("debugger-editor-jump-to-generated-location"),
                attributes=[
                    FTL.Attribute(
                        id=FTL.Identifier("label"),
                        value=REPLACE(
                            source,
                            "editor.jumpToMappedLocation1",
                            {"%1$S": COPY(source, "generated")},
                        ),
                    ),
                    FTL.Attribute(
                        id=FTL.Identifier("accesskey"),
                        value=COPY(source, "editor.jumpToMappedLocation1.accesskey"),
                    ),
                ],
            ),
            FTL.Message(
                id=FTL.Identifier("debugger-editor-jump-to-original-location"),
                attributes=[
                    FTL.Attribute(
                        id=FTL.Identifier("label"),
                        value=REPLACE(
                            source,
                            "editor.jumpToMappedLocation1",
                            {"%1$S": COPY(source, "original")},
                        ),
                    ),
                    FTL.Attribute(
                        id=FTL.Identifier("accesskey"),
                        value=COPY(source, "editor.jumpToMappedLocation1.accesskey"),
                    ),
                ],
            ),
        ],
    )
