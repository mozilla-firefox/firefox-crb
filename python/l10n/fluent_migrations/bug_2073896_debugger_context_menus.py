# Any copyright is dedicated to the Public Domain.
# http://creativecommons.org/publicdomain/zero/1.0/

import fluent.syntax.ast as FTL
from fluent.migrate.helpers import transforms_from
from fluent.migrate.transforms import COPY, REPLACE, Transform

# Locales that reuse the English accesskeys instead of picking their own.
EN_ACCESSKEY_LOCALES = {
    "as",
    "bn",
    "bn-BD",
    "bn-IN",
    "bo",
    "bqi",
    "brx",
    "en-CA",
    "en-GB",
    "en-US",
    "en-ZA",
    "gn",
    "gu-IN",
    "hi-IN",
    "ja",
    "ja-JP-mac",
    "km",
    "kn",
    "ko",
    "ks",
    "lb",
    "lo",
    "mai",
    "mr",
    "my",
    "ne-NP",
    "or",
    "pa-IN",
    "sat",
    "sco",
    "si",
    "skr",
    "ta",
    "ta-LK",
    "te",
    "tl",
    "trs",
    "ur",
    "vi",
    "zh-CN",
    "zh-TW",
}
DESCENDERS = "gjpqy"
NARROW = "ilI"


def english_accesskey(ctx, reference_path, reference_key):
    msg_key, _, attr_key = reference_key.partition(".")
    for entry in ctx.reference_resources[reference_path].body:
        if isinstance(entry, FTL.Message) and entry.id.name == msg_key:
            for attribute in entry.attributes:
                if attribute.id.name == attr_key:
                    return attribute.value.clone()
    raise KeyError(f"{reference_key} not found in {reference_path}")


class EN_OR_LOCALE_ACCESSKEY(COPY):
    """Pick the en-US accesskey for locales that use the English accesskey,
    otherwise copy the accesskey the locale currently uses.
    """

    def __init__(self, path, key, reference_path, reference_key):
        super().__init__(path, key)
        self.reference_path = reference_path
        self.reference_key = reference_key

    def __call__(self, ctx):
        if ctx.locale in EN_ACCESSKEY_LOCALES:
            return english_accesskey(ctx, self.reference_path, self.reference_key)
        return super().__call__(ctx)


class ACCESSKEY_FROM_LABEL(COPY):
    """Pick an accesskey from the text of a translated label, preferring
    characters that are neither narrow nor have descenders.

    The English accesskey is read from `reference_key` in the reference FTL
    file at `reference_path`.
    """

    def __init__(self, path, key, reference_path, reference_key):
        super().__init__(path, key)
        self.reference_path = reference_path
        self.reference_key = reference_key

    def __call__(self, ctx):
        if ctx.locale in EN_ACCESSKEY_LOCALES:
            return english_accesskey(ctx, self.reference_path, self.reference_key)
        pattern = super().__call__(ctx)
        label = "".join(
            element.value
            for element in pattern.elements
            if isinstance(element, FTL.TextElement)
        )
        candidates = [c for c in label if c.isalpha()]
        for allowed in (
            lambda c: c not in NARROW and c not in DESCENDERS,
            lambda c: c not in DESCENDERS,
            lambda c: True,
        ):
            for c in candidates:
                if allowed(c):
                    return Transform.pattern_of(FTL.TextElement(c))
        return english_accesskey(ctx, self.reference_path, self.reference_key)


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
debugger-breakpoint-edit-condition =
    .label = { COPY(from_path, "breakpointMenuItem.editCondition2.label") }
    .accesskey = { COPY(from_path, "breakpointMenuItem.editCondition2.accesskey") }
debugger-add-log-point =
    .label = { COPY(from_path, "editor.addLogPoint") }
    .accesskey = { COPY(from_path, "editor.addLogPoint.accesskey") }
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
debugger-editor-disable-breakpoints-on-line =
    .label = { COPY(from_path, "breakpointMenuItem.disableAllAtLine.label") }
    .accesskey = { COPY(from_path, "breakpointMenuItem.disableAllAtLine.accesskey") }
debugger-editor-continue-to-here =
    .label = { COPY(from_path, "editor.continueToHere.label") }
    .accesskey = { COPY(from_path, "editor.continueToHere.accesskey") }
debugger-editor-unignore-line =
    .label = { COPY(from_path, "ignoreContextItem.unignoreLine") }
    .accesskey = { COPY(from_path, "ignoreContextItem.unignoreLine.accesskey") }
debugger-editor-copy-to-clipboard =
    .label = { COPY(from_path, "copyToClipboard.label") }
    .accesskey = { COPY(from_path, "copyToClipboard.accesskey") }
debugger-editor-add-watch-expression =
    .label = { COPY(from_path, "expressions.label") }
    .accesskey = { COPY(from_path, "expressions.accesskey") }
debugger-copy-source =
    .label = { COPY(from_path, "copySource.label") }
    .accesskey = { COPY(from_path, "copySource.accesskey") }
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
debugger-source-tree-set-directory-root =
    .label = { COPY(from_path, "setDirectoryRoot.label") }
    .accesskey = { COPY(from_path, "setDirectoryRoot.accesskey") }
""",
            from_path=source,
        ),
    )

    ctx.add_transforms(
        target,
        target,
        [
            FTL.Message(
                id=FTL.Identifier("debugger-breakpoint-add-condition"),
                attributes=[
                    FTL.Attribute(
                        id=FTL.Identifier("label"),
                        value=COPY(source, "breakpointMenuItem.addCondition2.label"),
                    ),
                    FTL.Attribute(
                        id=FTL.Identifier("accesskey"),
                        value=EN_OR_LOCALE_ACCESSKEY(
                            source,
                            "breakpointMenuItem.addCondition2.accesskey",
                            target,
                            "debugger-breakpoint-add-condition.accesskey",
                        ),
                    ),
                ],
            ),
            FTL.Message(
                id=FTL.Identifier("debugger-pause-here"),
                attributes=[
                    FTL.Attribute(
                        id=FTL.Identifier("label"),
                        value=COPY(source, "breakpointMenuItem.enabledbg.label"),
                    ),
                    FTL.Attribute(
                        id=FTL.Identifier("accesskey"),
                        value=ACCESSKEY_FROM_LABEL(
                            source,
                            "breakpointMenuItem.enabledbg.label",
                            target,
                            "debugger-pause-here.accesskey",
                        ),
                    ),
                ],
            ),
            FTL.Message(
                id=FTL.Identifier("debugger-never-pause-here"),
                attributes=[
                    FTL.Attribute(
                        id=FTL.Identifier("label"),
                        value=COPY(source, "breakpointMenuItem.disabledbg.label"),
                    ),
                    FTL.Attribute(
                        id=FTL.Identifier("accesskey"),
                        value=ACCESSKEY_FROM_LABEL(
                            source,
                            "breakpointMenuItem.disabledbg.label",
                            target,
                            "debugger-never-pause-here.accesskey",
                        ),
                    ),
                ],
            ),
            FTL.Message(
                id=FTL.Identifier("debugger-edit-log-point"),
                attributes=[
                    FTL.Attribute(
                        id=FTL.Identifier("label"),
                        value=COPY(source, "editor.editLogPoint"),
                    ),
                    FTL.Attribute(
                        id=FTL.Identifier("accesskey"),
                        value=EN_OR_LOCALE_ACCESSKEY(
                            source,
                            "editor.editLogPoint.accesskey",
                            target,
                            "debugger-edit-log-point.accesskey",
                        ),
                    ),
                ],
            ),
            FTL.Message(
                id=FTL.Identifier("debugger-editor-enable-breakpoints-on-line"),
                attributes=[
                    FTL.Attribute(
                        id=FTL.Identifier("label"),
                        value=COPY(source, "breakpointMenuItem.enableAllAtLine.label"),
                    ),
                    FTL.Attribute(
                        id=FTL.Identifier("accesskey"),
                        value=EN_OR_LOCALE_ACCESSKEY(
                            source,
                            "breakpointMenuItem.enableAllAtLine.accesskey",
                            target,
                            "debugger-editor-enable-breakpoints-on-line.accesskey",
                        ),
                    ),
                ],
            ),
            FTL.Message(
                id=FTL.Identifier("debugger-editor-ignore-line"),
                attributes=[
                    FTL.Attribute(
                        id=FTL.Identifier("label"),
                        value=COPY(source, "ignoreContextItem.ignoreLine"),
                    ),
                    FTL.Attribute(
                        id=FTL.Identifier("accesskey"),
                        value=EN_OR_LOCALE_ACCESSKEY(
                            source,
                            "ignoreContextItem.ignoreLine.accesskey",
                            target,
                            "debugger-editor-ignore-line.accesskey",
                        ),
                    ),
                ],
            ),
            FTL.Message(
                id=FTL.Identifier("debugger-editor-ignore-lines"),
                attributes=[
                    FTL.Attribute(
                        id=FTL.Identifier("label"),
                        value=COPY(source, "ignoreContextItem.ignoreLines"),
                    ),
                    FTL.Attribute(
                        id=FTL.Identifier("accesskey"),
                        value=EN_OR_LOCALE_ACCESSKEY(
                            source,
                            "ignoreContextItem.ignoreLines.accesskey",
                            target,
                            "debugger-editor-ignore-lines.accesskey",
                        ),
                    ),
                ],
            ),
            FTL.Message(
                id=FTL.Identifier("debugger-editor-unignore-lines"),
                attributes=[
                    FTL.Attribute(
                        id=FTL.Identifier("label"),
                        value=COPY(source, "ignoreContextItem.unignoreLines"),
                    ),
                    FTL.Attribute(
                        id=FTL.Identifier("accesskey"),
                        value=EN_OR_LOCALE_ACCESSKEY(
                            source,
                            "ignoreContextItem.unignoreLines.accesskey",
                            target,
                            "debugger-editor-unignore-lines.accesskey",
                        ),
                    ),
                ],
            ),
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
            FTL.Message(
                id=FTL.Identifier("debugger-editor-evaluate-in-console"),
                attributes=[
                    FTL.Attribute(
                        id=FTL.Identifier("label"),
                        value=COPY(source, "evaluateInConsole.label"),
                    ),
                    FTL.Attribute(
                        id=FTL.Identifier("accesskey"),
                        value=ACCESSKEY_FROM_LABEL(
                            source,
                            "evaluateInConsole.label",
                            target,
                            "debugger-editor-evaluate-in-console.accesskey",
                        ),
                    ),
                ],
            ),
            FTL.Message(
                id=FTL.Identifier("debugger-editor-show-inline-preview"),
                attributes=[
                    FTL.Attribute(
                        id=FTL.Identifier("label"),
                        value=COPY(source, "inlinePreview.show.label"),
                    ),
                    FTL.Attribute(
                        id=FTL.Identifier("accesskey"),
                        value=ACCESSKEY_FROM_LABEL(
                            source,
                            "inlinePreview.show.label",
                            target,
                            "debugger-editor-show-inline-preview.accesskey",
                        ),
                    ),
                ],
            ),
            FTL.Message(
                id=FTL.Identifier("debugger-editor-hide-inline-preview"),
                attributes=[
                    FTL.Attribute(
                        id=FTL.Identifier("label"),
                        value=COPY(source, "inlinePreview.hide.label"),
                    ),
                    FTL.Attribute(
                        id=FTL.Identifier("accesskey"),
                        value=ACCESSKEY_FROM_LABEL(
                            source,
                            "inlinePreview.hide.label",
                            target,
                            "debugger-editor-hide-inline-preview.accesskey",
                        ),
                    ),
                ],
            ),
            FTL.Message(
                id=FTL.Identifier("debugger-editor-wrap-lines"),
                attributes=[
                    FTL.Attribute(
                        id=FTL.Identifier("label"),
                        value=COPY(source, "editorWrapping.show.label"),
                    ),
                    FTL.Attribute(
                        id=FTL.Identifier("accesskey"),
                        value=ACCESSKEY_FROM_LABEL(
                            source,
                            "editorWrapping.show.label",
                            target,
                            "debugger-editor-wrap-lines.accesskey",
                        ),
                    ),
                ],
            ),
            FTL.Message(
                id=FTL.Identifier("debugger-editor-unwrap-lines"),
                attributes=[
                    FTL.Attribute(
                        id=FTL.Identifier("label"),
                        value=COPY(source, "editorWrapping.hide.label"),
                    ),
                    FTL.Attribute(
                        id=FTL.Identifier("accesskey"),
                        value=ACCESSKEY_FROM_LABEL(
                            source,
                            "editorWrapping.hide.label",
                            target,
                            "debugger-editor-unwrap-lines.accesskey",
                        ),
                    ),
                ],
            ),
            FTL.Message(
                id=FTL.Identifier("debugger-copy-source-uri"),
                attributes=[
                    FTL.Attribute(
                        id=FTL.Identifier("label"),
                        value=COPY(source, "copySourceUri2"),
                    ),
                    FTL.Attribute(
                        id=FTL.Identifier("accesskey"),
                        value=EN_OR_LOCALE_ACCESSKEY(
                            source,
                            "copySourceUri2.accesskey",
                            target,
                            "debugger-copy-source-uri.accesskey",
                        ),
                    ),
                ],
            ),
            FTL.Message(
                id=FTL.Identifier("debugger-source-tree-collapse-all"),
                attributes=[
                    FTL.Attribute(
                        id=FTL.Identifier("label"),
                        value=COPY(source, "collapseAll.label"),
                    ),
                    FTL.Attribute(
                        id=FTL.Identifier("accesskey"),
                        value=ACCESSKEY_FROM_LABEL(
                            source,
                            "collapseAll.label",
                            target,
                            "debugger-source-tree-collapse-all.accesskey",
                        ),
                    ),
                ],
            ),
            FTL.Message(
                id=FTL.Identifier("debugger-source-tree-expand-all"),
                attributes=[
                    FTL.Attribute(
                        id=FTL.Identifier("label"),
                        value=COPY(source, "expandAll.label"),
                    ),
                    FTL.Attribute(
                        id=FTL.Identifier("accesskey"),
                        value=ACCESSKEY_FROM_LABEL(
                            source,
                            "expandAll.label",
                            target,
                            "debugger-source-tree-expand-all.accesskey",
                        ),
                    ),
                ],
            ),
            FTL.Message(
                id=FTL.Identifier("debugger-source-tree-remove-directory-root"),
                attributes=[
                    FTL.Attribute(
                        id=FTL.Identifier("label"),
                        value=COPY(source, "removeDirectoryRoot.label"),
                    ),
                    FTL.Attribute(
                        id=FTL.Identifier("accesskey"),
                        value=ACCESSKEY_FROM_LABEL(
                            source,
                            "removeDirectoryRoot.label",
                            target,
                            "debugger-source-tree-remove-directory-root.accesskey",
                        ),
                    ),
                ],
            ),
            FTL.Message(
                id=FTL.Identifier("debugger-source-tree-ignore"),
                attributes=[
                    FTL.Attribute(
                        id=FTL.Identifier("label"),
                        value=COPY(source, "ignoreAll.label"),
                    ),
                    FTL.Attribute(
                        id=FTL.Identifier("accesskey"),
                        value=ACCESSKEY_FROM_LABEL(
                            source,
                            "ignoreAll.label",
                            target,
                            "debugger-source-tree-ignore.accesskey",
                        ),
                    ),
                ],
            ),
            FTL.Message(
                id=FTL.Identifier("debugger-source-tree-ignore-in-group"),
                attributes=[
                    FTL.Attribute(
                        id=FTL.Identifier("label"),
                        value=COPY(source, "ignoreAllInGroup.label"),
                    ),
                    FTL.Attribute(
                        id=FTL.Identifier("accesskey"),
                        value=ACCESSKEY_FROM_LABEL(
                            source,
                            "ignoreAllInGroup.label",
                            target,
                            "debugger-source-tree-ignore-in-group.accesskey",
                        ),
                    ),
                ],
            ),
            FTL.Message(
                id=FTL.Identifier("debugger-source-tree-unignore-in-group"),
                attributes=[
                    FTL.Attribute(
                        id=FTL.Identifier("label"),
                        value=COPY(source, "unignoreAllInGroup.label"),
                    ),
                    FTL.Attribute(
                        id=FTL.Identifier("accesskey"),
                        value=ACCESSKEY_FROM_LABEL(
                            source,
                            "unignoreAllInGroup.label",
                            target,
                            "debugger-source-tree-unignore-in-group.accesskey",
                        ),
                    ),
                ],
            ),
            FTL.Message(
                id=FTL.Identifier("debugger-source-tree-ignore-outside-group"),
                attributes=[
                    FTL.Attribute(
                        id=FTL.Identifier("label"),
                        value=COPY(source, "ignoreAllOutsideGroup.label"),
                    ),
                    FTL.Attribute(
                        id=FTL.Identifier("accesskey"),
                        value=ACCESSKEY_FROM_LABEL(
                            source,
                            "ignoreAllOutsideGroup.label",
                            target,
                            "debugger-source-tree-ignore-outside-group.accesskey",
                        ),
                    ),
                ],
            ),
            FTL.Message(
                id=FTL.Identifier("debugger-source-tree-unignore-outside-group"),
                attributes=[
                    FTL.Attribute(
                        id=FTL.Identifier("label"),
                        value=COPY(source, "unignoreAllOutsideGroup.label"),
                    ),
                    FTL.Attribute(
                        id=FTL.Identifier("accesskey"),
                        value=ACCESSKEY_FROM_LABEL(
                            source,
                            "unignoreAllOutsideGroup.label",
                            target,
                            "debugger-source-tree-unignore-outside-group.accesskey",
                        ),
                    ),
                ],
            ),
            FTL.Message(
                id=FTL.Identifier("debugger-source-tree-ignore-in-directory"),
                attributes=[
                    FTL.Attribute(
                        id=FTL.Identifier("label"),
                        value=COPY(source, "ignoreAllInDir.label"),
                    ),
                    FTL.Attribute(
                        id=FTL.Identifier("accesskey"),
                        value=ACCESSKEY_FROM_LABEL(
                            source,
                            "ignoreAllInDir.label",
                            target,
                            "debugger-source-tree-ignore-in-directory.accesskey",
                        ),
                    ),
                ],
            ),
            FTL.Message(
                id=FTL.Identifier("debugger-source-tree-unignore-in-directory"),
                attributes=[
                    FTL.Attribute(
                        id=FTL.Identifier("label"),
                        value=COPY(source, "unignoreAllInDir.label"),
                    ),
                    FTL.Attribute(
                        id=FTL.Identifier("accesskey"),
                        value=ACCESSKEY_FROM_LABEL(
                            source,
                            "unignoreAllInDir.label",
                            target,
                            "debugger-source-tree-unignore-in-directory.accesskey",
                        ),
                    ),
                ],
            ),
            FTL.Message(
                id=FTL.Identifier("debugger-source-tree-ignore-outside-directory"),
                attributes=[
                    FTL.Attribute(
                        id=FTL.Identifier("label"),
                        value=COPY(source, "ignoreAllOutsideDir.label"),
                    ),
                    FTL.Attribute(
                        id=FTL.Identifier("accesskey"),
                        value=ACCESSKEY_FROM_LABEL(
                            source,
                            "ignoreAllOutsideDir.label",
                            target,
                            "debugger-source-tree-ignore-outside-directory.accesskey",
                        ),
                    ),
                ],
            ),
            FTL.Message(
                id=FTL.Identifier("debugger-source-tree-unignore-outside-directory"),
                attributes=[
                    FTL.Attribute(
                        id=FTL.Identifier("label"),
                        value=COPY(source, "unignoreAllOutsideDir.label"),
                    ),
                    FTL.Attribute(
                        id=FTL.Identifier("accesskey"),
                        value=ACCESSKEY_FROM_LABEL(
                            source,
                            "unignoreAllOutsideDir.label",
                            target,
                            "debugger-source-tree-unignore-outside-directory.accesskey",
                        ),
                    ),
                ],
            ),
        ],
    )
